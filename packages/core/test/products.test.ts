import { describe, expect, it } from "vitest";
import { BUILT_IN_ROLES, DEFAULT_PROFILES, KNOWN_TOOLS } from "../src/library.js";
import type { State } from "../src/model.js";
import { productName, suggestProductName } from "../src/products.js";
import { Simulator } from "../src/sim.js";

function state(): State {
  return { now: 0, seq: 0, products: [
    { id: "p", name: "Petrina AI", repo: "acme/petrina-ai", path: "/code/petrina-ai", tone: "blue", delivery: "pull-request", approveDelivery: true },
    { id: "q", name: "Shop API", repo: "acme/shop-api", tone: "green" },
  ], tasks: [], inbox: [], roles: BUILT_IN_ROLES, profiles: DEFAULT_PROFILES, tools: KNOWN_TOOLS, pool: { limit: 3, paused: true, toolCaps: {} } };
}

describe("product names and settings", () => {
  it("suggests a name from the folder, preserving written capitals and common abbreviations", () => {
    for (const [path, name] of [
      ["/code/petrina-ai/", "Petrina AI"], ["C:\\code\\shop_api", "Shop API"], ["some-ui-ux-cli-sdk", "Some UI UX CLI SDK"],
      ["/code/my-iPhone-aPi", "My iPhone aPi"], [" /code/petrina_ai ", "Petrina AI"], ["", ""],
    ]) expect(suggestProductName(path!)).toBe(name);
  });

  it("trims names, refuses duplicates regardless of case, and enforces one line and 60 characters", () => {
    expect(productName("  New name  ", state().products)).toBe("New name");
    expect(productName("Petrina AI", state().products, "p")).toBe("Petrina AI");
    expect(productName("a".repeat(60), [])).toHaveLength(60);
    for (const name of ["", "  ", "a".repeat(61), "one\ntwo", "one\rtwo", "one\u2028two", "one\u2029two"]) expect(() => productName(name, [])).toThrow();
    expect(() => productName("shop api", state().products)).toThrow("Another product is already called Shop API.");
  });

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
