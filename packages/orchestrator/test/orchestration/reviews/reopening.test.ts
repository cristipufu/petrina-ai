import { expect, it } from "vitest";
import { checkReviewEvidence } from "@petrina/core";
import { report, reviewReportFixture } from "../../fixtures/review-reports.js";

const proof = "The current guest state fails after signing out; the signed-in control and original case pass.";

for (const severity of ["blocking", "suggestion", "pre-existing"] as const) for (const by of ["sol-high", "opus-high"]) {
  it(`reopens dismissed ${severity} with fresh ${by} proof without losing ownership or earlier review history`, () => {
    const f = reviewReportFixture(), { task, stage, first, second } = f;
    task.hunt = { stageId: stage.id, round: 2, reported: {}, findings: 1 }; task.rounds[stage.id] = 2;
    const finding = f.finding("dismissed", { text: "The greeting is missing.", productIds: [first, second], severity,
      raisedBy: "opus-high", status: "dismissed", confirmedBy: ["opus-xhigh"], evidence: "The original welcome path passed.",
      disputes: [{ by: "sol-high", reason: "The original path works on current code.", at: 1 }],
      verification: { by: "sol-high", verdict: "not-a-bug", reason: "The old reproduction does not fail.", at: 1 },
      votes: [{ by: "sol-high", toolId: "codex", verdict: "not-a-bug", reason: "The original path passes." }] });
    const before = structuredClone(finding);
    const result = report({ verdict: "fail", confirms: [finding.id], confirmationEvidence: { [finding.id]: proof } });
    expect(checkReviewEvidence(task.findings, result, task)).toBeUndefined();
    f.reports.apply(task, stage, result, by, "code-reviewer", "0");
    expect(task.findings).toHaveLength(1); expect(finding.status).toBe("open"); expect(finding.severity).toBe(severity);
    expect(finding.productIds).toEqual([first, second]); expect(finding.evidence).toBe(proof); expect(finding.confirmedBy).toEqual([by]);
    expect(finding.verification).toBeUndefined(); expect(finding.votes).toBeUndefined(); expect(finding.disputes).toBeUndefined();
    expect(finding.earlierReviews).toHaveLength(1);
    expect(finding.earlierReviews![0]).toEqual({ at: finding.reopenedAt, evidence: before.evidence, confirmedBy: before.confirmedBy,
      disputes: before.disputes, verification: before.verification, votes: before.votes });
    task.hunt.reported = { "0": true }; f.reports.settle(task, stage); expect(finding.status).toBe("open");
    task.hunt.reported["1"] = true; f.pending(false); f.reports.settle(task, stage); expect(finding.status).toBe("open");
  });
}

it("does not reopen or alter a settled check-owned finding on an agent confirmation", () => {
  const f = reviewReportFixture();
  const finding = f.finding("native", { raisedBy: "petrina", status: "fixed", productIds: [f.first], evidence: "The actual check now passes." });
  f.reports.apply(f.task, f.stage, report({ verdict: "fail", confirms: [finding.id], confirmationEvidence: { [finding.id]: proof } }), "sol-high", "code-reviewer", "0");
  expect(finding).toMatchObject({ status: "fixed", evidence: "The actual check now passes." }); expect(finding.earlierReviews).toBeUndefined();
});

for (const status of ["dismissed", "fixed", "open"] as const) it(`a differently worded new report leaves a peer product's ${status} finding independent`, () => {
  const f = reviewReportFixture(), { task, stage, first, second } = f;
  const prior = f.finding("prior-api", { text: "The greeting is missing.", productIds: [second], status, evidence: "The original API guest case.",
    ...(status === "fixed" ? { answer: { fixed: true, at: 1, text: "The API guest case now passes." } } : {}) });
  const incoming = { text: "The GREETING is missing!", productIds: [first], severity: "important" as const, evidence: proof };
  expect(checkReviewEvidence(task.findings, report({ verdict: "fail", findings: [{ ...incoming, evidence: undefined }] }), task)).toBeUndefined();
  f.reports.apply(task, stage, report({ verdict: "fail", findings: [incoming] }), "opus-high", "code-reviewer", "0");
  expect(task.findings).toHaveLength(2); expect(prior).toMatchObject({ id: "prior-api", status, productIds: [second], evidence: "The original API guest case." });
  expect(task.findings[1]).toMatchObject({ status: "open", productIds: [first], evidence: proof }); expect(task.findings[1]!.earlierReviews).toBeUndefined();
  expect(task.findings.every(finding => finding.confirmedBy.length === 0)).toBe(true);
  expect(f.verdicts.at(-1)).toMatchObject({ taskId: task.id, count: 1, blocking: 1 });
  expect(checkReviewEvidence(task.findings, report({ verdict: "fail", findings: [{ ...incoming, evidence: undefined }] }), task)).toBeUndefined();
});

it("requires current proof for an explicit shared fixed identity, reopening it without creating another finding", () => {
  const f = reviewReportFixture(), { task, stage, first, second } = f;
  const finding = f.finding("shared-fixed", { text: "The greeting is missing.", productIds: [second, first], evidence: "The original shared case.",
    status: "fixed", answer: { fixed: true, at: 1, text: "Both owners repaired it." } });
  expect(checkReviewEvidence(task.findings, report({ verdict: "fail", confirms: [finding.id] }), task)).toContain(finding.id);
  const confirmation = report({ verdict: "fail", confirms: [finding.id], confirmationEvidence: { [finding.id]: proof } });
  expect(checkReviewEvidence(task.findings, confirmation, task)).toBeUndefined();
  f.reports.apply(task, stage, confirmation, "opus-high", "code-reviewer", "0");
  expect(task.findings).toHaveLength(1); expect(finding).toMatchObject({ id: "shared-fixed", status: "open", productIds: [second, first], evidence: proof });
  expect(finding.earlierReviews![0]!.evidence).toBe("The original shared case.");
});

const owners = [
  { prior: ["second"], incoming: undefined, expected: [] },
  { prior: undefined, incoming: ["first"], expected: ["first"] },
  { prior: ["second"], incoming: ["not-a-product"], expected: [] },
  { prior: undefined, incoming: ["not-a-product"], expected: [] },
];
it.each(owners)("new ownership $incoming does not change prior ownership $prior", ({ prior, incoming, expected }) => {
  const f = reviewReportFixture(), { task, stage } = f;
  const finding = f.finding("ownership-unknown", { text: "The greeting is missing.", productIds: prior, status: "fixed",
    answer: { fixed: true, at: 1, text: "Claimed repaired." } });
  const incomingFinding = { text: "The GREETING is missing!", productIds: incoming, severity: "important" as const, evidence: proof };
  expect(checkReviewEvidence(task.findings, report({ verdict: "fail", findings: [{ ...incomingFinding, evidence: undefined }] }), task)).toBeUndefined();
  f.reports.apply(task, stage, report({ verdict: "fail", findings: [incomingFinding] }), "opus-high", "code-reviewer", "0");
  expect(task.findings).toHaveLength(2); expect(finding).toMatchObject({ id: "ownership-unknown", status: "fixed" });
  expect(finding.productIds).toEqual(prior); expect(task.findings[1]).toMatchObject({ status: "open", productIds: expected, evidence: proof });
});
