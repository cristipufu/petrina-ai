import { expect, it } from "vitest";
import { completeCheckExecution } from "@petrina/test-support/check-execution-facts";
import { checkOutcome, checkOutcomeLabel, checkExecutionPassed, CHECK_EXIT_UNREPORTED } from "../../../src/check-outcome.js";
import { checkCounts, checkEntryCommandOutcome, checkEntryResult, evidenceFor, checkProblem } from "../../../src/check-evidence.js";
import type { CheckRun, JourneyProductCheck } from "../../../src/model.js";

const completed = (code: number): CheckRun => ({ name: "Tests", command: "check", ok: code === 0, ms: 20, output: "Original diagnostic", execution: completeCheckExecution(code) });
const pair = (run: CheckRun) => { const outcome = checkOutcome(run); return [outcome.kind, outcome.reason]; };

it.each([0, 7])("classifies a complete native exit %s without inspecting diagnostic words", code => {
  const run = completed(code);
  expect(pair(run)).toEqual(code === 0 ? ["passed", "complete"] : ["failed", "command-failed"]);
  run.output = CHECK_EXIT_UNREPORTED;
  expect(pair(run)).toEqual(code === 0 ? ["passed", "complete"] : ["failed", "command-failed"]);
  expect(checkOutcome(run).reportedOk).toBe(code === 0);
});

it.each([true, false])("retains a legacy reportedOk=%s without manufacturing execution", reportedOk => {
  const run = { ...completed(reportedOk ? 0 : 7), ok: reportedOk, execution: undefined };
  expect(checkOutcome(run)).toEqual({ kind: "incomplete", reason: "native-evidence-missing", reportedOk });
  expect(run.ok).toBe(reportedOk);
  expect(run.execution).toBeUndefined();
});

it("reports absent evidence without claiming that an unrecorded command never ran", () => {
  expect(checkOutcome()).toEqual({ kind: "unavailable", reason: "not-recorded" });
});

it.each([
  ["timed-out", (run: CheckRun) => { run.timedOut = true; run.execution!.timedOut = true; }],
  ["cancelled", (run: CheckRun) => { run.interrupted = true; run.execution!.cancelled = true; }],
  ["stopped", (run: CheckRun) => { run.interrupted = true; }],
  ["machine-interruption", (run: CheckRun) => { run.interruption = { source: "macOS power log", event: "Recorded sleep", at: 10 }; }],
  ["read-failed", (run: CheckRun) => { run.execution!.stdout = "read-error"; run.execution!.failure = { kind: "read", message: "Pipe failed" }; }],
  ["output-incomplete", (run: CheckRun) => { run.execution!.stderr = "incomplete"; }],
  ["exit-unreported", (run: CheckRun) => { run.execution!.exit = { status: "unreported" }; }],
  ["exit-rejected", (run: CheckRun) => { run.execution!.exit = { status: "rejected" }; }],
  ["invalid-exit", (run: CheckRun) => { run.execution!.exit = { status: "invalid" }; }],
  ["signalled", (run: CheckRun) => { run.execution!.exit.signal = "SIGTERM"; }],
  ["cleanup-unconfirmed", (run: CheckRun) => { run.execution!.cleanup = "unconfirmed"; }],
  ["cleanup-unconfirmed", (run: CheckRun) => { run.execution!.outputCleanup = "unconfirmed"; }],
  ["observation-failed", (run: CheckRun) => { run.execution!.failure = { kind: "observer", message: "Cannot save start" }; run.interrupted = true; }],
  ["contradictory-result", (run: CheckRun) => { run.ok = true; }],
] as const)("does not turn %s into a code failure", (reason, change) => {
  const run = completed(7); change(run);
  expect(pair(run)).toEqual(["incomplete", reason]);
  expect(checkProblem({ checks: { at: 1, results: [run] } })).toBe("unverified");
});

it("records a start failure as unavailable, without guessing which setup requirement failed", () => {
  const run: CheckRun = { ...completed(7), execution: { ...completeCheckExecution(7), started: false, exit: { status: "unreported" }, stdout: "incomplete", stderr: "incomplete", failure: { kind: "start", message: "Cannot launch" } } };
  expect(pair(run)).toEqual(["unavailable", "start-failed"]);
  expect(checkOutcomeLabel(checkOutcome(run))).toBe("could not start");
  expect(checkProblem({ checks: { at: 1, results: [run] } })).toBe("unverified");
});

it("keeps diagnostic persistence separate from a complete successful command", () => {
  const run = { ...completed(0), logError: "Cannot write the diagnostic", logComplete: false };
  expect(pair(run)).toEqual(["passed", "complete"]);
  expect(run.logError).toBe("Cannot write the diagnostic");
});

it.each(["started", "exit", "stdout", "stderr", "timedOut", "cancelled", "cleanup", "outputCleanup"] as const)("does not fill in a missing %s observation", field => {
  const run = completed(0); Reflect.deleteProperty(run.execution!, field);
  expect(pair(run)).toEqual(["incomplete", "native-evidence-invalid"]);
});

for (const code of [0, 7]) it.each(["pending", "running", "skipped", "stopped"] as const)(`preserves a %s row ahead of an older exit ${code}`, result => {
  const check: JourneyProductCheck = { name: "Tests", result, run: completed(code) };
  expect(checkEntryResult(check)).toBe(result);
  expect(checkEntryCommandOutcome(check)).toBe(result === "skipped" ? "not-executed" : "unfinished");
  expect(checkCounts([check])).toEqual({ failed: 0, passed: 0, unverified: result === "skipped" ? 0 : 1 });
});

it("keeps mixed real failures and incomplete checks distinct, with failure priority", () => {
  const failed = completed(7), timedOut = { ...completed(7), timedOut: true };
  expect(checkProblem({ checks: { at: 1, results: [failed, timedOut] } })).toBe("failing");
  expect(checkCounts([{ name: "Failed", result: "fail", run: failed }, { name: "Timed out", result: "did-not-finish", run: timedOut }])).toEqual({ failed: 1, passed: 0, unverified: 1 });
});

it("keeps historical row data separate from the absence of execution evidence", () => {
  const check: JourneyProductCheck = { name: "Reported pass", result: "pass", run: { ...completed(0), execution: undefined } };
  expect(checkEntryResult(check)).toBe("stopped");
  expect(check.result).toBe("pass");
  expect(check.run!.ok).toBe(true);
});

for (const field of ["failure", "signal"] as const) it.each([null, false, 0, ""])(`does not accept malformed ${field}=%j as an absent observation`, value => {
  const run = completed(0);
  Reflect.set(field === "signal" ? run.execution!.exit : run.execution!, field, value);
  expect(checkExecutionPassed(run.execution)).toBe(false);
  expect(pair(run)).toEqual(["incomplete", "native-evidence-invalid"]);
  expect(checkProblem({ checks: { at: 1, results: [run] } })).toBe("unverified");
});

for (const field of ["timedOut", "interrupted", "cleanupIncomplete", "exitSignal", "interruption"] as const) it.each([null, 0, ""])(`does not accept malformed outer ${field}=%j as absent execution facts`, value => {
  const run = completed(0); Reflect.set(run, field, value);
  expect(pair(run)).toEqual(["incomplete", "native-evidence-invalid"]);
  expect(checkProblem({ checks: { at: 1, results: [run] } })).toBe("unverified");
});

it.each(["exitSignal", "interruption"] as const)("does not accept false as an absent %s observation", field => {
  const run = completed(0); Reflect.set(run, field, false);
  expect(pair(run)).toEqual(["incomplete", "native-evidence-invalid"]);
});

for (const code of [0, 7]) it.each(["pending", "running", "skipped", "stopped"] as const)(`keeps a saved %s entry ahead of its carried exit ${code}`, result => {
  const run = { ...completed(code), source: { stepId: "checks", attemptId: "run-0", checkId: "c0" } };
  const row: JourneyProductCheck = { id: "c0", attemptId: "run-0", productId: "p", name: "Tests", result, run };
  const task = { journey: [{ id: "checks", kind: "petrina" as const, work: "checks" as const, startedAt: 1, round: 1, sub: 0, productChecks: [row] }] };
  const evidence = evidenceFor(task, { productId: "p", checks: { at: 1, current: true, results: [run] } });
  expect(evidence).toHaveLength(1);
  expect(evidence[0]!.result).toBe(result);
  expect(checkEntryCommandOutcome(evidence[0]!)).toBe(result === "skipped" ? "not-executed" : "unfinished");
  expect(evidence[0]!.run).toEqual(run);
});

it("does not choose a lifecycle from ambiguous source identities or invent missing native evidence", () => {
  const run = { ...completed(0), execution: undefined, source: { stepId: "checks", attemptId: "run-0", checkId: "c0" } };
  const row: JourneyProductCheck = { id: "c0", attemptId: "run-0", productId: "p", name: "Tests", result: "pending", run };
  const task = { journey: [{ id: "checks", kind: "petrina" as const, work: "checks" as const, startedAt: 1, round: 1, sub: 0, productChecks: [row, { ...row, result: "running" as const }] }] };
  const evidence = evidenceFor(task, { productId: "p", checks: { at: 1, results: [run] } });
  expect(evidence).toHaveLength(1);
  expect(evidence[0]!.result).toBe("stopped");
  expect(checkOutcome(evidence[0]!.run)).toMatchObject({ kind: "incomplete", reason: "native-evidence-missing", reportedOk: true });
  expect(evidence[0]!.run!.execution).toBeUndefined();
});
