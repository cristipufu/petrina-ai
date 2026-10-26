import { fixtureRetention, FIXTURE_JOURNAL } from "@petrina/test-support/fixture-retention";
import { impactRuntime } from "./impact-runtime.js";
// Repository-specific early feedback. Only the complete configured suite can authorize delivery.
import { mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { createTestRun } from "@petrina/test-support/environment";
import { writeFixtureJson } from "@petrina/test-support/fixture-json";
import { SuiteCoordinator } from "@petrina/test-support/suite-coordinator";
import { suiteRecords, workspaceOutcome } from "@petrina/test-support/suite-results";
import { conventions, inputs, observe, readGit, recordedCoverage, ROOT } from "./repository.js";
import { fingerprint, impactPlan, isTest } from "./impact.js";
import { NATIVE_SCOPE, nativeScriptProblems } from "./required-plan.js";
import { feedbackFiles, feedbackPlan } from "./feedback-plan.js";
import { executeTests } from "./execution.js";
import { runSettlements } from "@petrina/test-support/run-settlement";

const args = process.argv.slice(2);
const usage = "Use bun run test:affected [--base <revision>]. This is early feedback; delivery still requires bun run test.";
if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) { console.log(usage); process.exit(0); }
if (args.length && (args.length !== 2 || args[0] !== "--base" || !args[1] || args[1].startsWith("-"))) {
  console.error(`No tests ran. ${usage}`); process.exit(1);
}
const initial = await inputs(ROOT);
const errors = [...conventions(initial), ...nativeScriptProblems(initial)];
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
let plan: Awaited<ReturnType<typeof observe>> | ReturnType<typeof impactPlan>;
try { plan = await observe(ROOT, args[1] ?? process.env.PETRINA_TEST_BASE, recordedCoverage(ROOT)); }
catch (error) {
  plan = impactPlan(await inputs(ROOT), ["unknown-base"], impactRuntime());
  plan.reasons.push(error instanceof Error ? error.message : String(error));
}
const manifest = await inputs(ROOT);
if (fingerprint(manifest, impactRuntime().identity) !== plan.fingerprint) throw new Error("Test inputs changed while preparing affected feedback; no suites started");
const expectedFiles = [...manifest.keys()].filter(isTest).sort();
const requested = [...plan.selected];
plan = { ...plan, selected: feedbackFiles(requested, expectedFiles) };
if (plan.selected.length !== requested.length) plan.reasons.push("Vitest feedback runs each selected workspace completely; native feedback retains exact file selection");
const executionPlan = feedbackPlan(plan.selected, expectedFiles);
const revision = (await readGit(ROOT, ["rev-parse", "HEAD", "HEAD^{tree}"])).trim();
const [head, tree] = revision.split("\n");
const source = { head, tree, fingerprint: plan.fingerprint };
const folder = join(ROOT, ".test-results", "feedback", `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`);
mkdirSync(folder, { recursive: true });
writeFixtureJson(join(folder, "selection.json"), { ...plan, requested }, 2);
writeFixtureJson(join(folder, "files.json"), plan.selected, 2);
console.log(`Affected feedback: ${plan.selected.length}/${plan.total} files (${requested.length} requested). This does not authorize delivery. Reports: ${relative(ROOT, folder)}`);
const began = performance.now();
const controller = new AbortController();
let interrupted: number | undefined;
const onInt = () => { interrupted = 130; controller.abort("SIGINT"); };
const onTerm = () => { interrupted = 143; controller.abort("SIGTERM"); };
process.on("SIGINT", onInt); process.on("SIGTERM", onTerm);
const owned = createTestRun();
const settlements = runSettlements();
let disposal: Promise<boolean> | undefined, disposalFailure: { error: unknown } | undefined;
const dispose = () => disposal ??= settlements.dispose(owned).catch(error => { disposalFailure = { error }; return false; });
const coordinator = executionPlan.length ? new SuiteCoordinator(executionPlan, { revision, fingerprint: plan.fingerprint }) : undefined;
try {
  await coordinator?.run(async execution => {
    const evidence = await executeTests(execution, {
      root: ROOT, folder, expectedFiles: plan.selected, env: owned.env, signal: controller.signal, settlements,
      ...(execution.id === NATIVE_SCOPE.id ? { files: plan.selected.filter(file => execution.workspaces.some(workspace => file.startsWith(`${workspace}/`))) } : {}),
    });
    if (fixtureRetention(owned.env[FIXTURE_JOURNAL]!).kind !== "clear") controller.abort("Fixture cleanup was not confirmed");
    return evidence;
  }, controller.signal);
} finally {
  try {
    process.off("SIGINT", onInt); process.off("SIGTERM", onTerm);
    const final = { revision: (await readGit(ROOT, ["rev-parse", "HEAD", "HEAD^{tree}"])).trim(), fingerprint: fingerprint(await inputs(ROOT), impactRuntime().identity) };
    const conclusion = coordinator?.conclusion(final, interrupted !== undefined);
    const records = suiteRecords(coordinator?.results ?? [], plan.selected);
    const stableInputs = final.revision === revision && final.fingerprint === plan.fingerprint;
    const disposed = await dispose();
    writeFixtureJson(join(folder, "results.json"), {
      kind: "affected-feedback", deliveryEligible: false, source,
      environment: { platform: process.platform, arch: process.arch, bun: Bun.version },
      scope: !disposed ? "partial" : conclusion?.complete ? "selected-complete" : coordinator ? "partial" : "no-work",
      cleanup: disposed ? "confirmed" : "retained",
      stableInputs, interrupted, ms: Math.round(performance.now() - began), ...records,
    }, 2);
    if (!coordinator) console.log("No affected tests selected; no validation was performed.");
    else if (interrupted === undefined) {
      console.log("Affected feedback summary (the full delivery check is still required):");
      for (const work of records.results) console.log(`  ${work.workspace}: ${workspaceOutcome(work, records.executions.find(execution => execution.id === work.executionId)!)}`);
    }
    process.exitCode = interrupted ?? (disposed && stableInputs && (!coordinator || conclusion?.successful) ? 0 : 1);
  } finally {
    if (!await dispose()) {
      console.error(`Test command settlement was not confirmed; private files retained at ${owned.env.TMPDIR}`);
      if (disposalFailure) console.error(disposalFailure.error);
      if (interrupted === undefined) process.exitCode = 1;
    }
  }
}
