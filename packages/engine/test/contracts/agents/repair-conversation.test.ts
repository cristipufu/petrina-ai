import { expect, it } from "bun:test";
import { join } from "node:path";
import { type CheckId } from "@petrina/core";
import { Engine } from "../../engine.js";
import { executionFor } from "@petrina/orchestrator";
import { freshBuilderRethink } from "../../../src/roles.js";
import { Fakes, git, makeProduct, removeDir, tempDir } from "../../fixtures.js";



it("starts one late rethink, then continues that Builder for unchanged and reopened same-round repairs", async () => {
  const root = tempDir("petrina-repair-conversation-");
  const fakes = new Fakes(join(root, "fake")); fakes.scenario({ builder: "plain", reopen: "resume" });
  const engine = new Engine(join(root, "data"), { agentCommand: () => [process.execPath, join(import.meta.dir, "../../fake-agent.ts"), fakes.dir], toolPath: () => process.execPath });
  try {
    engine.schedule = () => {};
    engine.s.setup!.checks = engine.s.tools.map(tool => ({ id: tool.id as CheckId, status: "ready" }));
    engine.s.tools.forEach(tool => { tool.status = "ready"; });
    const repo = await makeProduct(root), base = await git(repo, "rev-parse", "HEAD");
    engine.s.products.push({ id: "p", name: "Product", path: repo, repo: "local/product", tone: "blue" });
    const id = engine.addTask({ productId: "p", title: "Repair once", description: "Original repair request", backlog: true });
    const task = engine.task(id)!, scope = executionFor(task);
    Object.assign(scope.work, { worktree: repo, branch: "main", base: "main", baseSha: base });
    const stage = { id: "build", kind: "do" as const, roleId: "builder", title: "Build", profileIds: ["sol-high"] };
    task.plan = { rationale: "Controlled repairs", plannerProfileId: "sol-high", stages: [stage, { id: "review", kind: "review-chain", roleId: "code-reviewer", title: "Review", profileIds: ["grok-high"] }] };
    task.stageIndex = 0;
    const turn = async (fixing: boolean) => {
      task.stageIndex = 0;
      task.fixing = fixing;
      await engine["work"].runDo(scope, stage, new AbortController().signal);
      engine.finishStep(scope);
      return task.journey!.at(-1)!.agentInputs!.at(-1)!;
    };
    const first = await turn(false);
    task.rounds.review = 4;
    const rethink = await turn(true);
    expect(rethink.mode).toBe("fresh");
    expect(rethink.sessionId).not.toBe(first.sessionId);
    expect(rethink.freshReason).toContain("deliberate fresh rethink");
    expect(scope.work.builderSession?.rethought).toBe(true);
    // Persist the completed replacement before the next check-return admission.
    engine.commitNow(task);
    expect(engine.store.load()!.tasks.find(entry => entry.id === id)?.repository?.builderSession?.rethought).toBe(true);
    task.stageIndex = 0; task.fixing = true;
    expect(engine.builderConversation(scope, "sol-high")?.sessionId).toBe(rethink.sessionId);
    const continued = await turn(true);
    expect(continued.mode).toBe("continued");
    expect(continued.sessionId).toBe(rethink.sessionId);
    expect(continued.taskDescription).toBeUndefined();
    task.findings.push({ id: "reopened", text: "A newly reopened defect", status: "open", severity: "blocking", raisedBy: "grok-high", confirmedBy: [] });
    const reopened = await turn(true);
    expect(reopened.mode).toBe("continued");
    expect(reopened.sessionId).toBe(rethink.sessionId);
    expect(JSON.stringify(reopened.sections)).toContain("A newly reopened defect");
    expect(task.rounds.review).toBe(4);
    expect(freshBuilderRethink(task, scope.work.builderSession, "another-stage", "sol-high")).toBe(false); // Finished fixing.
    task.fixing = true;
    expect(freshBuilderRethink(task, scope.work.builderSession, stage.id, "astra-xhigh")).toBe(true);
    expect(freshBuilderRethink(task, scope.work.builderSession, "another-stage", "sol-high")).toBe(true);
  } finally { await engine.shutdown(); removeDir(root); }
});
