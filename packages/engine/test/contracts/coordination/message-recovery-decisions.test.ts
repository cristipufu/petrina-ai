import { engineCaseFixtures, type EngineCaseOwner } from "../../fixtures/engine-cases.js";
import { mkdtempSync } from "node:fs";
import { afterAll as closeOwnedCases } from "bun:test";
import { expect, it } from "bun:test";
import { join } from "node:path";
import { takeMessages } from "@petrina/core";
import { executionFor } from "@petrina/orchestrator";
import { holdUnconfirmed, MESSAGE_RECOVERY_OPTIONS } from "../../../src/messages.js";
const cases = engineCaseFixtures();
closeOwnedCases(() => cases.close());


async function fixture(owner: EngineCaseOwner) {
  const root = mkdtempSync(join(owner.root, "petrina-message-recovery-decisions-"));
  const engine = owner.open(join(root, "data"), { agentCommand: () => undefined, browser: false });
  engine.schedule = () => {};
  try {
    await engine.waitUntilReady();
    engine.setPoolPaused(true);
    engine.s.products.push({ id: "p", name: "Product", repo: "local/product", tone: "blue" });
    const task = engine.task(engine.addTask({ productId: "p", title: "Resolve each participant independently", backlog: true }))!;
    task.plan = { rationale: "Only the persisted receipt decision", plannerProfileId: "sol-high", stages: [{ id: "build", title: "Build", kind: "do", roleId: "builder", profileIds: ["sol-high"] }] };
    task.stageIndex = 0; task.state = "running";
    return { engine, task, scope: executionFor(task), async dispose() { try { await owner.stop(engine); } finally {  } } };
  } catch (error) { try { await owner.stop(engine); } finally {  } throw error; }
}

it("resolves one reviewer's uncertain receipt without consuming its peer's decision", async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const f = await fixture(owner);
    const controller = new AbortController();
    try {
      await owner.run(f.engine, async () => {
        f.task.queued = [{ id: "parallel-note", at: Date.now(), text: "Check both views", recipients: { "review-0": false, "review-1": false }, deliveries: {
              "review-0": { state: "accepted", via: "live", toolId: "grok" },
              "review-1": { state: "accepted", via: "live", toolId: "codex" },
            } }];
        const first = holdUnconfirmed(f.engine, f.scope, "review-0", controller.signal, "reviewer:0");
        const second = holdUnconfirmed(f.engine, f.scope, "review-1", controller.signal, "reviewer:1");
        const decisions = f.engine.s.inbox.filter(item => item.taskId === f.task.id && item.kind === "question");
        expect(decisions).toHaveLength(2);
        const firstDecision = decisions.find(item => item.reviewKey === "reviewer:0")!;
        const secondDecision = decisions.find(item => item.reviewKey === "reviewer:1")!;
        f.engine.answer(firstDecision.id, MESSAGE_RECOVERY_OPTIONS[0]);
        await first;
        expect(f.task.queued[0]?.deliveries?.["review-0"]?.state).toBe("skipped");
        expect(f.task.queued[0]?.deliveries?.["review-1"]?.state).toBe("accepted");
        expect(f.engine.s.inbox.some(item => item.id === secondDecision.id)).toBe(true);
        f.engine.answer(secondDecision.id, MESSAGE_RECOVERY_OPTIONS[1]);
        await second;
        expect(takeMessages(f.task, "review-0")).toEqual([]);
        expect(takeMessages(f.task, "review-1").map(message => message.id)).toEqual(["parallel-note"]);

      });
    } finally { controller.abort(); await f.dispose(); }

  });
});
