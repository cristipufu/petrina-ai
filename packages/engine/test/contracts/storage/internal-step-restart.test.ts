import { afterAll, expect, it } from "bun:test";
import { join } from "node:path";
import { Engine } from "../../engine.js";
import { executionFor } from "@petrina/orchestrator";
import { beginSideStep } from "../../../src/side-step.js";
import { removeDir, tempDir } from "../../fixtures.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

for (const roleId of ["check-finder", "guide-keeper"]) it(`retains the main conversation across a restart inside ${roleId}`, async () => {
  const root = tempDir("petrina-side-step-"); roots.push(root);
  const options = { admissionsClosed: true, agentCommand: () => undefined, usageCommands: { codex: null, grok: null, antigravity: null },   };
  let engine = new Engine(root, options);
  try {
    engine.setPoolPaused(true);
    engine.s.products.push({ id: "p", name: "Product", repo: "local/p", path: join(root, "product"), tone: "blue" });
    const id = engine.addTask({ productId: "p", title: "Keep the Builder", backlog: true });
    const task = engine.task(id)!, scope = executionFor(task);
    scope.work.conversation = { step: "build", roleId: "builder", profileId: "opus-high", toolId: "claude-code", model: "opus", sessionId: "original-builder", startedAt: 1, briefed: true };
    scope.work.stepAttempts = 3; task.todo = "Finish the original change";
    beginSideStep(engine, scope, roleId);
    scope.work.conversation = { ...scope.work.sideStep!.conversation!, roleId, sessionId: "internal-errand" };
    scope.work.stepAttempts = 1; task.todo = "Internal work";
    engine.commitNow();
    await engine.shutdown();
    engine = new Engine(root, options);
    const reopened = engine.task(id)!, restored = executionFor(reopened);
    expect(restored.work.conversation!.sessionId).toBe("internal-errand");
    expect(restored.work.sideStep!.conversation!.sessionId).toBe("original-builder");
    beginSideStep(engine, restored, roleId)();
    expect(restored.work.conversation!.sessionId).toBe("original-builder");
    expect(restored.work.stepAttempts).toBe(3);
    expect(reopened.todo).toBe("Finish the original change");
    expect(restored.work.sideStep).toBeUndefined();
  } finally { await engine.shutdown(); }
});
