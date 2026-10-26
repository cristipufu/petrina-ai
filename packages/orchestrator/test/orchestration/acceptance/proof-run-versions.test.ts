import { expect, it } from "vitest";
import { routeAcceptance } from "../../../src/acceptance-routing.js";
import { acceptanceHost } from "../../fixtures/acceptance.js";
import { acceptanceResultsFixture } from "../../fixtures/acceptance-results.js";

for (const shared of [false, true]) for (const unrelated of shared ? [false, true] : [false]) for (const result of ["pass", "fail"] as const) {
  it(`preserves ${result} for ${shared ? "shared" : "single"} proof when ${unrelated ? "another" : "an affected"} product changes during testing`, async () => {
    const f = acceptanceResultsFixture(shared), request = f.request("proof", [f.task.productId]);
    f.task.retest = true;
    const before = structuredClone(f.versions), ids = Object.keys(before);
    const changed = ids[unrelated ? 1 : 0]!;
    const observed = { ...before, [changed]: `${before[changed]}-changed-during-test` };
    const answer = { id: request.id, result, evidence: "The scoped scenario and its nearby control were tried" };
    const raw = { summary: "Tried required proof", checks: [], proofAnswers: [answer], learnings: [] };
    const recorded = await f.record(raw, observed);
    const route = acceptanceHost();
    expect(routeAcceptance(route.host, f.scope, recorded)).toBe("continue");
    expect(request.proof!.versions).toEqual(before); expect(request.proof!.result).toBe(result);
    expect(request.status).toBe(unrelated ? result === "pass" ? "proved" : "failed" : "stale");
    expect(f.task.acceptanceUnverified).toBe(false); expect(f.task.acceptanceBlocked).toBeUndefined();
    expect(f.step.agentResults![0]!.value).toBe(raw);
    expect(f.step.agentResults![0]!.versions).toEqual(before);
    if (result === "fail") {
      expect(f.task.stageIndex).toBe(0); expect(f.task.findings).toHaveLength(1);
      expect(f.task.findings[0]!.proofRequestId).toBe(request.id); expect(f.task.findings[0]!.status).toBe("open");
      expect(f.scope.work.acceptanceReturns).toBe(1);
      if (shared) expect(f.task.repair!.products).toEqual([f.task.productId]);
    } else {
      expect(f.task.stageIndex).toBe(3); expect(f.task.acceptancePassed).toBe(false);
      expect(f.task.findings).toEqual([]); expect(f.scope.work.acceptanceReturns).toBeUndefined();
    }
    expect(f.task.proofRefreshes).toBeUndefined();
    // The actual changed-worktree and subsequent final-refresh conjunction is retained in the native pair.
    // This controller only consumes the adapter's independent before/current version observations.
  });
}
