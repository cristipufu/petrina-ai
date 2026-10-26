import { expect, it } from "vitest";
import { acceptanceGap, builderFindings, gateStatus, gateTitle, owedAcceptanceTest } from "@petrina/core";
import { acceptanceObservation as check, acceptanceRepairFixture, GREETING, PHONE, UNAVAILABLE } from "../../fixtures/acceptance-repair.js";
import { acceptanceReviewFixture, reviewReply } from "../../fixtures/acceptance-review.js";

it("runs every owed review after a successful early acceptance repair, then asks at the planned delivery check", async () => {
  const f = acceptanceRepairFixture();
  const first = await f.report([check("fail", ["a"])]);
  expect(first.next).toBe("continue");
  expect(f.task.repair).toEqual({ products: ["a"], index: 0, returnStage: 1, kind: "acceptance" });
  expect(f.task.repositories!.map(work => work.acceptanceReturns)).toEqual([1, undefined]);
  expect(f.task.stageIndex).toBe(0);
  await f.returned();
  expect(f.task.repairCheck).toBe(true); expect(f.task.stageIndex).toBe(1);
  expect(owedAcceptanceTest(f.task)?.final).toBe(false);
  await f.report([check("pass", ["a"])]);
  expect(f.task.stageIndex).toBe(2); expect(f.task.plan!.stages[f.task.stageIndex]!.id).toBe("review");
  expect(f.task.findings.filter(finding => finding.text === `Failed acceptance check: ${GREETING}`).map(finding => finding.status)).toEqual(["fixed"]);
  expect(f.task.repairCheck).toBeUndefined(); expect(f.task.acceptancePassed).toBe(true);
  expect(f.task.plan!.stages.filter(stage => stage.gate === "delivery")).toHaveLength(1);
  expect(f.task.retest).toBeUndefined();
  // Native review seats, passed outcomes, before/after main identities and actual approval/landing remain in
  // the retained custom acceptance role's planned-gate journey and the built-in automatic-delivery journey.
});

it("repairs a real failure while another required item stays unavailable, runs every owed review, then asks one decision at the planned delivery check", async () => {
  const f = acceptanceRepairFixture([GREETING, PHONE]);
  await f.report([check("fail", ["a"]), check("blocked", ["b"])]);
  expect(f.task.repair?.products).toEqual(["a"]);
  expect(f.task.repositories!.map(work => work.acceptanceReturns)).toEqual([1, undefined]);
  await f.returned();
  await f.report([check("pass", ["a"]), check("blocked", ["b"])]);
  expect(f.task.plan!.stages[f.task.stageIndex]!.id).toBe("review");
  expect(f.task.findings.some(finding => finding.text.includes(PHONE))).toBe(false);
  expect(f.task.brief!.acceptance.map(item => item.verification)).toEqual(["passed", "blocked"]);
  expect(f.task.brief!.acceptance[1]!.reason).toBe(UNAVAILABLE);
  expect(f.task.plan!.stages.filter(stage => stage.gate === "delivery")).toHaveLength(1);
  expect(f.task.proofDeliveryGate).toBeUndefined();
  expect(f.notes.filter(text => text.startsWith("Added your delivery check"))).toEqual([]);
  expect(gateTitle(f.task, "delivery")).toBe("Your call on “Show the greeting”: 1 acceptance check could not be verified");
  // The retained added-delivery-check mixed-evidence journey proves the actual inbox body and approval/landing.
});

for (const repaired of [true, false]) it(`still runs the owed reviews for a task the previous version saved between an early repair and its test, at an added delivery check, ${repaired ? "when the repair passes" : "when its repairs are then used up"}`, async () => {
  const f = acceptanceRepairFixture([GREETING, PHONE]);
  // Explicit restored legacy state: no repairCheck, retest true, and unfinished reviews after the current Tester.
  f.task.plan!.stages = f.task.plan!.stages.filter(stage => stage.gate !== "delivery");
  f.task.proofDeliveryGate = "added-delivery-check";
  f.task.plan!.stages.splice(-1, 0, { id: f.task.proofDeliveryGate, kind: "gate", gate: "delivery", title: "Your delivery check", roleId: "release-manager", profileIds: [] });
  f.task.repositories![0]!.acceptanceReturns = 1; f.task.retest = true;
  expect(owedAcceptanceTest(f.task)?.final).toBe(false);
  await f.report([check(repaired ? "pass" : "fail", ["a"]), check("blocked", ["b"])]);
  if (!repaired) {
    expect(f.task.repair?.kind).toBe("acceptance");
    expect(f.task.repair?.final).toBeUndefined();
    await f.returned();
    await f.report([check("fail", ["a"]), check("blocked", ["b"])]);
  }
  expect(f.task.plan!.stages[f.task.stageIndex]!.id).toBe("review");
  expect(f.task.repositories!.map(work => work.acceptanceReturns)).toEqual([repaired ? 1 : 2, undefined]);
  expect(f.task.plan!.stages.filter(stage => stage.gate === "delivery")).toHaveLength(1);
  expect(f.task.retest).toBeUndefined(); expect(f.task.repairCheck).toBeUndefined();
  if (!repaired) {
    expect(f.task.findings.filter(finding => finding.text === `Failed acceptance check: ${GREETING}`).map(finding => finding.status)).toEqual(["open"]);
    expect(f.notes.filter(text => text === "Acceptance still fails: the builder returns are unavailable or used up. The remaining reviews run first, then the decision goes to you at your delivery check")).toHaveLength(1);
  }
});

it("keeps used-up acceptance failures open beside an unavailable item through every owed review and one added delivery check", async () => {
  const f = acceptanceReviewFixture([GREETING, PHONE], false);
  await f.report([check("fail", ["a"]), check("blocked", ["b"])]);
  await f.returned();
  await f.report([check("fail", ["a"]), check("blocked", ["b"])]);
  const held = f.task.findings.find(finding => finding.text === `Failed acceptance check: ${GREETING}`)!;
  // Accepted historical Builder claim is input, before the real later failing Tester report below.
  // Native A04/A07 prove applying Builder answers; this case proves the later owners do not reuse that claim.
  held.answer = { fixed: true, text: "The earlier Builder reported repairing this item.", at: f.now() };
  await f.returned();
  const lastTest = await f.report([check("fail", ["a"]), check("blocked", ["b"])]);
  expect(held.answer.at).toBeLessThan(lastTest.step.startedAt);
  expect(lastTest.step.acceptanceChecks?.map(item => item.result)).toEqual(["fail", "blocked"]);
  expect(f.returnedProducts).toEqual(["a", "a"]);
  expect(f.task.repositories!.map(work => work.acceptanceReturns)).toEqual([2, undefined]);
  expect(f.task.acceptanceBlocked).toBe(true);
  expect(f.notes.filter(text => text === "Acceptance still fails: the builder returns are unavailable or used up. The remaining reviews run first, then the decision goes to you at your delivery check")).toHaveLength(1);

  const code = f.startReview();
  f.acceptReview(code.stage, "0", reviewReply([{ text: "Consider a friendlier greeting.", severity: "nit", productIds: ["a"] }]));
  f.acceptReview(code.stage, "1", reviewReply([{ text: "Consider an even friendlier greeting.", severity: "nit", productIds: ["a"] }]));
  f.settleReview(code.stage);
  expect(f.ballots.next(f.task, code.stage)).toBeUndefined();
  await f.finishReview(code.stage);
  const security = f.startReview();
  f.acceptReview(security.stage, "0", reviewReply());
  f.settleReview(security.stage);
  expect(f.ballots.next(f.task, security.stage)).toBeUndefined();
  await f.finishReview(security.stage);
  expect(f.seats.sort()).toEqual(["review:1:code-reviewer:opus-high", "review:1:code-reviewer:sol-high", "security:1:security-reviewer:opus-high"]);
  expect(f.task.rounds.review ?? 1).toBe(1);
  expect(held.status).toBe("open"); expect(held.reopenedAt).toBeUndefined();
  const results = [code.step, security.step];
  expect(results.map(step => step.outcome)).toEqual(["2 nits", "Nothing to fix"]);
  expect(results.flatMap(step => step.result?.findings ?? []).some(finding => finding.id === held.id)).toBe(false);
  expect(results.flatMap(step => step.result?.findingChanges?.claimedFixed ?? [])).toEqual([]);
  const reports = f.finishedReviews();
  expect(reports.map(report => [report.openImportant, report.stillOpen, report.reopened, report.heldForDecision, (report.reportCounts as { closing: { open: { important: number } } }).closing.open.important]))
    .toEqual([[[held.id], [held.id], [], [held.id], 1], [[held.id], [held.id], [], [held.id], 1]]);
  expect(reports[0]!.summary).toContain("3 open reports (1 Important, 2 nits, 0 pre-existing follow-ups); 1 of the Important is an acceptance failure held for your delivery decision, not review work;");
  expect(f.task.plan!.stages[f.task.stageIndex]!.gate).toBe("delivery");
  expect(f.task.plan!.stages.filter(stage => stage.kind === "gate")).toHaveLength(1);
  expect(f.task.proofDeliveryGate).toBeDefined();
  expect(f.notes.filter(text => text.startsWith("Added your delivery check"))).toEqual(["Added your delivery check: a required acceptance check could not be verified, so delivery waits for your decision"]);
  expect(gateTitle(f.task, "delivery")).toBe("Your call on “Show the greeting”: 1 blocking finding still open");
  expect(gateStatus(f.task, "delivery")).toBe("Acceptance still fails after the builder's returns. Your call");
  expect(acceptanceGap(f.task)?.items).toEqual([{ text: PHONE, productIds: ["b"], evidence: "Tried to start the phone simulator twice; it never opened.", reason: UNAVAILABLE }]);
  // Native A03/A04 own the actual Inbox body, stable decision/restart and unchanged-then-advanced main branches.
});

for (const leading of ["important", "nit"] as const) it(`assigns only the independent finding's product after both acceptance returns are exhausted (${leading} first)`, async () => {
  const f = acceptanceReviewFixture();
  await f.report([check("fail", ["a", "b"])]);
  await f.returned(); await f.returned();
  await f.report([check("fail", ["a", "b"])]);
  await f.returned(); await f.returned();
  await f.report([check("fail", ["a", "b"])]);
  expect(f.returnedProducts).toEqual(["a", "b", "a", "b"]);
  expect(f.task.repositories!.map(work => work.acceptanceReturns)).toEqual([2, 2]);
  const held = f.task.findings.find(finding => finding.text === `Failed acceptance check: ${GREETING}`)!;
  const code = f.startReview();
  f.acceptReview(code.stage, "0", reviewReply([{ text: "Consider a friendlier greeting.", severity: "nit", productIds: ["a"] }]));
  f.acceptReview(code.stage, "1", reviewReply([{ text: "The greeting is missing on the welcome page.", severity: "important", productIds: ["a"], evidence: "Opened the welcome page; no greeting appeared." }]));
  f.settleReview(code.stage);
  const review = f.task.findings.find(finding => finding.text === "The greeting is missing on the welcome page.")!;
  const nit = f.task.findings.find(finding => finding.text === "Consider a friendlier greeting.")!;
  expect(nit.severity).toBe("suggestion"); expect(review.productIds).toEqual(["a"]);
  const first = leading === "important" ? review : nit;
  f.task.findings = [first, ...f.task.findings.filter(finding => finding !== first)];
  expect(f.task.findings[0]).toBe(first);
  const outcome = f.verifyReal(code.stage);
  expect(review.votes?.length).toBeGreaterThan(0); expect(review.verification?.verdict).toBe("real");
  expect(held.votes).toBeUndefined();
  expect(await f.finishReview(code.stage, outcome)).toBe("continue");
  expect(f.task.repair).toEqual({ products: ["a"], index: 0, returnStage: 2, kind: "review" });
  expect(f.task.blockingFindingsAfter!.review).toEqual([[review.id]]);
  expect(f.task.stageIndex).toBe(0); expect(f.task.activeProductId).toBe("a");
  expect(builderFindings(f.task, "a").map(finding => finding.id)).toEqual(leading === "important" ? [review.id, nit.id] : [nit.id, review.id]);
  expect(builderFindings(f.task, "a").some(finding => finding.id === held.id)).toBe(false);
  await f.returned();
  const assigned = f.task.journey!.findLast(step => step.roleId === "builder")!;
  expect(assigned.findingIds).toContain(review.id); expect(assigned.findingIds).not.toContain(held.id);
  expect(f.returnedProducts).toEqual(["a", "b", "a", "b", "a"]);
  expect(f.task.stageIndex).toBe(2); expect(f.task.rounds.review).toBe(2);
  expect(f.task.repair).toBeUndefined();
  expect(f.task.repositories!.map(work => work.acceptanceReturns)).toEqual([2, 2]);
  expect(held.status).toBe("open"); expect(review.status).toBe("open");
  // Native A07 applies the accepted Builder answer, marks only this review finding fixed and completes rereview.
});
