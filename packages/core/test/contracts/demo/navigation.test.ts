import { describe, expect, it } from "vitest";
import { searchTasks } from "../../../src/navigation.js";
import { createPortfolioDemo } from "../../../src/demo.js";

describe("palette search", () => {
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
