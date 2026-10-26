import { expect, it } from "vitest";
import { proofFreshnessFixture } from "../../fixtures/proof-freshness.js";

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
