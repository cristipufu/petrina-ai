// The required command passes only when every workspace runs and passes. The quick suites run first, all
// of them even after a failure, and the long engine suite starts only after they pass; otherwise it is
// recorded as not run. Selection is measured, never used to skip tests.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { conventions, inputs, observe, readGit, recordedCoverage, ROOT } from "./repository.js";
import { fingerprint, impactPlan, isTest, WORKSPACES } from "./impact.js";
import { requireFiles, testResults, type TestResults } from "@petrina/test-support/test-results";
import { createTestRun } from "@petrina/test-support/environment";
import { TEST_WORKSPACES } from "./workspaces.js";
import { writeFixtureJson } from "@petrina/test-support/fixture-json";
import { keepTestTimings, seedTestTimings, type TimingHintUse } from "./timings.js";
import { SuiteCoordinator, suitePassed, type WorkspaceEvidence } from "@petrina/test-support/suite-coordinator";

// This entry point is the required full check, never a focused test selector.
const args = process.argv.slice(2);
if (args.length) {
  const help = args.length === 1 && (args[0] === "--help" || args[0] === "-h");
  const usage = `Run the required full check with no arguments:
  bun run test
For focused engine tests, run from the repository root:
  bun run --cwd packages/engine test test/rules/testing/results.test.ts
Focused runs do not replace the required full check. See docs/testing.md for other workspaces.`;
  if (help) console.log(usage);
  else console.error(`The root test command does not accept file selectors or options. No tests ran.\n${usage}`);
  process.exit(help ? 0 : 1);
}

const PRELIMINARY: readonly string[] = TEST_WORKSPACES.filter(workspace => workspace.phase === "quick").map(workspace => workspace.path);
const ORDER = [...PRELIMINARY, ...WORKSPACES.filter(workspace => !PRELIMINARY.includes(workspace))];
const suite = (workspace: string) => workspace.split("/").at(-1)!;
type Ran = WorkspaceEvidence & { code: number; ms: number; missedFailures?: readonly string[]; durationHints?: TimingHintUse };
type Result = Ran | { workspace: string; notRun: string };
const passed = (result: Result) => "code" in result && suitePassed({ id: result.workspace, code: result.code, ms: result.ms, workspaces: [result] });

const errors = conventions(await inputs(ROOT));
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
console.log(`Affected-test observation: ${plan.selected.length}/${plan.total} candidates; it never changes which tests run. Order: ${PRELIMINARY.map(suite).join(" and ")}, then ${ORDER.slice(PRELIMINARY.length).map(suite).join(" and ")} only if they pass. Reports: ${relative(ROOT, folder)}`);
const coordinator = new SuiteCoordinator(ORDER.map(workspace => ({ id: workspace, workspaces: [workspace], ...(!PRELIMINARY.includes(workspace) ? { requires: PRELIMINARY } : {}) })), { revision, fingerprint: plan.fingerprint });
const details = new Map<string, { missedFailures?: readonly string[]; durationHints?: TimingHintUse }>();
const timingOutputs = new Map<string, string>();
let child: ReturnType<typeof Bun.spawn> | undefined;
let interrupted: number | undefined;
let finished = false;
const controller = new AbortController();
const interrupt = (signal: "SIGINT" | "SIGTERM", code: number) => { interrupted = code; controller.abort(); child?.kill(signal); };
const onInt = () => interrupt("SIGINT", 130), onTerm = () => interrupt("SIGTERM", 143);
process.on("SIGINT", onInt); process.on("SIGTERM", onTerm);
const owned = createTestRun();
try {
  await coordinator.run(async execution => {
    const workspace = execution.workspaces[0]!;
    const engine = TEST_WORKSPACES.find(entry => entry.path === workspace)!.runner === "bun";
    const output = join(folder, `${suite(workspace)}.${engine ? "xml" : "json"}`);
    // Bun uses existing durations to start slow files first at its normal worker count.
    // Every required file still runs. Retain both the supplied hints and the new measurements.
    const timings = join(folder, `${suite(workspace)}-timings.json`);
    const durationHints = engine ? seedTestTimings(ROOT, workspace, timings, expectedFiles) : undefined;
    if (engine) timingOutputs.set(workspace, timings);
    const reporter = engine ? ["--reporter=junit", `--reporter-outfile=${output}`, `--timings=${timings}`, "--update-timings"] : ["--reporter=json", `--outputFile=${output}`];
    const start = performance.now();
    child = Bun.spawn([process.execPath, "run", "--cwd", workspace, "test", ...reporter], { cwd: ROOT, env: owned.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    const code = await child.exited;
    const result: { workspace: string; failures?: string[]; counts?: Omit<TestResults, "files" | "failures">; reportComplete?: boolean; error?: string } = { workspace };
    const ms = Math.round(performance.now() - start);
    let missedFailures: string[] | undefined;
    try {
      const parsed = testResults(readFileSync(output, "utf8"), workspace, engine ? "bun" : "vitest", ROOT);
      const { files, failures, ...counts } = parsed;
      result.failures = failures;
      result.counts = counts;
      missedFailures = result.failures.filter(file => !plan.selected.includes(file));
      requireFiles(parsed, expectedFiles.filter(file => file.startsWith(`${workspace}/`)));
      result.reportComplete = true;
      if (code !== 0 && !result.failures.length) result.error = "Run failed without an attributable test file; selection accuracy is unknown";
    } catch (error) { result.error = `Incomplete test evidence: ${error instanceof Error ? error.message : String(error)}`; }
    if (result.error) console.error(`${workspace}: ${result.error}`);
    else if (code === 0 && result.failures?.length) console.error(`${workspace}: structured results report failed files despite a zero exit code: ${result.failures.join(", ")}`);
    details.set(workspace, { ...(missedFailures ? { missedFailures } : {}), ...(durationHints ? { durationHints } : {}) });
    child = undefined;
    return { code, ms, workspaces: [result] };
  }, controller.signal);
  finished = true;
} finally {
  try {
    process.off("SIGINT", onInt); process.off("SIGTERM", onTerm);
    // The current native adapter runs one workspace per execution.
    const results: Result[] = coordinator.results.map(result => "code" in result
      ? { ...result.workspaces[0]!, code: result.code, ms: result.ms, ...details.get(result.id), ...(result.error ? { error: result.error } : {}) }
      : { workspace: result.workspaceNames[0]!, notRun: result.notRun });
    const { complete, stableInputs: stable, successful } = coordinator.conclusion({ fingerprint: fingerprint(await inputs(ROOT)), revision: (await readGit(ROOT, ["rev-parse", "HEAD", "HEAD^{tree}"])).trim() }, interrupted !== undefined);
    writeFixtureJson(join(folder, "results.json"), { mode: "observation", scope: complete ? "complete" : "partial", source, environment, stableInputs: stable, interrupted, ms: Math.round(performance.now() - began), results }, 2);
    if (successful) {
      const updates = [...timingOutputs].map(([workspace, file]) => ({ workspace, ...keepTestTimings(ROOT, workspace, file, expectedFiles) }));
      try { writeFixtureJson(join(folder, "timing-cache-updates.json"), updates, 2); }
      catch (error) { console.error(`Could not record optional duration-hint updates: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (finished && !interrupted) {
      const unrun = results.filter(result => !("code" in result)).map(result => suite(result.workspace));
      console.log(unrun.length ? `Test summary: ${unrun.join(" and ")} did not run, so this run cannot pass and its affected-test observation covers only the suites that ran.` : "Test summary:");
      for (const result of results) console.log(`  ${suite(result.workspace)}: ${outcome(result)}`);
    }
    if (!stable) console.error("Test inputs changed during the run, or the checkout revision moved. Results cannot authorize delivery.");
    process.exitCode = interrupted ?? (successful ? 0 : 1);
  } finally { owned.close(); }
}

/** One plain line per suite. It never starts like a runner's failure marker, so real failing tests stay the diagnostic. */
function outcome(result: Result): string {
  if (!("code" in result)) return `not run, because ${result.notRun}`;
  const time = `${(result.ms / 1000).toFixed(1)}s`;
  const files = result.failures?.length ? `; failing files: ${result.failures.slice(0, 5).join(", ")}${result.failures.length > 5 ? ` and ${result.failures.length - 5} more` : ""}` : "";
  if (passed(result)) return `passed in ${time}`;
  if (result.code !== 0) return `failed after ${time}${files || "; no failing test file could be attributed"}`;
  return `incomplete after ${time}: ${result.error ? "its structured results were unavailable" : "it exited successfully but its structured results report failures"}${files}`;
}
