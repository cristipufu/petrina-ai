import { describe, expect, it } from "vitest";
import {
  changeRuntimeWait,
  checkActivityLine,
  createTaskState,
  workflowEvents,
  workflowFacts,
  WorkflowObserver,
  type CheckActivity,
  type CheckLineOwner,
  type DeepMutable,
  type JourneyStep,
  type TaskState,
  type WorkflowContext,
} from "../../../src/index.js";
import { stateFixture, taskFixture } from "../../fixtures/state.js";

const state = stateFixture({ now: 1_000_000_000_000 });
const owner = (title: string): CheckLineOwner => ({
  taskId: title.toLowerCase().replace(/\W+/g, "-"),
  title,
  kind: "checks",
});
const waiting: CheckActivity = { phase: "waiting", since: 1, slots: 1, ahead: 2, owners: [owner("Other task")] };

function base(changes: Partial<TaskState> = {}): TaskState {
  const task = taskFixture(state, { id: "t1", title: "Checked task", state: "running", startedAt: 1, stageIndex: 1 });
  task.plan = {
    rationale: "Checks",
    plannerProfileId: "sol-high",
    stages: [
      { id: "build", title: "Build", kind: "do", roleId: "builder", profileIds: ["sol-high"] },
      { id: "security", title: "Security review", kind: "review-chain", roleId: "security-reviewer", profileIds: ["opus-high"] },
    ],
  };
  return { ...(task as unknown as TaskState), journey: [], ...changes };
}

const context = (findTask?: WorkflowContext["findTask"]): WorkflowContext => ({
  roles: state.roles,
  profiles: state.profiles,
  inbox: [],
  products: state.products.map(({ id, name }) => ({ id, name })),
  now: 5,
  ...(findTask ? { findTask } : {}),
});

describe("workflow events record check waits and prerequisite waits from their facts", () => {
  it("says once when a run enters the line, becomes held or keeps its place through a pause, never for counts alone", () => {
    const observer = new WorkflowObserver();
    const task = base({
      statusLine: "Preparing automated checks",
      checkActivity: { phase: "preparing", since: 1, slots: 1 },
    }) as DeepMutable<TaskState>;
    observer.baseline(task, context());
    const step = (activity: CheckActivity, changes: Partial<TaskState> = {}) => {
      Object.assign(task, { checkActivity: activity, statusLine: checkActivityLine(activity), ...changes });
      return observer.observe(task, context()).filter((event) => event.kind === "task.waiting" || event.kind === "task.state");
    };
    const [entered] = step({ ...waiting, ahead: 2 });
    expect(entered).toMatchObject({
      kind: "task.waiting",
      wait: "checks",
      summary: "Waiting for checks · 2 runs ahead",
      checkActivity: { phase: "waiting", ahead: 2, slots: 1, owners: [{ title: "Other task" }] },
    });
    expect(workflowFacts(task, context()).waitKind).toBe("checks");
    expect(step({ ...waiting, ahead: 1 })).toEqual([]);
    expect(step({ ...waiting, ahead: 1, owners: [owner("Next owner")] })).toEqual([]);
    expect(step({ ...waiting, phase: "held", ahead: 1 })).toMatchObject([
      { kind: "task.waiting", wait: "checks", summary: "Waiting for checks · held for cleanup", checkActivity: { phase: "held" } },
    ]);
    expect(step({ ...waiting, phase: "paused", ahead: 1 }, { state: "waiting" })).toMatchObject([
      {
        kind: "task.state",
        from: "running",
        to: "waiting",
        wait: "checks",
        reason: "Waiting for the pool to resume",
        checkActivity: { phase: "paused", ahead: 1 },
      },
    ]);
    expect(step({ ...waiting, ahead: 0 }, { state: "running" })).toMatchObject([
      {
        kind: "task.state",
        to: "running",
        summary: "waiting → running: Waiting for checks · next in line",
        checkActivity: { phase: "waiting", ahead: 0 },
      },
    ]);
    // Admission is reported by the checks' own events.
    expect(step({ phase: "starting", since: 1, slots: 1 })).toEqual([]);
  });

  it("summarizes a prerequisite wait from its record, not a slot wait left on the status line", () => {
    const task = createTaskState({ productId: "", title: "Resumed work" }, [], {
      id: "resumed",
      now: 1,
      priority: 0,
      timelineId: "created",
    });
    const prerequisite = createTaskState({ productId: "", title: "Runtime fix" }, [], {
      id: "fix",
      now: 1,
      priority: 0,
      timelineId: "fix-created",
    });
    task.startedAt = 2;
    task.state = "paused";
    task.statusLine = "Paused by you";
    changeRuntimeWait(task, { after: [prerequisite.id], reason: "Needs the runtime fix first" }, 3);
    const ctx = context((id) => (id === prerequisite.id ? prerequisite : undefined));
    const observer = new WorkflowObserver();
    observer.baseline(task, ctx);
    task.state = "waiting";
    task.statusLine = "Waiting for a free slot";
    const events = observer.observe(task, ctx).filter((event) => event.kind.startsWith("task."));
    expect(events.map((event) => [event.kind, event.wait, event.summary, event.reason])).toEqual([
      ["task.state", "dependencies", "paused → waiting: Waiting for “Runtime fix” to land", "Waiting for “Runtime fix” to land"],
      ["task.waiting", "dependencies", "Waiting for “Runtime fix” to land", "Needs the runtime fix first"],
    ]);
    expect(events.some((event) => String(event.summary).includes("free slot"))).toBe(false);
  });

  it("starts a checks step with its recorded reason instead of the step that ended before it", () => {
    const checks: JourneyStep = {
      id: "j30",
      kind: "petrina",
      work: "checks",
      stageId: "gate",
      round: 1,
      sub: 0,
      startedAt: 4,
      trigger: { after: "j29", reason: "Review passed" },
      checkReasons: [
        {
          attemptId: "run-0",
          purpose: "delivery-check",
          earlier: { nodeId: "j28", attemptId: "run-0", sha: "a338ab0", tree: "ca932e6", passed: true, at: 1 },
          changed: ["code", "start"],
        },
      ],
    };
    const events = workflowEvents(workflowFacts(base(), context()), workflowFacts(base({ journey: [checks] }), context()), context(), new Map());
    const started = events.find((event) => event.kind === "node.started")!;
    expect(started.summary).toBe(
      "Automated checks started: Before your delivery check: the code changed since the passing run in step 28 (main moved on)",
    );
    expect(started.summary).not.toContain("Review passed");
    expect(started.checkReason).toMatchObject({
      purpose: "delivery-check",
      changed: ["code", "start"],
      earlier: { nodeId: "j28", passed: true },
    });
  });
});
