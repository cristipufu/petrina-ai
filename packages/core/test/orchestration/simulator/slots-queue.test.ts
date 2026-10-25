import { emptyState, task } from "../../fixtures/simulator.js";
import { describe, expect, it } from "vitest";

import { slotUses } from "../../../src/scheduler.js";

import { Simulator } from "../../../src/sim.js";

describe("limits between simulated agents", () => {
  for (const limit of ["tool", "pool", "paused"] as const) {
    it(`keeps running agents when the ${limit} limit changes, then checks same-tool successors`, () => {
      const sim = new Simulator(emptyState(9));
      sim.setPoolPaused(true);
      sim.setToolCap("claude-code", 7);
      const ids = Array.from({ length: 9 }, (_, index) => sim.addTask({ productId: "p", title: `Task ${index}`, kind: "new" }));
      sim.setPoolPaused(false);
      expect(slotUses(sim.getState())).toHaveLength(7);
      if (limit === "tool") sim.setToolCap("claude-code", 5);
      else if (limit === "pool") sim.setPoolLimit(5);
      else sim.setPoolPaused(true);
      expect(slotUses(sim.getState())).toHaveLength(7);
      let reachedFive = false;
      const queued = ids.slice(7);
      let waitingSeen = false;
      let otherToolSeen = false;
      for (let tick = 0; tick < 100; tick += 1) {
        sim.tick();
        const state = sim.getState();
        const uses = slotUses(state);
        for (const task of state.tasks) if (task.holdsSlot) expect(task.agent).toBeDefined();
        const used = limit === "tool" ? uses.filter((use) => use.toolId === "claude-code").length : uses.length;
        if (used <= 5) reachedFive = true;
        if (reachedFive) expect(used).toBeLessThanOrEqual(5);
        for (const task of state.tasks.filter((task) => task.state === "waiting")) {
          waitingSeen = true;
          expect(task.column).not.toBe("queue");
          expect(task.statusLine).toMatch(/Waiting for (a free|the pool)/);
        }
        otherToolSeen ||= uses.some((use) => use.toolId === "codex");
        for (const item of state.inbox) if (!item.blocking) sim.approve(item.id);
        if (limit === "paused" && uses.length === 0) {
          expect(queued.every((id) => task(sim, id).state === "queued")).toBe(true);
          sim.setPoolPaused(false);
          expect(queued.every((id) => task(sim, id).state === "queued")).toBe(true);
          break;
        }
      }
      expect(waitingSeen).toBe(true);
      if (limit !== "paused") expect(otherToolSeen).toBe(true);
    });
  }
});

describe("Simulator", () => {
  it("starts queued tasks in priority order and respects the pool limit", () => {
    const sim = new Simulator({ ...emptyState(1), pool: { limit: 1, paused: true, toolCaps: {} } });
    const a = sim.addTask({ productId: "p", title: "First", kind: "chore" });
    const b = sim.addTask({ productId: "p", title: "Second", kind: "chore", position: "top" });
    sim.setPoolPaused(false);

    expect(task(sim, b).state).toBe("running");
    expect(task(sim, a).state).toBe("queued");
  });

  it("releases the slot when a task is paused and lets the next one start", () => {
    const sim = new Simulator(emptyState(1));
    const a = sim.addTask({ productId: "p", title: "One", kind: "chore" });
    const b = sim.addTask({ productId: "p", title: "Two", kind: "chore" });

    sim.pause(a);
    expect(task(sim, a).holdsSlot).toBe(false);
    expect(task(sim, b).state).toBe("running");
  });

  it("skips held tasks in the queue", () => {
    const sim = new Simulator({ ...emptyState(1), pool: { limit: 1, paused: true, toolCaps: {} } });
    const held = sim.addTask({ productId: "p", title: "Not yet", kind: "chore" });
    const next = sim.addTask({ productId: "p", title: "Go", kind: "chore" });
    sim.setHeld(held, true);
    sim.setPoolPaused(false);

    expect(task(sim, held).state).toBe("queued");
    expect(task(sim, next).state).toBe("running");
  });

  it("reorders the queue", () => {
    const sim = new Simulator({ ...emptyState(1), pool: { limit: 1, paused: true, toolCaps: {} } });
    const a = sim.addTask({ productId: "p", title: "A", kind: "chore" });
    const b = sim.addTask({ productId: "p", title: "B", kind: "chore" });
    const c = sim.addTask({ productId: "p", title: "C", kind: "chore" });
    sim.moveInQueue(c, 0);
    const order = sim.getState().tasks.filter((entry) => entry.state === "queued").sort((x, y) => x.priority - y.priority).map((entry) => entry.id);
    expect(order).toEqual([c, a, b]);
  });
});
