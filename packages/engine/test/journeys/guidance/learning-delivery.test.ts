import { instructionAgents } from "../../fixtures/instruction-agents.js";

import { afterAll, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "@petrina/core";
import { Engine } from "../../engine.js";


import { git, makeProduct, removeDir, tempDir, waitFor } from "../../fixtures.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

describe("lessons agents pass on", () => {
  it("are offered at the delivery check once each, and the ones ticked join AGENTS.md with the next delivery", async () => {
    const root = tempDir("petrina-lessons-");
    roots.push(root);
    const engine = new Engine(join(root, "data"), instructionAgents({ learnings: true }));
    try {
      const repo = await makeProduct(root);
      const productId = await engine.addProduct(repo);
      engine.setProductDelivery(productId, "local", true);
      const offers: { body?: string; detail?: string }[] = [];
      const ship = async (title: string) => {
        const taskId = engine.addTask({ productId, title, description: "[no-check]" });
        return waitFor(() => {
          const state = engine.getState();
          for (const item of state.inbox) {
            if (item.kind === "learnings") {
              offers.push(item);
              // The coordinator ticks only the second.
              engine.addLessons(item.id, [1]);
            }
            if (item.taskId !== taskId) continue;
            if (item.kind === "plan" || item.kind === "delivery") engine.approve(item.id);
            else if (item.kind === "permission") engine.allow(item.id, "once");
            else if (item.kind === "question") engine.answer(item.id, item.options?.[0] ?? "Yes");
          }
          const found = state.tasks.find((entry) => entry.id === taskId) as Task | undefined;
          if (found?.state === "failed") throw new Error(`The task failed: ${found.error}`);
          return found?.state === "done" && found;
        }, "the work to ship", 90_000);
      };
      const first = await ship("Add a greeting");
      // One offer, with each lesson once: the reviewers' copy of the builder's lesson is the same lesson.
      expect(offers).toHaveLength(1);
      expect(offers[0]!.body).toBe("- Run the tests with bun test: they take a second.\n- Greetings live at the repository root.");
      expect(offers[0]!.detail).toContain("Claude Code and Codex both read that file by themselves");
      expect(first.timeline.map((entry) => entry.text)).toContain("You added a lesson to AGENTS.md");
      expect(await git(repo, "ls-tree", "--name-only", "main")).not.toContain("AGENTS.md");

      // The next delivery carries them, in its one commit, and lessons AGENTS.md has are not offered again.
      await ship("Add a farewell");
      expect(await git(repo, "show", "main:AGENTS.md")).toBe("## Learnings\n\nWhat agents learned about working in this repository, added with the coordinator's OK.\n\n- Greetings live at the repository root.");
      expect(await git(repo, "log", "-1", "--format=%s", "main")).toBe("Add a farewell");
      expect(offers).toHaveLength(1);
    } finally {
      const at = roots.indexOf(root); if (at >= 0) roots.splice(at, 1);
      await engine.shutdown();
      removeDir(root);
    }
  });
});

describe("a lesson AGENTS.md gained in the meantime", () => {
  it("is not offered: the coordinator, or another task, got there first", async () => {
    const root = tempDir("petrina-lessons-known-");
    roots.push(root);
    const engine = new Engine(join(root, "data"), instructionAgents({ learnings: true }));
    try {
      const repo = await makeProduct(root);
      const productId = await engine.addProduct(repo);
      engine.setProductDelivery(productId, "local", true);
      const taskId = engine.addTask({ productId, title: "Add a greeting", description: "[no-check]" });
      let written = false;
      const offers: { body?: string }[] = [];
      const task = await waitFor(async () => {
        let state = engine.getState();
        let found = state.tasks.find((entry) => entry.id === taskId) as Task | undefined;
        // While the builder works on its branch, main gains the second lesson by the coordinator's own hand.
        if (!written && found?.timeline.some((entry) => entry.text === "Builder started")) {
          writeFileSync(join(repo, "AGENTS.md"), "## Learnings\n\n- Greetings live at the repository root.\n");
          await git(repo, "add", "AGENTS.md");
          await git(repo, "commit", "-q", "-m", "Note where greetings live");
          written = true;
          // Answer what the engine shows now, not what it showed before the commit.
          state = engine.getState();
          found = state.tasks.find((entry) => entry.id === taskId) as Task | undefined;
        }
        for (const item of state.inbox) {
          if (item.taskId !== taskId) continue;
          if (item.kind === "learnings") {
            offers.push(item);
            engine.decline(item.id);
          } else if (item.kind === "plan" || item.kind === "delivery") engine.approve(item.id);
          else if (item.kind === "permission") engine.allow(item.id, "once");
          else if (item.kind === "question") engine.answer(item.id, item.options?.[0] ?? "Yes");
        }
        if (found?.state === "failed") throw new Error(`The task failed: ${found.error}`);
        return found?.state === "done" && found;
      }, "the work to ship", 120_000);
      expect(written).toBe(true);
      // The work was brought onto the new main before the delivery check, so the lesson main has by now stays out.
      expect(task.timeline.map((entry) => entry.text)).toContain("Brought up to date with main (1 new commit there), with no conflicts");
      expect(offers).toHaveLength(1);
      expect(offers[0]!.body).toBe("- Run the tests with bun test: they take a second.");
    } finally {
      const at = roots.indexOf(root); if (at >= 0) roots.splice(at, 1);
      await engine.shutdown();
      removeDir(root);
    }
  });
});
