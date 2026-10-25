import { afterAll, expect, it } from "bun:test";
import { beginPetrinaStep } from "@petrina/core";
import { proofRequestFixtures } from "../../fixtures/proof-requests.js";

const { signal, fixture, close } = proofRequestFixtures();
afterAll(close);
for (const started of [false, true]) it(`records the publishing return with ${started ? "an open" : "no open"} publishing step`, async () => {
  const f = await fixture(); await f.request(); await f.recordPass();
  try {
    await f.drive(); f.engine.approve(f.engine.s.inbox.find(item => item.kind === "delivery")!.id);
    if (started) beginPetrinaStep(f.task, "delivery", Date.now());
    await f.advance();
    if (started) await f.engine["shipping"]["returnForDecision"](f.task, "proof");
    else expect(await f.engine["shipping"]["readyToShip"](f.scope, signal())).toBe("back");
    const steps = f.task.journey!.filter(step => step.kind === "petrina" && step.work === "delivery");
    expect(steps).toHaveLength(1); expect(steps[0]!.outcome).toBe("Nothing published; a new delivery decision is needed");
    expect(steps[0]!.endedAt).toBeDefined(); expect(steps[0]!.reason).toContain("differ from your delivery decision");
    expect(f.task.stageIndex).toBe(3); expect(f.task.approvedProofDecision).toBeUndefined();
  } finally { await f.engine.shutdown(); }
});
