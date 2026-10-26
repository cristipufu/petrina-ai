import { expect, it } from "vitest";
import { acceptanceGap, gateTitle, recordedCheckBatch } from "@petrina/core";
import { addDeliveryCheck } from "../../../src/delivery-gate.js";
import { requiredAcceptanceFixture, REQUIRED, SECOND, UNAVAILABLE, TRIED, blocked, passed, failing } from "../../fixtures/required-acceptance.js";

for (const checklist of [true, false]) it(`keeps the saved automatic delivery when ${checklist ? "every required item passes" : "there is no checklist"} and only an extra probe could not be verified`, async () => {
  const f = requiredAcceptanceFixture(checklist ? [REQUIRED] : []);
  try {
    const extra = blocked("The greeting also shows offline");
    f.configure({ checks: [...(checklist ? [passed()] : []), extra] });
    await f.drive();
    expect(f.decisions()).toEqual([]);
    expect(f.task.plan!.stages.some(stage => stage.kind === "gate")).toBe(false);
    expect(f.delivery.published).toHaveLength(1);
    expect(f.task.acceptancePassed).toBe(true); expect(f.task.acceptanceUnverified).toBe(true);
    expect(f.runs().at(-1)!.acceptanceChecks!.find(check => check.text === extra.text)).toMatchObject({ result: "blocked", reason: UNAVAILABLE });
    expect(f.agents.received("checks")).toHaveLength(1);
    expect(recordedCheckBatch(f.scope.work).kind).toBe("passed");
  } finally { await f.close(); }
});

it("tries the final code again after you send it back from the added check, then ships on its own once every required item passes", async () => {
  const f = requiredAcceptanceFixture();
  try {
    f.configure({ checks: [blocked()] }); await f.drive();
    expect(f.decisions()).toHaveLength(1); expect(f.delivery.published).toEqual([]);
    f.requestChanges("The hosted preview account works again; please try the welcome page once more");
    expect(f.task.approvedAcceptanceGap).toBeUndefined();
    f.configure({ checks: [passed(), blocked("The greeting also shows offline")] });
    await f.drive();
    expect(f.agents.received("checks")).toHaveLength(2);
    expect(f.acceptanceStarts.at(-1)!.retest).toBe(true);
    expect(f.task.timeline.some(entry => entry.text === "Trying the acceptance list once more on the final code")).toBe(true);
    expect(f.task.timeline.some(entry => entry.text === "Required acceptance is verified and checks passed: shipping without asking you, as this task's settings allow")).toBe(true);
    expect(f.decisions()).toEqual([]); expect(f.delivery.published).toHaveLength(1);
    expect(f.task.brief!.acceptance).toEqual([{ text: REQUIRED, met: true, verification: "passed" }]);
    expect(f.task.plan!.stages.filter(stage => stage.kind === "gate")).toHaveLength(1);
  } finally { await f.close(); }
});

for (const [repaired, planned] of [[true, false], [false, false], [true, true]] as const) it(`keeps a reproduced failure on its bounded repair route while another required item could not be verified, then asks one decision${repaired ? "" : " with both once the returns are used"}${planned ? ", at a delivery check planned from the start" : ""}`, async () => {
  const f = requiredAcceptanceFixture([REQUIRED, SECOND]);
  try {
    if (planned) { f.task.approveDelivery = true; f.task.plan!.stages.splice(3, 0, { id: "gate", title: "Delivery", kind: "gate", gate: "delivery", roleId: "release-manager", profileIds: [] }); }
    f.configure({ checks: [failing(), blocked(SECOND)], ...(repaired ? { fixedChecks: [passed(), blocked(SECOND)] } : {}) });
    await f.drive();
    expect(f.delivery.published).toEqual([]); expect(f.decisions()).toHaveLength(1);
    expect(f.scope.work.acceptanceReturns).toBe(repaired ? undefined : 2);
    expect(f.agents.received("checks")).toHaveLength(repaired ? 2 : 4);
    expect(f.task.timeline.filter(entry => entry.text === "Sent back to the builder: 1 acceptance check failed on the final code")).toHaveLength(repaired ? 0 : 2);
    expect(f.task.timeline.at(-1)!.text).toBe(repaired ? "Acceptance could not be fully verified, so the decision goes to you" : "Acceptance still fails: the builder returns are used up, so the decision goes to you");
    expect(f.runs().every(run => run.acceptanceChecks!.find(check => check.text === SECOND)!.result === "blocked")).toBe(true);
    const failure = f.task.findings.filter(finding => finding.text === `Failed acceptance check: ${REQUIRED}`);
    expect(failure).toHaveLength(1); expect(failure[0]!.status).toBe(repaired ? "fixed" : "open");
    expect(f.task.findings.some(finding => finding.text.includes(SECOND))).toBe(false);
    expect(f.task.acceptanceBlocked).toBe(true);
    expect(f.decisions()[0]!.title).toBe(repaired ? "Your call on “Show the greeting”: 1 acceptance check could not be verified" : "Your call on “Show the greeting”: 1 blocking finding still open");
    // Native role/shared journeys retain the actual Inbox rendering; the policy consumes the canonical gap items.
    expect(acceptanceGap(f.task)!.items).toEqual([{ text: SECOND, reason: UNAVAILABLE, evidence: TRIED }]);
    expect(f.task.brief!.acceptance.map(item => item.verification)).toEqual([repaired ? "passed" : "failed", "blocked"]);
    expect(f.task.plan!.stages.filter(stage => stage.kind === "gate")).toHaveLength(1);
    expect(f.task.proofDeliveryGate === undefined).toBe(planned);
    expect(f.task.timeline.some(entry => entry.text.startsWith("Added your delivery check"))).toBe(!planned);
    // SQL reopening of the used allowance/decision is retained by repair-reviews' native exhausted shared case.
    expect(f.runs("builder")).toHaveLength(repaired ? 1 : 3);
  } finally { await f.close(); }
});

for (const entry of ["already at delivery", "prepared with automatic approval", "decided for an earlier run", "approved by you before this update"] as const) it(`asks before publishing starts with an undecided required gap: ${entry}`, async () => {
  const f = requiredAcceptanceFixture();
  try {
    f.configure({ checks: [blocked()] }); await f.report();
    f.task.plan!.stages = f.task.plan!.stages.filter(stage => stage.kind !== "gate"); delete f.task.proofDeliveryGate;
    f.task.stageIndex = 3;
    if (entry !== "already at delivery") {
      f.scope.work.approvedSha = "scripted:head";
      f.scope.work.approvedFor = { by: entry === "approved by you before this update" ? "coordinator" : "task", mode: "local", destination: "unused" };
      expect(await f.delivery.effects.prepare(f.scope, f.ship, new AbortController().signal)).toBe("ready");
    }
    if (entry === "decided for an earlier run") f.task.approvedAcceptanceGap = { stepId: "an-earlier-run", items: [{ text: REQUIRED, reason: UNAVAILABLE }] };
    await f.drive();
    expect(f.delivery.published).toEqual([]);
    expect(f.scope.work.shipping).toBeUndefined(); expect(f.scope.work.approvedFor).toBeUndefined();
    expect(f.task.plan!.stages.map(stage => stage.kind)).toEqual(["do", "do", "review-chain", "gate", "do"]);
    const earlier = entry === "decided for an earlier run" || entry === "approved by you before this update";
    expect(f.task.timeline.filter(line => line.text.startsWith("Nothing was published:")).map(line => line.text)).toEqual([earlier
      ? "Nothing was published: Petrina has no record that your approval covered the acceptance checks that could not be verified, so it asks you about them first."
      : "Nothing was published: required acceptance could not be verified and has no decision from you yet. Petrina asks you first."]);
    expect(f.decisions()).toHaveLength(1);
    expect(acceptanceGap(f.task)!.items).toEqual([{ text: REQUIRED, reason: UNAVAILABLE, evidence: TRIED }]);
    expect(f.agents.received("checks")).toHaveLength(1);
    expect(f.delivery.events.filter(event => event.startsWith("back-to-work:"))).toHaveLength(1);
    f.approve(); await f.drive();
    expect(f.delivery.published).toHaveLength(1);
  } finally { await f.close(); }
});

it("reuses the requested-proof delivery check without adding another, and one explicit approval covers both decisions", async () => {
  const f = requiredAcceptanceFixture();
  try {
    f.task.proofRequests = [{ id: "proof-1", text: "Run the greeting on Linux", reason: "Required on the final code", productIds: [f.task.productId], source: "review:0:0", requestedBy: { stageId: f.review.id, round: 1, seat: "0", roleId: "code-reviewer", profileId: "sol-high" }, ownerStageId: f.tester.id, reviewedVersions: f.versions(), status: "pending" }];
    expect(addDeliveryCheck(f.catalog, f.task)).toBe(true);
    f.configure({ checks: [blocked()], proofAnswers: [{ id: "proof-1", result: "pass", evidence: "Ran it on Ubuntu 24.04: the greeting printed once" }] });
    await f.drive();
    expect(f.task.plan!.stages.filter(stage => stage.kind === "gate")).toHaveLength(1);
    expect(f.task.timeline.some(entry => entry.text.startsWith("Added your delivery check"))).toBe(false);
    expect(f.task.proofRequests[0]!.status).toBe("proved");
    expect(f.decisions()).toHaveLength(1); expect(f.delivery.published).toEqual([]);
    expect(gateTitle({ ...f.task, ...f.scope.work }, "delivery")).toBe("Your call on “Show the greeting”: 1 acceptance check could not be verified");
    expect(acceptanceGap(f.task)!.items).toEqual([{ text: REQUIRED, reason: UNAVAILABLE, evidence: TRIED }]);
    f.approve();
    expect(f.task.approvedProofDecision!.statuses).toEqual({ "proof-1": "proved" }); expect(f.task.approvedAcceptanceGap!.items.map(item => item.text)).toEqual([REQUIRED]);
    await f.drive(); expect(f.delivery.published).toHaveLength(1); expect(f.agents.received("checks")).toHaveLength(1);
  } finally { await f.close(); }
});

for (const changed of [false]) it(`${changed ? "tries the final code again when it changed after" : "ships on its own straight after"} a required pass with an extra probe unverified, through an added delivery check`, async () => {
  const f = requiredAcceptanceFixture();
  try {
    f.configure({ checks: [passed(), blocked("The greeting also shows offline")] }); await f.report();
    expect(f.task.acceptancePassed).toBe(true); expect(f.task.proofDeliveryGate).toBeUndefined();
    expect(addDeliveryCheck(f.catalog, f.task)).toBe(true); f.task.stageIndex = 3;
    const tested = { ...f.task.testedVersions };
    await f.drive();
    expect(f.agents.received("checks")).toHaveLength(changed ? 2 : 1);
    expect(f.decisions()).toEqual([]); expect(f.delivery.published).toHaveLength(1);
    expect(f.task.testedVersions).toEqual(tested);
    expect(f.task.testedVersions![f.task.productId]).toBe(f.versions()[f.task.productId]);
  } finally { await f.close(); }
});

for (const failure of [new Error("source observation failed"), undefined]) it(`stops the actual checkpoint at a ${failure === undefined ? "undefined" : "Error"} source rejection without starting checks or approval`, async () => {
  const f = requiredAcceptanceFixture(), calls: string[] = [];
  try {
    f.checkpointEffects.writeGuide = async bound => { expect(bound.task).toBe(f.task); expect(bound.work).toBe(f.scope.work); calls.push("guide"); };
    f.checkpointEffects.writeLearnings = async () => { calls.push("learnings"); };
    f.checkpointEffects.upToDate = async () => { calls.push("source"); throw failure; };
    f.checkpointEffects.checksBeforeDelivery = async () => { calls.push("checks"); throw new Error("Checks must not start after the rejected source observation"); };
    const result = await f.checkpoint.run(f.scope, new AbortController().signal).then(() => ({ failed: false, error: undefined }), error => ({ failed: true, error }));
    expect(result.failed).toBe(true); expect(result.error).toBe(failure);
    expect(calls).toEqual(["guide", "learnings", "source"]);
    expect(f.decisions()).toEqual([]); expect(f.scope.work.approvedFor).toBeUndefined(); expect(f.delivery.published).toEqual([]);
  } finally { await f.close(); }
});

for (const failure of [new Error("restore failed"), undefined]) it(`retains bound preparation and the original ${failure === undefined ? "undefined" : "Error"} rejection when return-to-work fails`, async () => {
  const f = requiredAcceptanceFixture();
  try {
    f.scope.work.approvedFor = { by: "coordinator", mode: "local", destination: "scripted:main" };
    f.scope.work.shipping = { moves: 1, failures: 2 };
    f.task.stageIndex = 3;
    f.delivery.hooks.backToWork = async bound => { expect(bound.work).toBe(f.scope.work); throw failure; };
    const result = await f.delivery.workflow.returnForDecision(f.task, "acceptance").then(() => ({ failed: false, error: undefined }), error => ({ failed: true, error }));
    expect(result.failed).toBe(true); expect(result.error).toBe(failure);
    expect(f.scope.work.approvedFor).toEqual({ by: "coordinator", mode: "local", destination: "scripted:main" });
    expect(f.scope.work.shipping).toEqual({ moves: 1, failures: 2 });
    expect(f.task.stageIndex).toBe(3); expect(f.task.proofDeliveryGate).toBeUndefined(); expect(f.delivery.published).toEqual([]);
  } finally { await f.close(); }
});

it("keeps the actual missing-head fallback bound to its execution and clears older checked observations", async () => {
  const f = requiredAcceptanceFixture();
  try {
    f.configure({ checks: [blocked()] }); await f.report();
    f.scope.work.checkedSha = "older-observation"; f.scope.work.checkedPatch = "older-patch";
    f.checkpointEffects.head = async () => { throw undefined; };
    const seen: unknown[] = [];
    f.checkpointEffects.patch = async (bound, head) => { seen.push(bound.work, head); return undefined; };
    expect(await f.checkpoint.run(f.scope, new AbortController().signal)).toEqual({ kind: "stop" });
    expect(seen).toEqual([f.scope.work, undefined]);
    expect(f.scope.work.checkedSha).toBeUndefined(); expect(f.scope.work.checkedPatch).toBeUndefined();
    expect(f.decisions()).toHaveLength(1); expect(f.delivery.published).toEqual([]);
  } finally { await f.close(); }
});
