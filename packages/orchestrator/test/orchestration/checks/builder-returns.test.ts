import { expect, it } from "vitest";
import { journeyProblems } from "@petrina/core";
import { taskView } from "../../../src/repository-context.js";
import { checkReturnWorkflow } from "../../fixtures/check-return-workflow.js";

it("keeps a check open when the Builder blames the environment, without admitting a reviewer", async () => {
  const claim = "Nothing to fix: the check failed because the Mac went to sleep.";
  const f = await checkReturnWorkflow("review", { fixed: false, text: claim });
  try {
    const task = await f.run();
    expect(f.evidence.executions()).toBe(0);
    expect(task.journey!.filter(step => step.work === "checks")).toHaveLength(1);
    expect(f.scope.work.checkReturns).toBe(2);
    expect(task.findings[0]).toMatchObject({ status: "open", answer: { fixed: false, text: claim } });
    expect(f.dispatches).toEqual(["builder", "builder"]);
    const repairs = task.journey!.flatMap(step => step.checkRepairs ?? []);
    expect(repairs).toHaveLength(2);
    expect(repairs.every(repair => repair.failureNode === f.checks.provenance!.nodeId && repair.attemptId === f.checks.provenance!.attemptId)).toBe(true);
    expect(repairs.map(repair => repair.answer)).toEqual([{ fixed: false, text: claim }, { fixed: false, text: claim }]);
    expect(task.journey!.filter(step => step.fixing && step.roleId === "builder").map(step => step.outcome)).toEqual([
      "No code changes; checks still failing", "No code changes; checks still failing",
    ]);
    expect(f.state.inbox.filter(item => item.taskId === task.id).map(item => item.kind)).toEqual(["delivery"]);
    expect(task.rounds).toEqual({});
    expect(f.scope.work.checks!.results).toEqual(f.checks.results);
    expect(f.preflightCalls).toEqual(["prepare-review", "verify", "prepare-review", "verify", "prepare-review", "verify"]);
  } finally { await f.close(); }
});

it("spends no acceptance or review turn on unchanged failing code before asking the coordinator", async () => {
  const f = await checkReturnWorkflow("acceptance", { fixed: true, text: "Fixed it." });
  try {
    const task = await f.run();
    expect(f.evidence.executions()).toBe(0);
    expect(task.journey!.filter(step => step.work === "checks")).toHaveLength(1);
    expect(f.dispatches).toEqual(["builder", "builder"]);
    expect(task.journey!.some(step => step.roleId === "tester")).toBe(false);
    expect(journeyProblems(taskView(task))).toEqual([]);
    expect(f.scope.work.checkReturns).toBe(2);
    expect(task.findings.some(finding => finding.text.startsWith("Check failed") && finding.status === "open")).toBe(true);
    expect(task.plan!.stages[task.stageIndex]!.roleId).toBe("tester");
    expect(f.state.inbox.filter(item => item.taskId === task.id).map(item => item.kind)).toEqual(["delivery"]);
    expect(f.preflightCalls).toEqual(["source", "definitions", "verify", "source", "definitions", "verify", "source", "definitions", "verify"]);
  } finally { await f.close(); }
});
