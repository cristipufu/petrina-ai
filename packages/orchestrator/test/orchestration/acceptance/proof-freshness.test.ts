import { expect, it } from "vitest";
import { proofFreshnessFixture, PROOF_ITEM } from "../../fixtures/proof-freshness.js";

for (const brief of [false, true]) it(`requires exact-version proof after unchanged-patch main advances, with brief ${brief}, and bounds main-only reruns`, async () => {
  const f = proofFreshnessFixture(false, brief), request = f.request();
  const first = await f.report(), patch = f.task.testedPatch;
  for (let move = 1; move <= 3; move++) {
    f.observe();
    const outcome = await f.final();
    if (move < 3) {
      expect(outcome.kind).toBe("repeat"); expect(f.task.retest).toBe(true); expect(f.task.stageIndex).toBe(1);
      expect(f.task.proofRetestReason).toBe("main-moved"); expect(f.task.proofRefreshes).toBe(move);
      await f.report();
      expect(request.status).toBe("proved"); expect(request.proof!.versions).toEqual(f.versions);
      expect(f.task.testedPatch).toBe(patch); expect(f.task.testedVersions).toEqual(f.versions);
    } else {
      expect(outcome.kind).toBe("stop"); expect(request.status).toBe("stale"); expect(f.task.proofRefreshes).toBe(2);
      expect(f.task.proofRefreshBlocked).toBe(true); expect(f.task.stageIndex).toBe(3);
    }
  }
  expect(f.reports).toHaveLength(3); expect(f.task.findings).toEqual([]);
  expect(f.scope.work.acceptanceReturns).toBeUndefined(); expect(f.scope.work.checkReturns).toBeUndefined();
  expect(f.task.rounds.review).toBeUndefined(); expect(first.step.acceptancePatch).toBe(patch);
  expect(f.notes.filter(note => note === "Final acceptance testing: main moved since the proof was recorded")).toHaveLength(2);
  // Actual Git main-only identity observation, checkpoint log reading and SQL reopening remain native pairs.
});

for (const refreshes of [0, 1]) it(`refreshes proof after main moves during final testing, with ${2 - refreshes} refreshes available`, async () => {
  const f = proofFreshnessFixture(), request = f.request(); await f.report(); f.task.proofRefreshes = refreshes;
  f.observe(); expect((await f.final()).kind).toBe("repeat");
  const stale = await f.report({ beforeRecord: () => f.observe() });
  expect(stale.step.agentResults![0]!.versions).toEqual(stale.run.versions);
  expect(stale.run.versions).not.toEqual(f.versions); expect(request.proof!.result).toBe("pass");
  expect(f.task.acceptancePassed).toBe(false); expect(f.task.acceptanceUnverified).toBe(false);
  const again = await f.final();
  if (!refreshes) { expect(again.kind).toBe("repeat"); await f.report(); expect((await f.final()).kind).toBe("stop"); }
  else expect(again.kind).toBe("stop");
  expect(f.reports).toHaveLength(3 - refreshes); expect(f.task.proofRefreshes).toBe(2);
  expect(request.status).toBe(refreshes ? "stale" : "proved"); expect(f.task.proofRefreshBlocked).toBe(!!refreshes);
  expect(f.task.findings).toEqual([]); expect(f.task.acceptanceBlocked).toBeUndefined(); expect(f.task.stageIndex).toBe(3);
  await f.final(); expect(f.reports).toHaveLength(3 - refreshes);
});

it("keeps ordinary unchanged-patch reuse and already-current proof without another acceptance observation", async () => {
  const f = proofFreshnessFixture(); await f.report(); f.observe();
  expect((await f.final()).kind).toBe("stop"); expect(f.task.retest).toBeUndefined(); expect(f.reports).toHaveLength(1);
  const request = f.request(); await f.report();
  expect((await f.final()).kind).toBe("stop"); expect(request.status).toBe("proved"); expect(f.reports).toHaveLength(2);
});

it("requires every affected shared product version and bounds main-only shared refreshes", async () => {
  const f = proofFreshnessFixture(true), request = f.request(); await f.report();
  for (let move = 0; move < 3; move++) {
    f.observe(move % 2); const outcome = await f.final();
    if (move < 2) { expect(outcome.kind).toBe("repeat"); await f.report(); }
    else expect(outcome.kind).toBe("stop");
  }
  expect(f.reports).toHaveLength(3); expect(f.task.proofRefreshes).toBe(2); expect(request.status).toBe("stale");
  expect(request.proof!.versions).not.toEqual(f.versions); expect(f.task.repair).toBeUndefined(); expect(f.task.findings).toEqual([]);
});

it("asks after the shared refresh limit even when only an owner outside the requested subset changes", async () => {
  const f = proofFreshnessFixture(true), request = f.request("Prove only the first product", [f.ids[0]!]); await f.report();
  for (let move = 0; move < 3; move++) {
    f.observe(1); const outcome = await f.final();
    if (move < 2) { expect(outcome.kind).toBe("repeat"); await f.report(); }
    else expect(outcome.kind).toBe("stop");
  }
  expect(f.reports).toHaveLength(3); expect(request.status).toBe("proved"); expect(f.task.proofRefreshBlocked).toBe(true);
  expect(f.task.stageIndex).toBe(3); expect(f.task.approvedProofDecision).toBeUndefined(); expect(f.decisions).toHaveLength(1);
});

for (const requests of [undefined, []]) it(`does not read discarded versions for single-product delivery with ${requests ? "empty" : "absent"} proof requests`, async () => {
  const f = proofFreshnessFixture(false, true);
  await f.report(); f.task.proofRequests = requests;
  f.effects.versions = async () => { throw new Error("No proof or shared owner needs a version observation"); };
  f.effects.committedCode = async () => { throw new Error("No proof needs committed code"); };
  let patches = 0;
  const patch = f.effects.acceptanceVersion;
  f.effects.acceptanceVersion = async (scope, versions) => {
    expect(versions).toBeUndefined(); patches++;
    return patch(scope, versions);
  };
  expect(await f.final()).toEqual({ kind: "stop" });
  expect(patches).toBe(1);
  expect(f.decisions).toEqual([f.task.id]);
  expect(f.task.acceptancePassed).toBe(true);
});

it("keeps the shared acceptance invalidation's actual version observation without an extra read", async () => {
  const f = proofFreshnessFixture(true, true);
  await f.report({ checks: [{ text: PROOF_ITEM, result: "pass", evidence: "The supplied acceptance result covers both products", productIds: f.ids }] }); f.observe(1, true);
  f.effects.versions = async () => { throw new Error("Shared invalidation already supplies the observed versions"); };
  const invalidation = f.effects.invalidateAcceptance;
  let observed: Record<string, string> | undefined;
  f.effects.invalidateAcceptance = async (task, versions) => { observed = await invalidation(task, versions); return observed; };
  expect(await f.final()).toEqual({ kind: "repeat" });
  expect(observed).toEqual(f.versions);
  expect(f.task.retest).toBe(true);
  expect(f.decisions).toEqual([]);
});

it("still refreshes requested proof from the committed snapshot before a delivery decision", async () => {
  const f = proofFreshnessFixture(false, true), request = f.request();
  await f.report(); expect(request.status).toBe("proved"); f.observe();
  const capture = f.effects.committedCode;
  let captures = 0;
  f.effects.committedCode = async task => { captures++; return capture(task); };
  f.effects.versions = async () => { throw new Error("The current committed proof snapshot must be reused"); };
  expect(await f.final()).toEqual({ kind: "repeat" });
  expect(captures).toBe(1); expect(request.status).toBe("stale");
  expect(f.task.proofRetestReason).toBe("main-moved");
  expect(f.decisions).toEqual([]);
});
