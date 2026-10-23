import { describe, expect, it } from "vitest";
import type { NewTaskInput } from "../src/commands.js";
import type { Product, Task } from "../src/model.js";
import { DEFAULT_PROFILES } from "../src/library.js";
import { startClock } from "../src/summary.js";
import { assignFutureProfile, appendFutureReviewer, blockingDependencies, cancelTaskState, combineBacklogTasks, createTaskState, finishTaskStep, pauseTaskState, queueBacklogTask, resumeTaskState, returnQueuedTaskToBacklog, validateTaskDependencies } from "../src/task-transitions.js";

const products: Product[] = [
  { id: "a", name: "Shop", repo: "local/shop", tone: "blue", delivery: "local", approveDelivery: false },
  { id: "b", name: "Notes", repo: "local/notes", tone: "green", delivery: "pull-request", approveDelivery: true },
];
function request(input: Partial<NewTaskInput> = {}, id = "task") {
  return createTaskState({ productId: "a", title: "  Tidy the footer  ", ...input }, products, { id, timelineId: `${id}-added`, now: 100, priority: 4 });
}

describe("shared task request and queue rules", () => {
  it("retains independent source choices and applies approval defaults across the complete scope", () => {
    const choices: NonNullable<NewTaskInput["worksOn"]>[number][] = products.map(({ id, delivery }) => ({ productId: id, delivery: delivery!, startFrom: { kind: "default" } }));
    const task = request({ worksOn: choices, approvePlan: false });
    expect(task.title).toBe("Tidy the footer");
    expect(task.approvePlan).toBe(true);
    expect(task.approveDelivery).toBe(true);
    expect(task.explicitStart).toBe(true);
    choices[0]!.startFrom = { kind: "branch", name: "other" };
    task.selectedProducts![0]!.startFrom.kind = "default";
    expect(task.workChoice?.startFrom).toEqual({ kind: "default" });
    expect(request().approveDelivery).toBe(false);
    expect(request({ productId: "", approvePlan: false }).approvePlan).toBe(false);
    expect(request({ productId: "" }).approvePlan).toBe(true);
    expect(request({ worksOn: [], productId: "" }).selectedProducts).toEqual([]);
  });

  it("rejects invalid complete requests before producing a task", () => {
    expect(() => request({ title: "  " })).toThrow("title");
    expect(() => request({ productId: "missing" })).toThrow("registered products");
    const choice = { productId: "a", startFrom: { kind: "default" as const }, delivery: "local" as const };
    expect(() => request({ worksOn: [choice, choice] })).toThrow("once");
  });

  it("only moves untouched requests back and keeps combined request provenance", () => {
    const source = request({ backlog: true }, "source");
    const other = request({ backlog: true }, "other");
    const combined = request({ backlog: true }, "combined");
    expect(queueBacklogTask(source, 2)).toBe(true);
    source.startedAt = 101;
    expect(returnQueuedTaskToBacklog(source)).toBe(false);
    delete source.startedAt;
    expect(returnQueuedTaskToBacklog(source)).toBe(true);
    combineBacklogTasks(combined, [source, other], 200, 8);
    expect(combined.state).toBe("queued");
    expect(combined.priority).toBe(8);
    expect(combined.combinedFrom?.map(({ id }) => id)).toEqual(["source", "other"]);
    expect([source, other].map(({ state, combinedInto, holdsSlot }) => [state, combinedInto, holdsSlot])).toEqual([["cancelled", "combined", false], ["cancelled", "combined", false]]);
    expect(source.finishedAt).toBe(200);
  });
});

describe("shared dependency and future plan rules", () => {
  it("checks lazy dependency chains without changing existing dependencies on rejection", () => {
    const a = request({}, "a"), b = request({}, "b"), c = request({}, "c");
    b.after = ["c"]; c.after = ["a"];
    const records = new Map([a, b, c].map((task) => [task.id, task]));
    expect(() => validateTaskDependencies("a", ["b"], (id) => records.get(id))).toThrow("each other");
    expect(a.after).toBeUndefined();
    expect(() => validateTaskDependencies("a", ["missing"], (id) => records.get(id))).toThrow("Unknown task");
    expect(() => validateTaskDependencies("a", ["a"], (id) => records.get(id))).toThrow("itself");
    expect(validateTaskDependencies("c", ["a", "a"], (id) => records.get(id))).toEqual(["a"]);
  });

  it("keeps a delivered shared pull request blocking until its landing is settled", () => {
    const dependency = request({}, "dependency");
    dependency.state = "done";
    dependency.repositories = [{ productId: "a", delivery: "pull-request", completedStages: [], pr: { number: 1, url: "https://example.test/1", state: "open", openedAt: 100 } }];
    const task = request(); task.after = [dependency.id];
    expect(blockingDependencies(task, () => dependency)).toEqual([dependency]);
    dependency.repositories![0]!.pr!.state = "merged";
    expect(blockingDependencies(task, () => dependency)).toEqual([]);
    dependency.repositories![0]!.pr!.state = "closed";
    expect(blockingDependencies(task, () => dependency)).toHaveLength(1);
    dependency.repositories![0]!.landingAccepted = { at: 200 };
    expect(blockingDependencies(task, () => dependency)).toEqual([]);
  });

  it("preserves partially specified reviewer roles and refuses to change current or past work", () => {
    const task = request();
    task.stageIndex = 0;
    task.plan = { rationale: "A focused review", plannerProfileId: "sonnet-medium", stages: [
      { id: "build", kind: "do", roleId: "builder", title: "Build", profileIds: ["sol-high"] },
      { id: "review", kind: "review-chain", roleId: "code-reviewer", title: "Review", profileIds: ["sol-high", "opus-high"], roleIds: ["security-reviewer"], maxRounds: 2 },
    ] };
    expect(assignFutureProfile(task, DEFAULT_PROFILES, "build", "profileIds", 0, "opus-high")).toBeUndefined();
    expect(appendFutureReviewer(task, DEFAULT_PROFILES, "review", "sol-xhigh")).toBe("Review");
    expect(task.plan!.stages[1]!.roleIds).toEqual(["security-reviewer", "code-reviewer", "code-reviewer"]);
    expect(assignFutureProfile(task, DEFAULT_PROFILES, "review", "profileIds", 0, "missing")).toBeUndefined();
    expect(assignFutureProfile(task, DEFAULT_PROFILES, "review", "profileIds", 1, "sol-xhigh")).toBe("Review");
    expect(task.plan!.stages[1]!.profileIds).toEqual(["sol-high", "sol-xhigh", "sol-xhigh"]);
    expect(task.plan!.stages[1]!.assignments?.[1]).toEqual({ profileId: "sol-xhigh", by: "coordinator", reason: "Chosen by you." });
    expect(task.plan!.stages[1]!.assignments?.[2]).toEqual({ profileId: "sol-xhigh", by: "coordinator", reason: "Added to the review by you." });
  });
});

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
