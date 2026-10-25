import { executionFor } from "@petrina/orchestrator";
import { afterAll, describe, expect, it } from "bun:test";
import { type DeepMutable, type Task } from "@petrina/core";
import { coordinator, finish, git, taskOf, until } from "../../support.js";
import { sourceWorlds, deliveryGate, taskCommit } from "../../fixtures/source-world.js";
const { setup, close } = sourceWorlds();
afterAll(close);

describe.concurrent("review findings for a confirmed start",()=>{
it("puts an interrupted commit hook back on the task's work before review", async () => {
    const { w, fakes, start } = await setup("hook-restart");
    let engine = start();
    try {
      const productId = await engine.addProduct(w.clone);
      const id = engine.addTask({ productId, title: "A greeting", description: "[quick]", delivery: "local", approvePlan: false });
      await deliveryGate(engine, id);
      const live = engine.task(id)!;
      const work = await git(executionFor(live).work.worktree!, "rev-parse", "HEAD");
      const base = executionFor(live).work.baseSha!;
      expect(work).not.toBe(base);
      expect(await git(executionFor(live).work.worktree!, "show", "HEAD:greeting.txt")).toContain("Hello");
      const seen = fakes.received("code reviewer").length;
      expect(seen).toBeGreaterThan(0);
      await engine.shutdown();
      await Promise.all(engine.settling.values());
      await git(executionFor(live).work.worktree!, "update-ref", "--no-deref", "HEAD", base);
      w.editSaved((saved) => {
        const task = taskOf(saved, id) as DeepMutable<Task>;
        task.hooking = true;
        task.state = "waiting";
        task.holdsSlot = false;
        task.stageIndex = task.plan!.stages.findIndex((stage) => stage.kind === "review-chain");
        task.sub = 0;
        // The finished round is closed. A restart at that stage must review the recovered work again.
        delete task.hunt;
        delete task.agent;
        delete task.conversation;
        delete task.error;
        saved.inbox = saved.inbox.filter((item) => item.taskId !== id);
      });
      engine = start();
      await until(engine, async () => {
        const task = engine.task(id);
        return !!task && !!executionFor(task).work.worktree && executionFor(task).work.hooking === undefined && await git(executionFor(task).work.worktree!, "rev-parse", "HEAD") === work && fakes.received("code reviewer").length > seen;
      }, coordinator(["plan", "design"]));
      expect(await git(executionFor(engine.task(id)!).work.worktree!, "rev-parse", "HEAD")).toBe(work);
      expect(executionFor(engine.task(id)!).work.hooking).toBeUndefined();
      expect(fakes.prompts("code reviewer").at(-1)).toContain(`git diff ${base}...HEAD`);
      const done = taskOf(await finish(engine, id), id);
      expect(done.error).toBeUndefined();
      expect(done.hooking).toBeUndefined();
      expect(await git(w.clone, "show", `${await taskCommit(w, done)}:greeting.txt`)).toContain("Hello");
    } finally { await engine.shutdown(); }
  });
});
