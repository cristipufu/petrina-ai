import { expect, it } from "vitest";
import { gateTitle, owedAcceptanceTest } from "@petrina/core";
import { acceptanceObservation as check, acceptanceRepairFixture, GREETING, PHONE, UNAVAILABLE } from "../../fixtures/acceptance-repair.js";

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
