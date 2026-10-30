import { engineCaseFixtures } from "../../fixtures/engine-cases.js";

import { executionFor } from "@petrina/orchestrator";
import { afterAll, expect, it } from "bun:test";

import { join } from "node:path";
import { ROLE_STARTS } from "@petrina/core";







const engineCases = engineCaseFixtures();
afterAll(() => engineCases.close());



const start = (id: string) => ROLE_STARTS.find((entry) => entry.id === id)!.draft;

  it("keeps added and built-in reviewers independent of each other's saved verdicts and the latest port builder", async () => {
  return engineCases.use("petrina-added-independence-", async caseOwner => {
    const root = caseOwner.root;

    const engine = caseOwner.open(join(root, "data"), { toolPath: () => process.execPath, usageCommands: { codex: null } });
    try {
      engine.setPoolPaused(true);
      const added = engine.addRole(start("security"));
      const productId = "private-product";
      engine.s.products.push({ id: productId, name: "Private product", repo: "local/private", tone: "blue", path: root });
      const taskId = engine.addTask({ productId, title: "Review the greeting", backlog: true });
      const task = engine.s.tasks.find((entry) => entry.id === taskId)!;
      task.plan = { plannerProfileId: "opus-high", rationale: "Two independent reviews.", stages: [{ id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["sol-high", "sol-high"], roleIds: ["code-reviewer", added] }] };
      task.stageIndex = 0;
      task.rounds.review = 1;
      // With Claude unavailable, Grok is the only tool independent of the reviewer who finished on Codex.
      engine.s.pool.limited = [{ toolId: "claude-code", until: Date.now() + 60_000, reason: "Usage used up" }];
      for (const position of [0, 1]) {
        const roleId = task.plan.stages[0]!.roleIds![position]!;
        const peer = 1 - position;
        task.hunt = { stageId: "review", round: 1, reported: { [peer]: true }, profiles: { [peer]: "sol-high" } };
        expect(engine.choose("sol-high", task, roleId, undefined, String(position))).toEqual(expect.objectContaining({ profile: expect.objectContaining({ toolId: "grok" }) }));
        // Older saved rounds have the verdict, but no record of which profile used each position.
        delete task.hunt.profiles;
        engine.tracking.verdict(task, task.plan.stages[0]!.roleIds![peer]!, "sol-high", 1, "pass", 0, 0);
        expect(engine.choose("sol-high", task, roleId, undefined, String(position))).toEqual(expect.objectContaining({ profile: expect.objectContaining({ toolId: "grok" }) }));
      }
      executionFor(task).work.builderSession = { stageId: "build", profileId: "sol-high", toolId: "codex", model: "gpt-6.1-sol", sessionId: "latest-port" };
      executionFor(task).work.portReview = { from: "a", onto: "b", head: "c", files: ["greeting.txt"] };
      expect(engine.choose("sol-high", task, added, undefined, "1")).toEqual(expect.objectContaining({ profile: expect.objectContaining({ toolId: "grok" }) }));
    } finally {
      await caseOwner.stop(engine);

    }

  });
});
