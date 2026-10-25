import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { executionFor } from "@petrina/orchestrator";
import { git } from "../../fixtures.js";
import { reviewContextFixtures } from "../../fixtures/review-context.js";
import { preparedReviewerInputs } from "../../fixtures/reviewer-inputs.js";

// Immutable original finding data; no workflow fixture is opened.
const { earlier } = reviewContextFixtures();

describe.concurrent("reviewer conversations across fix rounds", () => {
for (const single of [false, true]) it(`omits unchanged closed findings from the actual continued ${single ? "single" : "parallel"} reviewer input`, async () => {
    const f = await preparedReviewerInputs({ single, seedFinding: earlier });
    try {
      await f.review(1); await f.commitRepair();
      const task = await f.review(2);
      const first = task.journey!.find((step) => step.roleId === "code-reviewer" && step.round === 1)!;
      const next = task.journey!.find((step) => step.roleId === "code-reviewer" && step.round === 2)!;
      expect(first.agentInputs!.every((input) => input.sections.some((section) => section.body.includes(earlier.text)))).toBe(true);
      for (const input of next.agentInputs!) {
        expect(input.mode).toBe("continued");
        expect(input.sections.some((section) => section.title === "Current finding status index" && section.body.includes("older: fixed"))).toBe(true);
        expect(input.sections.map((section) => section.body).join("\n")).not.toContain(earlier.text);
        expect(input.sections.some((section) => section.title.startsWith("New or changed finding records"))).toBe(true);
      }
    } finally { await f.close(); }
  });
});

describe.concurrent("reviewer conversations across fix rounds", () => {
for (const changed of ["context", "absent context", "profile", "source", "bases", "incomplete bases"] as const) it(`starts the affected seats fresh after ${changed} changes while main advances`, async () => {
    const f = await preparedReviewerInputs();
    try {
      await f.review(1); await f.advanceMain();
      const stage = f.task().plan!.stages.find((entry) => entry.kind === "review-chain")!;
      const prior = f.task().reviewSessions![stage.id]!["0"]!;
      if (changed === "context") {
        // Both seats saved the complete packet; only this seat's reference then loses its file.
        for (const seat of ["0", "1"]) {
          const saved = f.task().reviewSessions![stage.id]![seat]!.context!;
          const packet = readFileSync(saved.file, "utf8");
          expect(createHash("sha256").update(packet).digest("hex")).toBe(saved.digest);
          expect(packet).toContain("ORIGINAL-REVIEW-REQUEST");
        }
        prior.context!.file += ".missing";
      } else if (changed === "absent context") {
        // Context storage is optional: a failed save sends complete instructions without a packet.
        delete prior.context;
      } else if (changed === "profile") stage.profileIds[0] = "opus-xhigh";
      else if (changed === "source") {
        const work = executionFor(f.task()).work;
        work.source!.initialSha = await git(work.worktree!, "rev-parse", `${prior.bases![work.productId]}~1`);
      } else if (changed === "bases") delete prior.bases;
      else if (changed === "incomplete bases") prior.bases = {};
      await f.commitRepair();
      const task = await f.review(2);
      const inputs = task.journey!.find((step) => step.roleId === "code-reviewer" && step.round === 2)!.agentInputs!;
      expect(inputs.find((input) => input.reviewerKey === "0")!.mode).toBe("fresh");
      expect(inputs.find((input) => input.reviewerKey === "1")!.mode).toBe(changed === "source" ? "fresh" : "continued");
      expect(inputs.find((input) => input.mode === "fresh")!.taskDescription).toContain("ORIGINAL-REVIEW-REQUEST");
      expect(inputs.find((input) => input.mode === "fresh")!.sections.some((section) => section.title === "Design brief")).toBe(true);
      expect(inputs.filter((input) => input.mode === "fresh").every((input) => !input.sections.some((section) => section.title === "The review base advanced since your last review"))).toBe(true);
      const reason = changed === "context" || changed === "absent context" ? "saved context is unavailable" : changed === "bases" || changed === "incomplete bases" ? "saved repository bases are unavailable" : changed === "profile" ? "you changed who works on this seat" : "role, profile, request or starting point changed";
      expect(task.timeline.some((entry) => entry.text.includes(reason))).toBe(true);
      // The recorded fresh reason is the one the selection gave, including a reopen failure discovered before instructions.
      for (const input of inputs) {
        if (input.mode === "continued") expect(input.freshReason).toBeUndefined();
        else expect(input.freshReason).toBe(changed === "profile" ? reason : `its ${reason}`);
      }
    } finally { await f.close(); }
  });
});
