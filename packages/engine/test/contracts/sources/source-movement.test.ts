import { executionFor } from "@petrina/orchestrator";
import * as gitOps from "@petrina/repositories/git";
import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type DeepMutable } from "@petrina/core";
import { coordinator, finish, git, itemOf, REPO, remoteRef, taskOf, until } from "../../support.js";
import { readLooseCommit, readRef, readWorktreeCommit } from "../../fixtures/shared-preparation.js";
import { sourceWorlds, branch, commitOnCloneBranch, pull, planGate, deliveryGate, taskCommit, advance } from "../../fixtures/source-world.js";
const fixtures = sourceWorlds();
afterAll(() => fixtures.close());

describe.concurrent("pull request background and source movement",()=>{
for (const pr of [true]) it(`brings in a moving ${pr ? "PR working branch" : "named branch"} after delivery approval, retaining its initial commit separately`, async () => {
    await fixtures.world(`moves-${pr}`, async ({ w, engine: withEngine, candidate }) => {
    const source = pr ? (await pull(w)).sha : await branch(w);

    await withEngine(async engine => {

      const productId = await w.preparedProduct(engine);
      const id = await candidate(engine, { productId, title: "A greeting", startFrom: pr ? { kind: "pull-request", value: "7" } : { kind: "branch", name: "release-2.x" }, delivery: "pull-request" }, { checks: "none" });
      const state = await deliveryGate(engine, id);
      const moved = await advance(w, w.remote, pr ? "review-work" : "release-2.x");
      engine.approve(itemOf(state, id, "delivery")!.id);
      const task = taskOf(await finish(engine, id), id);
      expect(task.error).toBeUndefined(); expect(task.source?.initialSha).toBe(source); expect(task.baseSha).toBe(moved);
      expect(readWorktreeCommit(task.worktree!)?.parents[0]).toBe(moved);
      expect(readFileSync(join(task.worktree!, "NEWS.md"), "utf8").trim()).toBe("New source work");
      expect(task.timeline.filter((entry) => entry.text === "You approved the delivery")).toHaveLength(1);

    });
    });
  });
});

describe.concurrent("pull request background and source movement",()=>{
it("creates a missing local destination without disturbing uncommitted work on another branch", async () => {
    await fixtures.world("missing-local", async ({ w, engine: withEngine, candidate }) => { await branch(w); rmSync(join(w.clone, ".git", "refs", "heads", "release-2.x"), { force: true });
    writeFileSync(join(w.clone, "README.md"), "My uncommitted work\n");

    await withEngine(async engine => {

      const productId = await w.preparedProduct(engine);
      const id = await candidate(engine, { productId, title: "A greeting", startFrom: { kind: "branch", name: "release-2.x" }, delivery: "local" }, { checks: "none" });
      const task = taskOf(await finish(engine, id), id);
      expect(task.error).toBeUndefined(); expect(task.state).toBe("done");
      expect(readRef(join(w.clone, ".git"), "refs/heads/release-2.x")).toBe((await remoteRef(w.remote, "refs/heads/release-2.x"))!);
      expect(readFileSync(join(w.clone, "README.md"), "utf8")).toBe("My uncommitted work\n");
      expect(readFileSync(join(w.clone, ".git", "HEAD"), "utf8").trim()).toBe("ref: refs/heads/main");

    });
    });
  });
});

describe.concurrent("source failures and delivery recovery",()=>{
it("preserves newer local work when an unpushed delivery and GitHub both moved before Retry", async () => {
    await fixtures.world("commit-retry-local-and-remote", async ({ w, engine: withEngine, candidate }) => { await branch(w);
    const reject = join(w.remote, "hooks", "pre-receive"); writeFileSync(reject, "#!/bin/sh\nexit 1\n"); chmodSync(reject, 0o755);

    await withEngine(async engine => {

      const productId = await w.preparedProduct(engine);
      const id = await candidate(engine, { productId, title: "A greeting", startFrom: { kind: "branch", name: "release-2.x" }, delivery: "local" }, { checks: "none" });
      let state = await finish(engine, id);
      const original = taskOf(state, id).shipping!.prepared!.tested;
      rmSync(reject);
      const remote = await advance(w, w.remote, "release-2.x");
      const local = await commitOnCloneBranch(w.clone, "release-2.x", "local-later.txt", "My newer work\n", "Newer local work");
      await engine.retry(itemOf(state, id, "stuck")!.id);
      const task = taskOf(await finish(engine, id), id);
      expect(task.error).toContain("divergent history");
      expect(task.landed).toBeUndefined(); expect(task.localUpdate?.pushed).toBe(false);
      expect(readRef(join(w.clone, ".git"), "refs/heads/release-2.x")).toBe(local);
      expect(await remoteRef(w.remote, "refs/heads/release-2.x")).toBe(remote);
      expect(readWorktreeCommit(task.worktree!)?.commit).toBe(original);
      expect((await gitOps.fileAt(w.clone, "release-2.x", "local-later.txt"))?.trim()).toBe("My newer work");

    });
    });
  });
});

describe.concurrent("source failures and delivery recovery",()=>{
for (const problem of ["deleted branch", "uncommitted work"] as const) it(`preserves an unpushed delivery on Retry with ${problem}`, async () => {
    await fixtures.world(`commit-retry-${problem.replaceAll(" ", "-")}`, async ({ w, engine: withEngine, candidate }) => { await branch(w);
    const reject = join(w.remote, "hooks", "pre-receive"); writeFileSync(reject, "#!/bin/sh\nexit 1\n"); chmodSync(reject, 0o755);

    await withEngine(async engine => {

      const productId = await w.preparedProduct(engine);
      const id = await candidate(engine, { productId, title: "A greeting", startFrom: { kind: "branch", name: "release-2.x" }, delivery: "local" }, { checks: "none" });
      const state = await finish(engine, id);
      const tested = taskOf(state, id).shipping!.prepared!.tested;
      rmSync(reject);
      if (problem === "deleted branch") rmSync(join(w.remote, "refs", "heads", "release-2.x"), { force: true });
      else {
        await advance(w, w.remote, "release-2.x");
        writeFileSync(join(w.clone, ".git", "HEAD"), "ref: refs/heads/release-2.x\n");
        await gitOps.discardChanges(w.clone);
        writeFileSync(join(w.clone, "README.md"), "My uncommitted work\n");
      }
      const remote = await remoteRef(w.remote, "refs/heads/release-2.x");
      await engine.retry(itemOf(state, id, "stuck")!.id);
      const task = taskOf(await finish(engine, id), id);
      expect(task.error).toContain(problem === "deleted branch" ? "no longer available" : "files in the main copy");
      expect(task.landed).toBeUndefined(); expect(task.localUpdate?.pushed).toBe(false);
      expect(readRef(join(w.clone, ".git"), "refs/heads/release-2.x")).toBe(tested);
      expect(await remoteRef(w.remote, "refs/heads/release-2.x")).toBe(remote);
      expect(readWorktreeCommit(task.worktree!)?.commit).toBe(tested);
      if (problem === "uncommitted work") expect(readFileSync(join(w.clone, "README.md"), "utf8")).toBe("My uncommitted work\n");

    });
    });
  });
});

describe.concurrent("source failures and delivery recovery",()=>{
it("refreshes background before resuming the builder's interrupted conversation", async () => {
    await fixtures.world("resume", async ({ w, fakes, engine: withEngine, planned }) => { await pull(w);

    let { id, first, readAt, previous } = await withEngine(async engine => {

      const productId = await w.preparedProduct(engine);
      const id = await planned(engine, { productId, title: "A greeting", startFrom: { kind: "pull-request", value: "7" } }, "builder");
      await until(engine, (state) => fakes.marked("builder-working") && !!taskOf(state, id).conversation?.briefed && taskOf(state, id).timeline.some((entry) => entry.text === "Drafting the greeting"));
      const first = fakes.received("builder")[0]!;
      const readAt = taskOf(engine.getState(), id).prBackground!.readAt;

      return { id, first, readAt, previous: engine };

    }); await Promise.all(previous.settling.values());
      w.setGitHub((github) => { github.pages = { "issues/7/comments?per_page=100": [[{ body: "Fresh after restarting" }]] }; });

    await withEngine(async engine => {
      const task = taskOf(await finish(engine, id), id);
      expect(task.error).toBeUndefined();
      const resumed = fakes.received("builder")[1]!;
      expect(resumed.session).toBe(first.session);
      expect(resumed.text).toContain("Petrina restarted");
      expect(resumed.text).toContain("Fresh after restarting");
      expect(task.prBackground!.readAt).toBeGreaterThan(readAt);

    });
    }, { builder: "work" });
  });
});

describe.concurrent("source failures and delivery recovery",()=>{
for (const kind of ["branch", "pull-request"] as const) it(`an unavailable ${kind} fetch fails without falling back to a local copy`, async () => {
    await fixtures.world(`fetch-fails-${kind}`, async ({ w, engine: withEngine }) => {
    if (kind === "branch") await branch(w); else await pull(w);

    await withEngine(async engine => {

      const productId = await w.preparedProduct(engine);
      const id = engine.addTask({ productId, title: "A greeting", startFrom: kind === "branch" ? { kind, name: "release-2.x" } : { kind, value: "7" }, approvePlan: true });
      const state = await planGate(engine, id);
      const ref = kind === "branch" ? "refs/heads/release-2.x" : "refs/pull/7/head";
      rmSync(join(w.remote, ...ref.split("/")), { force: true });
      if (kind === "pull-request") rmSync(join(w.remote, "refs", "heads", "review-work"), { force: true });
      engine.approve(itemOf(state, id, "plan")!.id);
      const task = taskOf(await finish(engine, id), id);
      expect(task.state).toBe("failed"); expect(task.error).toContain("Could not fetch the approved starting point");
      expect(task.worktree).toBeUndefined(); expect(task.source?.start.kind).toBe(kind);
      expect(itemOf(engine.getState(), id, "stuck")).toBeDefined();

    });
    });
  });
});

describe.concurrent("source failures and delivery recovery",()=>{
it("task identity and destination survive changed product defaults and an agent-edited remote", async () => {
    await fixtures.world("pinning", async ({ w, engine: withEngine, candidate }) => { await branch(w);
    await withEngine(async engine => {

      const productId = await w.preparedProduct(engine);
      const id = await candidate(engine, { productId, title: "A greeting", startFrom: { kind: "branch", name: "release-2.x" }, delivery: "local" }, { checks: "none" });
      const state = await deliveryGate(engine, id);
      const product = state.products.find((entry) => entry.id === productId)! as DeepMutable<(typeof state.products)[number]>;
      product.defaultBranch = "elsewhere"; product.remote = "https://github.com/other/product.git";
      await git(w.clone, "remote", "set-url", "origin", "https://github.com/other/product.git");
      engine.approve(itemOf(state, id, "delivery")!.id);
      const task = taskOf(await finish(engine, id), id);
      expect(task.error).toBeUndefined(); expect(task.source?.destination).toMatchObject({ repo: REPO, branch: "release-2.x", remote: "https://github.com/acme/demo.git" });
      expect(await remoteRef(w.remote, "refs/heads/release-2.x")).toBe(await taskCommit(w, task));

    });
    });
  });
});



describe.concurrent("review findings for a confirmed start",()=>{
it("stops when replaced source history drops a commit already brought in", async () => {
    await fixtures.world("replaced-history", async ({ w, engine: withEngine, candidate }) => {
    const initial = await branch(w);

    await withEngine(async engine => {

      const productId = await w.preparedProduct(engine);
      const id = await candidate(engine, { productId, title: "A greeting", description: "[quick]", startFrom: { kind: "branch", name: "release-2.x" }, delivery: "local" }, { checks: "none" });
      const state = await deliveryGate(engine, id);
      const worktree = executionFor(engine.task(id)!).work.worktree!;
      expect(executionFor(engine.task(id)!).work.baseSha).toBe(initial);
      const moved = await advance(w, w.remote, "release-2.x", "KEPT.md", "Kept source work\n");
      await git(w.clone, "fetch", "-q", w.remote, "refs/heads/release-2.x:refs/petrina/kept-source");
      await git(worktree, "-c", "core.editor=true", "rebase", "--onto", moved, initial);
      executionFor(engine.task(id)!).work.baseSha = moved;
      const copy = join(w.dir, "rewrite");
      await git(w.dir, "clone", "-q", w.remote, copy);
      await git(copy, "config", "user.name", "Someone else");
      await git(copy, "config", "user.email", "other@example.com");
      await git(copy, "checkout", "-q", "-B", "replacement", initial);
      writeFileSync(join(copy, "OTHER.md"), "Removed on purpose\n");
      await git(copy, "add", ".");
      await git(copy, "commit", "-qm", "Replacement history");
      const replacement = readWorktreeCommit(copy)!.commit;
      await git(copy, "push", "-q", "--force", w.remote, "HEAD:release-2.x");
      engine.approve(itemOf(state, id, "delivery")!.id);
      const task = taskOf(await finish(engine, id), id);
      expect(task.state).toBe("failed");
      expect(task.error).toContain("history was replaced");
      expect(readWorktreeCommit(worktree)?.parents[0]).toBe(moved);
      expect(readFileSync(join(worktree, "KEPT.md"), "utf8").trim()).toBe("Kept source work");
      expect(readFileSync(join(worktree, "greeting.txt"), "utf8")).toContain("Hello");
      expect(await gitOps.fileAt(worktree, "HEAD", "OTHER.md")).toBeUndefined();
      expect(await remoteRef(w.remote, "refs/heads/release-2.x")).toBe(replacement);
      expect(await remoteRef(w.remote, "refs/heads/release-2.x")).not.toBe(readWorktreeCommit(worktree)?.commit);

    });
    });
  });
});

describe.concurrent("review findings for a confirmed start",()=>{
it("publishes after a later refresh once a newer local commit was brought in", async () => {
    await fixtures.world("local-refresh", async ({ w, engine: withEngine, planned }) => {
    await branch(w);

    await withEngine(async engine => {
    let added = false;
    let local = "";

      const productId = await w.preparedProduct(engine);
      const id = await planned(engine, { productId, title: "A greeting", description: "[quick]", startFrom: { kind: "branch", name: "release-2.x" }, delivery: "local" }, "builder");
      const state = await until(engine, (s) => !!itemOf(s, id, "delivery") || taskOf(s, id).state === "failed", async (eng, s) => {
        const task = taskOf(s, id);
        if (!added && task.agent?.roleId === "builder" && s.inbox.some((item) => item.taskId === id && item.kind === "permission")) {
          added = true;
          local = await commitOnCloneBranch(w.clone, "release-2.x", "local.txt", "Newer local work\n", "Newer local work");
          // The snapshot predates the local work: answer from what the engine shows now.
          s = eng.getState();
        }
        coordinator(["plan", "design"])(eng, s);
      });
      expect(added).toBe(true);
      const atCheck = taskOf(state, id);
      expect(atCheck.state).not.toBe("failed");
      expect(atCheck.error).toBeUndefined();
      expect(atCheck.baseSha).toBe(local);
      expect(itemOf(state, id, "delivery")).toBeDefined();
      engine.approve(itemOf(state, id, "delivery")!.id);
      const task = taskOf(await finish(engine, id), id);
      expect(task.error).toBeUndefined();
      expect(task.state).toBe("done");
      const tested = await taskCommit(w, task);
      expect(readLooseCommit(join(w.clone, ".git"), tested)?.parents[0]).toBe(local);
      expect(await remoteRef(w.remote, "refs/heads/release-2.x")).toBe(tested);
      expect((await gitOps.fileAt(w.clone, "release-2.x", "local.txt"))?.trim()).toBe("Newer local work");
      expect(w.github().prs).toHaveLength(0);

    });
    }, { builder: undefined });
  });
});

describe.concurrent("review findings for a confirmed start",()=>{
it("publishes a commit onto a branch that was already ahead on this computer", async () => {
    await fixtures.world("local-already-ahead", async ({ w, engine: withEngine, candidate }) => {
    const initial = await branch(w);
    const local = await commitOnCloneBranch(w.clone, "release-2.x", "local-ahead.txt", "Already on this computer\n", "Already on this computer");

    await withEngine(async engine => {

      const productId = await w.preparedProduct(engine);
      const id = await candidate(engine, { productId, title: "A greeting", description: "[quick]", startFrom: { kind: "branch", name: "release-2.x" }, delivery: "local" }, { checks: "none" });
      const state = await deliveryGate(engine, id);
      const atCheck = taskOf(state, id);
      expect(atCheck.state).not.toBe("failed");
      expect(atCheck.error).toBeUndefined();
      expect(atCheck.baseSha).toBe(local);
      expect(itemOf(state, id, "delivery")).toBeDefined();
      engine.approve(itemOf(state, id, "delivery")!.id);
      const task = taskOf(await finish(engine, id), id);
      expect(task.error).toBeUndefined();
      expect(task.state).toBe("done");
      const tested = await taskCommit(w, task);
      expect(readLooseCommit(join(w.clone, ".git"), tested)?.parents[0]).toBe(local);
      expect(readLooseCommit(join(w.clone, ".git"), local)?.parents[0]).toBe(initial);
      expect(await remoteRef(w.remote, "refs/heads/release-2.x")).toBe(tested);
      expect((await gitOps.fileAt(w.clone, "release-2.x", "local-ahead.txt"))?.trim()).toBe("Already on this computer");
      expect(w.github().prs).toHaveLength(0);

    });
    });
  });
});
