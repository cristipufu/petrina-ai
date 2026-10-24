import { expect, it } from "vitest";
import { addEvidence, recordDisputes } from "../../../src/review-evidence.js";
import { finding } from "../../fixtures/findings.js";

it("keeps independent evidence once when earlier proofs are repeated, without dropping overlapping new details", () => {
  const first = "Dispute before confirmation dismisses it.\n\nThe reverse order leaves it open.";
  const second = "Dismiss then independently confirm: expected open, observed dismissed.";
  const record = finding("a", { evidence: first });
  addEvidence(record, second);
  const combined = `${first}\n\n${second}`;
  expect(record.evidence).toBe(combined);
  for (const repeated of [first, second, `  ${first}  `]) {
    addEvidence(record, repeated);
    expect(record.evidence).toBe(combined);
  }
  // A phrase shared with an existing proof is not an identical block of evidence.
  const overlapping = "independently confirm";
  addEvidence(record, overlapping);
  expect(record.evidence).toBe(`${combined}\n\n${overlapping}`);
  const extended = `${first} Reloading still leaves it dismissed.`;
  addEvidence(record, extended);
  const all = `${combined}\n\n${overlapping}\n\n${extended}`;
  expect(record.evidence).toBe(all);
  // Once surrounded by other proofs, this one is still retained only once.
  addEvidence(record, second);
  expect(record.evidence).toBe(all);
});

it("keeps who disputed a finding and why without settling it before other reviewers report", () => {
  const findings = [finding("a"), finding("b", { confirmedBy: ["opus-high"] }), finding("c", { raisedBy: "petrina" })];
  recordDisputes(findings, [
    { id: "a", reason: "The test it names passes on main; the failure was a flaky run." },
    { id: "b", reason: "I could not reproduce this on the branch." },
    { id: "c", reason: "This test was renamed, not deleted." },
  ], "opus-xhigh", 1);
  expect(findings[0]!.status).toBe("open");
  expect(findings[0]!.disputes).toEqual([{ by: "opus-xhigh", reason: "The test it names passes on main; the failure was a flaky run.", at: 1 }]);
  // Confirmed by another reviewer, and Petrina's own check: both stay open, with the dispute shown.
  expect(findings[1]!.status).toBe("open");
  expect(findings[1]!.disputes).toHaveLength(1);
  expect(findings[2]!.status).toBe("open");
});
