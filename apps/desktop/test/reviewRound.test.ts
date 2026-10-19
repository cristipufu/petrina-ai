import { describe, expect, it } from "vitest";
import { reviewOutcome, reviewRoundGroups } from "../src/reviewRound";
import { finding, step, node, repairedReviewFixture } from "./reviewRoundFixture";

describe("the recorded result of a review round", () => {
  it("separates accepted fixes, reopened reports and new reports, correcting the old new-only outcome", () => {
    const fixture = repairedReviewFixture();
    const groups = reviewRoundGroups(node(fixture.review), fixture.steps)!;
    expect(groups.fixed.map((f) => f.id)).toEqual(["old-4", "old-5", "old-6"]);
    expect(groups.reopened.map((f) => f.id)).toEqual(["old-0", "old-1", "old-2", "old-3"]);
    expect(groups.fresh.map((f) => f.id)).toEqual(["new-1", "new-2"]);
    expect(groups.stillOpen).toEqual([]);
    expect(groups.fixedRecorded).toBe(true);
    expect(groups.fixed.every((f) => f.status === "fixed" && f.answer?.fixed)).toBe(true);
    expect(reviewOutcome(node(fixture.review))).toBe("6 important");
    expect(fixture.previous.result!.findings!.every((f) => f.status === "open" && !f.answer)).toBe(true);
    const later = step("later", { startedAt: 60, endedAt: 70, result: { findings: [finding("old-4", { reopenedAt: 65 }), finding("new-1", { status: "fixed" })] } });
    expect(reviewRoundGroups(node(fixture.review), [...fixture.steps, later])).toEqual(groups);
  });

  it("counts a confirmed ID once and distinguishes still-open reports from reopened fixes", () => {
    const old = finding("still-open", { reopenedAt: 1 });
    const previous = step("before", { result: { findings: [old] } });
    const current = step("now", { startedAt: 40, endedAt: 50, result: { findings: [old, old, finding("nit", { severity: "suggestion" })] }, agentResults: [{ roleId: "code-reviewer", profileId: "one", at: 50, value: { confirms: [{ id: old.id }] } }, { roleId: "code-reviewer", profileId: "two", at: 50, value: { confirms: [old.id] } }] });
    const groups = reviewRoundGroups(node(current), [previous, current])!;
    expect(groups.stillOpen.map((f) => f.id)).toEqual([old.id]);
    expect(groups.reopened).toEqual([]);
    expect(groups.fresh.map((f) => f.id)).toEqual(["nit"]);
  });

  it("keeps dismissals separate and does not call a builder's refused fix accepted", () => {
    const previous = step("previous", { result: { findings: [finding("dismissed"), finding("refused")] } });
    const builder = step("builder", { roleId: "builder", fixing: true, agentResults: [{ roleId: "builder", profileId: "one", at: 25, value: { answers: [{ id: "refused", fixed: false, text: "Kept with a reason" }] } }] });
    const current = step("current", { startedAt: 40, endedAt: 50, result: { findings: [finding("dismissed", { status: "dismissed" }), finding("refused")] } });
    const groups = reviewRoundGroups(node(current), [previous, builder, current])!;
    expect(groups.dismissed.map((f) => f.id)).toEqual(["dismissed"]);
    expect(groups.fixed).toEqual([]);
    expect(groups.stillOpen.map((f) => f.id)).toEqual(["refused"]);
  });

  it("does not claim accepted fixes while review is unfinished, or invent missing older answers", () => {
    const fixture = repairedReviewFixture();
    expect(reviewRoundGroups(node({ ...fixture.review, endedAt: undefined }), fixture.steps)).toBeUndefined();
    const olderBuilder = { ...fixture.builder, agentResults: undefined };
    expect(reviewRoundGroups(node(fixture.review), [fixture.previous, olderBuilder, fixture.review])!.fixedRecorded).toBe(false);
    const voters = node({ ...fixture.review, roleId: "verifier", outcome: "6 real" });
    expect(reviewOutcome(voters)).toBe("6 real");
  });
});

it("counts custom build and findings roles by result, keeping unrelated agent steps out of the round boundary", () => {
  const fixture = repairedReviewFixture();
  const customSteps = fixture.steps.map((entry) => ({ ...entry, roleId: entry.roleId === "builder" ? "repair-specialist" : "custom-reviewer" }));
  const roles = { "repair-specialist": "build", "custom-reviewer": "findings" } as const;
  const current = customSteps.at(-1)!;
  const groups = reviewRoundGroups(node(current), customSteps, (id) => roles[id as keyof typeof roles])!;
  expect(groups.fixed.map((finding) => finding.id)).toEqual(["old-4", "old-5", "old-6"]);
  expect(groups.fixedRecorded).toBe(true);
});
