import { describe, expect, it } from "vitest";
import { Simulator } from "../../../src/sim.js";
import { productState as state } from "../../fixtures/products.js";

describe("product settings in the simulator", () => {
  it("saves name and defaults together, leaves existing tasks and repository identity alone, and rejects the whole save on error", () => {
    const sim = new Simulator(state());
    const oldId = sim.addTask({ productId: "p", title: "Existing task" });
    const before = sim.getState();
    expect(() => sim.updateProduct("p", { name: "shop api", delivery: "local", approveDelivery: false })).toThrow();
    expect(sim.getState()).toEqual(before);
    sim.updateProduct("p", { name: "  Petrina HQ  ", delivery: "local", approveDelivery: false });
    expect(sim.getState().products[0]).toEqual({ ...before.products[0], name: "Petrina HQ", delivery: "local", approveDelivery: false });
    expect(sim.getState().tasks.find((task) => task.id === oldId)).toEqual(before.tasks[0]);
    const id = sim.addTask({ productId: "p", title: "Next task" });
    expect(sim.getState().tasks.find((task) => task.id === id)).toMatchObject({ delivery: "local", approveDelivery: false });
    sim.setPoolPaused(false);
    sim.tick(); sim.tick();
    expect(sim.getState().tasks[0]!.timeline.some((entry) => entry.text.includes("Petrina HQ"))).toBe(true);
  });

  it("refuses removal until every task is finished or cancelled, then removes tasks and their inbox together", () => {
    const seed = new Simulator(state());
    seed.addTask({ productId: "p", title: "History" });
    seed.addTask({ productId: "q", title: "Other product" });
    const task = seed.getState().tasks[0]!;
    for (const runState of ["queued", "waiting", "running", "needs-you", "paused", "failed", "pr-open"] as const) {
      const sim = new Simulator({ ...seed.getState(), tasks: [{ ...task, state: runState }] });
      expect(() => sim.removeProduct("p")).toThrow("1 task must finish or be cancelled");
    }
    const sim = new Simulator({ ...seed.getState(), tasks: [{ ...task, state: "done" }, { ...task, id: "cancelled", state: "cancelled" }, seed.getState().tasks[1]!], inbox: [
      { id: "old", taskId: task.id, kind: "question", title: "Old question", at: 0, blocking: false },
      { id: "other", taskId: seed.getState().tasks[1]!.id, kind: "question", title: "Other question", at: 0, blocking: false },
    ] });
    sim.removeProduct("p");
    expect(sim.getState().products.map((product) => product.id)).toEqual(["q"]);
    expect(sim.getState().tasks.map((task) => task.productId)).toEqual(["q"]);
    expect(sim.getState().inbox.map((item) => item.id)).toEqual(["other"]);
  });
});
