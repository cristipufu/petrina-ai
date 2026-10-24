import { expect, it } from "bun:test";
import { checkReviewEvidence } from "@petrina/core";
import { BriefResult, ReviewResult } from "../../../src/roles.js";
import { finding } from "../../../../core/test/fixtures/findings.js";

it("normalizes current evidence while preserving legacy open confirmations", () => {
  const result = ReviewResult.parse({ verdict: "fail", confirms: ["open", { id: "fixed", evidence: "  A new ordering fails on this version.  " }] });
  expect(result.confirms).toEqual(["open", "fixed"]);
  expect(result.confirmationEvidence).toEqual({ fixed: "A new ordering fails on this version." });
  expect(checkReviewEvidence([finding("open"), finding("fixed", { status: "fixed", answer: { fixed: true, text: "Fixed the previous ordering", at: 1 } })], result)).toBeUndefined();
  expect(ReviewResult.safeParse({ verdict: "fail", confirms: [{ id: "fixed", evidence: "   " }] }).success).toBe(false);
});

it("requires evidence for an explicit reopening without inferring identity from a new report's wording", () => {
  const fixed = finding("fixed", { status: "fixed", evidence: "Old case", answer: { fixed: true, text: "Fixed the previous ordering", at: 1 } });
  const before = JSON.stringify(fixed);
  expect(checkReviewEvidence([fixed], ReviewResult.parse({ verdict: "fail", confirms: [fixed.id] }))).toContain("Current evidence is required");
  expect(checkReviewEvidence([fixed], ReviewResult.parse({ verdict: "fail", findings: [{ text: fixed.text, severity: "important" }] }))).toBeUndefined();
  expect(checkReviewEvidence([fixed], ReviewResult.parse({ verdict: "fail", findings: [{ text: fixed.text, severity: "important", evidence: "A different current case fails." }] }))).toBeUndefined();
  expect(JSON.stringify(fixed)).toBe(before);
  expect(checkReviewEvidence([finding("open")], ReviewResult.parse({ verdict: "fail", confirms: ["open"] }))).toBeUndefined();
  expect(checkReviewEvidence([finding("native", { raisedBy: "petrina", status: "fixed" })], ReviewResult.parse({ verdict: "fail", confirms: ["native"] }))).toBeUndefined();
});

it("requires fresh proof for dismissed and already reopened reports without reviving a historical id", () => {
  for (const earlier of [finding("dismissed", { status: "dismissed", evidence: "The original case passed." }), finding("reopened", { reopenedAt: 1, evidence: "A new current case fails." })]) {
    const before = JSON.stringify(earlier);
    expect(checkReviewEvidence([earlier], ReviewResult.parse({ verdict: "fail", confirms: [earlier.id] }))).toContain("Current evidence is required");
    expect(checkReviewEvidence([earlier], ReviewResult.parse({ verdict: "fail", findings: [{ text: earlier.text, severity: "important" }] }))).toBeUndefined();
    expect(checkReviewEvidence([earlier], ReviewResult.parse({ verdict: "fail", confirms: [{ id: earlier.id, evidence: "A different current path fails; the original path still passes." }] }))).toBeUndefined();
    expect(JSON.stringify(earlier)).toBe(before);
  }
});

it("refuses agreement with ids absent from the saved blind review input", () => {
  expect(checkReviewEvidence([finding("known")], ReviewResult.parse({ verdict: "fail", confirms: ["peer-not-shown"] }))).toContain("not shown");
  expect(checkReviewEvidence([finding("known")], ReviewResult.parse({ verdict: "pass", disputes: [{ id: "peer-not-shown", reason: "The current code handles this case." }] }))).toContain("not shown");
});

it("refuses a dispute without a reason", () => {
  expect(ReviewResult.safeParse({ verdict: "pass", findings: [], disputes: ["a"] }).success).toBe(false);
  expect(ReviewResult.safeParse({ verdict: "pass", findings: [], disputes: [{ id: "a", reason: "" }] }).success).toBe(false);
  expect(ReviewResult.safeParse({ verdict: "pass", findings: [], disputes: [{ id: "a", reason: "Not reproducible on the branch." }] }).success).toBe(true);
});

it("refuses a blank answer to an objection", () => {
  const brief = { summary: "A greeting.", acceptance: ["A greeting file exists"] };
  expect(BriefResult.safeParse({ ...brief, answers: [{ id: "o1", status: "accepted", answer: "  " }] }).success).toBe(false);
  expect(BriefResult.safeParse({ ...brief, answers: [{ id: "o1", status: "accepted", answer: "Added the empty state." }] }).success).toBe(true);
});
