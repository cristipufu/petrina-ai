import { describe, expect, it } from "vitest";
import type { Task } from "../../../src/model.js";
import { startClock } from "../../../src/summary.js";
import { cancelTaskState, finishTaskStep, pauseTaskState, resumeTaskState } from "../../../src/task-transitions.js";
import { request } from "../../fixtures/task-request.js";

describe("shared step lifetime rules", () => {
  it("releases paused agent seats and clears stale activity while preserving the request and queued instructions", () => {
    const task = request();
    task.state = "running"; task.holdsSlot = true;
    task.agent = { roleId: "builder", profileId: "sol-high", since: 100, step: 0 };
    task.helpers = [{ roleId: "code-reviewer", profileId: "opus-high", since: 100, step: 0 }];
    task.todo = "Fixing the footer"; task.stepClock = startClock(task, "builder", 100);
    task.toolActivity = { actionCount: 1, lastActivity: "Running a command", runningTool: { id: "call", description: "Running a command", startedAt: 100 } };
    task.journey = [{ id: "tools", kind: "agent", startedAt: 100, round: 1, sub: 0, toolActivity: { builder: task.toolActivity }, toolInvocations: [{ id: "call", turnId: "turn", toolCallId: "call", seat: "builder", roleId: "builder", profileId: "sol-high", productId: "a", description: "Running a command", kind: "execute", startedAt: 100, updatedAt: 100 }] }];
    task.queued = [{ id: "message", text: "Check narrow screens", at: 150 }];
    const execution = { editAttempt: { step: "build", failed: true }, conversation: { step: "build", roleId: "builder", startedAt: 100, sessionId: "session", profileId: "sol-high", toolId: "codex", model: "sol" } };
    expect(pauseTaskState(task, execution, 200)).toBe(true);
    expect(task.holdsSlot).toBe(false);
    expect(task.agent).toBeUndefined(); expect(task.helpers).toBeUndefined(); expect(task.todo).toBeUndefined();
    expect(execution.conversation).toBeUndefined();
    expect(execution.editAttempt).toEqual({ step: "build", failed: true });
    expect(task.toolActivity).toBeUndefined();
    expect(task.journey[0]!.toolActivity!.builder!.runningTool).toBeUndefined();
    expect(task.journey[0]!.toolInvocations![0]!.status).toBeUndefined();
    expect(task.journey[0]!.toolInvocations![0]!.endedAt).toBeUndefined();
    expect(task.queued[0]?.text).toBe("Check narrow screens");
    expect(task.title).toBe("Tidy the footer");
    expect(resumeTaskState(task, true)).toBe(true);
    expect(task.state).toBe("needs-you");
    cancelTaskState(task, execution, 300);
    expect(task.finishedAt).toBe(300);
    expect(task.state).toBe("cancelled");
    expect(execution.editAttempt).toBeUndefined();
  });

  it("records one completed step but never learns durations from a restarted step", () => {
    const task = request();
    const execution = { stepAttempts: 1, editAttempt: { step: "build" } };
    task.stepClock = startClock(task, "builder", 100);
    finishTaskStep(task, execution, 1100);
    expect(task.steps).toHaveLength(1);
    expect(task.stepClock).toBeUndefined();
    expect(execution.editAttempt).toBeUndefined();
    task.stepClock = startClock(task, "builder", 1200); execution.stepAttempts = 2;
    finishTaskStep(task, execution, 9000);
    expect(task.steps).toHaveLength(1);
    expect(execution.stepAttempts).toBeUndefined();
    expect("prAge" in (task as Task)).toBe(false);
  });
});
