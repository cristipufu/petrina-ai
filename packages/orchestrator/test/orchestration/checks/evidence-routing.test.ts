import { expect, it } from "vitest";
import { checkInputApplicability, checkOutcome, checkProblem, type CheckRun } from "@petrina/core";
import { completeCheckExecution } from "@petrina/test-support/check-execution-facts";
import { checkEvidence } from "../../fixtures/check-evidence.js";

const cases = ["legacy-failure", "start-failed", "timed-out", "cancelled", "read-failed", "output-incomplete", "exit-unreported", "cleanup-unconfirmed"] as const;

function incomplete(original: CheckRun, kind: typeof cases[number]): CheckRun {
  const run = structuredClone(original);
  if (kind === "legacy-failure") {
    delete run.execution;
    run.ok = false;
  } else {
    run.ok = false;
    run.execution = completeCheckExecution(7);
    if (kind === "start-failed") {
      run.output = "Could not start: configured command unavailable";
      run.execution = { ...completeCheckExecution(7), started: false, exit: { status: "unreported" }, stdout: "incomplete", stderr: "incomplete", failure: { kind: "start", message: "Cannot launch" } };
    } else if (kind === "timed-out") run.execution.timedOut = run.timedOut = true;
    else if (kind === "cancelled") run.execution.cancelled = run.interrupted = true;
    else if (kind === "read-failed") {
      run.execution.stdout = "read-error";
      run.execution.failure = { kind: "read", message: "Pipe failed" };
    } else if (kind === "output-incomplete") run.execution.stderr = "incomplete";
    else if (kind === "exit-unreported") run.execution.exit = { status: "unreported" };
    else run.execution.cleanup = "unconfirmed";
  }
  return run;
}


it.each([...cases])("records %s as blocking evidence without a code finding or an automatic rerun", async kind => {
  const f = await checkEvidence(), { scope, task } = f;
  expect((await f.verify()).kind).toBe("passed");
  const run = incomplete(scope.work.checks!.results[0]!, kind);
  scope.work.checkReturns = 1;
  const rounds = structuredClone(task.rounds);
  const snapshot = structuredClone(run);
  expect((await f.record([run])).kind).toBe("blocked");
  expect(checkOutcome(scope.work.checks!.results[0]!).kind).toBe(kind === "start-failed" ? "unavailable" : "incomplete");
  expect(scope.work.checks!.results).toEqual([snapshot]);
  expect(checkProblem({ checks: scope.work.checks })).toBe("unverified");
  expect(task.findings).toEqual([]);
  expect(scope.work.checkReturns).toBe(1);
  expect(task.rounds).toEqual(rounds);
  expect(checkInputApplicability(scope.work.checks, f.state).kind).toBe("matches");
  expect((await f.verify()).kind).toBe("blocked");
  expect((await f.verify()).kind).toBe("blocked");
  expect(scope.work.checks!.results).toEqual([snapshot]);
  expect(scope.work.checkReturns).toBe(1);
  expect(task.findings).toEqual([]);
  expect(f.executions()).toBe(1);
  const reuse = task.journey!.flatMap(step => step.reuses ?? []).at(-1)!;
  expect(reuse.passed).toBe(false);
});

it("keeps a real completed code failure beside an incomplete check and never changes the repair allowance while recording", async () => {
  const f = await checkEvidence();
  f.declaration.commands.push("build-product");
  expect((await f.verify()).kind).toBe("passed");
  const [first, second] = f.scope.work.checks!.results;
  const failed: CheckRun = { ...first!, ok: false, execution: completeCheckExecution(7), output: "Actual assertion failure" };
  const unavailable = incomplete(second!, "start-failed");
  f.scope.work.checkReturns = 1;
  const result = await f.record([failed, unavailable]);
  expect(result.results.filter(run => checkOutcome(run).kind !== "passed")).toHaveLength(2);
  expect(checkProblem({ checks: f.scope.work.checks })).toBe("failing");
  expect(f.task.findings.map(finding => finding.text)).toEqual([`Check failed: ${failed.name} (${failed.command})`]);
  expect(f.scope.work.checkReturns).toBe(1);
  expect(f.task.journey!.at(-1)!.outcome).toBe("Checks: 1 still failing, 1 unverified");
  expect(f.executions()).toBe(1);
});
