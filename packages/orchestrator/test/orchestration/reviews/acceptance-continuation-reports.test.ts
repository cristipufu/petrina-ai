import { expect, it } from "vitest";
import { reviewStats } from "@petrina/core";
import { acceptanceContinuationFixture } from "../../fixtures/acceptance-continuation.js";
import { report } from "../../fixtures/review-reports.js";

it("keeps blind reports separate and verifies each claim without inferring agreement from prose", async () => {
  const f = acceptanceContinuationFixture(); f.start();
  for (const [key, text] of [["0", "The greeting is missing on the welcome page."], ["1", "The GREETING is missing on the welcome page!"]] as const)
    f.report(key, report({ verdict: "fail", findings: [{ text, severity: "important", evidence: "Opened the welcome page" }] }));
  f.settle();
  const important = f.task.findings;
  expect(important).toHaveLength(2); expect(new Set(important.map(finding => finding.id)).size).toBe(2);
  expect(important.every(finding => finding.confirmedBy.length === 0)).toBe(true);
  const voting = f.votes("real");
  expect(voting.accepted).toHaveLength(2);
  for (const answer of voting.accepted) expect(answer.ids).toEqual(important.map(finding => finding.id));
  for (const finding of important) expect(finding.verification?.verdict).toBe("real");
  await f.close(voting.outcome);
  expect(f.task.fixing).toBe(true); expect(f.task.stageIndex).toBe(0);
  f.builderClaims(); f.start(2); f.report("0", report()); f.report("1", report()); f.settle();
  expect(important.every(finding => finding.status === "fixed")).toBe(true);
  expect(f.notes).toContain("Sent back to the builder: 2 important");
});

it("never sends work back for a finding the fresh agent shows is not a bug", async () => {
  const f = acceptanceContinuationFixture(); f.start();
  f.report("0", report({ verdict: "fail", findings: [{ text: "The greeting is missing on the welcome page.", severity: "important", evidence: "Opened the welcome page" }] }));
  f.report("1", report()); f.settle();
  const voting = f.votes("not-a-bug");
  await f.close(voting.outcome);
  expect(f.task.findings[0]).toMatchObject({ status: "dismissed", verification: { verdict: "not-a-bug", reason: "The welcome page shows the greeting already." } });
  expect(f.ended).toEqual(["passed"]); expect(f.task.fixing).not.toBe(true);
  expect(f.notes.some(words => words.startsWith("Sent back to the builder"))).toBe(false);
  expect(f.notes).toContain("1 checked: none to fix now, 1 not a bug");
});

it("keeps a previously real, builder-fixed finding fixed when fresh voters reject its reopening", async () => {
  const f = acceptanceContinuationFixture(); f.start();
  f.report("0", report({ verdict: "fail", findings: [{ text: "The greeting is missing on the welcome page.", severity: "important", evidence: "Opened the welcome page" }] }));
  f.report("1", report()); f.settle();
  const first = f.votes("real"); await f.close(first.outcome);
  f.builderClaims(); f.start(2); f.report("0", report()); f.report("1", report()); f.settle();
  const finding = f.task.findings[0]!, original = structuredClone(finding);
  expect(finding.status).toBe("fixed"); expect(finding.verification?.verdict).toBe("real");
  f.start(3);
  f.report("0", report({ verdict: "fail", confirms: [finding.id], confirmationEvidence: { [finding.id]: "Fresh current reproduction of the original report." } }));
  f.report("1", report()); f.settle();
  const checked = f.votes("not-a-bug");
  const sentBacks = f.notes.filter(words => words.startsWith("Sent back to the builder")).length;
  await f.close(checked.outcome, 3);
  expect(f.ended.at(-1)).toBe("passed"); expect(f.task.stageIndex).toBe(2);
  expect(f.notes.filter(words => words.startsWith("Sent back to the builder"))).toHaveLength(sentBacks);
  expect(finding.answer?.fixed).toBe(true); expect(finding.status).toBe("fixed");
  expect(finding.verification?.verdict).toBe("not-a-bug");
  expect(finding.earlierReviews).toHaveLength(1);
  expect(finding.earlierReviews![0]!.verification?.verdict).toBe("real");
  expect(finding.earlierReviews![0]!.votes).toEqual(original.votes);
  expect(reviewStats([f.task]).findings).toMatchObject({ fixed: 1, notABug: 0 });
  expect(checked.accepted.length).toBeGreaterThan(0);
});
