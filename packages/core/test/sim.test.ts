import { describe, expect, it } from "vitest";
import { createDemoState, createPortfolioDemo } from "../src/demo.js";
import { BUILT_IN_ROLES, DEFAULT_PROFILES, KNOWN_TOOLS } from "../src/library.js";
import type { State, Task } from "../src/model.js";
import { slotUses, startsNextCount } from "../src/scheduler.js";
import { Simulator } from "../src/sim.js";

function emptyState(limit = 2): State {
  return {
    now: 0,
    seq: 0,
    products: [{ id: "p", name: "Product", repo: "acme/product", tone: "blue" }],
    roles: BUILT_IN_ROLES,
    tools: KNOWN_TOOLS,
    profiles: DEFAULT_PROFILES,
    tasks: [],
    inbox: [],
    pool: { limit, paused: false, toolCaps: {} },
  };
}

function task(sim: Simulator, id: string): Task {
  const found = sim.getState().tasks.find((entry) => entry.id === id);
  if (!found) throw new Error(`no task ${id}`);
  return found;
}

/** Tick until `done`, settling the inbox the way a coordinator who says yes to everything would. */
function runUntil(sim: Simulator, done: () => boolean, limit = 300): void {
  for (let tick = 0; tick < limit && !done(); tick += 1) {
    sim.tick();
    for (const item of sim.getState().inbox) {
      if (item.kind === "question") sim.answer(item.id, item.options?.[0] ?? "Yes");
      else if (item.kind === "permission") sim.allow(item.id, "once");
      else sim.approve(item.id);
    }
  }
}

describe("Simulator", () => {
  it("takes a bug from the queue to an open pull request without ever merging it itself", () => {
    const sim = new Simulator(emptyState(), { prMergeAfter: 1_000 });
    const id = sim.addTask({ productId: "p", title: "Fix the broken link", kind: "bug" });

    runUntil(sim, () => task(sim, id).state === "pr-open");

    const done = task(sim, id);
    expect(done.state).toBe("pr-open");
    expect(done.column).toBe("ready");
    expect(done.pr?.state).toBe("open");
    // The first reviewer found a blocking issue, the builder fixed it, the second round passed.
    expect(done.findings.find((finding) => finding.severity === "blocking")?.status).toBe("fixed");
    expect(done.findings.find((finding) => finding.severity === "blocking")?.confirmedBy).toHaveLength(1);
  });

  it("waits at the delivery gate without holding a pool slot", () => {
    const sim = new Simulator(emptyState(1));
    const id = sim.addTask({ productId: "p", title: "Tidy the footer", kind: "chore" });
    for (let tick = 0; tick < 200 && !sim.getState().inbox.some((item) => item.kind === "delivery"); tick += 1) sim.tick();

    expect(task(sim, id).state).toBe("needs-you");
    expect(task(sim, id).holdsSlot).toBe(false);
    expect(slotUses(sim.getState())).toHaveLength(0);
  });

  it("settles a design only after the architect answers the blocking objection", () => {
    const sim = new Simulator(emptyState());
    const id = sim.addTask({ productId: "p", title: "Saved carts", kind: "feature" });
    for (let tick = 0; tick < 200 && !sim.getState().inbox.some((item) => item.kind === "design"); tick += 1) sim.tick();

    const designed = task(sim, id);
    expect(designed.brief).toBeDefined();
    expect(designed.objections.filter((objection) => objection.blocking).every((objection) => objection.status === "accepted")).toBe(true);
  });

  it("starts queued tasks in priority order and respects the pool limit", () => {
    const sim = new Simulator({ ...emptyState(1), pool: { limit: 1, paused: true, toolCaps: {} } });
    const a = sim.addTask({ productId: "p", title: "First", kind: "chore" });
    const b = sim.addTask({ productId: "p", title: "Second", kind: "chore", position: "top" });
    sim.setPoolPaused(false);

    expect(task(sim, b).state).toBe("running");
    expect(task(sim, a).state).toBe("queued");
  });

  it("delivers a queued message at the next step and an interrupt right away", () => {
    const sim = new Simulator(emptyState());
    const id = sim.addTask({ productId: "p", title: "Search", kind: "chore" });
    sim.sendMessage(id, "Keep it simple");
    expect(task(sim, id).queued).toHaveLength(1);

    sim.tick();
    expect(task(sim, id).queued).toHaveLength(0);
    expect(task(sim, id).session.some((line) => line.from === "you" && line.text === "Keep it simple")).toBe(true);

    sim.sendMessage(id, "Actually, stop and use the old icons", "interrupt");
    expect(task(sim, id).session.some((line) => line.text === "Actually, stop and use the old icons")).toBe(true);
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

  it("builds a demo board with work in every column and a consistent inbox", () => {
    const state = createDemoState(1_000_000_000);
    const columns = new Set(state.tasks.map((entry) => entry.column));
    for (const column of ["queue", "planning", "designing", "building", "reviewing", "ready", "done"]) expect(columns.has(column as Task["column"])).toBe(true);
    expect(new Set(state.inbox.map((item) => item.id)).size).toBe(state.inbox.length);
    expect(state.inbox.map((item) => item.kind).sort()).toEqual(["delivery", "permission", "plan", "question"]);
    expect(slotUses(state)).toHaveLength(3);
    expect(startsNextCount(state)).toBe(1);
  });

  it("builds a twenty-product portfolio that fits in its pool", () => {
    const { state } = createPortfolioDemo(1_000_000_000);
    expect(state.products).toHaveLength(20);
    expect(slotUses(state).length).toBeLessThanOrEqual(state.pool.limit);
    expect(new Set(state.inbox.map((item) => item.id)).size).toBe(state.inbox.length);
    expect(new Set(state.tasks.map((task) => task.productId)).size).toBe(16);
  });
});
