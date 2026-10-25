import { describe, expect, it } from "bun:test";
import { preparedReviewerInputs } from "../../fixtures/reviewer-inputs.js";

describe.concurrent("reviewer conversations across fix rounds", () => {
  it("starts the affected seats fresh after native session changes while main advances", async () => {
    const f = await preparedReviewerInputs({ native: true });
    try {
      await f.review(1); await f.advanceMain();
      const stage = f.task().plan!.stages.find((entry) => entry.kind === "review-chain")!;
      const prior = f.task().reviewSessions![stage.id]!["0"]!;
      f.removeNativeSession(prior.sessionId);
      await f.commitRepair();
      const task = await f.review(2);
      const inputs = task.journey!.find((step) => step.roleId === "code-reviewer" && step.round === 2)!.agentInputs!;
      expect(inputs.find((input) => input.reviewerKey === "0")!.mode).toBe("fresh");
      expect(inputs.find((input) => input.reviewerKey === "1")!.mode).toBe("continued");
      expect(inputs.find((input) => input.mode === "fresh")!.taskDescription).toContain("ORIGINAL-REVIEW-REQUEST");
      expect(inputs.find((input) => input.mode === "fresh")!.sections.some((section) => section.title === "Design brief")).toBe(true);
      expect(inputs.filter((input) => input.mode === "fresh").every((input) => !input.sections.some((section) => section.title === "The review base advanced since your last review"))).toBe(true);
      expect(task.timeline.some((entry) => entry.text.includes("Could not go back to its own review conversation"))).toBe(true);
      for (const input of inputs) {
        if (input.mode === "continued") expect(input.freshReason).toBeUndefined();
        else expect(input.freshReason).toContain("could not reopen the conversation");
      }
    } finally { await f.close(); }
  });
});
