// Every required workspace must run and pass. Vitest workspaces run first; all Bun packages
// then share one normal native worker pool. Selection is observed, never used to omit tests.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { conventions, inputs, observe, readGit, recordedCoverage, ROOT } from "./repository.js";
import { fingerprint, impactPlan, isTest } from "./impact.js";
import { requireFiles, executionTestResults } from "@petrina/test-support/test-results";
import { createTestRun } from "@petrina/test-support/environment";
import { PRELIMINARY, NATIVE_SCOPE, REQUIRED_EXECUTIONS, nativeScriptProblems } from "./required-plan.js";
import { writeFixtureJson } from "@petrina/test-support/fixture-json";
import { keepTestTimings, seedTestTimings, type TimingHintUse } from "./timings.js";
import { SuiteCoordinator, type WorkspaceEvidence } from "@petrina/test-support/suite-coordinator";
import { runProcess, SUITE_RUN_TIMEOUT_MS } from "@petrina/test-support/run-process";
import { CommandFailure } from "@petrina/test-support/commands";
import { testCommand } from "@petrina/test-support/run";
import { suiteRecords, workspaceOutcome } from "@petrina/test-support/suite-results";

// This entry point is the required full check, never a focused test selector.
const args = process.argv.slice(2);
if (args.length) {
  const help = args.length === 1 && (args[0] === "--help" || args[0] === "-h");
  const usage = `Run the required full check with no arguments:
  bun run test
For focused engine tests, run from the repository root:
  bun run --cwd packages/engine test test/contracts/testing/execution-results.test.ts
Focused runs do not replace the required full check. See docs/testing.md for other workspaces.`;
  if (help) console.log(usage);
  else console.error(`The root test command does not accept file selectors or options. No tests ran.\n${usage}`);
  process.exit(help ? 0 : 1);
}

const suite = (workspace: string) => workspace.split("/").at(-1)!;
const initial = await inputs(ROOT);
const errors = [...conventions(initial), ...nativeScriptProblems(initial)];
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
const began = performance.now();
const folder = join(ROOT, ".test-results", `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`);
mkdirSync(folder, { recursive: true });
let plan: Awaited<ReturnType<typeof observe>> | ReturnType<typeof impactPlan>;
try { plan = await observe(ROOT, process.env.PETRINA_TEST_BASE, recordedCoverage(ROOT)); }
catch (error) {
  const files = await inputs(ROOT);
  plan = impactPlan(files, ["unknown-base"]);
  plan.reasons.push(error instanceof Error ? error.message : String(error));
}
writeFileSync(join(folder, "impact.json"), JSON.stringify(plan, null, 2));
const manifest = await inputs(ROOT);
if (fingerprint(manifest) !== plan.fingerprint) throw new Error("Test inputs changed while preparing the run; no suites started");
const expectedFiles = [...manifest.keys()].filter(isTest).sort();
writeFileSync(join(folder, "files.json"), JSON.stringify(expectedFiles, null, 2));
const revision = (await readGit(ROOT, ["rev-parse", "HEAD", "HEAD^{tree}"])).trim();
const [head, tree] = revision.split("\n");
const source = { head, tree, fingerprint: plan.fingerprint, clean: !(await readGit(ROOT, ["status", "--porcelain=v1", "--untracked-files=normal"])).trim() };
const environment = { platform: process.platform, arch: process.arch, bun: Bun.version };
console.log(`Affected-test observation: ${plan.selected.length}/${plan.total} candidates; it never changes which tests run. Order: ${PRELIMINARY.map(workspace => suite(workspace.path)).join(" and ")}, then one native pool only if they pass. Reports: ${relative(ROOT, folder)}`);
const coordinator = new SuiteCoordinator(REQUIRED_EXECUTIONS, { revision, fingerprint: plan.fingerprint });
const details = new Map<string, { durationHints?: TimingHintUse }>();
let timingOutput: string | undefined;
let interrupted: number | undefined;
let finished = false;
const controller = new AbortController();
const interrupt = (signal: "SIGINT" | "SIGTERM", code: number) => { interrupted = code; controller.abort(signal); };
const onInt = () => interrupt("SIGINT", 130), onTerm = () => interrupt("SIGTERM", 143);
process.on("SIGINT", onInt); process.on("SIGTERM", onTerm);
const owned = createTestRun();
try {
  await coordinator.run(async execution => {
    const native = execution.id === NATIVE_SCOPE.id;
    const cwd = join(ROOT, native ? NATIVE_SCOPE.cwd : execution.workspaces[0]!);
    const output = join(folder, `${native ? "native" : suite(execution.id)}.${native ? "xml" : "json"}`);
    const timings = join(folder, "native-timings.json");
    if (native) {
      details.set(execution.id, { durationHints: seedTestTimings(ROOT, NATIVE_SCOPE, timings, expectedFiles) });
      timingOutput = timings;
    }
    const selectors = native ? execution.workspaces.map(workspace => {
      const path = relative(cwd, join(ROOT, workspace, "test"));
      return path.startsWith(".") ? path : `./${path}`;
    }) : [];
    const command = native ? testCommand([...selectors, "--reporter=junit", `--reporter-outfile=${output}`, `--timings=${timings}`, "--update-timings"])
      : [process.execPath, "--no-env-file", "run", "test", "--reporter=json", `--outputFile=${output}`];
    const start = performance.now();
    let code: number | null = null, executionError: string | undefined;
    try {
      const outcome = await runProcess(command, { cwd, env: owned.env, timeoutMs: SUITE_RUN_TIMEOUT_MS, signal: controller.signal, output: "inherit" });
      code = outcome.result.code;
    } catch (error) {
      if (!(error instanceof CommandFailure)) throw error;
      code = error.code ?? null;
      executionError = error.message;
    }
    const ms = Math.round(performance.now() - start);
    let workspaces: WorkspaceEvidence[];
    try {
      const parsed = executionTestResults(readFileSync(output, "utf8"), { root: ROOT, cwd, runner: native ? "bun" : "vitest", workspaces: execution.workspaces });
      workspaces = parsed.workspaces.map(work => {
        const { workspace, files, failures, ...counts } = work;
        try {
          requireFiles(work, expectedFiles.filter(file => file.startsWith(`${workspace}/`)));
          return { workspace, failures, counts, reportComplete: true };
        } catch (error) { return { workspace, failures, counts, error: `Incomplete test evidence: ${error instanceof Error ? error.message : String(error)}` }; }
      });
      if (code !== 0 && !parsed.total.failures.length) executionError ??= "Run failed without an attributable test file; selection accuracy is unknown";
    } catch (error) {
      const message = `Incomplete test evidence: ${error instanceof Error ? error.message : String(error)}`;
      workspaces = execution.workspaces.map(workspace => ({ workspace, error: message }));
    }
    if (executionError) console.error(`${execution.id}: ${executionError}`);
    for (const work of workspaces) {
      if (work.error) console.error(`${work.workspace}: ${work.error}`);
      else if (code === 0 && work.failures?.length) console.error(`${work.workspace}: structured results report failed files despite a zero exit code: ${work.failures.join(", ")}`);
    }
    return { code, ms, workspaces, ...(executionError ? { error: executionError } : {}) };
  }, controller.signal);
  finished = true;
} finally {
  try {
    process.off("SIGINT", onInt); process.off("SIGTERM", onTerm);
    const records = suiteRecords(coordinator.results, plan.selected);
    const executions = records.executions.map(execution => ({ ...execution, ...details.get(execution.id) }));
    const results = records.results;
    const { complete, stableInputs: stable, successful } = coordinator.conclusion({ fingerprint: fingerprint(await inputs(ROOT)), revision: (await readGit(ROOT, ["rev-parse", "HEAD", "HEAD^{tree}"])).trim() }, interrupted !== undefined);
    writeFixtureJson(join(folder, "results.json"), { mode: "observation", scope: complete ? "complete" : "partial", source, environment, stableInputs: stable, interrupted, ms: Math.round(performance.now() - began), executions, results }, 2);
    if (successful) {
      const updates = timingOutput ? [{ executionId: NATIVE_SCOPE.id, ...keepTestTimings(ROOT, NATIVE_SCOPE, timingOutput, expectedFiles) }] : [];
      try { writeFixtureJson(join(folder, "timing-cache-updates.json"), updates, 2); }
      catch (error) { console.error(`Could not record optional duration-hint updates: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (finished && !interrupted) {
      const unrun = results.filter(result => "notRun" in result).map(result => suite(result.workspace));
      console.log(unrun.length ? `Test summary: ${unrun.join(" and ")} did not run, so this run cannot pass and its affected-test observation covers only the suites that ran.` : "Test summary:");
      for (const result of results) console.log(`  ${suite(result.workspace)}: ${workspaceOutcome(result, executions.find(execution => execution.id === result.executionId)!)}`);
      console.log(`Execution times: ${executions.flatMap(execution => "ms" in execution ? [`${suite(execution.id)} ${(execution.ms / 1000).toFixed(1)}s (exit ${execution.code ?? "unreported"})`] : []).join("; ")}`);
    }
    if (!stable) console.error("Test inputs changed during the run, or the checkout revision moved. Results cannot authorize delivery.");
    process.exitCode = interrupted ?? (successful ? 0 : 1);
  } finally { owned.close(); }
}
