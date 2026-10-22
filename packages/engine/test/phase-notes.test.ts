import { executionFor } from "../src/repository-context.js";
import { expect, it } from "bun:test";
import { join } from "node:path";
import { Context } from "../src/context.js";
import { Engine } from "./engine.js";
import type { GuideKeeper } from "../src/guide-keeper.js";
import { makeProduct, removeDir, tempDir } from "./fixtures.js";

it("keeps a design revision instruction in its original phase without dropping later product decisions or legacy notes", async () => {
  const root = tempDir("petrina-phase-notes-");
  const engine = new Engine(join(root, "data"), { usageCommands: { codex: null } });
  try {
    engine.setPoolPaused(true);
    const productId = await engine.addProduct(makeProduct(root));
    const id = engine.addTask({ productId, title: "Build the complete follow-up feature", backlog: true });
    const task = engine.task(id)!;
    task.plan = { rationale: "Design, then build", plannerProfileId: "opus-high", stages: [
      { id: "design", title: "Design the follow-up rules", kind: "converge", roleId: "architect", profileIds: ["opus-high"], reviewerRoleId: "design-reviewer" },
      { id: "build", title: "Build all follow-ups", kind: "do", roleId: "builder", profileIds: ["opus-high"] },
    ] };
    task.stageIndex = 0;
    engine.remember(task, "Revise only the remaining duplicate-handling decision.", "design-note", "disagreement");
    task.stageIndex = 1;
    engine.remember(task, "Keep every confirmed older bug in Backlog.", "product-decision");
    task.notes!.push({ at: 1, text: "Keep the existing page." });
    const guide = { pendingPoints: async () => [] } as unknown as GuideKeeper;
    for (const role of ["builder", "code-reviewer", "architect"]) {
      const notes = (await new Context(engine, guide).sectionsFor(executionFor(task), role)).find((section) => section.title.startsWith("The coordinator's notes"))!.body;
      expect(notes).toContain("Recorded during “Design the follow-up rules” (Architect), at the coordinator's design call:");
      expect(notes).toContain("Revise only the remaining duplicate-handling decision.");
      expect(notes).toContain("not a smaller scope for your current assignment");
      expect(notes).toContain("latest wins");
      expect(notes).toContain("Keep every confirmed older bug in Backlog.");
      expect(notes).toContain("Earlier note (original step not recorded):\nKeep the existing page.");
    }
    engine.commitNow();
    expect(engine.store.loadActive()!.tasks.find((entry) => entry.id === id)!.notes![0]!.origin?.stageId).toBe("design");
  } finally { await engine.shutdown(); removeDir(root); }
});
