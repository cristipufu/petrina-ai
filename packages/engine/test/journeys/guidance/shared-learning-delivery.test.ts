import { engineCaseFixtures, type EngineCaseOwner } from "../../fixtures/engine-cases.js";
import { mkdtempSync } from "node:fs";
import { afterAll as closeOwnedCases } from "bun:test";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { instructionAgents } from "../../fixtures/instruction-agents.js";
import { describe, expect, it } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InboxItem, Task } from "@petrina/core";
import { executionFor } from "@petrina/orchestrator";
import { git, gitWith, makeProduct, waitFor } from "../../fixtures.js";
const cases = engineCaseFixtures();
closeOwnedCases(() => cases.close());


const INTRO = "What agents learned about working in this repository, added with the coordinator's OK.";
const BASE = `# Working on the demo\n\nKeep changes small.\n\n## Learnings\n\n${INTRO}\n\n- Run the package tests before delivering.\n`;
const SCRIPT_LESSON = "Engine tests script the stand-in agent through the JSON file named by --script; write it before the step starts.";
const TOOL_LESSON = "The stand-in agent used in engine tests reports token usage only when started with --tool=<tool id> (as the work-log tests do); without it, every turn records 'not reported'.";
const KEPT = "Kept both sets of approved learnings";

/** A file exactly as committed, without the helper's trimming. */
const show = (cwd: string, spec: string) => gitWith({ cwd, raw: true, timeoutMs: 30_000 }, "cat-file", "blob", spec);
const commit = async (cwd: string, message: string) => { await git(cwd, "add", "-A"); await git(cwd, "commit", "-q", "-m", message); return git(cwd, "rev-parse", "HEAD"); };

/** Two tasks on one product delivering locally, driven by fake agents. `ship` decides each delivery check. */
async function twoTasks(owner: EngineCaseOwner, name: string, script: (root: string) => object = () => ({})) {
  const root = mkdtempSync(join(owner.root, `petrina-${name}-`));

  const engine = owner.open(join(root, "data"), instructionAgents({ ownFiles: true, ...script(root) }));
  let closing: Promise<void> | undefined;
  const dispose = () => closing ??= (async () => {

    await owner.stop(engine);

  })();
  return setupWithCleanup(async () => {
    const repo = await makeProduct(root);
    writeFileSync(join(repo, "AGENTS.md"), BASE);
    await commit(repo, "Agent instructions");
    const productId = await engine.addProduct(repo);
    engine.setProductDelivery(productId, "local", true);
    const product = engine.s.products.find((entry) => entry.id === productId)!;
    // Each delivery check by its place among the task's checks: 1 for the first.
    const counted = new Map<string, number>(), perTask = new Map<string, number>();
    let ship = (_item: InboxItem, _count: number) => false;
    const find = (id: string) => engine.getState().tasks.find((task) => task.id === id) as Task;
    const until = <T>(check: () => T | undefined | false, what: string) => waitFor(() => {
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
    }, what, 90_000);
    const checks = (id: string) => perTask.get(id) ?? 0;
    /** Accepted at the task's earlier delivery check: its next delivery writes it. */
    const accept = (text: string, fromTask: string) => { product.learnings = [...(product.learnings ?? []), { text, at: Date.now(), fromTask }]; };
    const sentBack = (task: Task | undefined) => task?.journey?.filter((step) => step.update || (step.work === "update" && step.tone === "back"))
    .map((step) => step.update ? "Builder (update)" : `Update branch: ${step.outcome}`) ?? [];
    return { root, engine, dispose, repo, productId, product, find, until, checks, accept, sentBack, setShip: (decide: typeof ship) => { ship = decide; } };

  }, dispose);
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
          const second = f.engine.addTask({ productId: f.productId, title: "Greet visitors", description: "[no-check]" });
          await f.until(() => existsSync(`${hold}.reached`), "the second task's reviewers to start");
          const first = f.engine.addTask({ productId: f.productId, title: "Wave goodbye", description: "[no-check]" });
          f.accept(SCRIPT_LESSON, first);
          f.setShip((item) => item.taskId === first);
          await f.until(() => f.find(first)?.state === "done", "the first task to land");
          expect(await show(f.repo, "main:AGENTS.md")).toBe(`${BASE}- ${SCRIPT_LESSON}\n`);
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
          expect(await show(worktree, "HEAD:AGENTS.md")).toBe(`${BASE}- ${SCRIPT_LESSON}\n- ${TOOL_LESSON}\n`);
          expect(await git(worktree, "rev-parse", "HEAD~1")).toBe(await git(f.repo, "rev-parse", "main"));
          expect((await git(worktree, "diff", "--name-only", "HEAD~1", "HEAD")).split("\n")).toEqual(["AGENTS.md", "greet-visitors.txt"]);
          const update = task.journey!.find((step) => step.kind === "petrina" && step.work === "update")!;
          expect([update.outcome, update.reason, update.tone]).toEqual([KEPT, "up to date with main", undefined]);
          // The checks ran on the combined version before the delivery check.
          expect(work.checks?.tree).toBe(await git(worktree, "rev-parse", "HEAD^{tree}"));
          expect(task.journey!.findLastIndex((step) => !!step.productChecks?.length)).toBeGreaterThan(task.journey!.indexOf(update));
          expect(task.timeline.map((entry) => entry.text)).toContain(`Brought up to date with main (1 new commit there): main and this work only added approved learnings to AGENTS.md, so Petrina kept main's and added this work's: ${TOOL_LESSON}`);
          f.setShip(() => true);
          await f.until(() => f.find(second)?.state === "done", "the second task to land");
          expect(await show(f.repo, "main:AGENTS.md")).toBe(`${BASE}- ${SCRIPT_LESSON}\n- ${TOOL_LESSON}\n`);
          expect(await git(f.repo, "log", "--format=%s", "-3", "main")).toBe("Greet visitors\nWave goodbye\nAgent instructions");
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
          const first = f.engine.addTask({ productId: f.productId, title: "Wave goodbye", description: "[no-check]" });
          f.accept(TOOL_LESSON, first);
          await f.until(() => f.checks(first), "the first task's delivery check");
          // The first task wrote and reserved its lesson; the second writes only its own.
          const second = f.engine.addTask({ productId: f.productId, title: "Greet visitors", description: "[no-check]" });
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
          expect(await show(work.worktree!, "HEAD:AGENTS.md")).toBe(`${BASE}- ${TOOL_LESSON}\n- ${SCRIPT_LESSON}\n`);
          expect(work.checks?.tree).toBe(await git(work.worktree!, "rev-parse", "HEAD^{tree}"));
          expect(work.approvedSha).toBeUndefined();
          f.setShip(() => true);
          await f.until(() => f.find(second)?.state === "done", "the second task to land");
          expect(await show(f.repo, "main:AGENTS.md")).toBe(`${BASE}- ${TOOL_LESSON}\n- ${SCRIPT_LESSON}\n`);
        } finally {
          await f.dispose();
        }

      } finally { await f.dispose(); }

    });
  });
});
