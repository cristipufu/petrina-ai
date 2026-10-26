import { expect, it } from "vitest";
import { finishTaskStep, roleForTask } from "@petrina/core";
import { WorkCompletion } from "../../../src/work-completion.js";
import { continuedReviewFixture, important, report, COVERED } from "../../fixtures/continued-review.js";

it("continues an exhausted review through a later passing security review to final testing and a separate delivery decision", async () => {
  const f = continuedReviewFixture(), { task } = f;
  task.findings = [important("accepted")];
  const kept = structuredClone(task.findings[0]!);
  await f.exhaust();
  const decision = structuredClone(task.reviewDecision!);
  expect(decision).toMatchObject({ stageId: "review", round: 1, accepted: true, covers: [kept.id] });
  expect(task.plan!.stages[task.stageIndex]!.id).toBe("security");
  const rounds = structuredClone(task.rounds);
  expect(await f.review(report())).toBe("continue");
  expect(f.step().reason).toBe(COVERED); expect(f.step().tone).toBeUndefined();
  expect(f.notes).toContain("Review passed: 1 earlier important still open under your decision to continue");
  expect(f.notes.filter(words => words.startsWith("Sent back to the builder"))).toHaveLength(0);
  expect(f.notes.filter(words => words.startsWith("Review rounds used up"))).toHaveLength(1);
  expect(task.rounds).toEqual(rounds); expect(task.findings[0]).toEqual(kept);
  expect(task.fixing).not.toBe(true); expect(task.reviewDecision).toEqual(decision);
  expect(await f.acceptance(false, "The greeting appears for guests")).toBeUndefined();
  const completion = new WorkCompletion({ finishStep: bound => finishTaskStep(bound.task, bound.work, f.clock.now()),
    endStage() {}, rerun: () => false, invalidateAcceptance: async () => { throw new Error("A read-only acceptance result cannot supply a new product version"); },
    checkpoint: () => f.host.commitNow(task), changed: () => f.host.changed(task) });
  await completion.complete(f.scope, { stageId: f.stageOf("test").id, canEdit: false });
  expect(task.acceptancePassed).toBe(true);
  expect(task.journey!.filter(step => roleForTask(f.roles, step.roleId ?? "", task)?.result === "checks")).toHaveLength(1);
  expect(task.plan!.stages[task.stageIndex]!.gate).toBe("delivery");
  expect(task.findings[0]).toEqual(kept); expect(task.reviewDecision).toEqual(decision);
  expect(f.scope.work.approvedSha).toBeUndefined(); expect(f.scope.work.landed).toBeUndefined();
  // Actual API revisions, independent native review input, restart and Git/main publication remain in the paired journey.
});
