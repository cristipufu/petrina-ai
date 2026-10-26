import { executionFor } from "@petrina/orchestrator";
import { afterAll, describe, expect, it } from "bun:test";
import { type DeepMutable, type Task } from "@petrina/core";
import { finish, itemOf, remoteRef, taskOf } from "../../support.js";
import { sourceWorlds, pull, planGate, taskCommit } from "../../fixtures/source-world.js";
const fixtures = sourceWorlds();
afterAll(() => fixtures.close());



describe.concurrent("one approved product and starting point",()=>{
for (const changed of ["branch"] as const) it(`requires confirmation when the same PR number has a new working ${changed} on a redone plan`, async () => {
    await fixtures.world(`redo-pr-${changed}`, async ({ w, engine: withEngine }) => { await pull(w);
    let { id, state, approved, previous } = await withEngine(async engine => {

      const productId = await engine.addProduct(w.clone);
      const id = engine.addTask({ productId, title: "A greeting", startFrom: { kind: "pull-request", value: "7" }, approvePlan: true });
      let state = await planGate(engine, id);
      engine.setPoolPaused(true);
      engine.approve(itemOf(state, id, "plan")!.id);
      const approved = structuredClone(executionFor(engine.task(id)!).work.source);
      expect(approved?.confirmed).toBe(true);
      // Reopen a saved plan before preparation, as after a planning interruption.

      return { id, state, approved, previous: engine };

    }); await Promise.all(previous.settling.values());
      w.editSaved((state) => { const task = taskOf(state, id) as DeepMutable<Task>; task.stageIndex = -1; delete task.plan; task.state = "waiting"; });
      w.setGitHub((state) => {
        const pr = state.prs[0]!;
        if (changed === "branch") pr.headRefName = "renamed-work";
        else pr.headRepository = { nameWithOwner: "contributor/demo" };
      });

    await withEngine(async resumed => {
        resumed.setPoolPaused(false);
        state = await planGate(resumed, id);
        const task = taskOf(state, id);
        expect(task.error).toBeUndefined();
        expect(task.source).toEqual(approved);
        expect(task.proposedSource?.confirmed).toBe(false);
        expect(task.proposedSource?.destination[changed === "branch" ? "branch" : "repo"]).toBe(changed === "branch" ? "renamed-work" : "contributor/demo");
        expect(task.confirmWork).toBe(true); expect(task.worktree).toBeUndefined();

    });
    });
  });
});



describe.concurrent("one approved product and starting point",()=>{
for (const approvePlan of [undefined, false]) it(`requires source confirmation when the planner chooses the product, with optional plan approval ${approvePlan === false ? "off" : "defaulted"}`, async () => {
    await fixtures.world("choose-product", async ({ w, fakes, engine: withEngine }) => {
    await withEngine(async engine => {

      const productId = await engine.addProduct(w.clone);
      fakes.scenario({ planner: "short", worksOn: [{ productId, startFrom: { kind: "default" }, delivery: "local" }] });
      const id = engine.addTask({ productId: "", title: "Fix it", approvePlan });
      const state = await planGate(engine, id);
      expect(taskOf(state, id).productId).toBe(""); expect(taskOf(state, id).worktree).toBeUndefined();
      engine.approve(itemOf(state, id, "plan")!.id);
      expect(taskOf(await finish(engine, id), id).state).toBe("done");

    });
    });
  });
});

describe.concurrent("one approved product and starting point",()=>{
it("keeps ordinary default tasks able to skip the plan check, without interpreting PR words", async () => {
    await fixtures.world("default", async ({ w, engine: withEngine }) => {
    await withEngine(async engine => {

      const productId = await engine.addProduct(w.clone);
      const id = engine.addTask({ productId, title: "Fix PR #999 on release-2.x", delivery: "local", approvePlan: false });
      const task = taskOf(await finish(engine, id), id);
      expect(task.error).toBeUndefined(); expect(task.source?.start).toEqual({ kind: "default", branch: "main" });
      expect(task.timeline.some((entry) => entry.text === "You approved the plan")).toBe(false);
      expect(await remoteRef(w.remote, "refs/heads/main")).toBe(await taskCommit(w, task));

    });
    });
  });
});

describe.concurrent("one approved product and starting point",()=>{
it("keeps a default task saved by an older Petrina able to run without a new plan check", async () => {
    await fixtures.world("older-default", async ({ w, engine: withEngine }) => {
    let { id, previous } = await withEngine(async engine => {

      const productId = await engine.addProduct(w.clone);
      engine.setPoolPaused(true);
      const id = engine.addTask({ productId, title: "A greeting", delivery: "local", approvePlan: false });

      return { id, previous: engine };

    }); await Promise.all(previous.settling.values());
      w.editSaved((state) => {
        const task = taskOf(state, id) as DeepMutable<Task>;
        delete task.workChoice; delete task.workProduct; delete task.explicitStart;
      });

    await withEngine(async engine => { engine.setPoolPaused(false);
      const task = taskOf(await finish(engine, id), id);
      expect(task.error).toBeUndefined(); expect(task.state).toBe("done");
      expect(task.source?.start).toEqual({ kind: "default", branch: "main" });
      expect(task.timeline.some((entry) => entry.text === "You approved the plan")).toBe(false);

    });
    });
  });
});
