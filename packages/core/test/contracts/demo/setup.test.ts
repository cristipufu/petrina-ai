import { describe, expect, it } from "vitest";
import { createFirstRunDemo, DEMO_PRODUCTS } from "../../../src/demo.js";
import { Simulator } from "../../../src/sim.js";

describe("first run's demo", () => {
  it("has one tool Ready, one Not installed and one Not logged in, and nothing added yet", () => {
    const { state } = createFirstRunDemo(1_000_000);
    expect(state.products).toEqual([]);
    expect(state.tasks).toEqual([]);
    expect(state.setup?.done).toBe(false);
    expect(state.setup?.checks.filter((check) => ["claude-code", "codex", "gh"].includes(check.id)).map((check) => check.status)).toEqual(["ready", "not-installed", "logged-out"]);
  });

  it("starts with an empty history and records the first product and task in Analytics", () => {
    const now = 1_000_000;
    const demo = createFirstRunDemo(now);
    const sim = new Simulator(demo.state, { log: demo.log, open: demo.open, quirks: demo.quirks, triggers: demo.triggers });
    expect(sim.usage({ view: "analytics", period: "today" }).headline.turns).toBe(0);
    expect(sim.usage({ view: "analytics", period: "today" }).limits.tools).toEqual([]);
    expect(demo.log.products()).toEqual([]);
    const product = DEMO_PRODUCTS[0]!;
    sim.addProduct(product);
    sim.addProduct(product);
    expect(demo.log.products()).toEqual([{ id: product.id, name: product.name, repo: product.repo, addedAt: now }]);
    const request = { productId: product.id, title: "Add a greeting", approvePlan: true, clientId: "first-task" };
    const taskId = sim.startFirstTask(request);
    expect(sim.startFirstTask(request)).toBe(taskId);
    // The planner takes several actions under each to-do item: advance to its result, not a fixed action count.
    for (let tick = 0; tick < 30 && !sim.getState().inbox.some((item) => item.kind === "plan"); tick += 1) sim.tick();
    expect(sim.getState().inbox.some((item) => item.kind === "plan")).toBe(true);
    expect(sim.getState().tasks).toHaveLength(1);
    const usage = sim.usage({ view: "analytics", period: "today" });
    expect(usage.headline.turns).toBeGreaterThan(0);
    expect(usage.byProduct).toContainEqual(expect.objectContaining({ productId: product.id, label: product.name }));
  });
});
