import { installPreparedProduct, privateCloneProduct } from "../../fixtures/prepared-product.js";
import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { afterAll } from "bun:test";
import { restoreRepositoryState } from "@petrina/orchestrator";
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { type State } from "@petrina/core";
import { type RuntimeState, renameRoles } from "../../../src/kernel.js";


import { Store } from "@petrina/storage/store";
import { makeProduct } from "../../fixtures.js";
const cases = engineCaseFixtures();
afterAll(() => cases.close());


describe("a role renamed after the state was saved", () => {
  it("moves every stored “shipper” to the Release Manager once, as Petrina loads its state", async () => {
  return cases.use("petrina-renamed-role-", async owner => {
    const root = owner.root;
    const data = join(root, "data");
    let engine = owner.open(data, {});
    try {
      engine.setPoolPaused(true);
      const repo = await makeProduct(root);
      await engine.waitUntilReady(); owner.check(); engine.stopRequested.signal.throwIfAborted();
      const productId = installPreparedProduct(engine, privateCloneProduct(repo));
      const taskId = engine.addTask({ productId, title: "Old work" });
      const saved = JSON.parse(JSON.stringify(engine.getState())) as State;
      await owner.stop(engine);
      // Saved by the Petrina from before the rename, with the old id everywhere a role id is kept.
      const by = { roleId: "shipper", profileId: "opus-high" };
      Object.assign(saved.tasks[0]!, {
        state: "paused",
        delivery: "release",
        plan: {
          plannerProfileId: "sonnet-medium",
          rationale: "Old.",
          stages: [
            { id: `${taskId}:build`, kind: "do", title: "Build", roleId: "builder", profileIds: ["opus-high"] },
            { id: `${taskId}:delivery`, kind: "gate", title: "Your delivery check", roleId: "shipper", profileIds: [], gate: "delivery" },
            { id: `${taskId}:ship`, kind: "do", title: "Publish a release", roleId: "shipper", profileIds: ["opus-high"] },
          ],
        },
        stageIndex: 2,
        agent: { ...by, since: 1, step: 0 },
        helpers: [{ ...by, since: 1, step: 0 }],
        conversation: { step: `${taskId}:ship`, ...by, toolId: "claude-code", model: "Opus 5.5", sessionId: "old", startedAt: 1 },
        lessons: [{ text: "Tags here are signed.", ...by, at: 1 }],
        timeline: [{ id: "old-1", at: 1, ...by, text: "Shipper started", tone: "milestone" }],
        session: [{ id: "old-2", at: 1, from: "agent", ...by, text: "Writing the notes" }],
      });
      saved.inbox = [{ id: "old-question", taskId, kind: "question", title: "Which tag?", ...by, at: 1, blocking: false }];
      owner.check();
      const store = new Store(join(data, "petrina.db"));
      const closeStore = owner.afterBody(() => store.close());
      store.save(saved);
      await closeStore();

      engine = owner.open(data, {});
      const task = engine.getState().tasks[0]!;
      expect(task.plan!.stages.map((stage) => stage.roleId)).toEqual(["builder", "release-manager", "release-manager"]);
      expect(task.timeline.find((entry) => entry.id === "old-1")?.roleId).toBe("release-manager");
      expect(task.session.find((line) => line.id === "old-2")?.roleId).toBe("release-manager");
      expect(task.lessons?.[0]?.roleId).toBe("release-manager");
      expect(engine.getState().inbox.find((item) => item.id === "old-question")?.roleId).toBe("release-manager");
      // The working agents and the conversation note, as far as Petrina keeps them on a paused task, and as they were saved.
      for (const kept of [task.agent, ...(task.helpers ?? []), task.conversation]) if (kept) expect(kept.roleId).toBe("release-manager");
      restoreRepositoryState(saved.tasks[0]! as import("../../../src/kernel.js").RuntimeTask);
      renameRoles(saved as RuntimeState);
      const moved = saved.tasks[0]!;
      expect([moved.agent?.roleId, moved.helpers?.[0]?.roleId, moved.repository?.conversation?.roleId]).toEqual(["release-manager", "release-manager", "release-manager"]);
      expect(JSON.stringify(engine.getState())).not.toContain('"shipper"');
      // Saved under the new id: the next load has nothing to move.
      await owner.stop(engine);
      owner.check();
      const again = new Store(join(data, "petrina.db"));
      const closeAgain = owner.afterBody(() => again.close());
      expect(JSON.stringify(again.load())).not.toContain('"shipper"');
      await closeAgain();
      engine = owner.open(data, {});
    } finally {
      await owner.stop(engine);
    }

  });
});
});
