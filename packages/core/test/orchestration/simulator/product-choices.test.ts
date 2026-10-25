import { emptyState, task, runUntil, inboxItem, tickUntil } from "../../fixtures/simulator.js";
import { describe, expect, it } from "vitest";

import { Simulator } from "../../../src/sim.js";

describe("starting choices in the demo", () => {
  for (const startFrom of [{ kind: "default" }, { kind: "pull-request", value: "7" }] as const) it(`asks for confirmation of a ${startFrom.kind === "default" ? "planner-selected product" : "pull request destination"} with the optional plan check off`, () => {
    const sim = new Simulator(emptyState());
    const id = sim.addTask({ productId: startFrom.kind === "default" ? "" : "p", title: "A small change", kind: "chore", approvePlan: false, startFrom });
    for (let tick = 0; tick < 30 && !sim.getState().inbox.some((item) => item.taskId === id && item.kind === "plan"); tick++) sim.tick();
    const plan = sim.getState().inbox.find((item) => item.taskId === id && item.kind === "plan");
    expect(plan?.body).toContain("Works on: Product");
    expect(task(sim, id).approvePlan).toBe(false);
    sim.approve(plan!.id);
    expect(task(sim, id).confirmWork).toBe(false);
    expect(task(sim, id).source?.confirmed).toBe(true);
  });
});

describe("New task product rows", () => {
  it("lets the demo planner propose a product when none were selected, then keeps edits at approval", async () => {
    const sim = new Simulator(emptyState());
    const id = sim.addTask({ productId: "", worksOn: [], title: "Let the planner choose", kind: "chore" });
    const gate = tickUntil(sim, "plan");
    expect(task(sim, id).selectedProducts).toEqual([]);
    expect(task(sim, id).workRows).toHaveLength(1);
    expect(task(sim, id).workRows![0]!.change).toBe("added");
    const reason = task(sim, id).workRows![0]!.choice.reason;
    await sim.setTaskStart(id, { productId: "p", startFrom: { kind: "branch", name: "chosen-branch" }, delivery: "local" });
    expect(task(sim, id).workRows![0]!.change).toBe("added");
    expect(task(sim, id).workRows![0]!.choice.reason).toBe(reason);
    const resumed = new Simulator(sim.getState());
    expect(task(resumed, id).workRows![0]!.change).toBe("added");
    sim.approve(gate.id);
    expect(task(sim, id).repositories![0]!.source!.destination).toMatchObject({ branch: "chosen-branch", mode: "local" });
    expect(task(sim, id).delivery).toBe("local");
  });

  for (const count of [1, 2]) it(`keeps edits to each of ${count} product rows through approval and delivery`, async () => {
    const initial = emptyState();
    const products = [initial.products[0]!, { ...initial.products[0]!, id: "api", name: "API", repo: "acme/api" }].slice(0, count);
    const sim = new Simulator({ ...initial, products });
    const id = sim.addTask({ productId: "p", worksOn: products.map((product) => ({ productId: product.id, startFrom: { kind: "default" }, delivery: "pull-request" })), title: "Edit approved choices", kind: "chore", approvePlan: true, approveDelivery: true });
    const gate = tickUntil(sim, "plan");
    for (const [index, product] of products.entries()) {
      const choice = { productId: product.id, startFrom: { kind: "branch" as const, name: `release-${index}` }, delivery: "local" as const, lead: index === count - 1 };
      await sim.setTaskStart(id, choice);
      expect(task(sim, id).workRows![index]!.choice).toEqual(choice);
      expect(task(sim, id).workRows![index]!.source!.start).toEqual({ kind: "branch", branch: `release-${index}` });
    }
    sim.approve(gate.id);
    for (const [index, work] of task(sim, id).repositories!.entries()) {
      expect(work.source!.start).toEqual({ kind: "branch", branch: `release-${index}` });
      expect(work.source!.destination).toMatchObject({ mode: "local", kind: "branch", branch: `release-${index}` });
      expect(work.workChoice).toEqual(task(sim, id).workRows![index]!.choice);
    }
    expect(task(sim, id).leadProductId).toBe(products[count - 1]!.id);
    expect(task(sim, id).source).toEqual(task(sim, id).repositories![0]!.source);
    expect(task(sim, id).delivery).toBe("local");
    expect(task(sim, id).plan!.stages.find((stage) => stage.kind === "do" && stage.roleId === "release-manager")!.title).toBe(count > 1 ? "Deliver across 2 products" : "Commit to release-0");
    runUntil(sim, () => task(sim, id).state === "done");
    expect(task(sim, id).repositories!.map((work) => work.landed?.branch)).toEqual(products.map((_, index) => `release-${index}`));
    expect(task(sim, id).repositories!.every((work) => !work.pr)).toBe(true);
  });

  for (const startFrom of [{ kind: "default" }, { kind: "branch", name: "release-2.x" }, { kind: "pull-request", value: "7" }] as const) {
    for (const delivery of ["local", "pull-request"] as const) it(`preserves one product's ${startFrom.kind} start and ${delivery} delivery`, () => {
      const legacy = new Simulator(emptyState());
      const rows = new Simulator(emptyState());
      const previous = legacy.addTask({ productId: "p", title: "Keep the choice", kind: "chore", startFrom, delivery });
      const current = rows.addTask({ productId: "", worksOn: [{ productId: "p", startFrom, delivery }], title: "Keep the choice", kind: "chore" });
      const expected = task(legacy, previous), actual = task(rows, current);
      expect(actual.workChoice).toEqual(expected.workChoice);
      expect(actual.source).toEqual(expected.source);
      expect(actual.delivery).toBe(delivery);
      expect(actual.confirmWork).toBe(expected.confirmWork);
      runUntil(rows, () => !!inboxItem(rows, "delivery"));
      expect(task(rows, current).source).toEqual(expected.source);
      expect(task(rows, current).delivery).toBe(delivery);
    });
  }
});
