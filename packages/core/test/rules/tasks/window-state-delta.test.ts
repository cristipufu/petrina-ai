import { describe, expect, it } from "vitest";
import {
  applyWindowStateDelta,
  captureWindowStateBase,
  createDemo,
  diffWindowState,
  reviewStats,
  type State,
  type Task,
  type WindowStateDelta,
} from "../../../src/index.js";

function cloneWire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function makeTask(id: string, statusLine: string, priority: number): Task {
  return {
    id,
    productId: "prod-1",
    delivery: "pull-request",
    title: `Task ${id}`,
    description: "Summary board card",
    area: "board",
    kind: "feature",
    createdAt: 100,
    approvePlan: false,
    approveDelivery: false,
    detailsOmitted: true,
    detailsRevision: `boot:${priority + 1}`,
    priority,
    held: false,
    state: "queued",
    column: "queue",
    holdsSlot: false,
    stageIndex: 0,
    rounds: {},
    sub: 0,
    fixing: false,
    objections: [],
    findings: [],
    statusLine,
    queued: [],
    timeline: [],
    session: [],
  };
}

describe("windowStateDelta diff and patch", () => {
  it("emits only changed tasks and preserves reference identity for unchanged slices and unchanged task cards", () => {
    const initial: State = {
      ...createDemo(1_000).state,
      tasks: Array.from({ length: 20 }, (_, index) => makeTask(`task-${index}`, `Queued ${index}`, index)),
    };
    const base = captureWindowStateBase(initial);

    const updatedTask: Task = {
      ...initial.tasks[7]!,
      state: "running",
      column: "building",
      holdsSlot: true,
      statusLine: "Building step 2",
      detailsRevision: "boot:99",
    };
    const nextServer: State = {
      ...initial,
      now: 1_120,
      seq: initial.seq + 1,
      tasks: initial.tasks.map((task, index) => (index === 7 ? updatedTask : task)),
    };

    const wireDelta = cloneWire(diffWindowState(base, nextServer));
    expect(wireDelta.products).toBeUndefined();
    expect(wireDelta.roles).toBeUndefined();
    expect(wireDelta.tools).toBeUndefined();
    expect(wireDelta.profiles).toBeUndefined();
    expect(wireDelta.inbox).toBeUndefined();
    expect(wireDelta.pool).toBeUndefined();
    expect(wireDelta.tasks).toEqual({
      upserts: [updatedTask],
    });

    const patched = applyWindowStateDelta(initial, wireDelta);
    expect(patched).toEqual(nextServer);
    expect(patched.products).toBe(initial.products);
    expect(patched.roles).toBe(initial.roles);
    expect(patched.tools).toBe(initial.tools);
    expect(patched.profiles).toBe(initial.profiles);
    expect(patched.inbox).toBe(initial.inbox);
    expect(patched.pool).toBe(initial.pool);
    for (let index = 0; index < patched.tasks.length; index++) {
      if (index === 7) {
        expect(patched.tasks[index]).toEqual(updatedTask);
        expect(patched.tasks[index]).not.toBe(initial.tasks[index]);
      } else {
        expect(patched.tasks[index]).toBe(initial.tasks[index]);
      }
    }
  });

  it("handles task retirement, reordering, and optional state slices transitioning to and from undefined over JSON", () => {
    const initial: State = {
      ...createDemo(2_000).state,
      tasks: [makeTask("t-1", "First", 0), makeTask("t-2", "Second", 1), makeTask("t-3", "Third", 2)],
      terminals: [{ id: "iterm", name: "iTerm" }],
      terminal: "iterm",
      planner: "claude-opus",
      history: {
        revision: 1,
        total: 4,
        products: [{ productId: "prod-1", done: 4, cancelled: 0 }],
        reviews: reviewStats([]),
        reviewsByProduct: {},
        steps: [],
      },
    };
    const base1 = captureWindowStateBase(initial);

    // Reorder t-3 ahead of t-1, retire t-2, clear optional slices, and introduce backgroundAgents.
    const { terminals: _terminals, terminal: _terminal, planner: _planner, ...withoutOptionals } = initial;
    const step2: State = {
      ...withoutOptionals,
      now: 2_500,
      seq: initial.seq + 2,
      tasks: [initial.tasks[2]!, initial.tasks[0]!, makeTask("t-4", "Fourth", 3)],
      backgroundAgents: [{ id: "bg-1", roleId: "guide", profileId: "p-1", label: "Updating guide", since: 2_400 }],
      history: {
        ...initial.history!,
        revision: 2,
        total: 5,
      },
    };

    const delta1: WindowStateDelta = cloneWire(diffWindowState(base1, step2));
    expect(delta1.tasks?.order).toEqual(["t-3", "t-1", "t-4"]);
    expect(delta1.tasks?.upserts.map((task) => task.id)).toEqual(["t-4"]);
    expect(delta1.terminals).toEqual({ cleared: true });

    const patched2 = applyWindowStateDelta(initial, delta1);
    expect(patched2).toEqual(step2);
    expect(patched2.tasks[0]).toBe(initial.tasks[2]);
    expect(patched2.tasks[1]).toBe(initial.tasks[0]);
    expect("terminals" in patched2).toBe(false);
    expect("terminal" in patched2).toBe(false);
    expect("planner" in patched2).toBe(false);

    // Clear backgroundAgents back to undefined.
    const base2 = captureWindowStateBase(step2);
    const { backgroundAgents: _bg, ...step3 } = { ...step2, now: 3_000 };
    const delta2 = cloneWire(diffWindowState(base2, step3));
    const patched3 = applyWindowStateDelta(patched2, delta2);
    expect(patched3).toEqual(step3);
    expect("backgroundAgents" in patched3).toBe(false);
  });
});
