import { expect, it } from "vitest";
import { voteEligibility } from "../../fixtures/votes.js";

it("requires independent support rather than duplicate profiles or unknown identity", () => {
  const f = voteEligibility();
  expect(f.eligible()).toEqual([f.finding]);
  f.finding.confirmedBy = ["a-high", "a-medium", "unknown"];
  expect(f.eligible()).toEqual([f.finding]);
  f.finding.confirmedBy.push("b-high");
  expect(f.eligible()).toEqual([]);
  f.tools.delete("a-high"); f.tools.delete("a-medium");
  expect(f.eligible()).toEqual([f.finding]);
});

it.each(["fixed", "dismissed"] as const)("does not restart a ballot for a %s report", status => {
  const f = voteEligibility(); f.finding.status = status;
  expect(f.eligible()).toEqual([]);
});

it.each(["suggestion", "pre-existing"] as const)("does not start Important verification for %s severity", severity => {
  const f = voteEligibility(); f.finding.severity = severity;
  expect(f.eligible()).toEqual([]);
});

it("leaves settled, unresolved and engine-owned checks to their actual owners", () => {
  const f = voteEligibility();
  f.finding.verification = { verdict: "real", by: "b-high", reason: "Current reproduction", at: 100 };
  expect(f.eligible()).toEqual([]);
  delete f.finding.verification;
  f.finding.unresolved = { at: 100, reason: "No independent tool for the third answer" };
  expect(f.eligible()).toEqual([]);
  delete f.finding.unresolved; f.finding.raisedBy = "petrina";
  expect(f.eligible()).toEqual([]);
});

it.each(["reopened", "claimed fixed"] as const)("requires current support after a finding is %s", reason => {
  const f = voteEligibility(); f.finding.confirmedBy = ["b-high"];
  expect(f.eligible()).toEqual([]);
  if (reason === "reopened") f.finding.reopenedAt = 100;
  else f.finding.answer = { fixed: true, text: "The builder claims a repair", at: 100 };
  expect(f.eligible()).toEqual([f.finding]);
  f.finding.confirmedBy.push("a-medium");
  expect(f.eligible()).toEqual([]);
});

it("does not count an older-bug judgment as a second tool supporting an Important claim", () => {
  const f = voteEligibility();
  f.finding.confirmedBy = ["b-high"];
  f.finding.judgments = [{ by: "a-high", severity: "blocking", at: 100 }, { by: "b-high", severity: "pre-existing", at: 100 }];
  expect(f.eligible()).toEqual([f.finding]);
  f.finding.confirmedBy.push("c-high");
  expect(f.eligible()).toEqual([]);
});

it.each([{ name: "missing", productIds: undefined }, { name: "empty", productIds: [] }, { name: "foreign", productIds: ["foreign"] }, { name: "partially foreign", productIds: ["a", "foreign"] }])("refuses $name shared finding assignments", ({ productIds }) => {
  const f = voteEligibility(true); f.finding.productIds = productIds;
  expect(f.eligible()).toEqual([]);
});

it("accepts a known shared scope and retains complete-only assignment semantics", () => {
  const f = voteEligibility(true); f.finding.productIds = ["a", "b", "a"];
  expect(f.eligible()).toEqual([f.finding]);
  f.task.repositories![1]!.removed = true;
  expect(f.eligible()).toEqual([]);
});

it.each([false, true])("keeps exhausted acceptance failures outside review ballots only for shared tasks (%s)", shared => {
  const f = voteEligibility(shared);
  f.finding.text = "Failed acceptance check: The greeting appears";
  expect(f.eligible()).toEqual([f.finding]);
  f.task.acceptanceBlocked = true;
  expect(f.eligible()).toEqual(shared ? [] : [f.finding]);
});
