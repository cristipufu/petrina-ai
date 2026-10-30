import { afterAll, describe, expect, it } from "bun:test";
import * as gitOps from "@petrina/repositories/git";
import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { finish, git, itemOf, remoteRef, taskOf, waitFor } from "../../support.js";
import { readLooseCommit, readRef } from "../../fixtures/shared-preparation.js";
import { sourceWorlds, branch, commitOnCloneBranch, pull, deliveryGate, taskCommit, advance } from "../../fixtures/source-world.js";
const fixtures = sourceWorlds();
afterAll(() => fixtures.close());

describe.concurrent("pull request background and source movement",()=>{
for (const newerLocal of [false, true]) it(`keeps a completed local update separate from a refused push and finishes it once after restart${newerLocal ? ", preserving newer unchecked local work" : ""}`, async () => {
    await fixtures.world("push-retry", async ({ w, engine: withEngine, candidate }) => { await branch(w);
    const reject = join(w.remote, "hooks", "pre-receive"); writeFileSync(reject, "#!/bin/sh\nexit 1\n"); chmodSync(reject, 0o755);

    let { id, state, tested, previous } = await withEngine(async engine => {

      const productId = await w.preparedProduct(engine);
      const id = await candidate(engine, { productId, title: "A greeting", startFrom: { kind: "branch", name: "release-2.x" }, delivery: "local" }, { checks: "none" });
      let state = await finish(engine, id);
      const tested = taskOf(state, id).shipping?.prepared?.tested;
      expect(tested).toBeDefined(); expect(taskOf(state, id).shipping?.localUpdated).toBe(tested);
      expect(taskOf(state, id).landed).toBeUndefined(); expect(taskOf(state, id).error).toContain("could not push it to GitHub");
      expect(taskOf(state, id).localUpdate).toEqual({ branch: "release-2.x", sha: tested!, pushed: false });

      return { id, state, tested, previous: engine };

    }); await Promise.all(previous.settling.values()); rmSync(reject);
      if (newerLocal) {
        await commitOnCloneBranch(w.clone, "release-2.x", "local-later.txt", "Not checked or approved for publishing\n", "Later local work");
      }
      const local = readRef(join(w.clone, ".git"), "refs/heads/release-2.x")!;

    await withEngine(async engine => {
      state = engine.getState(); engine.retry(itemOf(state, id, "stuck")!.id);
      const task = taskOf(await finish(engine, id), id);
      expect(task.error).toBeUndefined(); expect(task.state).toBe("done");
      expect(await remoteRef(w.remote, "refs/heads/release-2.x")).toBe(tested);
      expect(await gitOps.commitsSince(w.clone, w.initial, local)).toBe(newerLocal ? 3 : 2);
      expect(readRef(join(w.clone, ".git"), "refs/heads/release-2.x")).toBe(local);
      if (newerLocal) expect(await gitOps.fileAt(w.clone, tested!, "local-later.txt")).toBeUndefined();
      expect(w.github().prs).toHaveLength(0);

    });
    });
  });
});

describe.concurrent("source failures and delivery recovery",()=>{
for (const named of [true]) it(`carries newer remote commits into a ${named ? "named branch" : "default branch"} commit delivery on Retry after restart`, async () => {
    await fixtures.world(`commit-remote-retry-${named}`, async ({ w, engine: withEngine, candidate }) => {
    const name = named ? "release-2.x" : "main";
    const initial = named ? await branch(w) : w.initial;
    if (!named) await git(w.clone, "switch", "-q", "main");
    const reject = join(w.remote, "hooks", "pre-receive"); writeFileSync(reject, "#!/bin/sh\nexit 1\n"); chmodSync(reject, 0o755);

    let { id, state, oldTested, previous } = await withEngine(async engine => {

      const productId = await w.preparedProduct(engine);
      const id = await candidate(engine, { productId, title: "A greeting", startFrom: named ? { kind: "branch", name } : { kind: "default" }, delivery: "local" });
      let state = await finish(engine, id);
      const oldTested = taskOf(state, id).shipping!.prepared!.tested;
      expect(taskOf(state, id).error).toContain("could not push it to GitHub");
      expect(taskOf(state, id).localUpdate?.pushed).toBe(false);

      return { id, state, oldTested, previous: engine };

    }); await Promise.all(previous.settling.values()); rmSync(reject);
      const moved = await advance(w, w.remote, name);

    await withEngine(async engine => {
      state = engine.getState(); await engine.retry(itemOf(state, id, "stuck")!.id);
      const task = taskOf(await finish(engine, id), id);
      expect(task.error).toBeUndefined(); expect(task.state).toBe("done");
      const tested = await taskCommit(w, task);
      expect(tested).not.toBe(oldTested); expect(task.baseSha).toBe(moved);
      expect(task.source?.initialSha).toBe(initial);
      expect(readLooseCommit(join(w.clone, ".git"), tested)?.parents[0]).toBe(moved);
      expect((await gitOps.fileAt(w.clone, tested, "NEWS.md"))?.trim()).toBe("New source work");
      expect((await gitOps.fileAt(w.clone, tested, "greeting.txt"))?.trim()).toContain("Hello");
      expect(readRef(join(w.clone, ".git"), `refs/heads/${name}`)).toBe(tested);
      expect(await remoteRef(w.remote, `refs/heads/${name}`)).toBe(tested);
      expect(task.localUpdate).toEqual({ branch: name, sha: tested, pushed: true });
      expect(task.checks?.sha).toBe(tested);
      expect(task.timeline.filter((entry) => entry.text === "You approved the delivery")).toHaveLength(1);
      expect(w.github().prs).toHaveLength(0);

    });
    });
  });
});

describe.concurrent("source failures and delivery recovery",()=>{
it("carries remote movement during the commit push through preparation and checks", async () => {
    await fixtures.world("commit-push-movement", async ({ w, engine: withEngine, candidate }) => { const initial = await branch(w);
    const hold = join(w.dir, "hold-push"); const reached = join(w.dir, "push-reached");
    writeFileSync(hold, "");
    const hook = join(w.remote, "hooks", "pre-receive");
    writeFileSync(hook, `#!/bin/sh\nif test ! -f '${reached}'; then\n  touch '${reached}'\n  while test -f '${hold}'; do sleep 0.05; done\n  exit 1\nfi\nexit 0\n`); chmodSync(hook, 0o755);

    await withEngine(async engine => {

    try {
      const productId = await w.preparedProduct(engine);
      const id = await candidate(engine, { productId, title: "A greeting", startFrom: { kind: "branch", name: "release-2.x" }, delivery: "local" });
      const state = await deliveryGate(engine, id);
      engine.approve(itemOf(state, id, "delivery")!.id);
      await waitFor(() => existsSync(reached), "the commit push to reach its remote");
      const moved = await advance(w, w.remote, "release-2.x"); rmSync(hold);
      const task = taskOf(await finish(engine, id), id);
      expect(task.error).toBeUndefined(); expect(task.state).toBe("done");
      const tested = await taskCommit(w, task);
      expect(task.baseSha).toBe(moved); expect(task.source?.initialSha).toBe(initial);
      expect(readLooseCommit(join(w.clone, ".git"), tested)?.parents[0]).toBe(moved);
      expect((await gitOps.fileAt(w.clone, tested, "NEWS.md"))?.trim()).toBe("New source work");
      expect(await remoteRef(w.remote, "refs/heads/release-2.x")).toBe(tested);
      expect(readRef(join(w.clone, ".git"), "refs/heads/release-2.x")).toBe(tested);
      expect(task.checks?.sha).toBe(tested);
      expect(task.timeline.filter((entry) => entry.text === "You approved the delivery")).toHaveLength(1);

    } finally { rmSync(hold, { force: true });  }
    });
    });
  });
});

describe.concurrent("source failures and delivery recovery",()=>{
it("brings in newer local destination commits as well as GitHub commits", async () => {
    await fixtures.world("local-moves", async ({ w, engine: withEngine, candidate }) => { await branch(w);
    await withEngine(async engine => {

      const productId = await w.preparedProduct(engine);
      const id = await candidate(engine, { productId, title: "A greeting", startFrom: { kind: "branch", name: "release-2.x" }, delivery: "local" }, { checks: "none" });
      const state = await deliveryGate(engine, id);
      const local = await commitOnCloneBranch(w.clone, "release-2.x", "local.txt", "Local destination work\n", "Local destination work");
      engine.approve(itemOf(state, id, "delivery")!.id);
      const task = taskOf(await finish(engine, id), id);
      expect(task.error).toBeUndefined();
      const tested = await taskCommit(w, task);
      expect(readLooseCommit(join(w.clone, ".git"), tested)?.parents[0]).toBe(local);
      expect(await remoteRef(w.remote, "refs/heads/release-2.x")).toBe(tested);
      expect((await gitOps.fileAt(w.clone, "release-2.x", "local.txt"))?.trim()).toBe("Local destination work");

    });
    });
  });
});

describe.concurrent("source failures and delivery recovery",()=>{
it("sends a source conflict back through the same builder, checks, review and delivery approval", async () => {
    await fixtures.world("conflict", async ({ w, fakes, engine: withEngine, planned }) => { await pull(w);
    await withEngine(async engine => {

      const productId = await w.preparedProduct(engine);
      const id = await planned(engine, { productId, title: "A greeting", startFrom: { kind: "pull-request", value: "7" } }, "builder");
      const state = await deliveryGate(engine, id);
      await advance(w, w.remote, "review-work", "greeting.txt", "Other greeting\n");
      engine.approve(itemOf(state, id, "delivery")!.id);
      const task = taskOf(await finish(engine, id), id);
      expect(task.error).toBeUndefined(); expect(task.state).toBe("pr-open");
      const builders = fakes.received("builder");
      expect(builders).toHaveLength(2); expect(builders[1]!.session).toBe(builders[0]!.session);
      expect(builders[1]!.text).toContain("review-work moved on");
      expect(task.timeline.filter((entry) => entry.text === "You approved the delivery")).toHaveLength(2);
      expect(task.checks?.results.every((result) => result.ok)).toBe(true);

    });
    });
  });
});
