import { describe, expect, it } from "vitest";
import { gateStatus, gateTitle, MAX_REVIEW_ROUNDS, noteRoundEnd, reviewRoundEnd } from "../../../src/flow.js";
import { BUILT_IN_ROLES } from "../../../src/library.js";
import type { Finding, Stage, Task } from "../../../src/model.js";
import { stateFixture, taskFixture } from "../../fixtures/state.js";

const state = stateFixture();

function finding(
  id: string,
  status: Finding["status"],
  severity: Finding["severity"] = "blocking",
): Finding {
  return {
    id,
    text: `Finding ${id}`,
    severity,
    raisedBy: "code-reviewer",
    confirmedBy: [],
    status,
  };
}

describe("a delivery whose review rounds ran out", () => {
  it("says the coordinator decides, with how many blocking findings are open, never 'ready to ship'", () => {
    const task = taskFixture(state, {
      title: "Fix the focus",
      findings: [finding("1", "open"), finding("2", "open"), finding("3", "fixed")],
    });
    expect(gateTitle(task, "delivery")).toBe("Your call on “Fix the focus”: 2 blocking findings still open");
    expect(gateStatus(task, "delivery")).toBe("Review rounds ran out with 2 blocking findings open. Your call");
    const passed = taskFixture(state, { title: "Fix the focus", findings: [] });
    expect(gateTitle(passed, "delivery")).toBe("Ready to ship “Fix the focus”");
    expect(gateStatus(passed, "delivery")).toBe("Reviews done. Waiting for your OK to ship");
  });
});

describe("review rounds that converge", () => {
  const buildStage: Stage = {
    id: "build",
    kind: "do",
    title: "Build",
    roleId: "builder",
    profileIds: ["b"],
  };
  const stage: Stage = {
    id: "review",
    kind: "review-chain",
    title: "Review",
    roleId: "code-reviewer",
    profileIds: ["a"],
    maxRounds: 2,
  };

  const task = (open: number, history?: number[], extra: Partial<Task> = {}) =>
    taskFixture(state, {
      stageIndex: 1,
      plan: { rationale: "Review convergence", plannerProfileId: "sonnet-medium", stages: [buildStage, stage] },
      findings: Array.from({ length: open }, (_, index) => finding(`open-${index}`, "open")),
      ...(history ? { blockingAfter: { review: history } } : {}),
      ...extra,
    });

  it("sends the work back within the planned rounds, whatever the count", () => {
    expect(reviewRoundEnd(task(4), stage, 1, BUILT_IN_ROLES).kind).toBe("send back");
  });

  it("uses the smaller count as progress for older tasks without finding snapshots", () => {
    expect(reviewRoundEnd(task(2, [4]), stage, 2, BUILT_IN_ROLES).kind).toBe("send back");
    expect(reviewRoundEnd(task(1, [4, 2]), stage, 3, BUILT_IN_ROLES).kind).toBe("send back");
  });

  it("counts resolved findings as progress even when reviewers raise new blockers", () => {
    const current = task(2, [2], {
      findings: [
        finding("old-1", "fixed"),
        finding("old-2", "fixed"),
        finding("new-1", "open"),
        finding("new-2", "open"),
      ],
      blockingFindingsAfter: { review: [["old-1", "old-2"]] },
    });
    expect(reviewRoundEnd(current, stage, 3, BUILT_IN_ROLES)).toEqual({ kind: "send back", builder: 0, open: 2 });
  });

  it("stops when the same blocking findings remain open", () => {
    const current = task(2, [2], {
      findings: [finding("same-1", "open"), finding("same-2", "open")],
      blockingFindingsAfter: { review: [["same-1", "same-2"]] },
    });
    expect(reviewRoundEnd(current, stage, 3, BUILT_IN_ROLES)).toEqual({ kind: "used up", open: 2 });
  });

  it("records only the open blockers by ID after a round", () => {
    const current = task(0, undefined, {
      findings: [
        finding("open", "open", "blocking"),
        finding("fixed", "fixed", "blocking"),
        finding("nit", "open", "suggestion"),
      ],
    });
    noteRoundEnd(current, "review", 1);
    expect(current.blockingFindingsAfter).toEqual({ review: [["open"]] });
  });

  it("hands the coordinator a round that stopped making progress, and never goes past five rounds", () => {
    expect(reviewRoundEnd(task(2, [2]), stage, 2, BUILT_IN_ROLES).kind).toBe("used up");
    expect(reviewRoundEnd(task(3, [2]), stage, 2, BUILT_IN_ROLES).kind).toBe("used up");
    expect(reviewRoundEnd(task(1, [5, 4, 3, 2]), stage, MAX_REVIEW_ROUNDS, BUILT_IN_ROLES).kind).toBe("used up");
  });
});
