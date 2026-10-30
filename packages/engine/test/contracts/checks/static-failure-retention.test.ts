import { afterAll, expect, it } from "bun:test";
import { decisionEvidence, type Task } from "@petrina/core";
import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { checkContext } from "../../fixtures/check-context.js";
import { itemOf, taskOf } from "../../support.js";

const cases = engineCaseFixtures();
afterAll(() => cases.close());
const checkSteps = (task: Task) => task.journey!.filter(step => step.kind === "petrina" && step.work === "checks");

// Check execution, skipped-command evidence, applicability, SQLite restart and explicit rerun are
// native here. Automatic unchanged Builder returns and participant admission have portable owners.
it("keeps an early static failure current across verification and restart, with heavy checks visibly skipped", () => cases.use("static-check-evidence-", owner => checkContext(owner, async f => {
  f.task.plan!.stages.push(
    { id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high"] },
    { id: "delivery", kind: "gate", title: "Delivery", gate: "delivery", roleId: "coordinator", profileIds: [] },
  );
  f.task.stageIndex = 1;
  f.engine.setProductChecks(f.productId, [{ name: "Tests", command: f.command("--pass") }, { name: "Type check", command: f.command() }]);
  await f.check(); owner.check();
  expect(f.runs()).toEqual(["failed"]);
  const task = taskOf(f.engine.getState(), f.taskId), step = checkSteps(task)[0]!;
  expect(step.productChecks!.map(check => [check.name, check.result])).toEqual([["Tests", "skipped"], ["Type check", "fail"]]);
  await f.check(); owner.check();
  expect(f.runs()).toEqual(["failed"]);
  f.engine["checks"].blocked(f.task);
  await f.restart(); owner.check();
  expect((await owner.run(f.engine, () => f.engine["checks"].current(f.scope))).inputs.kind).toBe("matches");
  expect(f.runs()).toEqual(["failed"]);
  f.engine.rerunChecks(itemOf(f.engine.getState(), f.taskId, "delivery")!.id);
  await f.check(); owner.check();
  f.engine["checks"].blocked(f.task);
  const rerun = taskOf(f.engine.getState(), f.taskId), evidence = decisionEvidence(rerun);
  expect(f.runs()).toEqual(["failed", "failed"]);
  expect(evidence.map(check => [check.name, check.result, check.reusedAt])).toEqual([["Type check", "fail", undefined], ["Tests", "skipped", undefined]]);
  expect(evidence[1]!.source?.stepId).toBe(checkSteps(rerun).at(-1)!.id);
  expect(itemOf(f.engine.getState(), f.taskId, "delivery")!.body).not.toContain("no new execution");
})));
