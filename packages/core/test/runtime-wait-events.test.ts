import { expect, it } from "vitest";
import { changeRuntimeWait, createTaskState, syncRuntimeWait, workflowFacts, WorkflowObserver, type WorkflowContext } from "../src/index.js";

it("stops reporting prerequisite decisions after admitted publication has finished", () => {
  const task = createTaskState({ productId: "", title: "Published work" }, [], { id: "published", now: 1, priority: 0, timelineId: "created" });
  const prerequisite = createTaskState({ productId: "", title: "Required fix" }, [], { id: "fix", now: 1, priority: 0, timelineId: "fix-created" });
  task.startedAt = 2; task.state = "running";
  changeRuntimeWait(task, { after: [prerequisite.id], reason: "Wait before new work" }, 3);
  const context: WorkflowContext = { roles: [], profiles: [], products: [], inbox: [], now: 4, findTask: id => id === prerequisite.id ? prerequisite : undefined };
  const observer = new WorkflowObserver();
  observer.baseline(task, context);
  task.state = "pr-open";
  syncRuntimeWait(task, context.findTask!, 4);
  prerequisite.state = "cancelled";
  expect(workflowFacts(task, context)).toMatchObject({ runtimeWait: { held: false, decisionNeeded: false, phase: "released" } });
  expect(workflowFacts(task, context).waitKind).toBeUndefined();
  expect(observer.observe(task, context).filter(event => event.kind === "task.waiting")).toEqual([]);
});

it("reports prerequisite decisions from saved landing facts with the coordinator's reason", () => {
  const task = createTaskState({ productId: "", title: "Waiting work" }, [], { id: "waiting", now: 1, priority: 0, timelineId: "created" });
  const prerequisite = createTaskState({ productId: "", title: "Fix the tests" }, [], { id: "fix", now: 1, priority: 0, timelineId: "fix-created" });
  task.startedAt = 2;
  task.state = "running";
  const context: WorkflowContext = { roles: [], profiles: [], products: [], inbox: [], now: 3, findTask: id => id === prerequisite.id ? prerequisite : undefined };
  const observer = new WorkflowObserver();
  observer.baseline(task, context);
  changeRuntimeWait(task, { after: [prerequisite.id], reason: "Usage and capacity are unrelated; this code fix is required", requestId: "wait" }, 3);
  task.state = "waiting";
  task.statusLine = "Waiting for “Fix the tests” to land";
  const events = observer.observe(task, context);
  expect(events.find(event => event.kind === "task.waiting")).toMatchObject({ wait: "dependencies", reason: task.runtimeWait!.reason, decisionNeeded: false, prerequisites: [{ id: "fix", landed: false, decisionNeeded: false }] });
  expect(observer.observe(task, context)).toEqual([]);
  prerequisite.state = "cancelled";
  task.statusLine = "Waiting for your decision: “Fix the tests” did not land (cancelled)";
  const decision = observer.observe(task, context).filter(event => event.kind === "task.waiting");
  expect(decision).toHaveLength(1);
  expect(decision[0]).toMatchObject({ wait: "needs-your-decision", reason: task.runtimeWait!.reason, decisionNeeded: true, prerequisites: [{ id: "fix", state: "cancelled", landed: false, decisionNeeded: true }] });
  expect(observer.observe(task, context)).toEqual([]);
  changeRuntimeWait(task, { after: [], reason: "Coordinator accepts proceeding", requestId: "clear" }, 5);
  expect(workflowFacts(task, context).waitKind).not.toBe("needs-your-decision");
});

it("does not derive a prerequisite decision from an agent's status words", () => {
  const task = createTaskState({ productId: "", title: "Ordinary work" }, [], { id: "normal", now: 1, priority: 0, timelineId: "created" });
  task.state = "waiting";
  task.statusLine = "Waiting for your decision: a missing prerequisite was mentioned";
  expect(workflowFacts(task, { roles: [], profiles: [], products: [], inbox: [], now: 2 }).waitKind).toBe("other");
});

it("keeps readiness waits separate while saved prerequisites take precedence", () => {
  const task = createTaskState({ productId: "", title: "Returning work" }, [], { id: "returning", now: 1, priority: 0, timelineId: "created" });
  const prerequisite = createTaskState({ productId: "", title: "Required fix" }, [], { id: "fix", now: 1, priority: 0, timelineId: "fix-created" });
  task.startedAt = 2;
  task.state = "waiting";
  task.statusLine = "Checking Codex before the Builder returns";
  const context: WorkflowContext = { roles: [], profiles: [], products: [], inbox: [], now: 3, findTask: id => id === prerequisite.id ? prerequisite : undefined };
  const observer = new WorkflowObserver();
  observer.baseline(task, context);
  expect(workflowFacts(task, context).waitKind).toBe("readiness");
  changeRuntimeWait(task, { after: [prerequisite.id], reason: "Wait for the required fix" }, 3);
  expect(observer.observe(task, context).filter(event => event.kind === "task.waiting")).toEqual([
    expect.objectContaining({ wait: "dependencies", reason: "Wait for the required fix" }),
  ]);
  prerequisite.state = "cancelled";
  expect(observer.observe(task, context).filter(event => event.kind === "task.waiting")).toEqual([
    expect.objectContaining({ wait: "needs-your-decision", decisionNeeded: true }),
  ]);
  changeRuntimeWait(task, { after: [], reason: "The coordinator resolved the prerequisite" }, 4);
  expect(observer.observe(task, context).filter(event => event.kind === "task.waiting")).toEqual([
    expect.objectContaining({ wait: "readiness" }),
  ]);
  expect(observer.observe(task, context)).toEqual([]);
});
