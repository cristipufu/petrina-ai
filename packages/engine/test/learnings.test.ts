import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@petrina/core";
import { Engine } from "../src/engine.js";
import { addLearnings } from "../src/learnings.js";
import { Fakes, git, makeProduct, removeDir, tempDir, waitFor } from "./support.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

describe("the Learnings section of AGENTS.md", () => {
  const folder = mkdtempSync(join(tmpdir(), "petrina-learnings-"));
  afterAll(() => removeDir(folder));
  const at = (name: string, text?: string) => {
    const root = mkdtempSync(join(folder, `${name}-`));
    if (text !== undefined) writeFileSync(join(root, "AGENTS.md"), text);
    return root;
  };
  const read = (root: string) => readFileSync(join(root, "AGENTS.md"), "utf8");

  it("starts the file, or the section at the end of an existing file", () => {
    const empty = at("empty");
    addLearnings(empty, ["Run the tests with bun test."]);
    expect(read(empty)).toBe("## Learnings\n\nWhat agents learned about working in this repository, added with the coordinator's OK.\n\n- Run the tests with bun test.\n");
    const kept = at("kept", "# Agents\n\nBe brief.\n");
    addLearnings(kept, ["One more"]);
    expect(read(kept)).toBe("# Agents\n\nBe brief.\n\n## Learnings\n\nWhat agents learned about working in this repository, added with the coordinator's OK.\n\n- One more\n");
  });

  it("adds to the end of the section, before whatever follows it", () => {
    const root = at("middle", "# Agents\n\n## Learnings\n\nIntro.\n\n- First\n\n## Checks\n\nRun them.\n");
    addLearnings(root, ["Second", "Third\nwith a break"]);
    expect(read(root)).toBe("# Agents\n\n## Learnings\n\nIntro.\n\n- First\n- Second\n- Third with a break\n\n## Checks\n\nRun them.\n");
  });
});

describe("lessons agents pass on", () => {
  it("are offered at the delivery check once each, and once accepted join AGENTS.md with the next delivery", async () => {
    const root = tempDir("petrina-lessons-");
    roots.push(root);
    const fakes = new Fakes(join(root, "fake"));
    fakes.scenario({ learnings: true });
    const engine = new Engine(join(root, "data"), { agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir] });
    try {
      const repo = makeProduct(root);
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
              engine.approve(item.id);
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
      expect(first.timeline.map((entry) => entry.text)).toContain("You added 2 lessons to AGENTS.md");
      expect(git(repo, "ls-tree", "--name-only", "main")).not.toContain("AGENTS.md");

      // The next delivery carries them, in its one commit, and lessons AGENTS.md has are not offered again.
      await ship("Add a farewell");
      expect(git(repo, "show", "main:AGENTS.md")).toBe("## Learnings\n\nWhat agents learned about working in this repository, added with the coordinator's OK.\n\n- Run the tests with bun test: they take a second.\n- Greetings live at the repository root.");
      expect(git(repo, "log", "-1", "--format=%s", "main")).toBe("Add a farewell");
      expect(offers).toHaveLength(1);
    } finally {
      engine.shutdown();
    }
  });
});
