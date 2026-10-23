import { describe, expect, it } from "vitest";
import { createDemoState, journeyView } from "@petrina/core";
import { reviewOutcome, reviewRoundGroups } from "../src/reviewRound";
import { finding, step, node, repairedReviewFixture } from "./reviewRoundFixture";

describe("the recorded result of a review round", () => {
  it("keeps reopenings and older confirmations from the earlier partial step of a settled round", () => {
    const reopened = finding("old-dismissed", { reopenedAt: 15, evidence: "The current case fails." });
    const nit = finding("older-nit", { severity: "suggestion" });
    const partial = step("partial", { end: "failed", result: { findings: [reopened, nit] } });
    const current = step("after-retry", { startedAt: 30, endedAt: 40, result: { findingsSettled: true, findings: [reopened, nit], findingChanges: { raised: [], fixed: [], dismissed: [], reopened: [{ id: reopened.id, evidence: true }], claimedFixed: [] } } });
    const before = JSON.stringify([partial, current]);
    const groups = reviewRoundGroups(node(current), [partial, current])!;
    expect(groups.reopened.map(finding => finding.id)).toEqual([reopened.id]);
    expect(groups.stillOpen.map(finding => finding.id)).toEqual([nit.id]);
    expect(groups.fresh).toEqual([]);
    expect(groups.settled).toBe(true);
    expect(JSON.stringify([partial, current])).toBe(before);
    const later = step("later", { round: 2, startedAt: 50, endedAt: 60, result: { findingsSettled: true, findings: [reopened], findingChanges: { raised: [], fixed: [], dismissed: [], reopened: [] } } });
    expect(reviewRoundGroups(node(later), [partial, current, later])!.reopened).toEqual([]);
    expect(reviewRoundGroups(node(current), [partial, current, later])).toEqual(groups);
  });
  it("uses this round's recorded decisions and distinguishes an old confirmed report without any earlier saved copy", () => {
    const previous = step("previous", { result: { findingsSettled: true, findings: [finding("old-dismissal", { status: "dismissed" }), finding("old-fix", { status: "fixed" })], findingChanges: { raised: [], fixed: ["old-fix"], dismissed: ["old-dismissal"] } } });
    const current = step("current", { round: 2, result: { findingsSettled: true, findings: [...previous.result!.findings!, finding("new-fix", { status: "fixed" }), finding("old-confirmed"), finding("new")], findingChanges: { raised: ["new"], fixed: ["new-fix"], dismissed: [] } } });
    const before = JSON.stringify([previous, current]);
    const groups = reviewRoundGroups(node(current), [previous, current])!;
    expect(groups.fixed.map(f => f.id)).toEqual(["new-fix"]);
    expect(groups.dismissed).toEqual([]);
    expect(groups.stillOpen.map(f => f.id)).toEqual(["old-confirmed"]);
    expect(groups.fresh.map(f => f.id)).toEqual(["new"]);
    expect(JSON.stringify([previous, current])).toBe(before);
  });

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
  it("shows settled dismissals and unmentioned fixes, while keeping an older copy labelled as a hand-back", () => {
    const current = step("settled", { outcome: "1 important", result: { findingsSettled: true, findings: [finding("dismissed", { status: "dismissed" }), finding("shared", { status: "fixed" })] } });
    const groups = reviewRoundGroups(node(current), [current])!;
    expect(groups.settled).toBe(true);
    expect(groups.dismissed.map(f => f.id)).toEqual(["dismissed"]);
    expect(groups.fixed.map(f => f.id)).toEqual(["shared"]);
    expect(groups.fresh).toEqual([]);
    expect(reviewOutcome(node(current))).toBe("Nothing to fix");
    const older = { ...current, result: { findings: [finding("dismissed")] } };
    expect(reviewRoundGroups(node(older), [older])!.settled).toBe(false);
    expect(older.result.findings[0]!.status).toBe("open");
  });
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
