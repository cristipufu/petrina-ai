import { afterAll, expect, it, spyOn } from "bun:test";
import { executionFor } from "@petrina/orchestrator";
import { commandInputText } from "../../../src/checks.js";
import { continuedReviewFixtures } from "../../fixtures/continued-review.js";
const { signal, important, rounds, close } = continuedReviewFixtures();
afterAll(close);

it("never covers failing product checks before the later review or before delivery", async () => {
  for (const where of ["review", "delivery"] as const) {
    const f = await rounds();
    let admit: { mockRestore(): void } | undefined;
    try {
      const observed = spyOn(f.engine["driver"].workflow as unknown as { admitNext: () => Promise<boolean> }, "admitNext");
      admit = observed; observed.mockResolvedValue(false);
      f.task.findings = [important("accepted")];
      await f.exhaust();
      f.engine.setProductChecks(f.task.productId, [{ name: "Tests", command: commandInputText([process.execPath, "-e", "console.error('reproduced check failure');process.exit(1)"]) }]);
      // Checks need the pool; nothing else is scheduled.
      f.engine.setPoolPaused(false);
      f.task.stageIndex = f.task.plan!.stages.findIndex((stage) => stage.id === (where === "review" ? "security" : "delivery"));
      // The review's own start runs the checks; delivery preparation runs them before any agent is admitted.
      if (where === "review") expect(await f.run(() => f.engine["reviews"].runReview(f.task, f.stageOf("security"), signal()))).toBe("continue");
      else await f.run(() => f.engine["driver"].workflow["drive"](f.task.id));
      expect(f.task.stageIndex).toBe(0); expect(executionFor(f.task).work.checkReturns).toBe(1);
      expect(f.task.findings.some((finding) => finding.raisedBy === "petrina" && finding.status === "open")).toBe(true);
      expect(f.task.reviewDecision!.accepted).toBe(true);
    } finally { try { await f.close(); } finally { admit?.mockRestore(); } }
  }
});
