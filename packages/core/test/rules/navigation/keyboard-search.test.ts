import { stateFixture, taskFixture } from "../../fixtures/state.js";
import { describe, expect, it } from "vitest";
import { boardOrder, inboxOrder, inboxTab, keyArea, matchesWords, reconcileHighlight, searchTasks, stepHighlight } from "../../../src/navigation.js";

const demo = stateFixture({ now: 1_000_000 });
demo.tasks = [taskFixture(demo, { id: "guest", title: "Guest checkout", state: "needs-you", holdsSlot: true }), taskFixture(demo, { id: "finished", state: "done" }), taskFixture(demo, { id: "queued", state: "queued", productId: "billing" })];
demo.inbox = [{ id: "blocking", taskId: "guest", kind: "question", title: "Choose", at: 1, blocking: true }, { id: "gate", taskId: "queued", kind: "plan", title: "Approve", at: 2, blocking: false }];

describe("palette search", () => {
  it("matches every word across title and product, in any word order and case", () => {
    expect(matchesWords(" shop GUEST ", "Guest checkout", "Shop")).toBe(true);
    expect(matchesWords("guest missing", "Guest checkout", "Shop")).toBe(false);
    expect(searchTasks(demo, "checkout").map((task) => task.title)).toContain("Guest checkout");
    expect(searchTasks(demo, "shop guest").map((task) => task.title)).toContain("Guest checkout");
    expect(searchTasks(demo, "shop guest absent")).toEqual([]);
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

  it("walks from a removed item to its surviving neighbours without restarting the list", () => {
    const previous = ["a", "b", "c", "d"];
    expect(stepHighlight(["a", "c", "d"], "b", 1, previous)).toBe("c");
    expect(stepHighlight(["a", "c", "d"], "b", -1, previous)).toBe("a");
    expect(stepHighlight(["a", "d"], "b", 1, previous)).toBe("d");
    expect(stepHighlight(["a", "b", "c"], "d", 1, previous)).toBeUndefined();
    expect(stepHighlight(["a", "b", "c"], "d", -1, previous)).toBe("c");
    expect(stepHighlight(["b", "c", "d"], "a", -1, previous)).toBeUndefined();
    expect(stepHighlight(["b", "c", "d"], "a", 1, previous)).toBe("b");
    expect(stepHighlight(["a"], "missing", 1)).toBeUndefined();
    expect(stepHighlight([], "b", 1, previous)).toBeUndefined();
  });

  it("lets a task take precedence and rests board keys on every other page", () => {
    for (const page of ["products", "agents", "analytics", "library", "settings"] as const) {
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
