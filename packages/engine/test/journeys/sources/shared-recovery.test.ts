import type { Engine } from "../../engine.js";
import { expectRejection } from "@petrina/test-support/rejections";
import { afterAll, describe, expect, it } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as gitOps from "@petrina/repositories/git";
import { coordinator, finish, git, itemOf, taskOf, until } from "../../support.js";
import { installSharedWorkflowFastPaths, readRef } from "../../fixtures/shared-preparation.js";
import { commitOnCloneBranch } from "../../fixtures/source-world.js";
import { sharedWorldFixtures } from "../../fixtures/shared-world.js";
const fixtures = sharedWorldFixtures();
afterAll(() => fixtures.close());

describe.concurrent("one task across products", () => {
  for (const recovery of ["fresh", "restart"]) it(`delivers to an addition's approved local branch after remote default changes: ${recovery}`, async () => {
    await fixtures.world(`local-default-${recovery}`, async ({ shop, api, engine: withEngine, fakes, remotes, sourceCandidate }) => {
    const next = await withEngine(async engine => {
      installSharedWorkflowFastPaths(engine, { skipDriverPrepare: true, skipPrepareChecks: true, skipReviewCopies: true, skipReviewInputDiffs: true, fastCleanup: true, fastCheckpoints: true });
      await engine.waitUntilReady(); engine.stopRequested.signal.throwIfAborted();
      const first = shop.preparedProduct(engine);
      fakes.scenario({ planner: "short", builder: "plain", reopen: "resume", worksOn: [{ productId: first, startFrom: { kind: "default" }, delivery: "local" }, { productId: "acme/api", repo: "acme/api", startFrom: { kind: "default" }, delivery: "local", reason: "The API also needs the greeting." }] });
      const id = await sourceCandidate(engine, { productId: first, title: "A local greeting in both places" }, { checks: "none" });
      await until(engine, (state) => !!itemOf(state, id, "plan") || !!taskOf(state, id).error, coordinator([]));
      const folder = join(shop.dir, "confirmed-local-api");
      await engine.setTaskAddition(id, "acme/api", "API", folder);
      expect(taskOf(engine.getState(), id).workRows![1]!.source!.product.defaultBranch).toBe("main");
      let trunk: string | undefined;
      if (recovery !== "unchanged") {
        trunk = await commitOnCloneBranch(api.clone, "trunk", "TRUNK_ONLY.md", "Unapproved new default\n", "A distinct new default");
        cpSync(join(api.clone, ".git", "objects"), join(api.remote, "objects"), { recursive: true, force: true });
        mkdirSync(dirname(join(api.remote, "refs", "heads", "trunk")), { recursive: true });
        writeFileSync(join(api.remote, "refs", "heads", "trunk"), `${trunk}\n`);
        writeFileSync(join(api.remote, "HEAD"), "ref: refs/heads/trunk\n");
      }
      if (recovery === "retry" || recovery === "restart") remotes["acme/api"] = join(api.dir, "unavailable.git");
      engine.approve(itemOf(engine.getState(), id, "plan")!.id);

      if (recovery === "retry" || recovery === "restart") {
        await until(engine, (state) => !!taskOf(state, id).error);
        expect(taskOf(engine.getState(), id).workRows![1]!.addition?.created).toBe(true);
        remotes["acme/api"] = api.remote;
        await git(shop.dir, "clone", "-q", api.remote, folder);
        expect(readRef(join(folder, ".git"), "refs/heads/main")).toBeUndefined();
        writeFileSync(join(folder, "keep.txt"), "Preserved completed clone\n");

        if (recovery === "restart") return resume;
        await resume(engine);
        return undefined;
      }
      await finishStep(engine);
      return undefined;
      async function resume(engine: Engine) { engine.retry(itemOf(engine.getState(), id, "stuck")!.id); await finishStep(engine); }
      async function finishStep(engine: Engine) {
      const task = taskOf(await finish(engine, id), id);
      expect(task.error).toBeUndefined();
      expect(task.state).toBe("done");
      const work = task.repositories!.find((entry) => entry.source?.product.repo === "acme/api")!;
      expect(work.source!.initialSha).toBe(api.initial);
      expect(work.source!.product.defaultBranch).toBe("main");
      expect(work.source!.start.branch).toBe("main");
      expect(work.source!.destination.branch).toBe("main");
      expect(work.landed?.branch).toBe("main");
      expect(work.nothingToPublish).not.toBe(true);
      const landed = readRef(join(folder, ".git"), "refs/heads/main")!;
      expect(readRef(join(folder, ".git"), `refs/heads/${work.branch}`)).toBe(landed);
      expect(readRef(api.remote, "refs/heads/main")).toBe(landed);
      expect(await gitOps.fileAt(folder, landed, "greeting.txt")).toContain("Hello");
      expect(await gitOps.fileAt(folder, landed, "TRUNK_ONLY.md")).toBeUndefined();
      if (trunk) {
        expect(readRef(api.remote, "refs/heads/trunk")).toBe(trunk);
        expect(readRef(join(folder, ".git"), "refs/heads/trunk")).toBe(trunk);
        expect(readFileSync(join(folder, ".git", "HEAD"), "utf8").trim()).toBe("ref: refs/heads/trunk");
      }
      if (recovery === "retry" || recovery === "restart") {
        expect(existsSync(join(folder, "keep.txt"))).toBe(true);
        expect(await gitOps.fileAt(folder, "HEAD", "keep.txt")).toBeUndefined();
      }
      expect(api.github().prs).toHaveLength(0);

      }
    });
    if (next) await withEngine(async engine => {
      installSharedWorkflowFastPaths(engine, { skipDriverPrepare: true, skipPrepareChecks: true, skipReviewCopies: true, skipReviewInputDiffs: true, fastCleanup: true, fastCheckpoints: true });
      await next(engine);
    });
    });
  });


  it("retries an interrupted clone in its saved folder and leaves an unrelated occupied folder untouched", async () => {
    await fixtures.world("clone-retry", async ({ shop, api, engine: withEngine, fakes, remotes, sourceCandidate }) => {
    const { id, folder, firstCopy } = await withEngine(async engine => {
      installSharedWorkflowFastPaths(engine, { skipDriverPrepare: true, skipPrepareChecks: true, skipReviewCopies: true, skipReviewInputDiffs: true, fastCleanup: true, fastCheckpoints: true });

      await engine.waitUntilReady(); engine.stopRequested.signal.throwIfAborted();
      const first = shop.preparedProduct(engine);
      fakes.scenario({ planner: "short", builder: "plain", worksOn: [{ productId: first, startFrom: { kind: "default" }, delivery: "pull-request" }, { productId: "acme/api", repo: "acme/api", reason: "Both repositories need the greeting", startFrom: { kind: "default" }, delivery: "pull-request" }] });
      const id = await sourceCandidate(engine, { productId: first, title: "Resume an addition" }, { checks: "none" });
      await until(engine, (state) => !!itemOf(state, id, "plan"), coordinator([]));
      await expectRejection(engine.setTaskAddition(id, "acme/api", "API", shop.clone), "already exists");
      const folder = join(shop.dir, "api-addition");
      await engine.setTaskAddition(id, "acme/api", "API", folder);
      remotes["acme/api"] = join(api.dir, "unavailable.git");
      engine.approve(itemOf(engine.getState(), id, "plan")!.id);
      const failed = await until(engine, (state) => !!taskOf(state, id).error);
      const firstCopy = taskOf(failed, id).repositories![0]!.worktree;
      expect(taskOf(failed, id).repositories![0]!.preparation).toBe("ready");
      expect(taskOf(failed, id).workRows![1]!.addition?.created).toBe(true);
      mkdirSync(join(folder, ".git"), { recursive: true }); writeFileSync(join(folder, ".git", "interrupted"), "unfinished clone");
      remotes["acme/api"] = api.remote;

      return { id, folder, firstCopy };

    });

    await withEngine(async engine => {
      installSharedWorkflowFastPaths(engine, { skipDriverPrepare: true, skipPrepareChecks: true, skipReviewCopies: true, skipReviewInputDiffs: true, fastCleanup: true, fastCheckpoints: true });
      engine.retry(itemOf(engine.getState(), id, "stuck")!.id);
      const done = taskOf(await finish(engine, id), id);
      expect(done.error).toBeUndefined();
      expect(done.repositories![0]!.worktree).toBe(firstCopy);
      expect(readFileSync(join(folder, ".git", "HEAD"), "utf8").trim()).toBe("ref: refs/heads/main");
      expect(readFileSync(join(shop.clone, "README.md"), "utf8")).toContain("Demo");
      expect(api.github().prs).toHaveLength(1);

    });

    });
  });
});
