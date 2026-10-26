import { expect, it } from "vitest";
import { gateTitle } from "@petrina/core";
import { acceptanceReviewFixture, reviewReply } from "../../fixtures/acceptance-review.js";
import { acceptanceObservation as check, GREETING, PHONE, UNAVAILABLE } from "../../fixtures/acceptance-repair.js";

const ALL_SEATS = ["review:1:code-reviewer:opus-high", "review:1:code-reviewer:sol-high", "security:1:security-reviewer:opus-high"];

async function owedReviews(f: ReturnType<typeof acceptanceReviewFixture>) {
  const code = f.startReview();
  f.acceptReview(code.stage, "0", reviewReply([{ text: "Consider a friendlier greeting.", severity: "nit", productIds: ["a"] }]));
  f.acceptReview(code.stage, "1", reviewReply([{ text: "Consider an even friendlier greeting.", severity: "nit", productIds: ["a"] }]));
  f.settleReview(code.stage); await f.finishReview(code.stage);
  const security = f.startReview();
  f.acceptReview(security.stage, "0", reviewReply()); f.settleReview(security.stage); await f.finishReview(security.stage);
}

it("runs every owed review after a successful early custom acceptance repair, then reaches the planned delivery check", async () => {
  const f = acceptanceReviewFixture();
  f.roles.push({ ...f.roles.find(role => role.result === "checks")!, id: "quality-partner", name: "Quality partner" });
  f.task.plan!.stages[1]!.roleId = "quality-partner";
  await f.report([check("fail", ["a"])]); await f.returned(); await f.report([check("pass", ["a"])]);
  expect(f.task.repositories!.map(work => work.acceptanceReturns)).toEqual([1, undefined]);
  await owedReviews(f);
  expect(f.seats.slice().sort()).toEqual(ALL_SEATS);
  expect(f.task.findings.filter(finding => finding.text === `Failed acceptance check: ${GREETING}`).map(finding => finding.status)).toEqual(["fixed"]);
  const results = f.task.journey!.filter(step => step.kind === "agent" && ["review", "security"].includes(step.stageId!));
  expect(results.map(step => step.outcome)).toEqual(["2 nits", "Nothing to fix"]);
  expect(results.flatMap(step => [...step.result?.findingChanges?.claimedFixed ?? [], ...step.result?.findingChanges?.fixed ?? []])).toEqual([]);
  expect(f.task.retest).toBeUndefined();
  expect(f.task.plan!.stages.filter(stage => stage.kind === "gate")).toHaveLength(1);
  expect(f.task.plan!.stages[f.task.stageIndex]!.gate).toBe("delivery");
  expect(f.task.journey!.filter(step => step.roleId === "quality-partner")).toHaveLength(2);
  // The actual planned-decision/approval/landing and custom session adapters remain paired native contracts.
});

it("repairs a real failure while another required item stays unavailable, runs every owed review, then reaches one added delivery check", async () => {
  const f = acceptanceReviewFixture([GREETING, PHONE], false);
  await f.report([check("fail", ["a"]), check("blocked", ["b"])]);
  await f.returned(); await f.report([check("pass", ["a"]), check("blocked", ["b"])]);
  await owedReviews(f);
  expect(f.task.repositories!.map(work => work.acceptanceReturns)).toEqual([1, undefined]); expect(f.seats.slice().sort()).toEqual(ALL_SEATS);
  expect(f.task.findings.some(finding => finding.text.includes(PHONE))).toBe(false);
  expect(f.task.plan!.stages.filter(stage => stage.kind === "gate")).toHaveLength(1);
  expect(f.task.proofDeliveryGate).toBeDefined(); expect(f.notes.filter(text => text.startsWith("Added your delivery check"))).toHaveLength(1);
  expect(gateTitle(f.task, "delivery")).toBe("Your call on “Show the greeting”: 1 acceptance check could not be verified");
  expect(f.task.brief!.acceptance.map(item => item.verification)).toEqual(["passed", "blocked"]);
  expect(f.task.brief!.acceptance[1]!.reason).toBe(UNAVAILABLE);
  expect(f.task.journey!.filter(step => step.roleId === "tester")).toHaveLength(2);
});

it("returns final testing's repair straight to the same delivery check after the reviews, without another review round", async () => {
  const f = acceptanceReviewFixture();
  await f.report([check("pass", ["a"])]);
  const first = f.startReview();
  f.acceptReview(first.stage, "0", reviewReply([{ text: "The greeting is missing on the welcome page.", severity: "important", productIds: ["a"], evidence: "Opened the welcome page" }]));
  f.acceptReview(first.stage, "1", reviewReply()); f.settleReview(first.stage);
  const outcome = f.verifyReal(first.stage); await f.finishReview(first.stage, outcome);
  await f.returned({ answerFindings: true });
  const repeated = f.startReview();
  f.acceptReview(repeated.stage, "0", reviewReply()); f.acceptReview(repeated.stage, "1", reviewReply());
  f.settleReview(repeated.stage); await f.finishReview(repeated.stage);
  const security = f.startReview(); f.acceptReview(security.stage, "0", reviewReply()); f.settleReview(security.stage); await f.finishReview(security.stage);
  const reviewed = f.seats.slice();
  f.task.retest = true; f.task.stageIndex = 1;
  await f.report([check("fail", ["a"])]);
  expect(f.task.repair).toEqual({ products: ["a"], index: 0, returnStage: 1, kind: "acceptance", final: true });
  await f.returned({ answerFindings: true }); await f.report([check("pass", ["a"])]);
  expect(f.seats).toEqual(reviewed); expect(f.task.rounds.review).toBe(2);
  expect(f.task.repositories!.map(work => work.acceptanceReturns)).toEqual([1, undefined]);
  expect(f.task.findings.filter(finding => finding.text === `Failed acceptance check: ${GREETING}`).map(finding => finding.status)).toEqual(["fixed"]);
  expect(f.task.plan!.stages.filter(stage => stage.kind === "gate")).toHaveLength(1);
  expect(f.task.plan!.stages[f.task.stageIndex]!.gate).toBe("delivery"); expect(f.task.acceptancePassed).toBe(true);
  // Store reopening and actual final Tester instruction/trigger observations stay explicit native obligations.
});
