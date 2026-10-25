import { expect, it } from "bun:test";
import { SuiteCoordinator, suitePassed, type ExecutionEvidence, type SuiteExecution } from "../../../src/suite-coordinator.js";
import { rejectionOf } from "../../../src/rejections.js";
import { successfulSuite, suitePlan, suiteSource } from "../../fixtures/suites.js";

async function run(change?: (execution: SuiteExecution, evidence: ExecutionEvidence) => ExecutionEvidence) {
  const coordinator = new SuiteCoordinator(suitePlan, suiteSource), seen: string[] = [];
  await coordinator.run(async execution => {
    if (!suitePlan.some(entry => entry.id === execution.id)) throw new Error("Unexpected execution");
    seen.push(execution.id);
    const evidence = successfulSuite(execution);
    return change ? change(execution, evidence) : evidence;
  }, new AbortController().signal);
  return { coordinator, seen, conclusion: coordinator.conclusion(suiteSource) };
}

it("executes every prerequisite and then one shared native execution with its duration recorded once", async () => {
  const { coordinator, seen, conclusion } = await run();
  expect(seen).toEqual(["core", "desktop", "native"]);
  expect(conclusion).toEqual({ complete: true, stableInputs: true, successful: true });
  expect(coordinator.results.every(suitePassed)).toBe(true);
  expect(coordinator.results[2]).toEqual({ id: "native", code: 0, ms: 25, workspaces: [
    { workspace: "packages/engine", counts: { tests: 2, passed: 2, failed: 0, skipped: 0 }, failures: [], reportComplete: true },
    { workspace: "packages/storage", counts: { tests: 2, passed: 2, failed: 0, skipped: 0 }, failures: [], reportComplete: true },
  ] });
});

for (const failing of [["core"], ["desktop"], ["core", "desktop"]]) it(`finishes independent prerequisites after ${failing.join(" and ")} fails and never starts their dependent`, async () => {
  const { coordinator, seen, conclusion } = await run((execution, evidence) => failing.includes(execution.id)
    ? { ...evidence, code: 1, workspaces: [{ workspace: execution.workspaces[0]!, counts: { tests: 2, passed: 1, failed: 1, skipped: 0 }, failures: ["reported.test.ts"], reportComplete: true }] } : evidence);
  expect(seen).toEqual(["core", "desktop"]);
  expect(coordinator.results.at(-1)).toEqual({ id: "native", workspaceNames: ["packages/engine", "packages/storage"], notRun: "core and desktop did not all pass" });
  expect(conclusion).toEqual({ complete: false, stableInputs: true, successful: false });
});

const invalid: [string, (e: ExecutionEvidence) => ExecutionEvidence][] = [
  ["missing report", e => ({ ...e, workspaces: e.workspaces.map(work => ({ workspace: work.workspace, error: "Missing report" })) })],
  ["unfinished report", e => ({ ...e, workspaces: e.workspaces.map(work => ({ ...work, reportComplete: false })) })],
  ["skipped-only report", e => ({ ...e, workspaces: e.workspaces.map(work => ({ ...work, counts: { tests: 2, passed: 0, failed: 0, skipped: 2 } })) })],
  ["inconsistent counts", e => ({ ...e, workspaces: e.workspaces.map(work => ({ ...work, counts: { tests: 3, passed: 2, failed: 0, skipped: 0 } })) })],
  ["negative counts", e => ({ ...e, workspaces: e.workspaces.map(work => ({ ...work, counts: { tests: 2, passed: 3, failed: -1, skipped: 0 } })) })],
  ["fractional counts", e => ({ ...e, workspaces: e.workspaces.map(work => ({ ...work, counts: { tests: 2, passed: 1.5, failed: 0.5, skipped: 0 } })) })],
  ["missing counts", e => ({ ...e, workspaces: e.workspaces.map(work => ({ ...work, counts: undefined })) })],
  ["missing attribution", e => ({ ...e, workspaces: e.workspaces.map(work => ({ ...work, failures: undefined })) })],
  ["zero exit with failed cases", e => ({ ...e, workspaces: e.workspaces.map(work => ({ ...work, counts: { tests: 2, passed: 1, failed: 1, skipped: 0 }, failures: ["failed.test.ts"] })) })],
  ["zero exit with file failure", e => ({ ...e, workspaces: e.workspaces.map(work => ({ ...work, failures: ["failed.test.ts"] })) })],
  ["nonzero exit without a failed case", e => ({ ...e, code: 1 })],
  ["cleanup unconfirmed", e => ({ ...e, error: "The native owner could not confirm cleanup" })],
  ["negative exit", e => ({ ...e, code: -1 })],
  ["unreported exit", e => ({ ...e, code: null })],
  ["invalid duration", e => ({ ...e, ms: Number.NaN })],
];
for (const [name, change] of invalid) it(`refuses ${name} despite otherwise passing prerequisites`, async () => {
  const { coordinator, seen, conclusion } = await run((execution, evidence) => execution.id === "core" ? change(evidence) : evidence);
  expect(seen).toEqual(["core", "desktop"]);
  expect(suitePassed(coordinator.results[0]!)).toBe(false);
  expect(conclusion.successful).toBe(false);
});

it("retains an unreported exit as unknown even beside complete passing case reports", async () => {
  const { coordinator, conclusion } = await run((execution, evidence) => execution.id === "native" ? { ...evidence, code: null } : evidence);
  expect(coordinator.results[2]).toMatchObject({ code: null, error: "The execution exit was not reported" });
  expect(conclusion).toEqual({ complete: false, stableInputs: true, successful: false });
});

it("preserves the native failure explanation when no exit was reported", async () => {
  const { coordinator, conclusion } = await run((execution, evidence) => execution.id === "native" ? { ...evidence, code: null, error: "Deadline expired; owned cleanup was unconfirmed" } : evidence);
  expect(coordinator.results[2]).toMatchObject({ code: null, error: "Deadline expired; owned cleanup was unconfirmed" });
  expect(conclusion).toEqual({ complete: false, stableInputs: true, successful: false });
});

for (const outcome of [{ code: -1, ms: 10 }, { code: Number.NaN, ms: 10 }, { code: 0.5, ms: 10 }, { code: 0, ms: Number.NaN }, { code: 0, ms: -1 }]) it(`keeps an invalid final outcome partial: ${JSON.stringify(outcome)}`, async () => {
  const { coordinator, conclusion } = await run((execution, evidence) => execution.id === "native" ? { ...evidence, ...outcome } : evidence);
  expect(coordinator.results[2]).toMatchObject({ error: "Invalid execution outcome" });
  expect(conclusion).toEqual({ complete: false, stableInputs: true, successful: false });
});

it("keeps a genuine shared failure complete and attributable to its actual workspace", async () => {
  const { coordinator, seen, conclusion } = await run((execution, evidence) => execution.id === "native"
    ? { ...evidence, code: 1, workspaces: evidence.workspaces.map(work => work.workspace === "packages/storage" ? { ...work, counts: { tests: 2, passed: 1, failed: 1, skipped: 0 }, failures: ["packages/storage/bad.test.ts"] } : work) } : evidence);
  expect(seen).toEqual(["core", "desktop", "native"]);
  expect(conclusion).toEqual({ complete: true, stableInputs: true, successful: false });
  const result = coordinator.results[2]!;
  if (!("code" in result)) throw new Error("The shared execution did not run");
  expect(result.workspaces.map(work => work.failures)).toEqual([[], ["packages/storage/bad.test.ts"]]);
});

for (const members of [[], ["packages/engine"], ["packages/engine", "packages/engine"], ["packages/engine", "unexpected"]]) it(`requires the exact shared workspace manifest: ${JSON.stringify(members)}`, async () => {
  const { coordinator, conclusion } = await run((execution, evidence) => execution.id === "native"
    ? { ...evidence, workspaces: members.map(workspace => ({ ...evidence.workspaces[0]!, workspace })) } : evidence);
  expect(coordinator.results[2]).toMatchObject({ error: "Incomplete execution workspace manifest" });
  expect(conclusion.complete).toBe(false);
  expect(conclusion.successful).toBe(false);
});

for (const ending of [{ ...suiteSource, revision: "another-commit/same-tree" }, { ...suiteSource, fingerprint: "changed-inputs" }]) it(`binds the required pass to its exact source: ${JSON.stringify(ending)}`, async () => {
  const { coordinator } = await run();
  expect(coordinator.conclusion(ending)).toEqual({ complete: true, stableInputs: false, successful: false });
});

it("starts no effects for an already interrupted run", async () => {
  const coordinator = new SuiteCoordinator(suitePlan, suiteSource), stop = new AbortController(); stop.abort();
  let calls = 0;
  await coordinator.run(async execution => { calls++; return successfulSuite(execution); }, stop.signal);
  expect(calls).toBe(0);
  expect(coordinator.results.map(result => "notRun" in result && result.notRun)).toEqual(suitePlan.map(() => "the run was interrupted first"));
  expect(coordinator.conclusion(suiteSource)).toEqual({ complete: false, stableInputs: true, successful: false });
});

it("retains a completed observation after interruption, starts nothing later and never authorizes delivery", async () => {
  const coordinator = new SuiteCoordinator(suitePlan, suiteSource), stop = new AbortController(), seen: string[] = [];
  await coordinator.run(async execution => { seen.push(execution.id); stop.abort(); return successfulSuite(execution); }, stop.signal);
  expect(seen).toEqual(["core"]);
  expect(coordinator.results[0]).toMatchObject({ code: 0, workspaces: [{ reportComplete: true }] });
  expect(coordinator.results.slice(1).map(result => "notRun" in result && result.notRun)).toEqual(["the run was interrupted first", "the run was interrupted first"]);
  expect(coordinator.conclusion(suiteSource).successful).toBe(false);
});

it("an interruption after all reports still prevents a pass", async () => {
  const { coordinator } = await run();
  expect(coordinator.conclusion(suiteSource, true)).toEqual({ complete: false, stableInputs: true, successful: false });
});

it("keeps an interrupted execution owned until its effect settles", async () => {
  const coordinator = new SuiteCoordinator(suitePlan, suiteSource), stop = new AbortController();
  const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>(), seen: string[] = [];
  let settled = false;
  const running = coordinator.run(async execution => { seen.push(execution.id); entered.resolve(); await released.promise; return successfulSuite(execution); }, stop.signal).finally(() => { settled = true; });
  try {
    await entered.promise;
    stop.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(coordinator.conclusion(suiteSource).successful).toBe(false);
  } finally { released.resolve(); await running; }
  expect(seen).toEqual(["core"]);
  expect(coordinator.conclusion(suiteSource).complete).toBe(false);
});

it("preserves an effect's rejection and records every unstarted execution without inventing outcomes", async () => {
  const coordinator = new SuiteCoordinator(suitePlan, suiteSource), reason = new Error("The native launch failed"), seen: string[] = [];
  const error = await rejectionOf(coordinator.run(async execution => { seen.push(execution.id); throw reason; }, new AbortController().signal));
  expect(error).toBe(reason);
  expect(seen).toEqual(["core"]);
  expect(coordinator.results.map(result => "notRun" in result && result.notRun)).toEqual(suitePlan.map(() => "the runner stopped first"));
  expect(coordinator.conclusion(suiteSource).successful).toBe(false);
});

it("retains private evidence and source snapshots, and executes the plan only once", async () => {
  const source = { ...suiteSource }, plan = suitePlan.map(entry => ({ ...entry, workspaces: [...entry.workspaces] }));
  const coordinator = new SuiteCoordinator(plan, source), observations = plan.map(successfulSuite); let calls = 0;
  source.revision = "later"; plan[0]!.workspaces.push("later-workspace");
  await coordinator.run(async () => observations[calls++]!, new AbortController().signal);
  Reflect.set(observations[0]!.workspaces[0]!.counts!, "passed", 0);
  Reflect.set(coordinator.results[0]!, "code", 1);
  expect(coordinator.conclusion(suiteSource)).toEqual({ complete: true, stableInputs: true, successful: true });
  const error = await rejectionOf(coordinator.run(async execution => { calls++; return successfulSuite(execution); }, new AbortController().signal));
  expect(String(error)).toContain("only once"); expect(calls).toBe(3);
});

for (const plan of [[], [{ id: "one", workspaces: [] }], [{ id: "one", workspaces: ["a"] }, { id: "one", workspaces: ["b"] }],
  [{ id: "one", workspaces: ["a", "a"] }], [{ id: "one", workspaces: ["a"], requires: ["missing"] }],
  [{ id: "one", workspaces: ["a"], requires: ["two"] }, { id: "two", workspaces: ["b"] }]]) it(`rejects an invalid required plan before any effects: ${JSON.stringify(plan)}`, () => {
  expect(() => new SuiteCoordinator(plan, suiteSource)).toThrow();
});

it("cannot claim completion before execution or without a starting source identity", () => {
  expect(new SuiteCoordinator(suitePlan, suiteSource).conclusion(suiteSource).successful).toBe(false);
  expect(() => new SuiteCoordinator(suitePlan, { revision: "", fingerprint: "inputs" })).toThrow("source identity");
  expect(() => new SuiteCoordinator(suitePlan, { revision: "commit", fingerprint: "" })).toThrow("source identity");
});
