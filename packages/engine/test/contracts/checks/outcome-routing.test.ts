import { afterAll } from "bun:test";
import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { nonpassingChecks } from "../../fixtures/check-verification.js";
import { expect, it } from "bun:test";
import { checkOutcome, checkProblem, type CheckRun } from "@petrina/core";
import { completeCheckExecution } from "@petrina/test-support/check-execution-facts";
import { checksFingerprint } from "@petrina/repositories/check-discovery";
import { checkContext } from "../../fixtures/check-context.js";
const engineCases = engineCaseFixtures();
afterAll(() => engineCases.close());


const cases = ["legacy-pass", "legacy-failure", "start-failed", "timed-out", "cancelled", "read-failed", "output-incomplete", "exit-unreported", "cleanup-unconfirmed"] as const;

function incomplete(original: CheckRun, kind: typeof cases[number]): CheckRun {
  const run = structuredClone(original);
  if (kind === "legacy-pass" || kind === "legacy-failure") {
    delete run.execution;
    run.ok = kind === "legacy-pass";
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

it.each(["legacy-pass", "start-failed"] as const)("records %s as blocking evidence without a code finding or an automatic rerun", async kind => {
  return engineCases.use("check-outcome-routing-", owner => checkContext(owner, async f => {
  try {
    f.setCheck(kind === "legacy-pass" ? "--sequence=PF" : "--pass");
    expect((await f.check()).kind).toBe("passed");
    const { task, scope } = f;
    const checks = f.engine["checks"];
    const signal = new AbortController().signal;
    const definitions = await checks.ensureChecks(scope, signal);
    const run = incomplete(scope.work.checks!.results[0]!, kind);
    const snapshot = structuredClone(run);
    scope.work.checkReturns = 1;
    const rounds = structuredClone(task.rounds);
    expect(nonpassingChecks(await checks["runPreparedChecks"](scope, definitions, signal, [run]))).toBe(1);
    expect(checkOutcome(scope.work.checks!.results[0]!).kind).toBe(kind === "start-failed" ? "unavailable" : "incomplete");
    expect(scope.work.checks!.results).toEqual([snapshot]);
    expect(checkProblem({ checks: scope.work.checks })).toBe("unverified");
    expect(task.findings).toEqual([]);
    expect(scope.work.checkReturns).toBe(1);
    expect(task.rounds).toEqual(rounds);
    // It still applies to this tree and definition as BLOCKING evidence, never as a pass.
    expect((await checks.current(scope)).inputs.kind).toBe("matches");
    expect((await checks.failing(scope, signal, definitions)).kind).toBe("blocked");
    expect((await checks.failing(scope, signal, definitions)).kind).toBe("blocked");
    expect(scope.work.checks!.results).toEqual([snapshot]);
    expect(scope.work.checkReturns).toBe(1);
    expect(task.findings).toEqual([]);
    expect(f.runs()).toEqual(["passed"]);
    const reuse = task.journey!.flatMap(step => step.reuses ?? []).at(-1)!;
    expect(reuse.passed).toBe(false);
    if (kind === "start-failed") {
      const product = f.engine.s.products.find(product => product.id === f!.productId)!;
      product.checksBy = "finder";
      product.checksFingerprint = checksFingerprint(scope.work.worktree!);
      expect(await checks.ensureChecks(scope, signal)).toEqual(definitions);
    }
    expect(f.agents.received()).toEqual([]);
    if (kind === "legacy-pass") {
      task.plan = { rationale: "Explicit revalidation", plannerProfileId: "sol-high", stages: [{ id: "delivery", title: "Delivery", kind: "gate", gate: "delivery", roleId: "coordinator", profileIds: [] }] };
      task.stageIndex = 0;
      f.engine.gate(task, "delivery");
      const item = f.engine.s.inbox.find(item => item.taskId === task.id && item.kind === "delivery")!;
      expect(() => f!.engine.approve(item.id)).toThrow("unverified");
      f.engine.rerunChecks(item.id);
      expect(scope.work.checkReturns).toBe(1);
      expect(scope.work.approvedSha).toBeUndefined();
      expect(f.engine.s.inbox.some(candidate => candidate.id === item.id)).toBe(false);
      expect((await checks.failing(scope, signal, definitions)).kind).toBe("product-failed");
      expect(f.runs()).toEqual(["passed", "failed"]);
      expect(checkOutcome(scope.work.checks!.results[0]!).kind).toBe("failed");
      expect(scope.work.checkReturns).toBe(1);
      expect(scope.work.approvedSha).toBeUndefined();
    }
  } finally {
    if (f) { await owner.stop(f.engine); }
  }

  }));
});
