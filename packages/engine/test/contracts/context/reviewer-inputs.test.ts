import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { preparedReviewerInputs } from "../../fixtures/reviewer-inputs.js";

describe.concurrent("reviewer conversations across fix rounds", () => {
for (const changed of ["context"] as const) it(`starts the affected seats fresh after ${changed} changes while main advances`, async () => {
    const f = await preparedReviewerInputs();
    try {
      await f.review(1); await f.advanceMain();
      const stage = f.task().plan!.stages.find((entry) => entry.kind === "review-chain")!;
      const prior = f.task().reviewSessions![stage.id]!["0"]!;
      // Both seats saved the complete packet; only this seat's reference then loses its file.
      for (const seat of ["0", "1"]) {
        const saved = f.task().reviewSessions![stage.id]![seat]!.context!;
        const packet = readFileSync(saved.file, "utf8");
        expect(createHash("sha256").update(packet).digest("hex")).toBe(saved.digest);
        expect(packet).toContain("ORIGINAL-REVIEW-REQUEST");
      }
      prior.context!.file += ".missing";
      await f.commitRepair();
      const task = await f.review(2);
      const inputs = task.journey!.find((step) => step.roleId === "code-reviewer" && step.round === 2)!.agentInputs!;
      expect(inputs.find((input) => input.reviewerKey === "0")!.mode).toBe("fresh");
      expect(inputs.find((input) => input.reviewerKey === "1")!.mode).toBe("continued");
      expect(inputs.find((input) => input.mode === "fresh")!.taskDescription).toContain("ORIGINAL-REVIEW-REQUEST");
      expect(inputs.find((input) => input.mode === "fresh")!.sections.some((section) => section.title === "Design brief")).toBe(true);
      expect(inputs.filter((input) => input.mode === "fresh").every((input) => !input.sections.some((section) => section.title === "The review base advanced since your last review"))).toBe(true);
      const reason = "saved context is unavailable";
      expect(task.timeline.some((entry) => entry.text.includes(reason))).toBe(true);
      // The recorded fresh reason is the one the selection gave, including a reopen failure discovered before instructions.
      for (const input of inputs) {
        if (input.mode === "continued") expect(input.freshReason).toBeUndefined();
        else expect(input.freshReason).toBe(`its ${reason}`);
      }
    } finally { await f.close(); }
  });
});
