import { describe, expect, it } from "vitest";
import { stepTip, stripOf, type PipelineStep } from "../../../src/board.js";

describe("a card's strip", () => {
  const plan = (current: number, length = 9): PipelineStep[] =>
    ["Plan", "Research", "Design", "Screens", "Your check", "Build", "Test", "Review", "Ship", "Docs", "Release", "Announce"].slice(0, length).map((label, index) => ({
      label,
      state: index < current ? "done" : index === current ? "current" : "next",
    }));

  const marks = (steps: PipelineStep[]) => stripOf(steps).map((item) => (item.folded ? `[${stepTip(item)}]` : `${item.label}:${item.state}`));

  it("shows every step of a short plan", () => {
    expect(stripOf(plan(3, 6))).toEqual(plan(3, 6));
  });

  it("folds the finished steps of a long plan into one check with a count, still named", () => {
    expect(marks(plan(5))).toEqual(["[Plan, Research, Design, Screens and Your check, done]", "Build:current", "Test:next", "Review:next", "Ship:next"]);
    expect(stripOf(plan(5))[0]).toMatchObject({ state: "done", folded: ["Plan", "Research", "Design", "Screens", "Your check"] });
    // A single finished step stays as it is: folding it saves nothing.
    expect(marks(plan(1))).toEqual(["Plan:done", "Research:current", "Design:next", "Screens:next", "Your check:next", "Build:next", "Test:next", "Review:next", "Ship:next"]);
  });

  it("folds the furthest steps of a very long plan into one +N, so it never needs a second line", () => {
    const items = stripOf(plan(0, 12));
    expect(items).toHaveLength(9);
    expect(items.at(-1)).toMatchObject({ state: "next", folded: ["Ship", "Docs", "Release", "Announce"] });
    expect(stepTip(items.at(-1)!)).toBe("Ship, Docs, Release and Announce, next");
    for (let current = 0; current < 12; current += 1) expect(stripOf(plan(current, 12)).length).toBeLessThanOrEqual(9);
  });
});
