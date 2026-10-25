import { executionFor } from "@petrina/orchestrator";
import { afterAll, describe, expect, it } from "bun:test";
import { type DeepMutable, type Task, type WorkChoice } from "@petrina/core";
import { finish, itemOf, REPO, remoteRef, taskOf } from "../../support.js";
import { sourceWorlds, branch, pull, planGate, taskCommit } from "../../fixtures/source-world.js";
const { setup, close } = sourceWorlds();
afterAll(close);

describe.concurrent("one approved product and starting point",()=>{
for (const corrected of ["default"]) it(`clears a mismatched link error when corrected to a ${corrected} and permits approval before setup`, async () => {
    const { w, start } = await setup(`wrong-link-${corrected}`); await pull(w); const engine = start();
    try {
      const productId = await engine.addProduct(w.clone);
      const id = engine.addTask({ productId, title: "Fix it", startFrom: { kind: "pull-request", value: "https://github.com/someone/other/pull/7" } });
      const state = await planGate(engine, id); const item = itemOf(state, id, "plan")!;
      expect(taskOf(state, id).workError).toContain("someone/other");
      expect(() => engine.approve(item.id)).toThrow("someone/other");
      expect(itemOf(engine.getState(), id, "plan")).toBeDefined();
      expect(taskOf(state, id).worktree).toBeUndefined(); expect(w.github().calls).toHaveLength(0);
      await engine.setTaskStart(id, { productId, startFrom: corrected === "default" ? { kind: "default" } : { kind: "pull-request", value: corrected === "number" ? "7" : `https://github.com/${REPO}/pull/7` }, delivery: "pull-request" });
      const fixed = taskOf(engine.getState(), id);
      expect(fixed.workError).toBeUndefined();
      expect(fixed.worktree).toBeUndefined();
      expect(itemOf(engine.getState(), id, "plan")?.body).not.toContain("someone/other");
      engine.approve(item.id);
      const task = taskOf(await finish(engine, id), id);
      expect(task.error).toBeUndefined(); expect(task.state).toBe("pr-open");
      if (corrected !== "default") expect(task.pr?.number).toBe(7);
    } finally { await engine.shutdown(); }
  });
});

describe.concurrent("one approved product and starting point",()=>{
for (const changed of ["branch", "repository"] as const) it(`requires confirmation when the same PR number has a new working ${changed} on a redone plan`, async () => {
    const { w, start } = await setup(`redo-pr-${changed}`); await pull(w); const engine = start();
    try {
      const productId = await engine.addProduct(w.clone);
      const id = engine.addTask({ productId, title: "A greeting", startFrom: { kind: "pull-request", value: "7" }, approvePlan: true });
      let state = await planGate(engine, id);
      engine.setPoolPaused(true);
      engine.approve(itemOf(state, id, "plan")!.id);
      const approved = structuredClone(executionFor(engine.task(id)!).work.source);
      expect(approved?.confirmed).toBe(true);
      // Reopen a saved plan before preparation, as after a planning interruption.
      await engine.shutdown(); await Promise.all(engine.settling.values());
      w.editSaved((state) => { const task = taskOf(state, id) as DeepMutable<Task>; task.stageIndex = -1; delete task.plan; task.state = "waiting"; });
      w.setGitHub((state) => {
        const pr = state.prs[0]!;
        if (changed === "branch") pr.headRefName = "renamed-work";
        else pr.headRepository = { nameWithOwner: "contributor/demo" };
      });
      const resumed = start();
      try {
        resumed.setPoolPaused(false);
        state = await planGate(resumed, id);
        const task = taskOf(state, id);
        expect(task.error).toBeUndefined();
        expect(task.source).toEqual(approved);
        expect(task.proposedSource?.confirmed).toBe(false);
        expect(task.proposedSource?.destination[changed === "branch" ? "branch" : "repo"]).toBe(changed === "branch" ? "renamed-work" : "contributor/demo");
        expect(task.confirmWork).toBe(true); expect(task.worktree).toBeUndefined();
      } finally { await resumed.shutdown(); }
    } finally { await engine.shutdown(); }
  });
});

describe.concurrent("one approved product and starting point",()=>{
for (const proposed of ["unknown"]) it(`shows a planner ${proposed} proposal in the existing plan check and keeps explicit choices until approval`, async () => {
    const { w, fakes, start } = await setup(`proposal-${proposed}`); await branch(w);
    const engine = start();
    try {
      const productId = await engine.addProduct(w.clone);
      const original: WorkChoice = { productId, startFrom: { kind: "default" }, delivery: "pull-request" };
      const choice: WorkChoice = { productId: proposed === "unknown" ? "Shop API" : productId, startFrom: proposed === "branch" ? { kind: "branch", name: "release-2.x" } : { kind: "default" }, delivery: proposed === "delivery" ? "local" : "pull-request" };
      fakes.scenario({ planner: "short", builder: "plain", worksOn: proposed === "multiple" ? [original, choice] : [choice] });
      const id = engine.addTask({ ...original, title: "Fix it", approvePlan: false });
      const state = await planGate(engine, id); const task = taskOf(state, id);
      expect(task.worktree).toBeUndefined(); expect(task.delivery).toBe("pull-request");
      expect(task.workChoice).toEqual(original);
      const item = itemOf(state, id, "plan")!;
      if (proposed === "unknown" || proposed === "multiple") {
        expect(task.workError).toContain(proposed === "unknown" ? "Needs adding" : "already included");
        expect(() => engine.approve(item.id)).toThrow();
        await engine.setTaskProducts(id, [original]);
      } else expect(task.proposedSource?.destination).toMatchObject({ branch: proposed === "branch" ? "release-2.x" : "main", mode: choice.delivery });
      engine.approve(item.id);
      expect(taskOf(await finish(engine, id), id).error).toBeUndefined();
    } finally { await engine.shutdown(); }
  });
});

describe.concurrent("one approved product and starting point",()=>{
for (const approvePlan of [undefined, false]) it(`requires source confirmation when the planner chooses the product, with optional plan approval ${approvePlan === false ? "off" : "defaulted"}`, async () => {
    const { w, fakes, start } = await setup("choose-product"); const engine = start();
    try {
      const productId = await engine.addProduct(w.clone);
      fakes.scenario({ planner: "short", worksOn: [{ productId, startFrom: { kind: "default" }, delivery: "local" }] });
      const id = engine.addTask({ productId: "", title: "Fix it", approvePlan });
      const state = await planGate(engine, id);
      expect(taskOf(state, id).productId).toBe(""); expect(taskOf(state, id).worktree).toBeUndefined();
      engine.approve(itemOf(state, id, "plan")!.id);
      expect(taskOf(await finish(engine, id), id).state).toBe("done");
    } finally { await engine.shutdown(); }
  });
});

describe.concurrent("one approved product and starting point",()=>{
it("keeps ordinary default tasks able to skip the plan check, without interpreting PR words", async () => {
    const { w, start } = await setup("default"); const engine = start();
    try {
      const productId = await engine.addProduct(w.clone);
      const id = engine.addTask({ productId, title: "Fix PR #999 on release-2.x", delivery: "local", approvePlan: false });
      const task = taskOf(await finish(engine, id), id);
      expect(task.error).toBeUndefined(); expect(task.source?.start).toEqual({ kind: "default", branch: "main" });
      expect(task.timeline.some((entry) => entry.text === "You approved the plan")).toBe(false);
      expect(await remoteRef(w.remote, "refs/heads/main")).toBe(await taskCommit(w, task));
    } finally { await engine.shutdown(); }
  });
});

describe.concurrent("one approved product and starting point",()=>{
it("keeps a default task saved by an older Petrina able to run without a new plan check", async () => {
    const { w, start } = await setup("older-default"); let engine = start();
    try {
      const productId = await engine.addProduct(w.clone);
      engine.setPoolPaused(true);
      const id = engine.addTask({ productId, title: "A greeting", delivery: "local", approvePlan: false });
      await engine.shutdown(); await Promise.all(engine.settling.values());
      w.editSaved((state) => {
        const task = taskOf(state, id) as DeepMutable<Task>;
        delete task.workChoice; delete task.workProduct; delete task.explicitStart;
      });
      engine = start(); engine.setPoolPaused(false);
      const task = taskOf(await finish(engine, id), id);
      expect(task.error).toBeUndefined(); expect(task.state).toBe("done");
      expect(task.source?.start).toEqual({ kind: "default", branch: "main" });
      expect(task.timeline.some((entry) => entry.text === "You approved the plan")).toBe(false);
    } finally { await engine.shutdown(); }
  });
});

describe.concurrent("one approved product and starting point",()=>{
for (const startFrom of [{ kind: "branch", name: "release-2.x" }, { kind: "pull-request", value: "7" }] as const) it(`keeps a release with a ${startFrom.kind} choice stopped for correction`, async () => {
    const { w, start } = await setup(`release-${startFrom.kind}`); const engine = start();
    try {
      const productId = await engine.addProduct(w.clone);
      const id = engine.addTask({ productId, title: "Release", startFrom, delivery: "release" });
      const state = await planGate(engine, id);
      expect(taskOf(state, id).workError).toContain("Releases start from the default branch");
      expect(taskOf(state, id).delivery).toBe("release"); expect(taskOf(state, id).worktree).toBeUndefined();
    } finally { await engine.shutdown(); }
  });
});
