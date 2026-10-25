import { describe, expect, it } from "vitest";

import { gateStatus, gateTitle, MAX_REVIEW_ROUNDS, noteRoundEnd, reviewRoundEnd, type DeepMutable } from "../../../src/flow.js";

import { BUILT_IN_ROLES } from "../../../src/library.js";

import type { Stage, Task } from "../../../src/model.js";

describe("a delivery whose review rounds ran out", () => {
  it("says the coordinator decides, with how many blocking findings are open, never 'ready to ship'", () => {
    const task = { title: "Fix the focus", findings: [{ status: "open", severity: "blocking" }, { status: "open", severity: "blocking" }, { status: "fixed", severity: "blocking" }] } as unknown as Task;
    expect(gateTitle(task, "delivery")).toBe("Your call on “Fix the focus”: 2 blocking findings still open");
    expect(gateStatus(task, "delivery")).toBe("Review rounds ran out with 2 blocking findings open. Your call");
    const passed = { title: "Fix the focus", findings: [] } as unknown as Task;
    expect(gateTitle(passed, "delivery")).toBe("Ready to ship “Fix the focus”");
    expect(gateStatus(passed, "delivery")).toBe("Reviews done. Waiting for your OK to ship");
  });
});

describe("review rounds that converge", () => {
  const stage = { id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["a"], maxRounds: 2 } as unknown as Stage;

  const task = (open: number, history?: number[]) =>
    ({
      stageIndex: 1,
      plan: { stages: [{ id: "build", kind: "do", roleId: "builder", profileIds: ["b"] }, stage] },
      findings: Array.from({ length: open }, () => ({ status: "open", severity: "blocking" })),
      ...(history ? { blockingAfter: { review: history } } : {}),
    }) as unknown as Task;

  it("sends the work back within the planned rounds, whatever the count", () => {
    expect(reviewRoundEnd(task(4), stage, 1, BUILT_IN_ROLES).kind).toBe("send back");
  });

  it("uses the smaller count as progress for older tasks without finding snapshots", () => {
    expect(reviewRoundEnd(task(2, [4]), stage, 2, BUILT_IN_ROLES).kind).toBe("send back");
    expect(reviewRoundEnd(task(1, [4, 2]), stage, 3, BUILT_IN_ROLES).kind).toBe("send back");
  });

  it("counts resolved findings as progress even when reviewers raise new blockers", () => {
    const current = {
      ...task(2, [2]),
      findings: [
        { id: "old-1", status: "fixed", severity: "blocking" },
        { id: "old-2", status: "fixed", severity: "blocking" },
        { id: "new-1", status: "open", severity: "blocking" },
        { id: "new-2", status: "open", severity: "blocking" },
      ],
      blockingFindingsAfter: { review: [["old-1", "old-2"]] },
    } as unknown as Task;
    expect(reviewRoundEnd(current, stage, 3, BUILT_IN_ROLES)).toEqual({ kind: "send back", builder: 0, open: 2 });
  });

  it("stops when the same blocking findings remain open", () => {
    const current = {
      ...task(2, [2]),
      findings: [
        { id: "same-1", status: "open", severity: "blocking" },
        { id: "same-2", status: "open", severity: "blocking" },
      ],
      blockingFindingsAfter: { review: [["same-1", "same-2"]] },
    } as unknown as Task;
    expect(reviewRoundEnd(current, stage, 3, BUILT_IN_ROLES)).toEqual({ kind: "used up", open: 2 });
  });

  it("records only the open blockers by ID after a round", () => {
    const current = {
      findings: [
        { id: "open", status: "open", severity: "blocking" },
        { id: "fixed", status: "fixed", severity: "blocking" },
        { id: "nit", status: "open", severity: "suggestion" },
      ],
    } as unknown as DeepMutable<Task>;
    noteRoundEnd(current, "review", 1);
    expect(current.blockingFindingsAfter).toEqual({ review: [["open"]] });
  });

  it("hands the coordinator a round that stopped making progress, and never goes past five rounds", () => {
    expect(reviewRoundEnd(task(2, [2]), stage, 2, BUILT_IN_ROLES).kind).toBe("used up");
    expect(reviewRoundEnd(task(3, [2]), stage, 2, BUILT_IN_ROLES).kind).toBe("used up");
    expect(reviewRoundEnd(task(1, [5, 4, 3, 2]), stage, MAX_REVIEW_ROUNDS, BUILT_IN_ROLES).kind).toBe("used up");
  });
});
