import { expect, it } from "vitest";
import { recordedCheckBatch, type CheckSetupAttempt, type DeepMutable } from "@petrina/core";
import { ReviewWorkflow } from "../../../src/review-workflow.js";
import { checkEvidence } from "../../fixtures/check-evidence.js";
import { compiler, fixture as checkSetup, reply } from "../../fixtures/check-setup.js";
import { repairTask } from "../../fixtures/tasks.js";

for (const peer of ["legacy-unobserved", "process-uncertain", "output-uncertain", "setup-uncertain"] as const)
it(`keeps shared review's ownership barrier precise for ${peer}`, async () => {
  const task = repairTask(true);
  task.plan!.stages.splice(1, 1); task.stageIndex = 1; task.state = "running";
  task.leadProductId = task.activeProductId = "a";
  let now = 200;
  const first = await checkEvidence(task, () => ++now, "a"), second = await checkEvidence(task, () => ++now, "b");
  expect((await first.record([first.run(7)])).kind).toBe("product-failed");
  expect((await second.record([second.run(7)])).kind).toBe("product-failed");
  second.scope.work.checkReturns = 1;
  if (peer === "setup-uncertain") {
    const setup = checkSetup([compiler]);
    setup.request.productId = "b";
    setup.request.input = { ...second.state };
    setup.host.execute = async requirement => {
      const observation = reply(requirement, 9);
      if (observation.kind !== "recorded") throw new Error("Expected a recorded scripted setup observation");
      observation.run.execution!.outputCleanup = "unconfirmed";
      return observation;
    };
    second.scope.work.checkSetup = structuredClone(await setup.run()) as DeepMutable<CheckSetupAttempt>;
  } else if (peer === "legacy-unobserved") {
    delete second.scope.work.checks!.results[0]!.execution;
    delete second.scope.work.checks!.results[0]!.cleanupIncomplete;
  } else second.scope.work.checks!.results[0]!.execution![peer === "process-uncertain" ? "cleanup" : "outputCleanup"] = "unconfirmed";
  const preserved = structuredClone(second.scope.work.checks!.results), setup = structuredClone(second.scope.work.checkSetup);
  const rounds = structuredClone(task.rounds), calls: string[] = [], eligible: string[][] = [];
  const unexpected = (effect: string): never => { throw new Error(`Unexpected shared ownership effect: ${effect}`); };
  const owned = (scope: typeof first.scope) => {
    if (scope.task !== task) return unexpected("foreign task");
    const found = scope.work === first.scope.work ? first : scope.work === second.scope.work ? second : undefined;
    return found ?? unexpected("foreign product");
  };
  const review = new ReviewWorkflow({
    now: () => ++now, id: () => unexpected("review identity"), checkpoint: () => unexpected("review checkpoint"),
    changed: () => unexpected("review admission"), finishStep: () => unexpected("review completion"),
    clearStep: () => unexpected("review completion"), rerun: () => unexpected("review rerun"),
  }, {
    async prepareChecks(scope) { owned(scope); calls.push(`prepare:${scope.work.productId}`); return true; },
    async checks(scope) { calls.push(`verify:${scope.work.productId}`); return owned(scope).verify(); },
    preparationChanged: () => false,
    backToBuilder(scope, products) { owned(scope); eligible.push([...products]); return first.repairs.backToBuilder(scope, "before review", products); },
    blocked(current) { if (current !== task) unexpected("foreign blocked task"); calls.push("blocked"); return "stop"; },
    versions: async () => unexpected("review versions"), input: async () => unexpected("review input"),
    pendingReviewers: () => unexpected("reviewer admission"), hunt: async () => unexpected("reviewer execution"),
    pendingVote: () => unexpected("voter admission"), vote: async () => unexpected("voter execution"),
    finishBallot: () => unexpected("ballot"), closeRound: async () => unexpected("review round"),
  });
  const result = await review.run(task, task.plan!.stages[1]!, new AbortController().signal);
  expect(eligible).toEqual([["a"]]);
  expect(first.executions()).toBe(0); expect(second.executions()).toBe(0);
  expect(task.rounds).toEqual(rounds);
  expect(second.scope.work.checkReturns).toBe(1);
  expect(second.scope.work.checks!.results).toEqual(preserved);
  if (peer === "legacy-unobserved") {
    expect(result).toBe("continue");
    expect(task.repair!.products).toEqual(["a"]);
    expect(first.scope.work.checkReturns).toBe(1);
    expect(recordedCheckBatch(second.scope.work).kind).toBe("blocked");
    expect(second.scope.work.checks!.results[0]!.execution).toBeUndefined();
    expect(calls).toEqual(["prepare:a", "verify:a", "prepare:b", "verify:b"]);
  } else {
    expect(result).toBe("stop");
    expect(task.repair).toBeUndefined();
    expect(task.stageIndex).toBe(1); expect(task.fixing).not.toBe(true);
    expect(first.scope.work.checkReturns).toBeUndefined();
    if (peer === "setup-uncertain") expect(second.scope.work.checkSetup).toEqual(setup);
    expect(calls).toEqual(["prepare:a", "verify:a", "prepare:b", "verify:b", "blocked"]);
  }
});
