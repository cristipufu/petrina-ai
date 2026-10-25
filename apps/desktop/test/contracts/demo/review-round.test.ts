import { describe, expect, it } from "vitest";
import { createDemoState, journeyView } from "@petrina/core";
import { reviewOutcome, reviewRoundGroups } from "../../../src/reviewRound";
import { finding } from "../../fixtures/review-round";

describe("the recorded result of a review round", () => {
  it("keeps the demo's split vote in its discovery round and leaves later reviews free of repeated findings", () => {
    const state = createDemoState(1_000_000_000_000);
    const task = state.tasks.find(task => task.findings.some(finding => finding.votes?.length))!;
    const view = journeyView(task, { ...state });
    const reviews = view.nodes.filter(node => node.roleId && state.roles.find(role => role.id === node.roleId)?.result === "findings");
    const first = reviews[0]!;
    const last = reviews.at(-1)!;
    expect(first.id).not.toBe(last.id);
    expect(reviewRoundGroups(first, task.journey!)!.fresh.some(f => f.votes?.length === 4)).toBe(true);
    const groups = reviewRoundGroups(last, task.journey!)!;
    expect(groups.fresh).toEqual([]); expect(groups.dismissed).toEqual([]);
    expect(groups.fixed).toHaveLength(1);
    expect(last.result!.findings).toHaveLength(1);
    expect(last.outcome).toBe("Nothing to fix");
    expect(reviewOutcome(last)).toBe(last.outcome);
  });
});
