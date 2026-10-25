import { afterAll, expect, it } from "bun:test";
import { join } from "node:path";
import { Engine } from "../../engine.js";
import { executionFor } from "@petrina/orchestrator";
import { SourceRefreshRequired } from "../../../src/kernel.js";
import { makeProduct, removeDir, tempDir } from "../../fixtures.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

for (const roleId of ["check-finder", "guide-keeper"]) it(`returns ${roleId} to source catch-up without accepting fallback work`, async () => {
  const root = tempDir("petrina-side-source-"); roots.push(root);
  const engine = new Engine(join(root, "data"), { agentCommand: () => undefined });
  engine.schedule = () => {};
  try {
    const path = await makeProduct(join(root, "product"));
    engine.s.products.push({ id: "p", name: "Product", repo: "local/p", path, tone: "blue" });
    const task = engine.task(engine.addTask({ productId: "p", title: "Keep the pending helper", backlog: true }))!;
    const scope = executionFor(task), product = engine.productOf(scope)!;
    scope.work.worktree = path;
    const conversation = { step: "build", roleId: "builder", profileId: "opus-high", toolId: "claude-code", model: "opus", sessionId: "original-builder", startedAt: 1, briefed: true };
    scope.work.conversation = conversation;
    scope.work.stepAttempts = 3; task.todo = "Finish the original change";
    task.miss = { note: "Keep the greeting", at: 1 };
    const refresh = new SourceRefreshRequired();
    engine["turns"].turn = async () => { throw refresh; };
    const pending = roleId === "check-finder"
      ? engine["checks"].ensureChecks(scope, new AbortController().signal)
      : engine["guide"].proposeGuideLine(scope, new AbortController().signal);
    expect(await pending.then(() => undefined, error => error)).toBe(refresh);
    expect(scope.work.conversation).toEqual(conversation);
    expect(scope.work.sideStep).toBeUndefined();
    expect(scope.work.stepAttempts).toBe(3);
    expect(task.todo).toBe("Finish the original change");
    expect(task.miss).toEqual({ note: "Keep the greeting", at: 1 });
    expect(product.checks).toBeUndefined();
    expect(product.checksFingerprint).toBeUndefined();
    expect(product.checksSeen).toBeUndefined();
    expect(engine.tracking.log.moments({ taskId: task.id, kinds: ["failure"] })).toEqual([]);
    expect(task.timeline.some(entry => entry.text.includes("could not finish"))).toBe(false);
  } finally { await engine.shutdown(); }
});
