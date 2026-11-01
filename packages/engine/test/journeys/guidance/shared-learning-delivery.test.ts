import { engineCaseFixtures, type EngineCaseOwner } from "../../fixtures/engine-cases.js";
import { mkdtempSync } from "node:fs";
import { afterAll as closeOwnedCases } from "bun:test";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { instructionAgents, type InstructionScript } from "../../fixtures/instruction-agents.js";
import { describe, expect, it } from "bun:test";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InboxItem, Task } from "@petrina/core";
import { executionFor } from "@petrina/orchestrator";
import * as gitOps from "@petrina/repositories/git";
import { createProductRepository, git, removeDir, tempDir, waitFor } from "../../fixtures.js";
import { installPreparedProduct, privateCloneProduct } from "../../fixtures/prepared-product.js";
import { preparedInstructionTask } from "../../fixtures/prepared-instructions.js";
import { installSharedWorkflowFastPaths, readLooseCommit, readRef, readWorktreeCommit } from "../../fixtures/shared-preparation.js";
const cases = engineCaseFixtures();
closeOwnedCases(() => cases.close());


const INTRO = "What agents learned about working in this repository, added with the coordinator's OK.";
const BASE = `# Working on the demo\n\nKeep changes small.\n\n## Learnings\n\n${INTRO}\n\n- Run the package tests before delivering.\n`;
const SCRIPT_LESSON = "Engine tests script the stand-in agent through the JSON file named by --script; write it before the step starts.";
const TOOL_LESSON = "The stand-in agent used in engine tests reports token usage only when started with --tool=<tool id> (as the work-log tests do); without it, every turn records 'not reported'.";
const KEPT = "Kept both sets of approved learnings";

let cachedBaseRepoPromise: Promise<{ root: string; repo: string }> | undefined;
process.once("exit", () => {
  if (cachedBaseRepoPromise) {
    void cachedBaseRepoPromise.then(({ root }) => removeDir(root)).catch(() => {});
  }
});
function getCachedBaseRepo(): Promise<{ root: string; repo: string }> {
  return cachedBaseRepoPromise ??= (async () => {
    const root = tempDir("petrina-shared-learning-seed-");
    const { path: repo } = await createProductRepository(root, { origin: "none" });
    writeFileSync(join(repo, "AGENTS.md"), BASE);
    await gitOps.commitChanges(repo, "Agent instructions");
    return { root, repo };
  })();
}

/** A file exactly as committed, without the helper's trimming. */
const show = (cwd: string) => readFileSync(join(cwd, "AGENTS.md"), "utf8");

/** Two tasks on one product delivering locally, driven by fake agents. `ship` decides each delivery check. */
async function twoTasks(owner: EngineCaseOwner, name: string, script: (root: string) => InstructionScript = () => ({})) {
  const root = mkdtempSync(join(owner.root, `petrina-${name}-`));

  const scenario: InstructionScript = { ownFiles: true, ...script(root) };
  const agents = instructionAgents(scenario);
  const engine = owner.open(join(root, "data"), agents);
  installSharedWorkflowFastPaths(engine, { skipDriverPrepare: true, skipUpToDate: true, skipPrepareChecks: true, skipReviewCopies: true, skipReviewInputDiffs: true, fastCheckCapture: true, fastCleanup: true });
  let closing: Promise<void> | undefined;
  const dispose = () => closing ??= (async () => {

    await owner.stop(engine);

  })();
  return setupWithCleanup(() => owner.run(engine, async () => {
    const seed = await getCachedBaseRepo(); owner.check();
    const repo = join(root, "clone");
    cpSync(seed.repo, repo, { recursive: true });
    const productId = installPreparedProduct(engine, privateCloneProduct(repo));
    engine.setProductDelivery(productId, "local", true);
    const product = engine.s.products.find((entry) => entry.id === productId)!;
    // Each delivery check by its place among the task's checks: 1 for the first.
    const counted = new Map<string, number>(), perTask = new Map<string, number>();
    let ship = (_item: InboxItem, _count: number) => false;
    const find = (id: string) => engine.getState().tasks.find((task) => task.id === id) as Task;
    const until = <T>(check: () => T | undefined | false, what: string) => owner.run(engine, () => waitFor(() => {
      owner.check();
      const done = check();
      if (done) return done;
      for (const task of engine.getState().tasks) if (task.state === "failed") throw new Error(`${task.title} failed: ${task.error}`);
      for (const item of engine.getState().inbox) {
        if (item.kind === "plan") engine.approve(item.id);
        else if (item.kind === "permission") engine.allow(item.id, "once");
        else if (item.kind === "question") engine.answer(item.id, item.options?.[0] ?? "Yes");
        else if (item.kind === "delivery") {
          if (!counted.has(item.id)) perTask.set(item.taskId, counted.set(item.id, (perTask.get(item.taskId) ?? 0) + 1).get(item.id)!);
          if (ship(item, counted.get(item.id)!)) engine.approve(item.id);
        }
      }
      return undefined;
    }, what, 90_000));
    const addTask = (title: string, input?: { reviewed: true }) => owner.run(engine, () => preparedInstructionTask(engine, { productId, title, description: "[no-check]" }, agents, scenario, { entry: "review", checks: "version", ...input }, owner.check));
    const checks = (id: string) => perTask.get(id) ?? 0;
    /** Accepted at the task's earlier delivery check: its next delivery writes it. */
    const accept = (text: string, fromTask: string) => { product.learnings = [...(product.learnings ?? []), { text, at: Date.now(), fromTask }]; };
    const sentBack = (task: Task | undefined) => task?.journey?.filter((step) => step.update || (step.work === "update" && step.tone === "back"))
    .map((step) => step.update ? "Builder (update)" : `Update branch: ${step.outcome}`) ?? [];
    return { root, engine, dispose, repo, productId, product, addTask, find, until, checks, accept, sentBack, setShip: (decide: typeof ship) => { ship = decide; } };

  }), dispose);
}

describe.concurrent("two deliveries that each add an approved lesson to AGENTS.md", () => {
  it("keeps main's lesson and the task's own when only those conflict, with no Builder turn", async () => {
    return cases.use("petrina-engine-case-", async owner => {
      let hold = "";
      // The second task's reviewers wait while the first task lands, as in the observed case.
      const f = await twoTasks(owner, "learnings-update", (root) => {
        hold = join(root, "hold-review");
        writeFileSync(hold, "");
        return { hold: { title: "Greet visitors", file: hold, role: "code reviewer" } };
      });
      try {
        try {
          const second = await f.addTask("Greet visitors");
          await f.until(() => existsSync(`${hold}.reached`), "the second task's reviewers to start");
          const first = await f.addTask("Wave goodbye", { reviewed: true });
          f.accept(SCRIPT_LESSON, first);
          f.setShip((item) => item.taskId === first);
          await f.until(() => f.find(first)?.state === "done", "the first task to land");
          expect(show(f.repo)).toBe(`${BASE}- ${SCRIPT_LESSON}\n`);
          // Separately accepted for the second task, which writes it on its own branch at its delivery check.
          f.accept(TOOL_LESSON, second);
          rmSync(hold);
          await f.until(() => f.sentBack(f.engine.task(second)).length || f.checks(second), "the second task's delivery check");
          const task = f.engine.task(second)!, work = executionFor(task).work;
          // Only AGENTS.md conflicted, with nothing but approved lessons on each side: no send-back to the Builder.
          expect({ sentBack: f.sentBack(task), conflicting: work.updating?.files }).toEqual({ sentBack: [], conflicting: undefined });
          expect(task.reviewSessions).toBeDefined();
          expect(task.reviewFreshReasons).toBeUndefined();
          const worktree = work.worktree!;
          expect(show(worktree)).toBe(`${BASE}- ${SCRIPT_LESSON}\n- ${TOOL_LESSON}\n`);
          expect(readWorktreeCommit(worktree)?.parents[0]).toBe(readRef(join(f.repo, ".git"), "refs/heads/main"));
          expect((await git(worktree, "diff", "--name-only", "HEAD~1", "HEAD")).split("\n")).toEqual(["AGENTS.md", "greet-visitors.txt"]);
          const update = task.journey!.find((step) => step.kind === "petrina" && step.work === "update")!;
          expect([update.outcome, update.reason, update.tone]).toEqual([KEPT, "up to date with main", undefined]);
          // The checks ran on the combined version before the delivery check.
          expect(work.checks?.tree).toBe(readWorktreeCommit(worktree)?.tree);
          expect(task.journey!.findLastIndex((step) => !!step.productChecks?.length)).toBeGreaterThan(task.journey!.indexOf(update));
          expect(task.timeline.map((entry) => entry.text)).toContain(`Brought up to date with main (1 new commit there): main and this work only added approved learnings to AGENTS.md, so Petrina kept main's and added this work's: ${TOOL_LESSON}`);
          f.setShip(() => true);
          await f.until(() => f.find(second)?.state === "done", "the second task to land");
          expect(show(f.repo)).toBe(`${BASE}- ${SCRIPT_LESSON}\n- ${TOOL_LESSON}\n`);
          const c0 = readLooseCommit(join(f.repo, ".git"), readRef(join(f.repo, ".git"), "refs/heads/main")!)!;
          const c1 = readLooseCommit(join(f.repo, ".git"), c0.parents[0]!)!;
          const c2 = readLooseCommit(join(f.repo, ".git"), c1.parents[0]!)!;
          expect([c0, c1, c2].map((c) => c.body.trim().split("\n")[0]).join("\n")).toBe("Greet visitors\nWave goodbye\nAgent instructions");
        } finally {
          await f.dispose();
        }

      } finally { await f.dispose(); }

    });
  });

  it("asks again after an approval when the combining happens on the way out, with the checks run on the new version", async () => {
    return cases.use("petrina-engine-case-", async owner => {
      const f = await twoTasks(owner, "learnings-approved");
      try {
        try {
          const first = await f.addTask("Wave goodbye", { reviewed: true });
          f.accept(TOOL_LESSON, first);
          await f.until(() => f.checks(first), "the first task's delivery check");
          // The first task wrote and reserved its lesson; the second writes only its own.
          const second = await f.addTask("Greet visitors");
          f.accept(SCRIPT_LESSON, second);
          await f.until(() => f.checks(second), "the second task's delivery check");
          f.setShip((item) => item.taskId === first);
          await f.until(() => f.find(first)?.state === "done", "the first task to land");
          f.setShip((item, count) => item.taskId === second && count === 1);
          await f.until(() => f.checks(second) === 2, "the second task's delivery check again");
          const task = f.engine.task(second)!, work = executionFor(task).work;
          expect(f.sentBack(task)).toEqual([]);
          const steps = task.journey!;
          const update = steps.findIndex((step) => step.work === "update");
          expect(steps[update]!.outcome).toBe(KEPT);
          expect(steps.slice(update + 1).map((step) => step.outcome)).toContain("Needs your OK again");
          expect(task.timeline.map((entry) => entry.text)).toContain("Main moved on, and on top of it this change reads differently from what you approved, so Petrina asks you again");
          expect(show(work.worktree!)).toBe(`${BASE}- ${TOOL_LESSON}\n- ${SCRIPT_LESSON}\n`);
          expect(work.checks?.tree).toBe(readWorktreeCommit(work.worktree!)?.tree);
          expect(work.approvedSha).toBeUndefined();
          f.setShip(() => true);
          await f.until(() => f.find(second)?.state === "done", "the second task to land");
          expect(show(f.repo)).toBe(`${BASE}- ${TOOL_LESSON}\n- ${SCRIPT_LESSON}\n`);
        } finally {
          await f.dispose();
        }

      } finally { await f.dispose(); }

    });
  });
});
