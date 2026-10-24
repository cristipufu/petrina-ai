import { expect, it } from "vitest";
import { beginAgentStep, endAgentStep } from "@petrina/core";
import { report, reviewReportFixture } from "../../fixtures/review-reports.js";

const ownership = [
  ["omitted ownership", [["second"], undefined], [["second"], []]],
  ["foreign ownership", [["second"], ["foreign"]], [["second"], []]],
  ["mixed valid and foreign ownership", [["first"], ["second", "foreign"]], [["first"], []]],
  ["valid expansion", [["first"], ["second"]], [["first"], ["second"]]],
  ["unknown-only reports", [undefined, ["foreign"]], [[], []]],
  ["invalid mixed reports", [["first", "foreign"], ["second", "foreign"]], [[], []]],
] as const;

for (const [name, incoming, owners] of ownership) for (const reverse of [false, true]) it(`keeps explicit finding owners across ${name}${reverse ? " in reverse order" : ""}`, () => {
  const f = reviewReportFixture(), { task, stage, first, second } = f;
  const ids = { first, second, foreign: "unregistered-product" };
  const ordered = reverse ? [...incoming].reverse() : incoming;
  for (const [index, productIds] of ordered.entries()) {
    f.reports.apply(task, stage, report({ verdict: "fail", findings: [{ text: index ? "The GREETING is missing!" : "The greeting is missing.", productIds: productIds?.map(id => ids[id]), severity: "important", evidence: `Current reproduction from reviewer ${index}.` }] }), index ? "sol-high" : "opus-high", "code-reviewer", String(index));
  }
  expect(task.findings).toHaveLength(2);
  const expected = reverse ? [...owners].reverse() : owners;
  for (const [index, finding] of task.findings.entries()) {
    expect(finding.productIds?.slice().sort()).toEqual(expected[index]!.map(id => ids[id]).sort());
    expect(finding.confirmedBy).toEqual([]);
    expect(finding.evidence).toBe(`Current reproduction from reviewer ${index}.`);
  }
  expect(new Set(task.findings.map(finding => finding.id)).size).toBe(2);
  expect(f.verdicts.map(value => [value.taskId, value.count, value.blocking])).toEqual([[task.id, 1, 1], [task.id, 1, 1]]);
});

it.each(["fixed", "dismissed"] as const)("reopens a %s finding by explicit id with current proof, retaining earlier support as history", status => {
  const f = reviewReportFixture();
  const finding = f.finding("old", { status, productIds: [f.second], evidence: "Earlier proof", confirmedBy: ["old-profile"],
    disputes: [{ by: "old-disputer", reason: "Earlier dispute", at: 1 }], votes: [{ by: "old-voter", toolId: "old-tool", verdict: "not-a-bug", reason: "Earlier vote" }],
    verification: { by: "old-voter", verdict: "not-a-bug", reason: "Earlier vote", at: 1 }, unresolved: { at: 1, reason: "Earlier gap" } });
  const before = structuredClone(finding);
  f.reports.apply(f.task, f.stage, report({ verdict: "fail", confirms: ["old"], confirmationEvidence: { old: "Current reproduction; nearby case passes." } }), "sol-high", "code-reviewer", "0");
  expect(finding).toMatchObject({ status: "open", productIds: [f.second], reopenedAt: 200, confirmedBy: ["sol-high"], evidence: "Current reproduction; nearby case passes." });
  expect(finding.verification).toBeUndefined(); expect(finding.votes).toBeUndefined(); expect(finding.disputes).toBeUndefined(); expect(finding.unresolved).toBeUndefined();
  expect(finding.earlierReviews).toEqual([{ at: 200, evidence: before.evidence, confirmedBy: before.confirmedBy, disputes: before.disputes, votes: before.votes, verification: before.verification, unresolved: before.unresolved }]);
  expect(f.verdicts[0]).toMatchObject({ count: 1, blocking: 1 });
});

it("accepts only follow-up identities actually shown, preserving normalized evidence and older-bug judgments", () => {
  const f = reviewReportFixture(); f.task.shownFollowUps = { "review-0": ["known-card"] };
  f.reports.apply(f.task, f.stage, report({ verdict: "fail", findings: [
    { text: "Older bug", severity: "pre-existing", sameBug: " known-card ", productIds: [f.first], steps: "  Open the form  ", where: "form.ts:5", evidence: "The form loses its label" },
    { text: "Different bug", severity: "important", sameBug: "unknown-card" },
    { text: "Another bug", severity: "nit", sameBug: "none" },
  ] }), "opus-high", "code-reviewer", "0");
  expect(f.task.findings[0]).toMatchObject({ productIds: [f.first], sameBug: "known-card", cardsShown: ["known-card"], steps: "Open the form", where: "form.ts:5", evidence: "The form loses its label", severity: "pre-existing", judgments: [{ by: "opus-high", severity: "pre-existing", at: 200 }] });
  expect(f.task.findings[1]!.sameBug).toBeUndefined(); expect(f.task.findings[2]!.sameBug).toBe("none");
  expect(f.verdicts[0]).toMatchObject({ count: 3, blocking: 1 });
  expect(f.notes[0]).toMatchObject({ taskId: f.task.id, roleId: "code-reviewer", profileId: "opus-high", tone: "warn" });
});

it("keeps a participant's handed-back copy immutable while later peers add independent current proof", () => {
  const f = reviewReportFixture(); f.finding("old", { productIds: [f.first], evidence: "Existing proof" });
  const step = beginAgentStep(f.task, "code-reviewer", "opus-high", 100, f.roles);
  step.agentResults = [{ roleId: "code-reviewer", profileId: "opus-high", at: 200, value: {} }];
  f.reports.apply(f.task, f.stage, report({ verdict: "fail", confirms: ["old"], confirmationEvidence: { old: "First current proof" } }), "opus-high", "code-reviewer", "0");
  const own = step.agentResults[0]!, saved = structuredClone(own.findings);
  step.agentResults = [...step.agentResults, { roleId: "code-reviewer", profileId: "sol-high", at: 201, value: {} }];
  f.advance();
  f.reports.apply(f.task, f.stage, report({ verdict: "fail", confirms: ["old"], confirmationEvidence: { old: "Second current proof" } }), "sol-high", "code-reviewer", "1");
  expect(own.findings).toEqual(saved);
  expect(own.findings![0]!.confirmedBy).toEqual(["opus-high"]);
  expect(step.agentResults[1]!.findings![0]!.confirmedBy).toEqual(["opus-high", "sol-high"]);
  expect(f.task.findings[0]!.evidence).toBe("Existing proof\n\nFirst current proof\n\nSecond current proof");
});

it.each(["pending", "other-stage", "other-round"])("does not settle a group with %s", cause => {
  const f = reviewReportFixture(); const finding = f.finding("old", { productIds: [f.first], disputes: [{ by: "opus-high", reason: "Not reproducible", at: 200 }] });
  if (cause !== "pending") f.pending(false);
  if (cause === "other-stage") f.task.hunt!.stageId = "another-stage";
  if (cause === "other-round") f.task.hunt!.round = 2;
  const before = structuredClone(f.task);
  f.reports.settle(f.task, f.stage);
  expect(finding.status).toBe("open"); expect(f.task).toEqual(before);
});

it("settles completed objections while preserving check-owned, acceptance and unknown-owner findings", () => {
  const f = reviewReportFixture();
  for (const value of [
    { id: "single", productIds: [f.first] }, { id: "unopposed", productIds: [f.second] },
    { id: "native", raisedBy: "petrina", productIds: [f.second] },
    { id: "acceptance", text: "Failed acceptance check: Shared behaviour", productIds: [f.first, f.second] },
    { id: "unassigned" },
  ]) f.finding(value.id, value);
  f.reports.apply(f.task, f.stage, report({ disputes: f.task.findings.map(finding => ({ id: finding.id, reason: "I disagree with this finding." })) }), "opus-high", "code-reviewer", "0");
  f.task.hunt!.reported = { "0": true };
  f.reports.settle(f.task, f.stage);
  expect(f.task.findings.every(finding => finding.status === "open")).toBe(true);
  f.reports.apply(f.task, f.stage, report({ verdict: "fail", confirms: ["single"] }), "sol-high", "code-reviewer", "1");
  f.task.hunt!.reported["1"] = true; f.pending(false);
  f.reports.settle(f.task, f.stage);
  expect(f.task.findings.map(finding => [finding.id, finding.status])).toEqual([["single", "open"], ["unopposed", "dismissed"], ["native", "open"], ["acceptance", "open"], ["unassigned", "open"]]);
  expect(f.task.findings[0]!.disputes).toHaveLength(1); expect(f.task.findings[0]!.confirmedBy).toEqual(["sol-high"]);
});

it.each(["code-reviewer", "custom-reviewer"])("records a complete settled copy for review result kind on %s", roleId => {
  const f = reviewReportFixture(false);
  const role = { ...f.roles.find(role => role.result === "findings")!, id: roleId, name: "Review" };
  if (roleId === "custom-reviewer") f.roles.push(role);
  f.stage.roleId = role.id;
  const finding = f.finding("old", { disputes: [{ by: "opus-high", reason: "Not reproducible", at: 200 }] });
  const open = beginAgentStep(f.task, role.id, "opus-high", 100, f.roles);
  f.task.hunt!.reported = { "0": true, "1": true }; f.pending(false);
  f.reports.settle(f.task, f.stage);
  expect(finding.status).toBe("dismissed");
  expect(open.result!.findingsSettled).toBe(true);
  expect(open.result!.findings![0]).toMatchObject({ id: "old", status: "dismissed" });
  expect(open.result!.findingChanges!.dismissed).toEqual(["old"]);
  const snapshot = structuredClone(open.result);
  endAgentStep(f.task, { outcome: "Review passed", reason: "No Important findings" }, 201);
  f.reports.settle(f.task, f.stage);
  expect(open.result).toEqual(snapshot);
});
