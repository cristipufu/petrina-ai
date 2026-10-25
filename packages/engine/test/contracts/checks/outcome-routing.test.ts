import { expect, it } from "bun:test";
import { checkOutcome, checkProblem, type CheckRun } from "@petrina/core";
import { completeCheckExecution } from "@petrina/test-support/check-execution-facts";
import { checksFingerprint } from "@petrina/repositories/check-discovery";
import { checkContext } from "../../fixtures/check-context.js";
import { removeDir, tempDir } from "../../fixtures.js";

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

it.each([...cases])("records %s as blocking evidence without a code finding or an automatic rerun", async kind => {
  const root = tempDir("check-outcome-routing-");
  let f: Awaited<ReturnType<typeof checkContext>> | undefined;
  let stopped = false;
  try {
    f = await checkContext(root);
    f.setCheck(kind === "legacy-pass" ? "--sequence=PF" : "--pass");
    expect(await f.check()).toBe(false);
    const { task, scope } = f;
    const checks = f.engine["checks"];
    const signal = new AbortController().signal;
    const definitions = await checks.ensureChecks(scope, signal);
    const run = incomplete(scope.work.checks!.results[0]!, kind);
    const snapshot = structuredClone(run);
    scope.work.checkReturns = 1;
    const rounds = structuredClone(task.rounds);
    expect(await checks["runPreparedChecks"](scope, definitions, signal, [run])).toBe(1);
    expect(checkOutcome(scope.work.checks!.results[0]!).kind).toBe(kind === "start-failed" ? "unavailable" : "incomplete");
    expect(scope.work.checks!.results).toEqual([snapshot]);
    expect(checkProblem({ checks: scope.work.checks })).toBe("unverified");
    expect(task.findings).toEqual([]);
    expect(scope.work.checkReturns).toBe(1);
    expect(task.rounds).toEqual(rounds);
    // It still applies to this tree and definition as BLOCKING evidence, never as a pass.
    expect(await checks.current(scope)).toBe(true);
    expect(await checks.failing(scope, signal, definitions)).toBe(true);
    expect(await checks.failing(scope, signal, definitions)).toBe(true);
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
      expect(await checks.failing(scope, signal, definitions)).toBe(true);
      expect(f.runs()).toEqual(["passed", "failed"]);
      expect(checkOutcome(scope.work.checks!.results[0]!).kind).toBe("failed");
      expect(scope.work.checkReturns).toBe(1);
      expect(scope.work.approvedSha).toBeUndefined();
    }
  } finally {
    if (f) { await f.engine.shutdown(); stopped = true; }
    // If setup never handed ownership back, retain the folder rather than assume its cleanup was confirmed.
    if (stopped) removeDir(root);
  }
});

it("keeps a real completed code failure beside an incomplete check and never changes the repair allowance while recording", async () => {
  const root = tempDir("check-outcome-mixed-");
  let f: Awaited<ReturnType<typeof checkContext>> | undefined;
  let stopped = false;
  try {
    f = await checkContext(root);
    f.engine.setProductChecks(f.productId, [
      { name: "Welcome", command: f.command("--pass") },
      { name: "Build", command: f.command("--pass", "--build") },
    ]);
    const checks = f.engine["checks"], signal = new AbortController().signal;
    const definitions = await checks.ensureChecks(f.scope, signal);
    expect(await checks.failing(f.scope, signal, definitions)).toBe(false);
    const [first, second] = f.scope.work.checks!.results;
    const failed: CheckRun = { ...first!, ok: false, execution: completeCheckExecution(7), output: "Actual assertion failure" };
    const unavailable = incomplete(second!, "start-failed");
    f.scope.work.checkReturns = 1;
    expect(await checks["runPreparedChecks"](f.scope, definitions, signal, [failed, unavailable])).toBe(2);
    expect(checkProblem({ checks: f.scope.work.checks })).toBe("failing");
    expect(f.task.findings.map(finding => finding.text)).toEqual([`Check failed: ${failed.name} (${failed.command})`]);
    expect(f.scope.work.checkReturns).toBe(1);
    expect(f.task.journey!.at(-1)!.outcome).toBe("Checks: 1 still failing, 1 unverified");
    expect(f.runs()).toEqual(["passed", "passed"]);
  } finally {
    if (f) { await f.engine.shutdown(); stopped = true; }
    if (stopped) removeDir(root);
  }
});
