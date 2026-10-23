import { describe, expect, it } from "vitest";
import { createDemoState, createPortfolioDemo, DEMO_TRIGGERS } from "../src/demo.js";
import { BUILT_IN_ROLES, DEFAULT_PROFILES, KNOWN_TOOLS } from "../src/library.js";
import type { State, Task } from "../src/model.js";
import { inboxOrder } from "../src/navigation.js";
import { slotUses, startsNextCount } from "../src/scheduler.js";
import { onScreen, SCREEN_HOUR_MS, screenMode, screenNext, screenOn, screenQueue, screenReason, screenWait } from "../src/screen.js";
import { MemoryWorkLog } from "../src/worklog.js";
import { Simulator } from "../src/sim.js";

const REASON = "Click through the quick note window";

function emptyState(limit: number): State {
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

/** Tasks whose builders need the screen at the same moment of their step. */
function screenSim(count: number, limit = 4): { sim: Simulator; ids: string[]; log: MemoryWorkLog } {
  const log = new MemoryWorkLog(0);
  const seed = new Simulator(emptyState(limit), { log, prMergeAfter: 1_000 });
  const ids = Array.from({ length: count }, (_, index) => seed.addTask({ productId: "p", title: `Quick note window ${index + 1}`, kind: "bug" }));
  const triggers = Object.fromEntries(ids.map((id) => [`${id}|builder|1|2`, { kind: "screen" as const, title: REASON }]));
  return { sim: new Simulator(seed.getState(), { triggers, log, prMergeAfter: 1_000 }), ids, log };
}

const task = (sim: Simulator, id: string): Task => sim.getState().tasks.find((entry) => entry.id === id)!;
const asking = (sim: Simulator, id: string) => {
  const found = task(sim, id);
  return found.state === "waiting" && found.screen !== undefined && !found.screen.granted;
};
const items = (sim: Simulator) => sim.getState().inbox.filter((item) => item.kind === "screen");
const timeline = (sim: Simulator, id: string) => task(sim, id).timeline.map((entry) => entry.text);

/** Tick until `done`, saying yes to everything except the screen: that stays the test's call. */
function tickUntil(sim: Simulator, done: () => boolean, limit = 300): void {
  for (let tick = 0; tick < limit && !done(); tick += 1) {
    sim.tick();
    for (const item of sim.getState().inbox) {
      if (item.kind === "question") sim.answer(item.id, item.options?.[0] ?? "Yes");
      else if (item.kind === "permission") sim.allow(item.id, "once");
      else if (item.kind !== "screen") sim.approve(item.id);
    }
  }
  if (!done()) throw new Error("never got there");
}

describe("the screen switch", () => {
  it.each(["waiting", "needs-you"] as const)("keeps an unapproved held request answerable while %s without putting it in the screen line", (taskState) => {
    const { sim, ids } = screenSim(1);
    tickUntil(sim, () => asking(sim, ids[0]!));
    const state = sim.getState();
    const held = state.tasks.find(task => task.id === ids[0])!;
    held.state = taskState;
    held.runtimeWait = { after: ["fix"], reason: "Wait for the fix", changes: [] };
    expect(screenWait(held, state, state.now)).toBe("ask");
    expect(screenQueue(state.tasks)).toEqual([]);
    expect(screenNext(state, state.now)).toBeUndefined();
    held.screen!.allowed = true;
    expect(screenWait(held, state, state.now)).toBeUndefined();
    expect(screenQueue(state.tasks)).toEqual([]);
    expect(screenNext(state, state.now)).toBeUndefined();
    held.runtimeWait.releasedAt = state.now;
    expect(screenNext(state, state.now)).toBe(held.id);
  });

  it("keeps a held request out of the screen line and restores its saved place when released", () => {
    const { sim, ids } = screenSim(2);
    tickUntil(sim, () => ids.every(id => asking(sim, id)));
    const initial = sim.getState();
    const state = { ...initial, tasks: initial.tasks.map(task => ({ ...task })), pool: { ...initial.pool, screen: { mode: "on" as const } } };
    const [first, second] = screenQueue(state.tasks);
    expect(screenNext(state, state.now)).toBe(first!.id);
    Object.assign(first!, { runtimeWait: { after: ["fix"], reason: "Wait for the fix", changes: [] } });
    expect(screenQueue(state.tasks).map(task => task.id)).toEqual([second!.id]);
    expect(screenNext(state, state.now)).toBe(second!.id);
    expect(screenWait(first!, state, state.now)).toBeUndefined();
    Object.assign(first!.runtimeWait!, { releasedAt: state.now });
    expect(screenNext(state, state.now)).toBe(first!.id);
    // A currently admitted screen agent retains exclusive use until the engine records its boundary.
    Object.assign(first!, { state: "running", runtimeWait: { after: ["fix"], reason: "Wait for the fix", changes: [] }, screen: { ...first!.screen!, granted: true } });
    expect(onScreen(state.tasks)?.id).toBe(first!.id);
    expect(screenNext(state, state.now)).toBeUndefined();
  });

  it("is Off unless turned on, and For an hour turns itself off when it runs out", () => {
    const state = emptyState(2);
    expect(screenMode(state.pool, 0)).toBe("off");
    const { sim } = screenSim(0);
    sim.setScreenUse("hour");
    const until = sim.getState().pool.screen!.until!;
    expect(until).toBe(sim.getState().now + SCREEN_HOUR_MS);
    expect(screenOn(sim.getState().pool, until - 1)).toBe(true);
    expect(screenOn(sim.getState().pool, until)).toBe(false);
    sim.tick(until + 1);
    expect(sim.getState().pool.screen).toEqual({ mode: "off" });
  });

  it("keeps an agent's reason on one short line", () => {
    expect(screenReason("  Click the menu\n  bar icon ")).toBe("Click the menu bar icon");
    expect(screenReason("x".repeat(400))).toHaveLength(160);
  });
});

describe("a simulated agent that needs the screen", () => {
  it.each([false, true])("records the screen continuation as a new turn, leaving waiting time out (allowed at once: %s)", (immediate) => {
    const { sim, ids, log } = screenSim(1);
    const [id] = ids as [string];
    const turns = () => log.turns({ taskId: id }).filter((turn) => turn.roleId === "builder");
    if (immediate) sim.setScreenUse("on");
    tickUntil(sim, () => task(sim, id).screen !== undefined);
    expect(turns()[0]).toMatchObject({ reason: "first", end: "finished" });
    if (!immediate) {
      expect(turns()).toHaveLength(1);
      sim.tick(sim.getState().now + SCREEN_HOUR_MS);
      expect(turns()).toHaveLength(1);
      sim.allowScreen(id);
    }
    expect(turns().map((turn) => turn.reason)).toEqual(["first", "continue"]);
    expect(turns()[1]!.end).toBeUndefined();
    tickUntil(sim, () => task(sim, id).screen === undefined);
    const [before, after] = turns();
    expect(after!.end).toBe("finished");
    expect(before!.endedAt!).toBeLessThanOrEqual(after!.startedAt);
    if (!immediate) expect(after!.startedAt - before!.endedAt!).toBeGreaterThanOrEqual(SCREEN_HOUR_MS);
  });

  it("waits without a slot while the switch is off, then picks up where it left off when it is turned on", () => {
    const { sim, ids } = screenSim(1);
    const [id] = ids as [string];
    tickUntil(sim, () => asking(sim, id));
    const waiting = task(sim, id);
    const step = waiting.screen!.step!;
    expect(waiting.holdsSlot).toBe(false);
    expect(waiting.statusLine).toBe(`Needs the screen for: ${REASON}`);
    expect(screenWait(waiting, sim.getState(), sim.getState().now)).toBe("ask");
    expect(slotUses(sim.getState())).toEqual([]);
    expect(items(sim)).toEqual([expect.objectContaining({ taskId: id, blocking: false, title: `Needs the screen for: ${REASON}` })]);
    // It does not hold back the queue.
    sim.addTask({ productId: "p", title: "Something else" });
    expect(startsNextCount(sim.getState())).toBe(0);
    sim.tick();
    expect(asking(sim, id)).toBe(true);

    sim.setScreenUse("on");
    const running = task(sim, id);
    expect(running.state).toBe("running");
    expect(running.screen).toMatchObject({ granted: true, heard: true });
    expect(running.agent?.step).toBe(step);
    expect(timeline(sim, id)).toContain("Picked up where it left off, now using the screen");
    expect(items(sim)).toEqual([]);
    // Its step ends: the screen is free again.
    tickUntil(sim, () => task(sim, id).agent?.roleId !== "builder");
    expect(task(sim, id).screen).toBeUndefined();
  });

  it("continues on Allow now, and gets the screen at once when it is allowed and free", () => {
    const { sim, ids } = screenSim(1);
    const [id] = ids as [string];
    tickUntil(sim, () => asking(sim, id));
    // Allowed while the pool is paused: it waits for the pool like any other task.
    sim.setPoolPaused(true);
    sim.allowScreen(id);
    expect(task(sim, id).statusLine).toBe("Waiting for the pool to resume");
    expect(screenWait(task(sim, id), sim.getState(), sim.getState().now)).toBeUndefined();
    expect(items(sim)).toEqual([]);
    sim.setPoolPaused(false);
    expect(task(sim, id).screen?.granted).toBe(true);
    expect(timeline(sim, id)).toContain("You allowed the screen for this request");

    const fresh = screenSim(1);
    fresh.sim.setScreenUse("on");
    const [other] = fresh.ids as [string];
    let waited = false;
    tickUntil(fresh.sim, () => {
      waited ||= asking(fresh.sim, other);
      return task(fresh.sim, other).screen?.granted === true;
    });
    expect(waited).toBe(false);
    expect(task(fresh.sim, other).holdsSlot).toBe(true);
    expect(timeline(fresh.sim, other)).toContain(`Using the screen for: ${REASON}`);
  });

  it("gives the screen to one agent at a time, first asked first served, the next when the first's step ends", () => {
    const { sim, ids } = screenSim(2);
    sim.setScreenUse("on");
    let most = 0;
    sim.subscribe(() => {
      most = Math.max(most, sim.getState().tasks.filter((entry) => entry.screen?.granted).length);
    });
    tickUntil(sim, () => ids.some((id) => asking(sim, id)));
    const holder = onScreen(sim.getState().tasks)!;
    const other = ids.find((id) => id !== holder.id)!;
    expect(task(sim, other).statusLine).toBe("Waiting its turn on the screen");
    expect(task(sim, other).holdsSlot).toBe(false);
    expect(items(sim)).toEqual([]);
    tickUntil(sim, () => task(sim, other).screen?.granted === true);
    expect(task(sim, holder.id).screen).toBeUndefined();
    expect(timeline(sim, other)).toContain("Picked up where it left off, now using the screen");
    expect(most).toBe(1);
  });

  it("goes ahead for a task allowed the screen while the switch is off; others still wait", () => {
    const { sim, ids } = screenSim(2);
    const [allowed, other] = ids as [string, string];
    sim.setTaskScreen(allowed, true);
    tickUntil(sim, () => asking(sim, other) && task(sim, allowed).screen?.granted === true);
    expect(items(sim).map((item) => item.taskId)).toEqual([other]);
    expect(timeline(sim, allowed)).toContain("You allowed the screen for this task");
    sim.setTaskScreen(allowed, false);
    expect(task(sim, allowed).screen?.granted).toBe(true);
  });

  it("lets the agent on the screen finish when the switch goes off; Allow now keeps its OK for this request", () => {
    const { sim, ids } = screenSim(2);
    sim.setScreenUse("on");
    tickUntil(sim, () => ids.some((id) => asking(sim, id)));
    const holder = onScreen(sim.getState().tasks)!.id;
    const other = ids.find((id) => id !== holder)!;

    sim.setScreenUse("off");
    expect(task(sim, holder).screen?.granted).toBe(true);
    expect(task(sim, holder).state).toBe("running");
    expect(task(sim, other).statusLine).toBe(`Needs the screen for: ${REASON}`);
    expect(items(sim).map((item) => item.taskId)).toEqual([other]);

    // Nobody new gets the screen once the holder's step ends.
    tickUntil(sim, () => task(sim, holder).screen === undefined);
    for (let tick = 0; tick < 5; tick += 1) sim.tick();
    expect(asking(sim, other)).toBe(true);

    // Allow now is for this request: the switch going on and off again does not take it back.
    sim.allowScreen(other);
    expect(task(sim, other).screen?.granted).toBe(true);
    sim.setScreenUse("on");
    sim.setScreenUse("off");
    expect(task(sim, other).screen?.granted).toBe(true);
  });

  it("drops the quiet item when the task is paused or cancelled", () => {
    const { sim, ids } = screenSim(2);
    const [paused, cancelled] = ids as [string, string];
    tickUntil(sim, () => ids.every((id) => asking(sim, id)));
    expect(items(sim)).toHaveLength(2);
    sim.pause(paused);
    sim.cancel(cancelled);
    expect(items(sim)).toEqual([]);
    expect(task(sim, paused).screen).toBeUndefined();
  });
});

describe("the demo", () => {
  it("shows a builder waiting for the screen with its reason, listed last in the inbox, and Allow now continues it", () => {
    const state = createDemoState(1_000_000_000);
    const waiting = state.tasks.find((entry) => entry.screen)!;
    expect(waiting.title).toBe("Quick note window opens behind others");
    expect(waiting.state).toBe("waiting");
    expect(waiting.holdsSlot).toBe(false);
    expect(waiting.statusLine).toBe(`Needs the screen for: ${DEMO_TRIGGERS["quick-note|builder|1|3"]!.title}`);
    expect(inboxOrder(state).at(-1)).toMatchObject({ kind: "screen", taskId: waiting.id, blocking: false });

    const sim = new Simulator(state, { triggers: DEMO_TRIGGERS });
    sim.allowScreen(waiting.id);
    expect(task(sim, waiting.id).state).toBe("running");
    expect(onScreen(sim.getState().tasks)?.id).toBe(waiting.id);

    const portfolio = createPortfolioDemo(1_000_000_000).state;
    expect(portfolio.tasks.filter((entry) => entry.screen && entry.state === "waiting")).toHaveLength(1);
    expect(portfolio.inbox.filter((item) => item.kind === "screen")).toHaveLength(1);
  });
});
