import { afterAll, expect, it, spyOn } from "bun:test";

import { executionFor } from "@petrina/orchestrator";
import { commandText } from "../../../src/checks.js";

import { continuedReviewFixtures } from "../../fixtures/continued-review.js";
const { signal, important, rounds, passedCovered, close } = continuedReviewFixtures();
afterAll(close);

it("sends an unchanged finding back as today without a decision to continue, after asking for changes, or with a decision saved before covers", async () => {
  for (const how of ["none", "changes", "older"] as const) {
    const f = await rounds();
    try {
      f.task.findings = [important("accepted")];
      if (how === "none") f.task.stageIndex = 2;
      else await f.exhaust(how === "changes" ? "changes" : "continue");
      if (how === "changes") { expect(f.task.reviewDecision).toBeUndefined(); expect(f.task.fixing).toBe(true); f.task.fixing = false; }
      if (how === "older") f.task.reviewDecision = { stageId: "review", round: 1, accepted: true };
      expect(await f.review()).toBe("continue");
      expect(f.task.fixing).toBe(true); expect(f.task.stageIndex).toBe(0);
      expect(f.step().reason).toBe("sent back: 1 important");
    } finally { await f.engine.shutdown(); }
  }
});

it("never covers failing product checks before the later review or before delivery", async () => {
  for (const where of ["review", "delivery"] as const) {
    const f = await rounds();
    const admit = spyOn(f.engine["driver"].workflow as unknown as { admitNext: () => Promise<boolean> }, "admitNext").mockResolvedValue(false);
    try {
      f.task.findings = [important("accepted")];
      await f.exhaust();
      f.engine.setProductChecks(f.task.productId, [{ name: "Tests", command: commandText([process.execPath, "-e", "console.error('reproduced check failure');process.exit(1)"]) }]);
      // Checks need the pool; nothing else is scheduled.
      f.engine.setPoolPaused(false);
      f.task.stageIndex = f.task.plan!.stages.findIndex((stage) => stage.id === (where === "review" ? "security" : "delivery"));
      // The review's own start runs the checks; delivery preparation runs them before any agent is admitted.
      if (where === "review") expect(await f.engine["reviews"].runReview(f.task, f.stageOf("security"), signal())).toBe("continue");
      else await f.engine["driver"].workflow["drive"](f.task.id);
      expect(f.task.stageIndex).toBe(0); expect(executionFor(f.task).work.checkReturns).toBe(1);
      expect(f.task.findings.some((finding) => finding.raisedBy === "petrina" && finding.status === "open")).toBe(true);
      expect(f.task.reviewDecision!.accepted).toBe(true);
    } finally { admit.mockRestore(); await f.engine.shutdown(); }
  }
});

it("judges shared cover per finding's products and repairs only the owners of findings it does not cover", async () => {
  for (const moved of ["api", "shop"] as const) {
    const f = await rounds({ shared: true });
    try {
      const [shop, api] = f.owners.map((owner) => owner.productId) as [string, string];
      f.task.findings = [important("accepted", { productIds: [shop] })];
      await f.exhaust();
      expect(Object.keys(f.task.reviewDecision!.versions!).sort()).toEqual([shop, api].sort());
      await f.commit(moved === "api" ? 1 : 0);
      if (moved === "api") {
        // Only the API's own change moved: the shop's finding stays covered.
        expect(await f.review()).toBe("continue");
        expect(passedCovered(f.task)).toBe(true);
      }
      // A new API finding: the API is repaired, and the shop too only once its own change moved.
      expect(await f.review({ verdict: "fail", findings: [{ text: "The API leaks the greeting", productIds: [api], severity: "important", evidence: "Read it signed out" }] })).toBe("continue");
      expect(f.task.repair).toEqual(expect.objectContaining({ products: moved === "api" ? [api] : [shop, api], kind: "review" }));
      expect(f.task.repositories!.map((work) => [work.acceptanceReturns, work.checkReturns])).toEqual([[undefined, undefined], [undefined, undefined]]);
      expect(f.task.findings[0]!.status).toBe("open");
    } finally { await f.engine.shutdown(); }
  }
});
