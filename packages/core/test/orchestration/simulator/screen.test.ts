import { describe, expect, it } from "vitest";

import { BUILT_IN_ROLES, DEFAULT_PROFILES, KNOWN_TOOLS } from "../../../src/library.js";
import type { State, Task } from "../../../src/model.js";

import { slotUses, startsNextCount } from "../../../src/scheduler.js";
import { onScreen, SCREEN_HOUR_MS, screenMode, screenOn, screenWait } from "../../../src/screen.js";
import { MemoryWorkLog } from "../../../src/worklog.js";
import { Simulator } from "../../../src/sim.js";

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
