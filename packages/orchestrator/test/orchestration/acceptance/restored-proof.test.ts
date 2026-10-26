import { expect, it } from "vitest";
import { ACCEPTANCE_RESTORED } from "@petrina/core";
import { proofFreshnessFixture, PROOF_ITEM } from "../../fixtures/proof-freshness.js";

for (const proof of [false, true]) for (const committed of [false, true]) it(`keeps final acceptance unverified after a supplied ${committed ? "commit" : "tracked-edit"} restoration, requested proof ${proof}`, async () => {
  const f = proofFreshnessFixture(false, true); await f.report();
  const request = proof ? f.request() : undefined;
  f.observe(0, true); const versions = f.versions;
  const restored = { at: 2_000, products: [{ productId: f.ids[0]!, ...(committed ? { commits: true } : { edits: true }), files: ["tester-edit.txt"] }] };
  const final = await f.report({ restored });
  expect(final.step.agentResults![0]!.value).toBe(final.reply); expect(final.reply.checks[0]!.result).toBe("pass");
  expect(final.step.proofRun!.restored).toEqual(restored);
  expect(final.step.acceptanceChecks).toEqual([{ text: PROOF_ITEM, result: "blocked", evidence: "Recovery worked.", reason: ACCEPTANCE_RESTORED },
    ...(request ? [{ text: request.text, result: "blocked", evidence: final.reply.proofAnswers[0]!.evidence, reason: ACCEPTANCE_RESTORED }] : [])]);
  expect(f.task.testedVersions).toEqual(versions); expect(f.versions).toEqual(versions);
  expect(f.task.acceptancePassed).toBe(false); expect(f.task.acceptanceUnverified).toBe(true); expect(f.task.acceptanceBlocked).toBe(true);
  expect(f.task.findings).toEqual([]); expect(f.task.rounds.review).toBeUndefined();
  expect(f.scope.work.acceptanceReturns).toBeUndefined(); expect(f.scope.work.checkReturns).toBeUndefined(); expect(f.task.proofRefreshes).toBeUndefined();
  if (request) {
    expect(final.reply.proofAnswers[0]!.result).toBe("pass"); expect(final.step.proofChecks![0]!.result).toBe("blocked");
    expect(request.status).toBe("unverified"); expect(request.proof).toMatchObject({ stepId: final.step.id, versions, result: "blocked", reason: ACCEPTANCE_RESTORED });
  }
  expect((await f.final()).kind).toBe("stop"); expect(f.reports).toHaveLength(2); expect(f.task.stageIndex).toBe(3);
  // Native pairs prove real Git restoration, exact files/HEAD, read-only prompt and coordinator approval persistence.
});

it("settles requested proof when cleanup reports no restored project content", async () => {
  const f = proofFreshnessFixture(), request = f.request(), versions = f.versions;
  const final = await f.report();
  expect(final.step.proofRun?.restored).toBeUndefined(); expect(request.status).toBe("proved"); expect(request.proof!.versions).toEqual(versions);
  expect(f.task.acceptancePassed).toBe(true); expect(f.task.acceptanceUnverified).toBe(false);
  expect(f.notes.some(note => note.startsWith("This acceptance run cannot verify"))).toBe(false);
  expect((await f.final()).kind).toBe("stop"); expect(f.reports).toHaveLength(1);
  // Both native output producers still run in the retained real-cleanup controls; no filesystem cleanup is inferred here.
});

for (const committed of [false, true]) it(`keeps a first ${committed ? "commit" : "tracked-edit"} restored run unverified and never reuses an older pass`, async () => {
  const f = proofFreshnessFixture(false, true); const earlier = await f.report();
  const final = await f.report({ final: false, restored: { at: 2_000, products: [{ productId: f.ids[0]!, ...(committed ? { commits: true } : { edits: true }), files: ["tester-edit.txt"] }] } });
  const request = f.request("Show recovery", f.ids, PROOF_ITEM);
  expect(request.status).toBe("pending"); expect(request.proof).toBeUndefined();
  expect(final.step.acceptanceChecks![0]).toMatchObject({ result: "blocked", reason: ACCEPTANCE_RESTORED });
  expect(f.task.acceptancePassed).toBe(false); expect(f.task.acceptanceUnverified).toBe(true); expect(f.task.findings).toEqual([]);
  expect(f.task.acceptanceBlocked).toBeUndefined(); expect(f.task.stageIndex).toBe(2);
  expect(f.task.brief!.acceptance[0]).toMatchObject({ text: PROOF_ITEM, verification: "blocked", reason: ACCEPTANCE_RESTORED });
  expect(final.step).not.toBe(earlier.step); expect(final.step.reason).toBe("Petrina undid changes during acceptance testing");
  // An actually new proof request is owed; the invalidated run and older pass cannot fulfill it.
  expect((await f.final()).kind).toBe("repeat"); expect(f.task.proofRetestReason).toBe("requested");
  delete f.task.proofRequests; delete f.task.retest; f.observe(0, true);
  expect((await f.final()).kind).toBe("stop"); expect(f.reports).toHaveLength(2);
});

for (const edited of [false, true]) it(`adds a decision only when required acceptance was restored, with no planned delivery gate (${edited})`, async () => {
  const f = proofFreshnessFixture(false, true, false);
  await f.report({ final: false, ...(edited ? { restored: { at: 2_000, products: [{ productId: f.ids[0]!, edits: true, files: ["tester-edit.txt"] }] } } : {}) });
  expect(f.task.acceptanceUnverified).toBe(edited);
  expect(f.task.plan!.stages.map(stage => stage.kind)).toEqual(edited ? ["do", "do", "review-chain", "gate", "do"] : ["do", "do", "review-chain", "do"]);
  expect(f.task.proofDeliveryGate !== undefined).toBe(edited); expect(f.task.stageIndex).toBe(2);
  expect(f.notes.some(note => note === "Added your delivery check: this acceptance run cannot verify the product, so delivery waits for your decision")).toBe(edited);
  // Actual automatic publication vs one explicit approval remains the retained native two-row conjunction.
});

for (const [where, change] of [["active", "edit"], ["companion", "edit"], ["companion", "commit"], ["companion", "output"]] as const) it(`preserves shared ownership and ${change === "output" ? "keeps" : "invalidates"} the whole result after ${where} ${change}`, async () => {
  const f = proofFreshnessFixture(true, true), touched = f.ids[where === "active" ? 0 : 1]!, other = f.ids[where === "active" ? 1 : 0]!;
  const request = f.request("Prove the untouched product", [other]), versions = f.versions;
  f.task.brief!.acceptance = [{ text: PROOF_ITEM, productIds: [other], versions: { [other]: versions[other]! }, verification: "passed", met: true }];
  const restored = change === "output" ? undefined : { at: 2_000, products: [{ productId: touched, ...(change === "commit" ? { commits: true } : { edits: true }), files: ["shared-edit.txt"] }] };
  const final = await f.report({ ...(restored ? { restored } : {}) });
  expect(f.versions).toEqual(versions); expect(f.task.findings).toEqual([]); expect(f.task.repair).toBeUndefined(); expect(f.task.stageIndex).toBe(3);
  if (change === "output") {
    expect(request.status).toBe("proved"); expect(final.step.proofRun?.restored).toBeUndefined();
  } else {
    expect(request.status).toBe("unverified"); expect(request.proof).toMatchObject({ versions, result: "blocked", reason: ACCEPTANCE_RESTORED });
    expect(f.task.acceptancePassed).toBe(false); expect(f.task.acceptanceUnverified).toBe(true); expect(f.task.acceptanceBlocked).toBe(true);
    expect(final.step.proofRun!.restored!.products).toEqual(restored!.products);
    expect(f.task.brief!.acceptance[0]).toEqual({ text: PROOF_ITEM, productIds: [other], versions: { [other]: versions[other]! }, met: undefined, verification: "blocked", reason: `${ACCEPTANCE_RESTORED} Together: no valid affected products were assigned. The coordinator must resolve ownership.` });
  }
});
