import { afterAll, describe, expect, it } from "bun:test";
import { independentReviewFixtures } from "../../fixtures/independence.js";

const { fixture, close } = independentReviewFixtures();
afterAll(close);
describe.concurrent("reviews after a usage handoff", () => {
it("includes a reopened finding in the saved reviewer outcome before handing it to verifiers", async () => {
    const f = await fixture({ controlled: true, reviewer: "confirm-dismissed", reopenedEvidence: "The current greeting is still missing its name: expected Hello Ada, observed Hello. The named greeting control passes." }, 3, ["sol-high", "opus-high"], undefined, true);
    try {
      await f.advance(() => f.fakes.received("builder").length > 0, (role) => role !== "builder");
      const task = f.engine.s.tasks.find((entry) => entry.id === f.task().id)!;
      const id = task.id + "-earlier";
      task.findings.push({ id, text: "The greeting loses its name", severity: "blocking", status: "fixed", raisedBy: "sol-high", confirmedBy: [], answer: { fixed: true, text: "Kept the name", at: Date.now() - 1000 } });
      await f.advance(() => f.task().journey?.some((step) => step.roleId === "code-reviewer" && step.endedAt !== undefined) ?? false, (role) => role !== "verifier");
      const review = f.task().journey!.find((step) => step.roleId === "code-reviewer")!;
      expect(review.result?.findings?.map((finding) => finding.id)).toEqual([id]);
      expect(review.outcome).toBe("1 important");
      expect(review.reason).toBe("1 important finding to check");
    } finally { await f.engine.shutdown(); }
  });

});
