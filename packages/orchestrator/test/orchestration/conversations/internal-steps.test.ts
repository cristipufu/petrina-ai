import { expect, it } from "vitest";
import { beginInternalStep } from "../../../src/side-step.js";
import { executionFor } from "../../../src/repository-context.js";
import { repositoryTask } from "../../fixtures/tasks.js";

for (const roleId of ["check-finder", "guide-keeper"]) it(`snapshots the main participant once and restores it after ${roleId}`, () => {
  const task = repositoryTask(false), scope = executionFor(task);
  const main = { step: "build", roleId: "builder", profileId: "opus-high", toolId: "claude-code", model: "opus", sessionId: "main", startedAt: 1, briefed: true };
  scope.work.conversation = main;
  scope.work.stepAttempts = 0; task.todo = "";
  task.stepClock = { roleId: "builder", repeat: true, worked: 20, since: 30 };
  const checkpoints: unknown[] = [];
  const host = { checkpoint(current: typeof task) { checkpoints.push(structuredClone(current)); } };
  const restore = beginInternalStep(host, scope, roleId);
  expect(scope.work.conversation).toBeUndefined();
  expect(scope.work.sideStep).toMatchObject({ roleId, conversation: main, stepAttempts: 0, todo: "", stepClock: task.stepClock });
  main.sessionId = "changed outside the snapshot";
  scope.work.conversation = { ...main, roleId, sessionId: "internal" };
  scope.work.stepAttempts = 5; task.todo = "Internal work";
  task.stepClock = { roleId, repeat: false, worked: 8 };
  beginInternalStep(host, scope, roleId);
  expect(checkpoints).toHaveLength(1);
  restore();
  expect(scope.work.conversation?.sessionId).toBe("main");
  expect(scope.work.stepAttempts).toBe(0); expect(task.todo).toBe("");
  expect(task.stepClock).toEqual({ roleId: "builder", repeat: true, worked: 20, since: 30 });
  expect(scope.work.sideStep).toBeUndefined();
  restore();
  expect(scope.work.conversation?.sessionId).toBe("main");
  expect(checkpoints).toHaveLength(1);
});

it("removes fields that the main step did not have, leaving a different repository untouched", () => {
  const task = repositoryTask(true), scope = executionFor(task, "a"), other = executionFor(task, "b").work;
  const restore = beginInternalStep({ checkpoint() {} }, scope, "check-finder");
  other.stepAttempts = 9;
  scope.work.stepAttempts = 1; task.todo = "Internal";
  task.stepClock = { roleId: "check-finder", repeat: false, worked: 1 };
  restore();
  expect(scope.work).not.toHaveProperty("conversation");
  expect(scope.work).not.toHaveProperty("stepAttempts");
  expect(task).not.toHaveProperty("todo"); expect(task).not.toHaveProperty("stepClock");
  expect(other.stepAttempts).toBe(9);
});

it("refuses a different unfinished internal role before mutating or checkpointing", () => {
  const task = repositoryTask(false), scope = executionFor(task);
  let saves = 0;
  const host = { checkpoint() { saves++; } };
  beginInternalStep(host, scope, "check-finder");
  const before = structuredClone(task);
  expect(() => beginInternalStep(host, scope, "guide-keeper")).toThrow("Another internal step is still unfinished.");
  expect(task).toEqual(before); expect(saves).toBe(1);
});

it("preserves a method-backed checkpoint receiver and propagates its failure", () => {
  const task = repositoryTask(false), scope = executionFor(task), failure = new Error("Checkpoint failed");
  const host = { calls: 0, checkpoint(current: typeof task) { this.calls++; expect(current).toBe(task); throw failure; } };
  expect(() => beginInternalStep(host, scope, "check-finder")).toThrow(failure);
  expect(host.calls).toBe(1); expect(scope.work.sideStep?.roleId).toBe("check-finder");
});
