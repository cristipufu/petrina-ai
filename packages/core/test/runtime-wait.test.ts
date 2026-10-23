import { describe, expect, it } from "vitest";
import type { DeepMutable } from "../src/flow.js";
import { historyItem } from "../src/history.js";
import type { ShippingRecord, State, Task, TaskState } from "../src/model.js";
import { changeRuntimeWait, runtimePrerequisite, runtimeWaitHolds, runtimeWaitView, runtimeWaitWords, syncRuntimeWait, validateRuntimeWait } from "../src/runtime-wait.js";
import { cancelTaskState, createTaskState, validateTaskDependencies } from "../src/task-transitions.js";
import { startsNextCount } from "../src/scheduler.js";

function task(id: string): DeepMutable<TaskState> {
  const result = createTaskState({ productId: "", title: `Task ${id}` }, [], { id, now: 10, priority: 0, timelineId: `added-${id}` });
  result.startedAt = 20; result.state = "waiting";
  return result;
}
const pr = (state: "open" | "merged" | "closed") => ({ number: 1, url: "https://example.test/1", openedAt: 20, state });

describe("explicit runtime prerequisites", () => {
  it("validates the complete list and reason before any record changes", () => {
    const a = task("a"), b = task("b");
    const records = new Map([a, b].map(value => [value.id, value]));
    const find = (id: string) => records.get(id);
    expect(validateRuntimeWait(a, ["b", "b"], "  Needed fix  ", find)).toEqual({ after: ["b"], reason: "Needed fix" });
    expect(() => validateRuntimeWait(a, ["a"], "Fix", find)).toThrow("itself");
    expect(() => validateRuntimeWait(a, ["missing"], "Fix", find)).toThrow("Unknown task");
    expect(() => validateRuntimeWait(a, ["b"], " ", find)).toThrow("reason");
    expect(() => validateRuntimeWait(a, ["b"], "x".repeat(1001), find)).toThrow("1,000");
    expect(() => validateRuntimeWait(a, Array.from({ length: 21 }, (_, i) => `task-${i}`), "Fix", find)).toThrow("20");
    delete a.startedAt;
    expect(() => validateRuntimeWait(a, ["b"], "Fix", find)).toThrow("Start after");
    a.startedAt = 20;
    for (const state of ["done", "cancelled", "pr-open"] as const) {
      a.state = state;
      expect(() => validateRuntimeWait(a, ["b"], "Fix", find)).toThrow("finished");
    }
    a.state = "waiting";
    for (const state of ["done", "cancelled"] as const) {
      b.state = state;
      expect(() => validateRuntimeWait(a, ["b"], "Fix", find)).toThrow("already finished");
    }
    expect(a.runtimeWait).toBeUndefined();
  });

  it("rejects loops across static and runtime edges without changing static release rules", () => {
    const a = task("a"), b = task("b"), c = task("c");
    const records = new Map([a, b, c].map(value => [value.id, value]));
    const find = (id: string) => records.get(id);
    b.after = ["c"];
    changeRuntimeWait(c, { after: ["a"], reason: "Fix" }, 30);
    expect(() => validateRuntimeWait(a, ["b"], "Fix", find)).toThrow("each other");
    expect(() => validateTaskDependencies("a", ["b"], find)).toThrow("each other");
    c.state = "cancelled";
    expect(validateTaskDependencies("a", ["b"], find)).toEqual(["b"]);
    c.state = "waiting";
    c.runtimeWait!.releasedAt = 40;
    expect(validateTaskDependencies("a", ["b"], find)).toEqual(["b"]);
    expect(a.after).toBeUndefined();
  });

  it("ignores ended tasks' historical prerequisites while rejecting an active combined loop", () => {
    const a = task("a"), b = task("b"), c = task("c");
    const records = new Map([a, b, c].map(value => [value.id, value]));
    const find = (id: string) => records.get(id);
    b.after = [c.id]; c.after = [a.id];
    delete c.startedAt; c.state = "queued";
    expect(() => validateRuntimeWait(a, [b.id], "Required fix", find)).toThrow("each other");
    expect(() => validateTaskDependencies(a.id, [b.id], find)).toThrow("each other");
    for (const state of ["cancelled", "done"] as const) {
      c.state = state;
      expect(validateRuntimeWait(a, [b.id], "Required fix", find)).toEqual({ after: [b.id], reason: "Required fix" });
      expect(validateTaskDependencies(a.id, [b.id], find)).toEqual([b.id]);
      expect(c.after).toEqual([a.id]);
    }
    c.state = "waiting"; c.after = [];
    changeRuntimeWait(c, { after: [a.id], reason: "Other fix" }, 30);
    expect(() => validateRuntimeWait(a, [b.id], "Required fix", find)).toThrow("each other");
    expect(a.runtimeWait).toBeUndefined(); expect(a.after).toBeUndefined();
  });

  it("does not hold or follow a saved runtime edge once the task is awaiting merge", () => {
    const a = task("a"), b = task("b");
    const records = new Map([a, b].map(value => [value.id, value]));
    const find = (id: string) => records.get(id);
    changeRuntimeWait(b, { after: [a.id], reason: "Required fix", requestId: "during-publication" }, 30);
    b.state = "pr-open";
    b.repository = { productId: "p", delivery: "pull-request", pr: pr("open") };
    const saved = JSON.stringify(b.runtimeWait);
    expect(runtimeWaitHolds(b)).toBe(false);
    expect(validateRuntimeWait(a, [b.id], "Await the published work", find)).toEqual({ after: [b.id], reason: "Await the published work" });
    expect(validateTaskDependencies(a.id, [b.id], find)).toEqual([b.id]);
    b.after = [a.id];
    expect(() => validateTaskDependencies(a.id, [b.id], find)).toThrow("each other");
    delete b.after;
    expect(() => validateRuntimeWait(b, [], "Clear after publication", find)).toThrow("awaiting merge");
    expect(() => validateRuntimeWait(b, [a.id], "Another wait", find)).toThrow("awaiting merge");
    a.state = "cancelled";
    expect(runtimeWaitView(b, find)).toMatchObject({ held: false, phase: "released", decisionNeeded: false, prerequisites: [{ id: a.id, state: "cancelled", decisionNeeded: true }] });
    expect(runtimePrerequisite(b.id, b)).toMatchObject({ landed: false, state: "awaiting merge" });
    expect(JSON.stringify(b.runtimeWait)).toBe(saved);
  });

  it("settles a restored awaiting-merge wait once while retaining its decisions and journey", () => {
    const a = task("a"), b = task("b");
    changeRuntimeWait(a, { after: [b.id], reason: "Required fix", requestId: "during-publication" }, 30);
    syncRuntimeWait(a, () => b, 35);
    a.runtimeWait!.titles = { [b.id]: b.title };
    a.runtimeWait!.refreshPending = true;
    a.runtimeWait!.refreshProducts = ["p"];
    a.runtimeWait!.refreshAfterStep = "delivery";
    a.state = "pr-open";
    a.repository = { productId: "p", delivery: "pull-request", pr: pr("open") };
    b.state = "cancelled";
    const restored = JSON.parse(JSON.stringify(a)) as DeepMutable<TaskState>;
    const decisions = JSON.parse(JSON.stringify(a.runtimeWait!.changes)) as NonNullable<typeof a.runtimeWait>["changes"];
    expect(syncRuntimeWait(restored, () => b, 40)).toBe(true);
    expect(restored.runtimeWait).toMatchObject({ after: [b.id], reason: "Required fix", titles: { [b.id]: b.title }, changes: decisions, releasedAt: 40, releaseReason: "Publishing finished; the task is awaiting merge" });
    expect(restored.runtimeWait!.refreshPending).toBeUndefined();
    expect(restored.runtimeWait!.refreshProducts).toBeUndefined(); expect(restored.runtimeWait!.refreshAfterStep).toBeUndefined();
    expect(restored.journey!.at(-1)).toMatchObject({ endedAt: 40, outcome: "Publishing finished; the task is awaiting merge", waitStates: [{ id: b.id, state: "cancelled", landed: false }] });
    const saved = JSON.stringify(restored);
    expect(syncRuntimeWait(restored, () => b, 50)).toBe(false);
    expect(JSON.stringify(restored)).toBe(saved);
    expect(runtimeWaitView(restored, () => b)).toMatchObject({ held: false, phase: "released", decisionNeeded: false });
  });

  it("keeps a shared hold until the whole task has finished publication", () => {
    const a = task("a"), b = task("b");
    a.state = "running";
    a.repositories = [
      { productId: "p", delivery: "pull-request", completedStages: [], pr: pr("open") },
      { productId: "q", delivery: "pull-request", completedStages: [] },
    ];
    changeRuntimeWait(a, { after: [b.id], reason: "The unfinished product needs the fix" }, 30);
    b.state = "cancelled";
    syncRuntimeWait(a, () => b, 40);
    expect(runtimeWaitView(a, () => b)).toMatchObject({ held: true, phase: "active", decisionNeeded: true });
    expect(a.runtimeWait!.releasedAt).toBeUndefined();
    a.repositories[1]!.pr = pr("open");
    a.state = "pr-open";
    expect(syncRuntimeWait(a, () => b, 50)).toBe(true);
    expect(a.runtimeWait).toMatchObject({ releasedAt: 50, releaseReason: "Publishing finished; the task is awaiting merge" });
    expect(runtimeWaitHolds(a)).toBe(false);
    expect(runtimePrerequisite(a.id, a)).toMatchObject({ landed: false, state: "awaiting merge" });
  });

  it("retains an earlier clear or landing release when publication finishes", () => {
    for (const how of ["clear", "landed"] as const) {
      const a = task("a"), b = task("b");
      changeRuntimeWait(a, { after: [b.id], reason: "Required fix", requestId: "set" }, 30);
      if (how === "clear") changeRuntimeWait(a, { after: [], reason: "Proceed", requestId: "clear" }, 40);
      else {
        b.repository = { productId: "p", delivery: "pull-request", pr: pr("merged") };
        syncRuntimeWait(a, () => b, 40);
      }
      const { releasedAt, releaseReason, changes } = JSON.parse(JSON.stringify(a.runtimeWait)) as NonNullable<typeof a.runtimeWait>;
      a.runtimeWait!.refreshProducts = ["p"];
      a.runtimeWait!.refreshAfterStep = "delivery";
      a.state = "pr-open";
      expect(syncRuntimeWait(a, () => b, 50)).toBe(true);
      expect(a.runtimeWait).toMatchObject({ releasedAt, releaseReason, changes });
      expect(a.runtimeWait!.refreshPending).toBeUndefined();
      expect(a.runtimeWait!.refreshProducts).toBeUndefined(); expect(a.runtimeWait!.refreshAfterStep).toBeUndefined();
      expect(syncRuntimeWait(a, () => b, 60)).toBe(false);
    }
  });

  it("ends a saved wait for a completed task without declaring its prerequisites landed", () => {
    const a = task("a"), b = task("b");
    changeRuntimeWait(a, { after: [b.id], reason: "Required fix", requestId: "set" }, 30);
    a.state = "done";
    expect(syncRuntimeWait(a, () => b, 40)).toBe(true);
    expect(a.runtimeWait).toMatchObject({ releasedAt: 40, releaseReason: "The task finished", changes: [{ requestId: "set" }] });
    expect(a.runtimeWait!.refreshPending).toBeUndefined();
    expect(runtimeWaitView(a, () => b)).toMatchObject({ held: false, decisionNeeded: false, prerequisites: [{ landed: false }] });
    expect(syncRuntimeWait(a, () => b, 50)).toBe(false);
  });

  it("keeps the original landing outcome when an ended wait is cleared", () => {
    const a = task("a"), b = task("b");
    changeRuntimeWait(a, { after: [b.id], reason: "Fix needed", requestId: "set" }, 30);
    syncRuntimeWait(a, () => b, 40);
    a.runtimeWait!.refreshProducts = ["old-progress"];
    b.repository = { productId: "p", delivery: "pull-request", pr: pr("merged") };
    syncRuntimeWait(a, () => b, 50);
    expect(a.runtimeWait!.refreshProducts).toBeUndefined();
    delete a.runtimeWait!.refreshPending;
    const released = JSON.stringify(a.runtimeWait), journey = JSON.stringify(a.journey);
    expect(changeRuntimeWait(a, { after: [], reason: "Tidy up", requestId: "clear" }, 60)).toBe(false);
    expect(JSON.stringify(a.runtimeWait)).toBe(released);
    expect(a.runtimeWait).toMatchObject({ releasedAt: 50, releaseReason: "All required tasks landed" });
    expect(a.runtimeWait!.refreshPending).toBeUndefined();
    expect(syncRuntimeWait(a, () => b, 60)).toBe(false);
    expect(JSON.stringify(a.journey)).toBe(journey);
  });

  it("clears an active wait once and allows a later genuine wait without rewriting that clear", () => {
    const a = task("a");
    expect(changeRuntimeWait(a, { after: [], reason: "Nothing to await", requestId: "absent" }, 20)).toBe(false);
    changeRuntimeWait(a, { after: ["b"], reason: "Fix needed", requestId: "set" }, 30);
    a.runtimeWait!.refreshProducts = ["old-progress"];
    expect(changeRuntimeWait(a, { after: [], reason: "Proceed", requestId: "clear" }, 40)).toBe(true);
    expect(a.runtimeWait!.refreshProducts).toBeUndefined();
    a.runtimeWait!.refreshProducts = ["p"];
    const released = JSON.stringify(a.runtimeWait);
    expect(changeRuntimeWait(a, { after: [], reason: "Another explanation", requestId: "clear-again" }, 50)).toBe(false);
    expect(JSON.stringify(a.runtimeWait)).toBe(released);
    expect(a.runtimeWait!.refreshPending).toBe(true);
    delete a.runtimeWait!.refreshPending;
    expect(changeRuntimeWait(a, { after: ["c"], reason: "A different fix", requestId: "new-wait" }, 60)).toBe(true);
    expect(runtimeWaitHolds(a)).toBe(true);
    expect(a.runtimeWait!.refreshProducts).toBeUndefined();
    expect(a.runtimeWait).toMatchObject({ after: ["c"], reason: "A different fix", changes: [
      { at: 30, after: ["b"], requestId: "set" },
      { at: 40, after: [], reason: "Proceed", requestId: "clear" },
      { at: 60, before: [], after: ["c"], requestId: "new-wait" },
    ] });
    expect(a.runtimeWait!.releasedAt).toBeUndefined(); expect(a.runtimeWait!.releaseReason).toBeUndefined();
    a.runtimeWait!.refreshProducts = ["p"];
    expect(changeRuntimeWait(a, { after: ["c"], reason: "Revised explanation", requestId: "revise" }, 70)).toBe(true);
    expect(a.runtimeWait!.refreshProducts).toBeUndefined();
  });

  it("keeps every revision and explicitly clears without erasing attempt or conversation state", () => {
    const a = task("a");
    a.rounds = { review: 2 }; a.fixing = true;
    a.repository = { productId: "p", delivery: "local", stepAttempts: 2, builderSession: { stageId: "build", profileId: "profile", toolId: "tool", model: "model", sessionId: "saved" } };
    expect(changeRuntimeWait(a, { after: ["b"], reason: "Fix needed", requestId: "first" }, 30)).toBe(true);
    expect(changeRuntimeWait(a, { after: ["b"], reason: "Fix needed", requestId: "retry" }, 31)).toBe(false);
    expect(changeRuntimeWait(a, { after: ["b", "c"], reason: "Two fixes", requestId: "second" }, 40)).toBe(true);
    expect(changeRuntimeWait(a, { after: [], reason: "Proceed with current scope", requestId: "clear" }, 50)).toBe(true);
    expect(a.runtimeWait?.changes).toEqual([
      { at: 30, before: [], after: ["b"], reason: "Fix needed", requestId: "first" },
      { at: 40, before: ["b"], after: ["b", "c"], reason: "Two fixes", requestId: "second" },
      { at: 50, before: ["b", "c"], after: [], reason: "Proceed with current scope", requestId: "clear" },
    ]);
    expect(runtimeWaitHolds(a)).toBe(false);
    expect(a.runtimeWait?.refreshPending).toBe(true);
    expect(a.rounds).toEqual({ review: 2 }); expect(a.fixing).toBe(true);
    expect(a.repository?.stepAttempts).toBe(2); expect(a.repository?.builderSession?.sessionId).toBe("saved");
  });

  it("keeps an unchanged wait idempotent after a prerequisite finishes or becomes unavailable", () => {
    const a = task("a"), b = task("b");
    changeRuntimeWait(a, { after: ["b"], reason: "Fix", requestId: "first" }, 30);
    b.state = "cancelled";
    expect(validateRuntimeWait(a, ["b"], " Fix ", id => id === "a" ? a : b)).toEqual({ after: ["b"], reason: "Fix" });
    const normalized = validateRuntimeWait(a, ["b"], "Fix", () => undefined);
    expect(changeRuntimeWait(a, { ...normalized, requestId: "new-reference" }, 40)).toBe(false);
    expect(a.runtimeWait?.changes).toHaveLength(1);
    a.runtimeWait!.titles = { b: "Fix the capacity tests" };
    expect(runtimeWaitWords(runtimeWaitView(a, () => undefined)!)).toBe("Waiting for your decision: “Fix the capacity tests” did not land (no longer available)");
  });

  it("drains current agents, preserves checkpoints and records a separate wait between steps", () => {
    const a = task("a"), b = task("b");
    changeRuntimeWait(a, { after: ["b"], reason: "Capacity fix must arrive" }, 30);
    a.agent = { roleId: "builder", profileId: "profile", since: 20, step: 0 };
    expect(runtimeWaitView(a, () => b)?.phase).toBe("after-current-work");
    delete a.agent;
    a.journey = [{ id: "gate", kind: "you", waitsFor: "delivery", round: 1, sub: 0, startedAt: 20 }];
    syncRuntimeWait(a, () => b, 40);
    expect(a.journey).toHaveLength(1); expect(a.journey[0]?.waitReason).toBeUndefined();
    a.journey[0]!.endedAt = 50; a.journey[0]!.outcome = "Approved";
    syncRuntimeWait(a, () => b, 60);
    expect(a.journey.at(-1)).toMatchObject({ kind: "wait", runtimeWait: true, waitReason: "Capacity fix must arrive", waitsOn: [{ id: "b", title: "Task b" }] });
    const restored = JSON.parse(JSON.stringify(a)) as DeepMutable<TaskState>;
    expect(runtimeWaitHolds(restored)).toBe(true);
    expect(runtimeWaitWords(runtimeWaitView(restored, () => b)!)).toBe("Waiting for “Task b” to land");
    b.repository = { productId: "p", delivery: "pull-request", pr: pr("merged") };
    expect(runtimeWaitWords(runtimeWaitView(restored, () => b)!)).toBe("Required tasks have landed; waiting to resume");
    expect(syncRuntimeWait(restored, () => b, 70)).toBe(true);
    expect(restored.runtimeWait?.releasedAt).toBe(70); expect(restored.runtimeWait?.refreshPending).toBe(true);
    expect(restored.journey?.at(-1)?.outcome).toBe("All required tasks landed");
    expect(syncRuntimeWait(restored, () => b, 71)).toBe(false);
  });

  it("keeps a partial parallel group incomplete and records how many seats reported", () => {
    const a = task("a"), b = task("b");
    changeRuntimeWait(a, { after: ["b"], reason: "Review needs the fix" }, 30);
    a.journey = [{ id: "group", kind: "agent", round: 2, sub: 0, startedAt: 20, outcome: "One report saved", seats: ["reviewer:0", "reviewer:1"], agentResults: [{ roleId: "reviewer", profileId: "profile", at: 25, value: { findings: [] } }] }];
    syncRuntimeWait(a, () => b, 40);
    expect(a.journey[0]?.outcome).toBe("1 of 2 reported; waiting for prerequisites");
    expect(a.journey[0]?.endedAt).toBeUndefined(); expect(a.journey[0]?.end).toBeUndefined();
    expect(a.journey[0]?.agentResults).toHaveLength(1); expect(a.rounds).toEqual({});
    changeRuntimeWait(a, { after: [], reason: "The remaining review can proceed" }, 50);
    syncRuntimeWait(a, () => b, 50);
    expect(a.journey[0]?.waitReason).toBeUndefined(); expect(a.journey[0]?.waitsOn).toBeUndefined();
    expect(a.journey[0]?.outcome).toBe("One report saved"); expect(a.journey[0]?.agentResults).toHaveLength(1);
  });

  it("clears an unstarted check node's wait annotation while retaining its stopped evidence", () => {
    const a = task("a"), b = task("b");
    changeRuntimeWait(a, { after: ["b"], reason: "The check must wait" }, 30);
    a.journey = [{ id: "checks", kind: "petrina", work: "checks", round: 1, sub: 0, startedAt: 20, outcome: "Checks stopped", productChecks: [{ id: "check", name: "Tests", result: "stopped", queuedAt: 20, endedAt: 30 }] }];
    syncRuntimeWait(a, () => b, 40);
    expect(a.journey[0]?.waitReason).toBe("The check must wait");
    changeRuntimeWait(a, { after: [], reason: "Proceed with the current checks" }, 50);
    syncRuntimeWait(a, () => b, 50);
    expect(a.journey[0]?.waitReason).toBeUndefined(); expect(a.journey[0]?.runtimeWait).toBeUndefined();
    expect(a.journey[0]?.outcome).toBe("Checks stopped");
    expect(a.journey[0]?.productChecks?.[0]?.result).toBe("stopped");
    expect(a.journey[0]?.endedAt).toBeUndefined();
  });

  it("cancels the hold while retaining its audit and leaves a normal task alone", () => {
    const a = task("a"), control = task("normal");
    expect(syncRuntimeWait(control, () => undefined, 30)).toBe(false);
    expect(control.runtimeWait).toBeUndefined();
    changeRuntimeWait(a, { after: ["b"], reason: "Fix" }, 30);
    a.runtimeWait!.refreshPending = true;
    a.runtimeWait!.refreshProducts = ["p"];
    a.runtimeWait!.refreshAfterStep = "build";
    cancelTaskState(a, {}, 40);
    expect(runtimeWaitHolds(a)).toBe(false);
    expect(a.runtimeWait).toMatchObject({ releasedAt: 40, releaseReason: "The task was cancelled", changes: [{ at: 30, reason: "Fix" }] });
    expect(a.runtimeWait?.refreshPending).toBeUndefined();
    expect(a.runtimeWait?.refreshProducts).toBeUndefined(); expect(a.runtimeWait?.refreshAfterStep).toBeUndefined();

    const released = task("released");
    changeRuntimeWait(released, { after: ["b"], reason: "Fix" }, 30);
    changeRuntimeWait(released, { after: [], reason: "Proceed" }, 40);
    released.runtimeWait!.refreshProducts = ["p"];
    released.runtimeWait!.refreshAfterStep = "review";
    cancelTaskState(released, {}, 50);
    expect(released.runtimeWait).toMatchObject({ releasedAt: 40, releaseReason: "You cleared the wait: Proceed" });
    expect(released.runtimeWait!.refreshPending).toBeUndefined();
    expect(released.runtimeWait!.refreshProducts).toBeUndefined(); expect(released.runtimeWait!.refreshAfterStep).toBeUndefined();
  });

  it("leaves room in the starts-next count for another task while the hold owns no slot", () => {
    const held = task("held"), queued = task("queued");
    queued.state = "queued"; delete queued.startedAt;
    const state: State = { tasks: [held as Task, queued as Task], now: 30, seq: 0, products: [], roles: [], profiles: [], tools: [], inbox: [], pool: { limit: 1, paused: false, toolCaps: {} } };
    expect(startsNextCount(state)).toBe(0);
    changeRuntimeWait(held, { after: ["fix"], reason: "Required fix" }, 30);
    expect(startsNextCount(state)).toBe(1);
    state.pool.paused = true;
    expect(startsNextCount(state)).toBe(0);
  });
});

describe("runtime prerequisite arrival", () => {
  it("uses confirmed delivery, including every publishing product and archived tasks", () => {
    const b = task("b");
    b.repositories = [
      { productId: "p", delivery: "pull-request", completedStages: [], pr: pr("merged") },
      { productId: "q", delivery: "local", completedStages: [], landed: { branch: "main", sha: "head" }, localUpdate: { branch: "main", sha: "head", pushed: false } },
      { productId: "empty", delivery: "local", completedStages: [], nothingToPublish: true },
    ];
    expect(runtimePrerequisite("b", b)).toMatchObject({ landed: false, state: "delivery has not been pushed" });
    b.repositories![1]!.localUpdate!.pushed = true;
    expect(runtimePrerequisite("b", b).landed).toBe(true);
    b.state = "done";
    expect(runtimePrerequisite("b", historyItem(b as Task)).landed).toBe(true);
    b.repositories![1]!.shipping = { step: "push" } as ShippingRecord;
    expect(runtimePrerequisite("b", b)).toMatchObject({ landed: false, state: "still publishing" });
    b.repositories![1]!.shipping = undefined;
    b.repositories![1]!.pr = pr("open"); b.repositories![1]!.landed = undefined;
    expect(runtimePrerequisite("b", b)).toMatchObject({ landed: false, state: "awaiting merge" });
    b.repositories![1]!.removed = true;
    expect(runtimePrerequisite("b", b)).toMatchObject({ landed: false, state: "awaiting merge" });
    b.repositories![1]!.pr = pr("merged");
    expect(runtimePrerequisite("b", b).landed).toBe(true);
  });

  it("keeps public publishing and an unprepared shared task distinct from a completed no-change task", () => {
    const b = task("b");
    b.repositories = [];
    expect(runtimePrerequisite("b", b)).toMatchObject({ state: "still in progress", decisionNeeded: false });
    b.state = "done";
    expect(runtimePrerequisite("b", b)).toMatchObject({ landed: false, decisionNeeded: true });
    b.repositories = undefined; b.state = "running";
    b.repository = { productId: "p", delivery: "local", landed: { branch: "main", sha: "saved" }, shipping: { step: "push" } as ShippingRecord };
    expect(runtimePrerequisite("b", b)).toMatchObject({ state: "still publishing", landed: false });
    changeRuntimeWait(b, { after: ["a"], reason: "Needed fix" }, 30);
    const displayed = { ...b, shipping: b.repository.shipping, repository: undefined };
    expect(runtimeWaitView(displayed, () => undefined)?.phase).toBe("after-current-work");
    displayed.state = "waiting";
    expect(runtimeWaitView(displayed, () => undefined)?.phase).toBe("active");
    displayed.agent = { roleId: "release-manager", profileId: "sol-high", since: 30, step: 0 };
    expect(runtimeWaitView(displayed, () => undefined)?.phase).toBe("after-current-work");
    delete displayed.agent;
    expect(runtimeWaitView(displayed, () => undefined)?.phase).toBe("active");
    b.state = "done"; b.repository.shipping = { carriedOver: true } as ShippingRecord;
    expect(runtimePrerequisite("b", b)).toMatchObject({ landed: false, decisionNeeded: true });
  });

  it("keeps provisional no-change products in progress until the prerequisite finishes", () => {
    const a = task("a"), b = task("b");
    b.repositories = ["p", "q"].map(productId => ({ productId, delivery: "local", completedStages: [], nothingToPublish: true }));
    changeRuntimeWait(a, { after: [b.id], reason: "The final fix must arrive" }, 30);
    for (const state of ["running", "waiting", "needs-you"] as const) {
      b.state = state;
      expect(runtimePrerequisite(b.id, b)).toMatchObject({ landed: false, decisionNeeded: false, state: "still in progress" });
      syncRuntimeWait(a, () => b, 40);
      expect(runtimeWaitView(a, () => b)).toMatchObject({ held: true, decisionNeeded: false });
    }
    b.state = "done";
    expect(runtimePrerequisite(b.id, b)).toMatchObject({ landed: false, decisionNeeded: true, state: "finished with no product changes" });
    expect(runtimeWaitView(a, () => b)).toMatchObject({ held: true, decisionNeeded: true });
  });

  it("requires a coordinator decision for non-landing endings and never silently releases", () => {
    const a = task("a"), b = task("b");
    changeRuntimeWait(a, { after: ["b"], reason: "Required fix" }, 30);
    const decision = (state: string) => {
      expect(runtimePrerequisite("b", b)).toMatchObject({ state, landed: false, decisionNeeded: true });
      syncRuntimeWait(a, () => b, 40);
      expect(runtimeWaitHolds(a)).toBe(true);
      expect(runtimeWaitWords(runtimeWaitView(a, () => b)!)).toContain("Waiting for your decision");
    };
    b.state = "cancelled"; decision("cancelled");
    b.combinedInto = "other"; decision("combined into another task"); delete b.combinedInto;
    b.state = "done";
    b.repositories = [{ productId: "p", delivery: "pull-request", completedStages: [], pr: pr("closed"), landingAccepted: { at: 20 } }];
    decision("closed without merging");
    b.repositories[0]!.pr = pr("merged"); b.repositories[0]!.cleanup = { markedDone: true } as NonNullable<typeof b.repositories[number]["cleanup"]>;
    decision("marked done without a confirmed delivery");
    expect(runtimePrerequisite("b", historyItem(b as Task))).toMatchObject({ state: "marked done without a confirmed delivery", landed: false, decisionNeeded: true });
    b.repositories[0]!.cleanup = undefined; b.repositories[0]!.nothingToPublish = true;
    decision("finished with no product changes");
    expect(runtimePrerequisite("b", undefined)).toMatchObject({ state: "no longer available", decisionNeeded: true });
  });
});
