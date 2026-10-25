import { task, inboxItem } from "../../fixtures/simulator.js";
import { describe, expect, it } from "vitest";

import { CALL_WORDS } from "../../../src/call.js";

import { CLEANUP_WORDS } from "../../../src/cleanup.js";

import { createDemoState, createPortfolioDemo, DEMO_TRIGGERS } from "../../../src/demo.js";

import type { Task } from "../../../src/model.js";

import { slotUses, startsNextCount } from "../../../src/scheduler.js";

import { Simulator } from "../../../src/sim.js";

describe("The coordinator's call on a design disagreement", () => {
  const CALL = "Accept the blocking point: keep the confirmation step only for existing accounts.";

  it("lets the demo coordinator make the call on the demo disagreement", () => {
    const sim = new Simulator(createDemoState(1_000_000_000), { triggers: DEMO_TRIGGERS, prMergeAfter: 1_000 });
    const item = inboxItem(sim, "disagreement")!;
    expect(item.body).toBe(CALL_WORDS.disagreement);
    sim.requestChanges(item.id, CALL);
    for (let tick = 0; tick < 100 && !sim.getState().inbox.some((entry) => entry.kind === "design" && entry.taskId === item.taskId); tick += 1) {
      sim.tick();
      for (const entry of sim.getState().inbox) if (entry.taskId !== item.taskId && entry.kind === "question") sim.answer(entry.id, entry.options?.[0] ?? "Yes");
    }
    const check = sim.getState().inbox.find((entry) => entry.kind === "design" && entry.taskId === item.taskId);
    expect(check?.body).toContain("Your call settled");
    const settled = task(sim, item.taskId);
    expect(settled.brief?.summary).toContain("following your call");
    expect(settled.objections.some((objection) => objection.call === CALL)).toBe(true);
    expect(settled.objections.some((objection) => objection.status === "open")).toBe(false);
  });
});

describe("Removing the working copies of finished tasks", () => {
  const texts = (entry: Task) => entry.timeline.map((line) => line.text);

  it("shows the demo's finished tasks without their copies, one after a retry, and keeps open pull requests' copies", () => {
    const state = createDemoState(1_000_000_000);
    const byTitle = (title: string) => state.tasks.find((entry) => entry.title === title)!;
    expect(texts(byTitle("Report errors to Sentry")).slice(-2)).toEqual([CLEANUP_WORDS.failed(CLEANUP_WORDS.locked), CLEANUP_WORDS.removed]);
    expect(texts(byTitle("Fix the footer links")).at(-1)).toBe(CLEANUP_WORDS.removed);
    for (const entry of state.tasks.filter((item) => item.state !== "done" && item.state !== "cancelled")) expect(entry.cleanup).toBeUndefined();

    const { state: portfolio } = createPortfolioDemo(1_000_000_000);
    for (const entry of portfolio.tasks) expect(entry.cleanup?.removedAt !== undefined).toBe(entry.state === "done" || entry.state === "cancelled");
  });
});

describe("Simulator", () => {
  it("builds a demo board with work in every column and a consistent inbox", () => {
    const state = createDemoState(1_000_000_000);
    const columns = new Set(state.tasks.map((entry) => entry.column));
    for (const column of ["queue", "planning", "designing", "building", "reviewing", "ready", "done"]) expect(columns.has(column as Task["column"])).toBe(true);
    expect(new Set(state.inbox.map((item) => item.id)).size).toBe(state.inbox.length);
    expect(state.inbox.map((item) => item.kind).sort()).toEqual(["delivery", "disagreement", "guide", "learnings", "permission", "plan", "question", "screen"]);
    // The reviewers of "Fix login loop on Safari" look at the change together: two slots for that task.
    expect(slotUses(state)).toHaveLength(4);
    expect(startsNextCount(state)).toBe(1);
  });

  it("builds a twenty-product portfolio that fits in its pool", () => {
    const { state } = createPortfolioDemo(1_000_000_000);
    expect(state.products).toHaveLength(20);
    expect(slotUses(state).length).toBeLessThanOrEqual(state.pool.limit);
    expect(new Set(state.inbox.map((item) => item.id)).size).toBe(state.inbox.length);
    // The last four products are quiet: nothing on the board, nothing in their history.
    const quiet = new Set(state.products.slice(16).map((product) => product.id));
    expect(state.tasks.some((task) => quiet.has(task.productId))).toBe(false);
  });
});
