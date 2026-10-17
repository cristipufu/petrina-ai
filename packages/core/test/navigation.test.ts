import { describe, expect, it } from "vitest";
import { boardOrder, inboxOrder, inboxTab, keyArea, matchesWords, queueNeighbour, queuePlacement, reconcileHighlight, searchTasks, stepHighlight } from "../src/navigation.js";
import { createDemoState, createPortfolioDemo } from "../src/demo.js";
import { Simulator } from "../src/sim.js";
import { queueOf } from "../src/scheduler.js";

const demo = createDemoState(1_000_000);

describe("palette search", () => {
  it("matches every word across title and product, in any word order and case", () => {
    expect(matchesWords(" shop GUEST ", "Guest checkout", "Shop")).toBe(true);
    expect(matchesWords("guest missing", "Guest checkout", "Shop")).toBe(false);
    expect(searchTasks(demo, "checkout").map((task) => task.title)).toContain("Guest checkout");
    expect(searchTasks(demo, "shop guest").map((task) => task.title)).toContain("Guest checkout");
    expect(searchTasks(demo, "shop guest absent")).toEqual([]);
  });
  it("searches the whole portfolio, with attention first and finished tasks last", () => {
    const state = createPortfolioDemo(1_000_000).state;
    const results = searchTasks(state, "");
    expect(state.products.length).toBeGreaterThanOrEqual(20);
    expect(results.length).toBe(state.tasks.length);
    expect(new Set(results.map((task) => task.productId)).size).toBeGreaterThan(10);
    const ranks = results.map((task) => ["needs-you", "failed"].includes(task.state) ? 0 : ["done", "cancelled"].includes(task.state) ? 2 : 1);
    expect(ranks).toEqual([...ranks].sort());
  });
});

describe("keyboard ownership and order", () => {
  it("uses the displayed board order and skips filtered and folded cards", () => {
    const all = boardOrder(demo.tasks, () => true, false);
    expect(all).not.toContain(demo.tasks.find((task) => task.state === "done")!.id);
    expect(stepHighlight(all, undefined, -1)).toBe(all[0]);
    expect(stepHighlight(all, all[0], -1)).toBe(all[0]);
    expect(stepHighlight(all, all.at(-1), 1)).toBe(all.at(-1));
    const filtered = boardOrder(demo.tasks, (task) => task.productId === "shop", true);
    expect(filtered.every((id) => demo.tasks.find((task) => task.id === id)!.productId === "shop")).toBe(true);
  });
  it("keeps its task through live changes and takes its old place only after removal", () => {
    expect(reconcileHighlight(["a", "b", "c"], ["c", "a", "b"], "b")).toBe("b");
    expect(reconcileHighlight(["a", "b", "c"], ["a", "c"], "b")).toBe("c");
    expect(reconcileHighlight(["a", "b"], ["a"], "b")).toBe("a");
    expect(reconcileHighlight(["a"], [], "a")).toBeUndefined();
    expect(reconcileHighlight([], ["new"], undefined)).toBeUndefined();
  });
  it("lets a task take precedence and rests board keys on every other page", () => {
    for (const page of ["products", "agents", "library", "settings"] as const) {
      expect(keyArea(page, true, "board", false)).toBeUndefined();
      expect(keyArea(page, true, "inbox", false)).toBe("inbox");
      expect(keyArea(page, true, "inbox", true)).toBe("task");
      expect(keyArea(page, false, "inbox", false)).toBeUndefined();
    }
    expect(keyArea("board", false, "inbox", false)).toBe("board");
  });
  it("uses inbox display order and the relevant tab for each kind of request", () => {
    expect(inboxOrder(demo)[0]?.blocking).toBe(true);
    expect(["plan", "design", "disagreement", "delivery", "question", "permission", "stuck"].map((kind) => inboxTab(kind as Parameters<typeof inboxTab>[0]))).toEqual(["plan", "design", "design", "review", "session", "session", "session"]);
  });
});

describe("queue moves beside visible neighbours", () => {
  const make = (ids: string[]) => new Simulator({ ...demo, inbox: [], tasks: ids.map((id, priority) => ({ ...demo.tasks[0]!, id, state: "queued", column: "queue", held: id === "A1", priority, holdsSlot: false })), pool: { ...demo.pool, paused: true } });
  const ids = (sim: Simulator) => queueOf(sim.getState().tasks).map((task) => task.id);
  it("moves A2 directly before A1, passing B1 while product B is hidden", () => {
    const sim = make(["A1", "B1", "A2"]);
    expect(sim.moveVisibleInQueue("A2", ["A1", "A2"], -1)).toBe(1);
    expect(ids(sim)).toEqual(["A2", "A1", "B1"]);
  });
  it("drops below the last visible card directly behind it, before hidden trailing cards", () => {
    const sim = make(["A1", "B1", "A2", "B2"]);
    sim.placeInQueue("A1", "A2", "after");
    expect(ids(sim)).toEqual(["B1", "A2", "A1", "B2"]);
  });
  it("builds three quick moves on the latest queue, counting held cards as places", () => {
    const sim = make(["A1", "B1", "A2", "B2", "A3", "A4"]);
    const visible = ["A1", "A2", "A3", "A4"];
    for (let n = 0; n < 3; n++) sim.moveVisibleInQueue("A4", visible, -1);
    expect(ids(sim)).toEqual(["A4", "A1", "B1", "A2", "B2", "A3"]);
    expect(queueNeighbour(ids(sim), visible, "A4", -1)).toBeUndefined();
    expect(queuePlacement(ids(sim), "A4", "A4", "before")).toBeUndefined();
  });
});
