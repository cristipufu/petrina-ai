import { stateFixture } from "../../fixtures/state.js";
import { describe, expect, it } from "vitest";

import { taskProductIds } from "../../../src/repositories.js";
import { Simulator } from "../../../src/sim.js";

describe("shared task ownership and landing", () => {
  it("shows the same shared companion preview in the demo and needs only one delivery decision", () => {
    const initial = stateFixture({ now: 1_000_000_000 });
    const products = initial.products.slice(0, 2).map((product) => ({ ...product, approveDelivery: true, shipLowRisk: false }));
    const simulator = new Simulator({ ...initial, products, tasks: [], inbox: [], pool: { ...initial.pool, paused: false } });
    const id = simulator.addTask({ productId: products[0]!.id, worksOn: products.map((product) => ({ productId: product.id, startFrom: { kind: "default" }, delivery: "pull-request" })), title: "One approved linked delivery", kind: "chore", approvePlan: true, approveDelivery: true });
    let decisions = 0;
    for (let tick = 0; tick < 300 && !["done", "pr-open"].includes(simulator.getState().tasks[0]!.state); tick += 1) {
      for (const item of simulator.getState().inbox) if (["plan", "design", "delivery"].includes(item.kind)) {
        if (item.kind === "delivery") {
          decisions++;
          for (const product of products) expect(item.body).toContain(`${product.repo}; link pending`);
          expect(item.body).toContain("visible to anyone who can read it");
        }
        simulator.approve(item.id);
      }
      simulator.tick();
    }
    expect(simulator.getState().tasks.find((task) => task.id === id)?.state).toBe("pr-open");
    expect(decisions).toBe(1);
  });

  it("keeps shared history when the first product is removed and deletes it only with the last product", () => {
    const initial = stateFixture({ now: 1_000_000_000 });
    const simulator = new Simulator({ ...initial, tasks: [], inbox: [], pool: { ...initial.pool, paused: false } });
    const products = initial.products.slice(0, 2);
    const id = simulator.addTask({ productId: products[0]!.id, worksOn: products.map((product) => ({ productId: product.id, startFrom: { kind: "default" }, delivery: "local" })), title: "Keep shared history", kind: "chore", approvePlan: true, approveDelivery: true });
    for (let tick = 0; tick < 300 && simulator.getState().tasks[0]?.state !== "done"; tick += 1) {
      for (const item of simulator.getState().inbox) if (["plan", "design", "delivery"].includes(item.kind)) simulator.approve(item.id);
      simulator.tick();
    }
    const done = simulator.getState().tasks[0]!;
    expect(done.state).toBe("done");
    expect(done.repositories).toHaveLength(2);
    const history = done.timeline;
    simulator.removeProduct(products[0]!.id);
    const retained = simulator.getState().tasks.find((entry) => entry.id === id)!;
    expect(retained.timeline).toEqual(history);
    expect(taskProductIds(retained)).toEqual([products[1]!.id]);
    expect(retained.repositories![0]!.source!.product.name).toBe(products[0]!.name);
    simulator.removeProduct(products[1]!.id);
    expect(simulator.getState().tasks).toHaveLength(0);
    expect(simulator.getState().inbox).toHaveLength(0);
  });
});
