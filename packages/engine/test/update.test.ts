import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "@petrina/core";
import { Engine } from "../src/engine.js";
import type { Scenario } from "./fake-agent.js";
import { Fakes, git, makeProduct, removeDir, tempDir, waitFor } from "./support.js";

const posix = process.platform !== "win32";
const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

/** A commit on the product's own main, as another task landing there would make. */
function land(repo: string, file: string, text: string, message: string): string {
  writeFileSync(join(repo, file), text);
  git(repo, "add", file);
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

/** A git hook in the product's own clone, local only, like one kept out of a public repository. */
function hook(repo: string, name: string, script: string): void {
  const path = join(repo, ".git", "hooks", name);
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
}

/**
 * One task to done on a product that commits to main locally. `setup` runs on the clone before it becomes a
 * product, `beforeBuild` at the plan check and `atDeliveryCheck` at the first delivery check, before the
 * coordinator approves either.
 */
async function ship(scenario: Scenario, hooks: { setup?: (repo: string) => void; beforeBuild?: (repo: string) => void; atDeliveryCheck?: (repo: string) => void } = {}) {
  const root = tempDir("petrina-update-");
  roots.push(root);
  const fakes = new Fakes(join(root, "fake"));
  fakes.scenario(scenario);
  const engine = new Engine(join(root, "data"), { agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir] });
  try {
    const repo = makeProduct(root);
    hooks.setup?.(repo);
    const before = git(repo, "rev-parse", "HEAD");
    const productId = await engine.addProduct(repo);
    engine.setProductDelivery(productId, "local", true);
    const taskId = engine.addTask({ productId, title: "Add a greeting", description: "[no-check]", approvePlan: true });
    let deliveryChecks = 0;
    const task = await waitFor(() => {
      const state = engine.getState();
      for (const item of state.inbox) {
        if (item.taskId !== taskId) continue;
        if (item.kind === "plan") {
          hooks.beforeBuild?.(repo);
          engine.approve(item.id);
        } else if (item.kind === "permission") engine.allow(item.id, "once");
        else if (item.kind === "question") engine.answer(item.id, item.options?.[0] ?? "Yes");
        else if (item.kind === "delivery") {
          deliveryChecks += 1;
          if (deliveryChecks === 1) hooks.atDeliveryCheck?.(repo);
          engine.approve(item.id);
        }
      }
      const found = state.tasks.find((entry) => entry.id === taskId) as Task | undefined;
      if (found?.state === "failed") throw new Error(`The task failed: ${found.error}`);
      return found?.state === "done" && found;
    }, "the work to ship", 90_000);
    return { task, fakes, repo, before, deliveryChecks };
  } finally {
    engine.shutdown();
  }
}

const lines = (task: Task) => task.timeline.map((entry) => entry.text);

describe.concurrent("work brought up to date with main", () => {
  it("puts the work on top of a main that moved, before the delivery check, and ships it as one commit there", async () => {
    let landed = "";
    const { task, repo, before, deliveryChecks } = await ship({}, { beforeBuild: (repo) => (landed = land(repo, "NEWS.md", "News\n", "News on main")) });
    expect(lines(task)).toContain("Brought up to date with main (1 new commit there), with no conflicts");
    expect(deliveryChecks).toBe(1);
    // Main: what landed meanwhile, then this task's one commit on top of it.
    expect(git(repo, "log", "--format=%s", `${before}..main`)).toBe("Add a greeting\nNews on main");
    expect(git(repo, "rev-parse", "main~1")).toBe(landed);
    expect(task.baseSha).toBe(landed);
  });

  it("sends a conflict to the builder, reviews the change again on top of main, and ships one commit", async () => {
    const { task, fakes, repo, before, deliveryChecks } = await ship({}, { beforeBuild: (repo) => land(repo, "greeting.txt", "Hi from main\n", "A greeting on main") });
    const text = lines(task);
    expect(text).toContain("Main moved on (1 new commit) and 1 file conflicts with this work, so the builder brings it up to date");
    expect(text).toContain("Brought up to date with main: Added a greeting.");
    // The builder was told what conflicts and where to learn what main changed.
    const update = fakes.prompts("builder").find((prompt) => prompt.includes("conflict markers"));
    expect(update).toContain("these files still have git's conflict markers: greeting.txt");
    expect(update).toMatch(/git log --stat [0-9a-f]{40}\.\.[0-9a-f]{40}/);
    // The review ran again after the update, from its first reviewer.
    const updated = text.indexOf("Brought up to date with main: Added a greeting.");
    expect(text.slice(updated).filter((line) => line === "Code reviewer started").length).toBeGreaterThan(0);
    expect(deliveryChecks).toBe(1);
    expect(git(repo, "log", "--format=%s", `${before}..main`)).toBe("Add a greeting\nA greeting on main");
    expect(git(repo, "show", "main:greeting.txt")).not.toContain("<<<<<<<");
  });

  it("ships without asking again when main moves after the approval without touching the change", async () => {
    const { task, repo, before, deliveryChecks } = await ship({}, { atDeliveryCheck: (repo) => land(repo, "NEWS.md", "News\n", "News on main") });
    const text = lines(task);
    expect(text.indexOf("Brought up to date with main (1 new commit there), with no conflicts")).toBeGreaterThan(text.indexOf("You approved the delivery"));
    expect(text.some((line) => line.includes("Petrina asks you again"))).toBe(false);
    expect(deliveryChecks).toBe(1);
    expect(git(repo, "log", "--format=%s", `${before}..main`)).toBe("Add a greeting\nNews on main");
  });

  it("asks again when a change made after the approval conflicts with main, once the builder brought it up to date and the review looked again", async () => {
    const { task, repo, before, deliveryChecks } = await ship({}, { atDeliveryCheck: (repo) => land(repo, "greeting.txt", "Hi from main\n", "A greeting on main") });
    expect(lines(task)).toContain("Brought up to date with main: Added a greeting.");
    expect(deliveryChecks).toBe(2);
    expect(git(repo, "log", "--format=%s", `${before}..main`)).toBe("Add a greeting\nA greeting on main");
  });
});

describe.concurrent("the builder's own conversation", () => {
  it("goes back to it for a fix round, with only its job now and where things stand", async () => {
    const { task, fakes } = await ship({ reviewer: "important", reopen: "resume" });
    expect(lines(task)).toContain("Went back to its own conversation from the last step");
    const builder = fakes.prompts("builder");
    // One conversation for the build and the fix round.
    expect(new Set(fakes.received("builder").map((entry) => entry.session)).size).toBe(1);
    const back = builder.find((prompt) => prompt.startsWith("Petrina is back with more work on this task"));
    expect(back).toContain("You are fixing the review findings listed below");
    expect(back).toContain("## Review findings (answer every one by id; fix every Important one)");
    expect(back).not.toContain("You are the Builder in Petrina");
  });

  it("starts a fresh one, with what it reported, when the tool cannot reopen it", async () => {
    const { task, fakes } = await ship({ reviewer: "important" });
    expect(lines(task).some((line) => line.startsWith("Could not go back to its own conversation"))).toBe(true);
    const fresh = fakes.openings("builder").at(-1)!;
    expect(fresh).toContain("You are fixing the review findings listed below");
    expect(fresh).toContain("## What the builder reports\nAdded a greeting.");
  });
});

describe.concurrent("checks only look", () => {
  it("puts back whatever a check changes in files git tracks, so nothing unreviewed ships", async () => {
    const { task, repo } = await ship({ checks: "writes" });
    expect(lines(task)).toContain("A check changed files, so Petrina put them back: checks only look, and fixes come from the builder");
    expect(git(repo, "ls-tree", "--name-only", "main")).toContain("README.md");
    expect(git(repo, "ls-tree", "--name-only", "main")).not.toContain("README.txt");
  });
});

describe.concurrent.skipIf(!posix)("the repository's own commit hooks", () => {
  // Like a hook that keeps employer-internal names out of a public repository: local, never committed.
  const guard = `hits=$(git diff --cached -U0 --no-color | grep '^+' | grep -inE 'internal-db-[0-9]+')
if [ -n "$hits" ]; then echo "pre-commit: staged changes contain internal names; scrub them first:" >&2; echo "$hits" >&2; exit 1; fi`;

  it("runs a local pre-commit hook on the whole change, and its output sends the work back to the builder", async () => {
    const { task, fakes, repo, before } = await ship({ leak: true }, { setup: (repo) => hook(repo, "pre-commit", guard) });
    const blocked = task.findings.find((finding) => finding.text === "Check failed: Pre-commit hook (git hook run --ignore-missing pre-commit)");
    expect(blocked?.evidence).toContain("staged changes contain internal names");
    expect(blocked?.evidence).toContain("internal-db-07");
    expect(blocked?.status).toBe("fixed");
    // The builder heard about the hook up front, and the fix round showed it what the hook said.
    expect(fakes.openings("builder")[0]).toContain("- Pre-commit hook: the repository's own");
    expect(fakes.prompts("builder").some((prompt) => prompt.includes("internal-db-07"))).toBe(true);
    // What landed is clean, as one commit, and the clone is back on its branch.
    expect(git(repo, "show", "main:greeting.txt")).not.toContain("internal-db");
    expect(git(repo, "log", "--format=%s", `${before}..main`)).toBe("Add a greeting");
    expect(git(task.worktree!, "symbolic-ref", "--short", "HEAD")).toBe(task.branch!);
    expect(task.hooking).toBeUndefined();
  });

  it("runs a commit-msg hook on the task's one commit message, with the builder's title", async () => {
    const { task, repo, before } = await ship({ title: "feat: add a greeting" }, { setup: (repo) => hook(repo, "commit-msg", `head -1 "$1" | grep -qE '^(feat|fix|chore): ' || { echo "commit-msg: use a conventional title" >&2; exit 1; }`) });
    expect(task.checks?.results.find((run) => run.name === "Commit message hook")).toMatchObject({ ok: true, command: "git hook run commit-msg" });
    expect(git(repo, "log", "--format=%s", `${before}..main`)).toBe("feat: add a greeting");
  });
});
