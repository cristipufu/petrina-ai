import { describe as originalDescribe } from "bun:test";
import { resolve as testFixturePath } from "node:path";
const TEST_FIXTURE_ROOT = testFixturePath(import.meta.dir, "../..");

import { afterAll, expect, it } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { ACCEPTANCE_RESTORED, draftOf } from "@petrina/core";
import { Engine } from "../../engine.js";
import { MAY_CHANGE } from "../../../src/prompts.js";
import { Fakes, git, makeProduct, removeDir, tempDir, waitFor } from "../../fixtures.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));


originalDescribe("the tester tries the change once, and the final code once more", () => {
it("keeps a tester's permitted edits before review and undoes its edits and commits on the final acceptance pass, leaving that pass unverified", async () => {
    const root = tempDir("petrina-tester-edits-");
    roots.push(root);
    const fakes = new Fakes(join(root, "fake"));
    fakes.scenario({ planner: "tester-first", builder: "plain", reviewer: "important", fixes: "change", tester: "writes" });
    const engine = new Engine(join(root, "data"), { agentCommand: () => [process.execPath, join(TEST_FIXTURE_ROOT, "fake-agent.ts"), fakes.dir] });
    try {
      const tester = engine.getState().roles.find((role) => role.id === "tester")!;
      engine.saveRole(tester.id, { ...draftOf(tester), canEdit: true });
      const repo = await makeProduct(root);
      // Exercise Git's Windows checkout conversion on every platform.
      await git(repo, "config", "core.autocrlf", "true");
      const productId = await engine.addProduct(repo);
      engine.setProductDelivery(productId, "local", true);
      const taskId = engine.addTask({ productId, title: "Try the greeting", description: "[no-check]" });
      const task = await waitFor(() => {
        const state = engine.getState();
        for (const item of state.inbox.filter((item) => item.taskId === taskId)) {
          if (item.kind === "plan") engine.approve(item.id);
          else if (item.kind === "permission") engine.allow(item.id, "once");
          else if (item.kind === "question") engine.answer(item.id, item.options?.[0] ?? "Yes");
        }
        const found = state.tasks.find((entry) => entry.id === taskId)!;
        if (found.state === "failed") throw new Error(found.error);
        return state.inbox.some((item) => item.taskId === taskId && item.kind === "delivery") && found;
      }, "the final tester pass and delivery check", 120_000);
      const openings = fakes.openings("tester");
      expect(openings).toHaveLength(2);
      expect(openings[0]).toContain(MAY_CHANGE.canEdit);
      expect(openings[1]).toContain(MAY_CHANGE.afterReview);
      expect(readFileSync(join(task.worktree!, "tester-edit.txt"), "utf8")).toBe("Before the review\r\n");
      expect(task.timeline.some((entry) => entry.text === "Saved the changes from the Tester on the task's branch")).toBe(true);
      expect(task.timeline.some((entry) => entry.text === "Undid commits from Tester, which is read-only")).toBe(true);
      expect(engine.getState().roles.find((role) => role.id === tester.id)!.canEdit).toBe(true);
      // The permitted first pass counts as usual; the final pass ran on code Petrina then restored.
      const [first, final] = task.journey!.filter((step) => step.roleId === "tester");
      expect(first!.proofRun!.restored).toBeUndefined(); expect(first!.acceptanceChecks!.every((check) => check.result === "pass")).toBe(true);
      expect(final!.proofRun!.restored!.products).toEqual([{ productId, commits: true, files: ["tester-edit.txt"] }]);
      expect(final!.acceptanceChecks!.every((check) => check.result === "blocked" && check.reason === ACCEPTANCE_RESTORED)).toBe(true);
      expect(task.acceptancePassed).toBe(false); expect(task.acceptanceUnverified).toBe(true);
      expect(engine.getState().inbox.find((item) => item.taskId === taskId && item.kind === "delivery")!.title).toContain("could not be verified");
    } finally {
      await engine.shutdown();
    }
  });
});
