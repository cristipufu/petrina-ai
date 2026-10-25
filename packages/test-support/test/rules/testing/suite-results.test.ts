import { expect, it } from "bun:test";
import { suiteRecords, workspaceOutcome } from "../../../src/suite-results.js";
import { successfulSuite, suitePlan } from "../../fixtures/suites.js";
import type { SuiteResult } from "../../../src/suite-coordinator.js";

const shared = (): SuiteResult => ({ id: "native", ...successfulSuite(suitePlan[2]!) });

it("records one actual duration and exit per execution with distinct package observations", () => {
  const source = shared(), records = suiteRecords([source], []);
  expect(records.executions).toEqual([{ id: "native", code: 0, ms: 25, workspaces: ["packages/engine", "packages/storage"] }]);
  expect(records.results.map(work => ({ workspace: work.workspace, executionId: work.executionId, hasMs: "ms" in work, hasCode: "code" in work })))
    .toEqual(["packages/engine", "packages/storage"].map(workspace => ({ workspace, executionId: "native", hasMs: false, hasCode: false })));
  expect(records.results.map(work => workspaceOutcome(work, records.executions[0]!))).toEqual(["passed", "passed"]);
  expect(source).toEqual(shared());
});

it("attributes a shared failure and selection misses only to the package that reported them", () => {
  const source = shared();
  if (!("code" in source)) throw new Error("Missing execution");
  const records = suiteRecords([{ ...source, code: 1, workspaces: source.workspaces.map(work => work.workspace === "packages/storage"
    ? { ...work, counts: { tests: 2, passed: 1, failed: 1, skipped: 0 }, failures: ["known", "missed"] } : work) }], ["known"]);
  expect(records.results.map(work => "missedFailures" in work ? work.missedFailures : undefined)).toEqual([[], ["missed"]]);
  expect(records.results.map(work => workspaceOutcome(work, records.executions[0]!))).toEqual(["passed", "failed; failing files: known, missed"]);
  expect(records.executions[0]).toMatchObject({ code: 1 });
});

it("keeps every unstarted package unstarted without inventing execution time or missed failures", () => {
  const records = suiteRecords([{ id: "native", workspaceNames: ["engine", "storage"], notRun: "core did not pass" }], []);
  expect(records.executions).toEqual([{ id: "native", workspaces: ["engine", "storage"], notRun: "core did not pass" }]);
  expect(records.results).toEqual(["engine", "storage"].map(workspace => ({ workspace, executionId: "native", notRun: "core did not pass" })));
  expect(records.results.map(work => workspaceOutcome(work, records.executions[0]!))).toEqual(["not run, because core did not pass", "not run, because core did not pass"]);
});

for (const code of [null, 0, 1]) it(`keeps missing structured evidence explicit beside execution exit ${code}`, () => {
  const records = suiteRecords([{ id: "native", code, ms: 12, workspaces: [{ workspace: "engine", error: "Missing report" }] }], []);
  expect(records.results[0]).not.toHaveProperty("missedFailures");
  expect(workspaceOutcome(records.results[0]!, records.executions[0]!)).toBe(code === null ? "incomplete: its execution exit was not reported"
    : code === 0 ? "incomplete: its execution or structured results were unavailable" : "failed; no failing test file could be attributed");
});

it("does not hide contradictory zero-exit failures or native ownership errors", () => {
  const source = shared();
  if (!("code" in source)) throw new Error("Missing execution");
  const contradiction = suiteRecords([{ ...source, workspaces: source.workspaces.map(work => ({ ...work, failures: ["bad.test.ts"] })) }], []);
  expect(workspaceOutcome(contradiction.results[0]!, contradiction.executions[0]!)).toBe("incomplete: it exited successfully but its structured results report failures; failing files: bad.test.ts");
  const uncertain = suiteRecords([{ ...source, error: "Owned cleanup unconfirmed" }], []);
  expect(workspaceOutcome(uncertain.results[0]!, uncertain.executions[0]!)).toBe("incomplete: its execution or structured results were unavailable");
  expect(uncertain.executions[0]).toHaveProperty("error", "Owned cleanup unconfirmed");
});
