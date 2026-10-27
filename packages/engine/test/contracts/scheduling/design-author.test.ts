import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { afterAll as closeOwnedCases } from "bun:test";
import { expect, it, spyOn } from "bun:test";
import type { CheckId } from "@petrina/core";
const cases = engineCaseFixtures();
closeOwnedCases(() => cases.close());


it("selects design reviewers from the saved author's identity without querying turn history", async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const root = mkdtempSync(join(owner.root, "petrina-design-admission-"));
    const engine = owner.open(root, { admissionsClosed: true, agentCommand: () => undefined, usageCommands: { codex: null, grok: null, antigravity: null },   });
    try {
      await owner.run(engine, async () => {
        engine.s.products.push({ id: "p", name: "Product", repo: "local/p", tone: "blue" });
        const task = engine.task(engine.addTask({ productId: "p", title: "Design", backlog: true }))!;
        const stage = { id: "design", title: "Design", kind: "converge" as const, roleId: "architect", profileIds: ["opus-high"], reviewerRoleId: "design-reviewer", reviewerProfileIds: ["sol-high"], maxRounds: 2 };
        task.plan = { rationale: "Design", plannerProfileId: "opus-high", stages: [stage] }; task.stageIndex = 0; task.sub = 1;
        task.designSessions = { [JSON.stringify([stage.id, "author", "p"])]: { scope: "saved", plannedProfileId: "opus-high", profileId: "sol-high", toolId: "codex", model: "gpt-6.1-sol", sessionId: "author" } };
        engine.s.tools.forEach((tool) => { tool.status = "ready"; });
        engine.s.setup!.checks = engine.s.tools.map((tool) => ({ id: tool.id as CheckId, status: "ready" }));
        const history = spyOn(engine.tracking.log, "turns").mockImplementation(() => { throw new Error("Scheduler read turn history"); });
        try {
          for (let tick = 0; tick < 20; tick++) {
            const choice = engine.choose("sol-high", task, "design-reviewer");
            expect(choice?.kind).not.toBe("none");
            if (choice && choice.kind !== "none") expect(choice.profile.toolId).not.toBe("codex");
          }
          expect(history).not.toHaveBeenCalled();
        } finally { history.mockRestore(); }

      });
    } finally { await owner.stop(engine); }

  });
});
