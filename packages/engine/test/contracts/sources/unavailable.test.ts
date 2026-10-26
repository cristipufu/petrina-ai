import { afterAll, describe, expect, it } from "bun:test";
import { type DeepMutable, type Task } from "@petrina/core";
import { finish, git, remoteRef, taskOf } from "../../support.js";
import { sourceWorlds, branch, pull, planGate, advance } from "../../fixtures/source-world.js";
const fixtures = sourceWorlds();
afterAll(() => fixtures.close());

describe.concurrent("source failures and delivery recovery",()=>{
for (const pr of [false, true]) it(`recovery confirms the tested ${pr ? "PR update" : "branch delivery"} once when newer commits followed it`, async () => {
    await fixtures.world(`evidence-${pr}`, async ({ w, engine: withEngine }) => { const initial = pr ? (await pull(w)).sha : await branch(w);

    let { id, tested, previous } = await withEngine(async engine => {

      const productId = await engine.addProduct(w.clone);
      const id = engine.addTask({ productId, title: "A greeting", startFrom: pr ? { kind: "pull-request", value: "7" } : { kind: "branch", name: "release-2.x" }, delivery: pr ? "pull-request" : "local" });
      const done = taskOf(await finish(engine, id), id); const tested = await git(w.clone, "rev-parse", done.branch!);

      return { id, tested, previous: engine };

    }); await Promise.all(previous.settling.values());
      const name = pr ? "review-work" : "release-2.x";
      const newer = await advance(w, w.remote, name);
      if (!pr) await git(w.clone, "fetch", "-q", w.remote, `refs/heads/${name}:refs/heads/${name}`);
      w.editSaved((state) => {
        const task = taskOf(state, id) as DeepMutable<Task>;
        task.state = "waiting"; delete task.pr; delete task.landed; delete task.finishedAt;
        task.stageIndex = task.plan!.stages.findIndex((stage) => stage.roleId === "release-manager" && stage.kind === "do");
        task.shipping = { start: tested, base: initial, prepared: { tested, summary: "Checked work" }, step: "push", boot: "lost-response", moves: 0, failures: 0, ...(!pr ? { localUpdated: tested } : {}) };
      });

    await withEngine(async engine => {
      const task = taskOf(await finish(engine, id), id);
      expect(task.error).toBeUndefined(); expect(task.state).toBe(pr ? "pr-open" : "done");
      expect(await remoteRef(w.remote, `refs/heads/${name}`)).toBe(newer);
      expect(task.source?.initialSha).toBe(initial); expect(task.shipping).toBeUndefined();
      expect(w.github().prs).toHaveLength(pr ? 1 : 0);
      // A finished local delivery removes its working copy. The task branch still names the tested commit.
      expect(await git(w.clone, "rev-parse", task.branch!)).toBe(tested);

    });
    });
  });
});

describe.concurrent("review findings for a confirmed start",()=>{
it("explains a missing branch instead of a failed pull request refresh", async () => {
    await fixtures.world("missing-branch", async ({ w, engine: withEngine }) => {

    await withEngine(async engine => {

      const productId = await engine.addProduct(w.clone);
      const id = engine.addTask({ productId, title: "A greeting", startFrom: { kind: "branch", name: "release-2.x" }, approvePlan: true });
      const state = await planGate(engine, id);
      const task = taskOf(state, id);
      expect(task.worktree).toBeUndefined();
      expect(task.workError).toContain("release-2.x");
      expect(task.workError).toContain("unavailable");
      expect(task.workError).toContain("Correct the choice");
      expect(task.workError).not.toContain("pull request background");

    });
    });
  });
});
