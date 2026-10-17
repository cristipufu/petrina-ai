import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { BUILT_IN_ROLES, createDemoState, type State } from "@petrina/core";
import { Engine } from "../src/engine.js";
import { type MState, renameRoles } from "../src/kernel.js";
import type { PromptContext } from "../src/prompts.js";
import { contractFor, ROLE_CONTRACTS, shapeFor } from "../src/roles.js";
import { Store } from "../src/store.js";
import { makeProduct, removeDir, tempDir } from "./support.js";

const state = createDemoState(1_000_000_000);
const task = state.tasks[0]!;
const ctx = (overrides: Partial<PromptContext["task"]> = {}): PromptContext => ({ task: { ...task, ...overrides }, product: state.products[0]!, role: BUILT_IN_ROLES[0]!, roles: BUILT_IN_ROLES, profiles: state.profiles, worktree: "/w", branch: "b", base: "origin/main", defaultBranch: "main", sections: [] });

describe("every role's contract", () => {
  it("covers every built-in role, and its example result passes its own schema", () => {
    for (const role of BUILT_IN_ROLES) expect(ROLE_CONTRACTS[role.id]).toBeDefined();
    for (const [id, contract] of Object.entries(ROLE_CONTRACTS)) {
      for (const shape of new Set([shapeFor(contract, ctx()), shapeFor(contract, ctx({ call: { text: "Do it this way", at: 1, stageIndex: 0, open: [] } as never }))])) {
        const parsed = contract.result.safeParse(JSON.parse(shape));
        expect(parsed.success ? id : `${id}: ${parsed.error.message}`).toBe(id);
      }
    }
  });

  it("tells a role the coordinator made its purpose, and has it hand back notes", () => {
    const contract = contractFor({ ...BUILT_IN_ROLES[0]!, id: "copy-editor", purpose: "Tighten the wording of every screen." });
    expect(contract.instructions(ctx())).toBe("Tighten the wording of every screen.");
    expect(contract.reads).toEqual(["notes", "brief"]);
    expect(contract.result.safeParse({ summary: "Done.", notes: [] }).success).toBe(true);
  });
});

describe("a role renamed after the state was saved", () => {
  it("moves every stored “shipper” to the Release Manager once, as Petrina loads its state", async () => {
    const root = tempDir("petrina-renamed-role-");
    const data = join(root, "data");
    let engine = new Engine(data);
    try {
      engine.setPoolPaused(true);
      const productId = await engine.addProduct(makeProduct(root));
      const taskId = engine.addTask({ productId, title: "Old work" });
      const saved = JSON.parse(JSON.stringify(engine.getState())) as State;
      engine.shutdown();
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
      const store = new Store(join(data, "petrina.db"));
      store.save(saved);
      store.close();

      engine = new Engine(data);
      const task = engine.getState().tasks[0]!;
      expect(task.plan!.stages.map((stage) => stage.roleId)).toEqual(["builder", "release-manager", "release-manager"]);
      expect(task.timeline.find((entry) => entry.id === "old-1")?.roleId).toBe("release-manager");
      expect(task.session.find((line) => line.id === "old-2")?.roleId).toBe("release-manager");
      expect(task.lessons?.[0]?.roleId).toBe("release-manager");
      expect(engine.getState().inbox.find((item) => item.id === "old-question")?.roleId).toBe("release-manager");
      // The working agents and the conversation note, as far as Petrina keeps them on a paused task, and as they were saved.
      for (const kept of [task.agent, ...(task.helpers ?? []), task.conversation]) if (kept) expect(kept.roleId).toBe("release-manager");
      renameRoles(saved as unknown as MState);
      const moved = saved.tasks[0]!;
      expect([moved.agent?.roleId, moved.helpers?.[0]?.roleId, moved.conversation?.roleId]).toEqual(["release-manager", "release-manager", "release-manager"]);
      expect(JSON.stringify(engine.getState())).not.toContain('"shipper"');
      // Saved under the new id: the next load has nothing to move.
      engine.shutdown();
      const again = new Store(join(data, "petrina.db"));
      expect(JSON.stringify(again.load())).not.toContain('"shipper"');
      again.close();
      engine = new Engine(data);
    } finally {
      engine.shutdown();
      removeDir(root);
    }
  });
});
