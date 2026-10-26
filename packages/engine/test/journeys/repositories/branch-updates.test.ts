import { updateAgents } from "../../fixtures/update-agents.js";
import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUILT_IN_ROLES, journeyProblems, stepName, type Task } from "@petrina/core";
import { Engine } from "../../engine.js";
import type { Scenario } from "../../fake-agent.js";
import { git, makeProduct, removeDir, tempDir, waitFor } from "../../fixtures.js";

const posix = process.platform !== "win32";
const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

/** A commit on the product's own main, as another task landing there would make. */
async function land(repo: string, file: string, text: string, message: string): Promise<string> {
  writeFileSync(join(repo, file), text);
  await git(repo, "add", file);
  await git(repo, "commit", "-q", "-m", message);
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
 * product. `beforeBuild` runs at the first builder permission, once the working copy exists and before the
 * builder writes. `atDeliveryCheck` runs at the first delivery check, before the coordinator approves it.
 * `atBuilderPermission` can land main or add work while the scripted builder is waiting for permission. Each
 * hook finishes, Git included, before the engine gets the answer it is holding for.
 */
type Hook<T extends unknown[]> = (...args: T) => unknown;
async function ship(scenario: Scenario, hooks: { setup?: Hook<[repo: string]>; beforeBuild?: Hook<[repo: string]>; atDeliveryCheck?: Hook<[repo: string]>; atBuilderPermission?: Hook<[repo: string, task: Task]> } = {}) {
  const root = tempDir("petrina-update-");
  roots.push(root);
  const fakes = updateAgents(join(root, "replies"), scenario);
  const engine = new Engine(join(root, "data"), fakes);
  try {
    const repo = await makeProduct(root);
    await hooks.setup?.(repo);
    const before = await git(repo, "rev-parse", "HEAD");
    const productId = await engine.addProduct(repo);
    engine.setProductDelivery(productId, "local", true);
    const taskId = engine.addTask({ productId, title: "Add a greeting", description: "[no-check]", approvePlan: true });
    let deliveryChecks = 0;
    let movedBeforeBuild = false;
    const task = await waitFor(async () => {
      const state = engine.getState();
      const found = state.tasks.find((entry) => entry.id === taskId)!;
      for (const item of state.inbox) {
        if (item.taskId !== taskId) continue;
        if (item.kind === "plan") {
          // Approval itself happens while the working copy does not exist yet.
          engine.approve(item.id);
        } else if (item.kind === "permission") {
          if (found.agent?.roleId === "builder") {
            // The copy exists and the builder has not written yet, so a commit here is a later move.
            if (!movedBeforeBuild) { movedBeforeBuild = true; await hooks.beforeBuild?.(repo); }
            await hooks.atBuilderPermission?.(repo, found);
          }
          engine.allow(item.id, "once");
        }
        else if (item.kind === "question") engine.answer(item.id, item.options?.[0] ?? "Yes");
        else if (item.kind === "delivery") {
          deliveryChecks += 1;
          if (deliveryChecks === 1) await hooks.atDeliveryCheck?.(repo);
          engine.approve(item.id);
        }
      }
      if (found?.state === "failed") throw new Error(`The task failed: ${found.error}`);
      return found?.state === "done" && found;
    }, "the work to ship", 90_000);
    return { task, fakes, repo, before, deliveryChecks };
  } finally {
    try { await engine.shutdown(); }
    catch (error) {
      const at = roots.indexOf(root); if (at >= 0) roots.splice(at, 1);
      throw error;
    }
  }
}

const lines = (task: Task) => task.timeline.map((entry) => entry.text);

describe.concurrent("a builder that brings main in itself", () => {
  it("has the work count from where the branch met main, so reviews see only its own changes and no merge commit lands", async () => {
    let landed = "";
    const { task, fakes, repo, before } = await ship({ mergesMain: true }, { beforeBuild: async (repo) => (landed = await land(repo, "NEWS.md", "News\n", "News on main")) });
    expect(lines(task).some((line) => line.startsWith("The builder brought main into the branch itself"))).toBe(true);
    expect(task.baseSha).toBe(landed);
    // Every reviewer compared against the met main, not the base from before the merge.
    for (const review of fakes.openings("code reviewer")) expect(review).toContain(`git diff ${landed}...HEAD`);
    expect(await git(repo, "log", "--format=%s", `${before}..main`)).toBe("Add a greeting\nNews on main");
    expect(await git(repo, "rev-list", "--merges", "--count", `${before}..main`)).toBe("0");
  });
});

describe.concurrent("work brought up to date with main", () => {
  it("puts the work on top of a main that moved, before the delivery check, and ships it as one commit there", async () => {
    let landed = "";
    const { task, repo, before, deliveryChecks } = await ship({}, { beforeBuild: async (repo) => (landed = await land(repo, "NEWS.md", "News\n", "News on main")) });
    expect(lines(task)).toContain("Brought up to date with main (1 new commit there), with no conflicts");
    expect(deliveryChecks).toBe(1);
    // Main: what landed meanwhile, then this task's one commit on top of it.
    expect(await git(repo, "log", "--format=%s", `${before}..main`)).toBe("Add a greeting\nNews on main");
    expect(await git(repo, "rev-parse", "main~1")).toBe(landed);
    expect(task.baseSha).toBe(landed);
  });

  it("brings the work up to date before a review starts, so no port is needed afterwards", async () => {
    const { task, fakes, repo, before } = await ship({}, { beforeBuild: (repo) => land(repo, "NEWS.md", "News\n", "News on main") });
    const text = lines(task);
    const updated = text.indexOf("Brought up to date with main (1 new commit there), with no conflicts");
    expect(updated).toBeGreaterThan(-1);
    expect(updated).toBeLessThan(text.indexOf("Code reviewer started"));
    expect(text.filter((line) => line.startsWith("Brought up to date with main"))).toHaveLength(1);
    // Every reviewer compared against the new main.
    const landed = await git(repo, "rev-parse", "main~1");
    for (const review of fakes.openings("code reviewer")) expect(review).toContain(`git diff ${landed}...HEAD`);
    expect(await git(repo, "log", "--format=%s", `${before}..main`)).toBe("Add a greeting\nNews on main");
  });

  it("sends a first-review conflict to the builder, then every planned reviewer looks at the whole change", async () => {
    const { task, fakes, repo, before, deliveryChecks } = await ship({}, { beforeBuild: (repo) => land(repo, "greeting.txt", "Hi from main\n", "A greeting on main") });
    const text = lines(task);
    const updateStep = task.journey!.find(step => step.kind === "agent" && step.update)!;
    const input = updateStep.agentInputs![0]!;
    expect(input.instructions).toContain("these files still have git's conflict markers: greeting.txt");
    expect(input.instructions).toContain("keep main's version of everything this task did not change");
    expect(fakes.prompts("builder").some(prompt => prompt.includes(input.instructions!))).toBe(true);
    expect(text).toContain("Main moved on (1 new commit) and 1 file conflicts with this work, so the builder brings it up to date");
    expect(text).toContain("Brought up to date with main: Added a greeting.");
    // The builder was told what conflicts and where to learn what main changed.
    const update = fakes.prompts("builder").find((prompt) => prompt.includes("conflict markers"));
    expect(update).toContain("these files still have git's conflict markers: greeting.txt");
    expect(update).toMatch(/git log --stat [0-9a-f]{40}\.\.[0-9a-f]{40}/);
    // No ordinary review happened before the conflict: the full planned review must still happen.
    const updated = text.indexOf("Brought up to date with main: Added a greeting.");
    expect(text.slice(updated).filter((line) => line === "Code reviewer started")).toHaveLength(2);
    expect(text.some((line) => line.startsWith("Port review passed"))).toBe(false);
    const reviews = fakes.openings("code reviewer");
    expect(reviews).toHaveLength(2);
    for (const review of reviews) {
      expect(review).not.toContain("Review only the port");
      expect(review).toContain(`git diff ${task.baseSha}...HEAD`);
    }
    // The journey shows the move, the update and the full first review.
    const steps = task.journey ?? [];
    const names = steps.map((step, index) => stepName(step, steps.slice(0, index), BUILT_IN_ROLES));
    const moved = names.indexOf("Update branch");
    expect(moved).toBeGreaterThan(-1);
    expect(names[moved + 1]).toBe("Builder (update)");
    expect(names.slice(moved + 2).filter((name) => name.startsWith("Code reviewer"))[0]).toBe("Code reviewers");
    expect(steps.some((step) => step.port)).toBe(false);
    const reviewStep = steps.find((step) => step.roleId === "code-reviewer")!;
    expect(reviewStep.team).toHaveLength(2);
    expect(names.some((name) => name.includes("again"))).toBe(false);
    expect(journeyProblems(task)).toEqual([]);
    expect(deliveryChecks).toBe(1);
    expect(await git(repo, "log", "--format=%s", `${before}..main`)).toBe("Add a greeting\nA greeting on main");
    expect(await git(repo, "show", "main:greeting.txt")).not.toContain("<<<<<<<");
  });

  it("resolves main's conflict before spending the first acceptance turn", async () => {
    const { task, fakes } = await ship({ planner: "tester-first" }, { beforeBuild: (repo) => land(repo, "greeting.txt", "Hi from main\n", "A greeting on main") });
    const text = lines(task);
    const updated = text.indexOf("Brought up to date with main: Added a greeting.");
    expect(updated).toBeGreaterThan(-1);
    expect(text.indexOf("Tester started")).toBeGreaterThan(updated);
    expect(fakes.openings("tester")).toHaveLength(1);
    expect(fakes.openings("code reviewer")).toHaveLength(2);
    expect(task.acceptancePassed).toBe(true);
    expect(journeyProblems(task)).toEqual([]);
  });

  it("ships without asking again when main moves after the approval without touching the change", async () => {
    const { task, repo, before, deliveryChecks } = await ship({}, { atDeliveryCheck: (repo) => land(repo, "NEWS.md", "News\n", "News on main") });
    const text = lines(task);
    expect(text.indexOf("Brought up to date with main (1 new commit there), with no conflicts")).toBeGreaterThan(text.indexOf("You approved the delivery"));
    expect(text.some((line) => line.includes("Petrina asks you again"))).toBe(false);
    expect(deliveryChecks).toBe(1);
    expect(await git(repo, "log", "--format=%s", `${before}..main`)).toBe("Add a greeting\nNews on main");
  });

  it("asks again when a change made after the approval conflicts with main, once the builder brought it up to date and the review looked again", async () => {
    const { task, fakes, repo, before, deliveryChecks } = await ship({}, { atDeliveryCheck: (repo) => land(repo, "greeting.txt", "Hi from main\n", "A greeting on main") });
    expect(lines(task)).toContain("Brought up to date with main: Added a greeting.");
    // Both ordinary reviewers passed this exact feature; one independent reviewer can now review the port.
    const reviews = fakes.openings("code reviewer");
    expect(reviews).toHaveLength(3);
    expect(reviews.slice(0, 2).every((prompt) => !prompt.includes("Review only the port"))).toBe(true);
    expect(reviews[2]).toContain("Review only the port of the already reviewed change, using the prepared port comparison and resolved files");
    expect(reviews[2]).toContain("resolving conflicts in: greeting.txt");
    expect(lines(task).some((line) => line.startsWith("Port review passed"))).toBe(true);
    const ports = task.journey!.filter((step) => step.port && step.roleId === "code-reviewer");
    expect(ports).toHaveLength(1);
    expect(ports[0]!.team ?? [ports[0]!.profileId]).toHaveLength(1);
    expect(task.reviewedTree).toBe(await git(repo, "rev-parse", "main^{tree}"));
    expect(journeyProblems(task)).toEqual([]);
    expect(deliveryChecks).toBe(2);
    expect(await git(repo, "log", "--format=%s", `${before}..main`)).toBe("Add a greeting\nA greeting on main");
  });

  it("gives unreviewed fixes the full planned review when main conflicts during a fix round", async () => {
    let landed = false;
    const { task, fakes, repo } = await ship({ reviewer: "important", fixes: "change" }, { atBuilderPermission: async (repo, current) => {
      if (!current.fixing || current.updating || landed) return;
      landed = true;
      await land(repo, "greeting.txt", "Hi from main\n", "A greeting on main");
    } });
    expect(landed).toBe(true);
    expect(lines(task)).toContain("Brought up to date with main: Added a greeting.");
    expect(await git(repo, "show", "main:welcome.txt")).toContain("Hello");
    const reviews = fakes.openings("code reviewer");
    expect(reviews).toHaveLength(4);
    for (const review of reviews.slice(2)) {
      expect(review).not.toContain("Review only the port");
      expect(review).not.toContain("Review only what changed since");
      expect(review).toContain(`git diff ${task.baseSha}...HEAD`);
    }
    expect(task.findings.filter((finding) => finding.severity === "blocking").every((finding) => finding.status === "fixed")).toBe(true);
    expect(task.journey!.some((step) => step.port)).toBe(false);
  });

  it("reviews extra work done during a port with every planned reviewer", async () => {
    let added = false;
    const { task, fakes, repo } = await ship({}, {
      atDeliveryCheck: (repo) => land(repo, "greeting.txt", "Hi from main\n", "A greeting on main"),
      atBuilderPermission: (_repo, current) => {
        if (!current.updating) return;
        writeFileSync(join(current.worktree!, "welcome.txt"), "An unreviewed welcome-page fix\n");
        added = true;
      },
    });
    expect(added).toBe(true);
    expect(await git(repo, "show", "main:welcome.txt")).toBe("An unreviewed welcome-page fix");
    const reviews = fakes.openings("code reviewer");
    expect(reviews).toHaveLength(4);
    for (const review of reviews.slice(2)) {
      expect(review).not.toContain("Review only the port");
      expect(review).toContain(`git diff ${task.baseSha}...HEAD`);
    }
    expect(task.journey!.some((step) => step.port && step.roleId === "code-reviewer")).toBe(false);
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
    const saved = fakes.prompts("builder").find((prompt) => prompt.includes("Saved failed-check output"))!.match(/- Pre-commit hook: ("[^"\n]+")/)!;
    expect(readFileSync(JSON.parse(saved[1]!), "utf8")).toContain("internal-db-07");
    // What landed is clean, as one commit, and the clone is back on its branch.
    expect(await git(repo, "show", "main:greeting.txt")).not.toContain("internal-db");
    expect(await git(repo, "log", "--format=%s", `${before}..main`)).toBe("Add a greeting");
    expect(await git(repo, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(await git(repo, "rev-parse", task.branch!)).toBe(await git(repo, "rev-parse", "main"));
    expect(task.hooking).toBeUndefined();
  });

});
