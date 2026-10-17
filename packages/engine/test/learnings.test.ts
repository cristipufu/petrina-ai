import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@petrina/core";
import { Engine } from "../src/engine.js";
import { addLearnings, Learnings } from "../src/learnings.js";
import { samePointRoughly } from "../src/points.js";
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
  it("offers and saves a complete lesson, including the instructions beyond 240 characters", async () => {
    const root = tempDir("petrina-lessons-complete-");
    roots.push(root);
    const engine = new Engine(join(root, "data"), { codexCommand: null });
    try {
      engine.setPoolPaused(true);
      const repo = makeProduct(root);
      const productId = await engine.addProduct(repo);
      const task = engine.task(engine.addTask({ productId, title: "Keep a complete instruction" }))!;
      task.worktree = repo;
      const learnings = new Learnings(engine);
      const lesson = "The Claude Code connector and SDK sources can be read without installing anything, in ~/.bun/install/cache (@agentclientprotocol/claude-agent-acp dist/acp-agent.js, and @anthropic-ai/claude-agent-sdk sdk.d.ts for the full settings and sandbox options); check both sources before changing how sessions start.";
      await learnings.note(task, [lesson], "builder", "sol-xhigh");
      await learnings.offer(task);
      const offer = engine.getState().inbox.find((item) => item.kind === "learnings")!;
      expect(offer.body).toBe(`- ${lesson}`);
      engine.addLessons(offer.id, [0]);
      await learnings.write(task);
      expect(git(repo, "show", "HEAD:AGENTS.md")).toContain(`- ${lesson}`);
      await learnings.note(task, [lesson], "builder", "sol-xhigh");
      await learnings.offer(task);
      expect(engine.getState().inbox.filter((item) => item.kind === "learnings")).toEqual([]);
    } finally {
      engine.shutdown();
    }
  });

  it("are offered at the delivery check once each, and the ones ticked join AGENTS.md with the next delivery", async () => {
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
      expect(git(repo, "ls-tree", "--name-only", "main")).not.toContain("AGENTS.md");

      // The next delivery carries them, in its one commit, and lessons AGENTS.md has are not offered again.
      await ship("Add a farewell");
      expect(git(repo, "show", "main:AGENTS.md")).toBe("## Learnings\n\nWhat agents learned about working in this repository, added with the coordinator's OK.\n\n- Greetings live at the repository root.");
      expect(git(repo, "log", "-1", "--format=%s", "main")).toBe("Add a farewell");
      expect(offers).toHaveLength(1);
    } finally {
      engine.shutdown();
    }
  });
});

describe("a lesson AGENTS.md gained in the meantime", () => {
  it("is not offered: the coordinator, or another task, got there first", async () => {
    const root = tempDir("petrina-lessons-known-");
    roots.push(root);
    const fakes = new Fakes(join(root, "fake"));
    fakes.scenario({ learnings: true });
    const engine = new Engine(join(root, "data"), { agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir] });
    try {
      const repo = makeProduct(root);
      const productId = await engine.addProduct(repo);
      engine.setProductDelivery(productId, "local", true);
      const taskId = engine.addTask({ productId, title: "Add a greeting", description: "[no-check]" });
      let written = false;
      const offers: { body?: string }[] = [];
      const task = await waitFor(() => {
        const state = engine.getState();
        const found = state.tasks.find((entry) => entry.id === taskId) as Task | undefined;
        // While the builder works on its branch, main gains the second lesson by the coordinator's own hand.
        if (!written && found?.timeline.some((entry) => entry.text === "Builder started")) {
          writeFileSync(join(repo, "AGENTS.md"), "## Learnings\n\n- Greetings live at the repository root.\n");
          git(repo, "add", "AGENTS.md");
          git(repo, "commit", "-q", "-m", "Note where greetings live");
          written = true;
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
      engine.shutdown();
    }
  });
});

describe("lessons said twice in other words", () => {
  // Offered side by side on real tasks: each group is one lesson.
  const core = [
    "A pure function in packages/core can be tried out without installing anything: write a small script outside the repo that imports the source file by its full path and run it with bun.",
    "To try one function from packages/core on its own, put a small script outside the working copy that imports the source file by its full path and run it with bun. No install is needed, because core's sources import nothing from outside the repository.",
    "Code in packages/core can be run straight from source with bun (a small script that imports packages/core/src/*.ts), with nothing installed.",
  ];
  const viewport = [
    "The app's tests run in a 1024px-wide window, so the inbox opens over the board there. To test the docked inbox, call window.happyDOM.setViewport({ width: 1400 }) inside act() and set the width back afterwards.",
    "Desktop tests run in happy-dom at 1024px wide, so the inbox opens over the board (narrow layout) unless a test widens the window to 1200px or more with happyDOM.setViewport.",
  ];
  const timeout = "The coordinator's Mac has no 'timeout' command. To cap how long a command runs, use the tool's own time limit.";

  it("are one lesson, and different lessons stay apart", () => {
    expect(samePointRoughly(core[0]!, core[1]!)).toBe(true);
    expect(samePointRoughly(core[1]!, core[2]!)).toBe(true);
    expect(samePointRoughly(viewport[0]!, viewport[1]!)).toBe(true);
    for (const line of [...core, ...viewport]) expect(samePointRoughly(line, timeout)).toBe(false);
    expect(samePointRoughly(core[0]!, viewport[0]!)).toBe(false);
  });
});
