import { describe, expect, it } from "vitest";
import { createDemoState } from "../src/demo.js";
import type { Finding, Task } from "../src/model.js";
import { reviewStats } from "../src/reviews.js";

const demo = createDemoState(1_000_000_000);
const base = demo.tasks.find((task) => task.state === "done")!;

/** A finished task with one review chain that passed in `rounds`, holding `findings`. */
function reviewed(id: string, rounds: number, findings: Finding[], extra: Partial<Task> = {}): Task {
  const chain = base.plan!.stages.find((stage) => stage.kind === "review-chain")!;
  return { ...base, id, state: "done", rounds: { [chain.id]: rounds }, findings, ...extra };
}

const finding = (id: string, raisedBy: string, extra: Partial<Finding> = {}): Finding => ({ id, text: `Finding ${id}`, severity: "blocking", raisedBy, confirmedBy: [], status: "open", ...extra });

describe("how reviews are going", () => {
  it("counts rounds to pass, what became of each finding, and how each reviewer's findings held up", () => {
    const stats = reviewStats([
      reviewed("a", 1, [finding("a1", "opus-high", { severity: "suggestion" })]),
      reviewed("b", 2, [finding("b1", "sol-xhigh", { status: "fixed", answer: { fixed: true, text: "Fixed.", at: 0 } }), finding("b2", "sol-xhigh", { status: "dismissed", verification: { by: "opus-high", verdict: "not-a-bug", reason: "It works.", at: 0 } }), finding("b3", "sol-xhigh", { status: "unverified" })]),
      reviewed("c", 4, [finding("c1", "opus-high", { severity: "pre-existing", verification: { by: "sol-xhigh", verdict: "pre-existing", reason: "Older than this.", at: 0 } }), finding("c2", "petrina", { status: "fixed" })], { sentBack: 1 }),
      // Still under review: not counted as reviewed, but its findings count.
      { ...reviewed("d", 1, [finding("d1", "opus-high", { severity: "suggestion", answer: { fixed: false, text: "Kept on purpose.", at: 0 } })]), state: "running", stageIndex: 0 },
    ]);

    expect(stats.reviewed).toBe(3);
    expect(stats.passed).toEqual({ total: 3, first: 1, second: 1, third: 0, later: 1 });
    expect(stats.meanRounds).toBeCloseTo(7 / 3);
    expect(stats.sentBack).toBe(1);
    // Petrina's own failing check is not a reviewer's finding.
    expect(stats.findings).toEqual({ total: 6, fixed: 1, notABug: 1, unverified: 1, downgraded: 1, kept: 1, open: 1 });
    expect(stats.profiles).toEqual([
      { profileId: "opus-high", raised: 3, important: 1, heldUp: 0, notABug: 0 },
      { profileId: "sol-xhigh", raised: 3, important: 3, heldUp: 1, notABug: 1 },
    ]);
  });

  it("says nothing about rounds before any review is over", () => {
    const stats = reviewStats([]);
    expect(stats.reviewed).toBe(0);
    expect(stats.meanRounds).toBeUndefined();
    expect(stats.profiles).toEqual([]);
  });
});
