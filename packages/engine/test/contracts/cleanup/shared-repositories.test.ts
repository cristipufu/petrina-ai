import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { completeAll } from "@petrina/core";
import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as gitOps from "@petrina/repositories/git";
import { addCopy, ensureWorktree } from "@petrina/repositories/git";
import { git, removeDir, waitFor, type World } from "../../support.js";
import { Cleanup } from "../../../src/cleanup.js";
import { withRepositoryRecords } from "../../fixtures/shared-records.js";
import { sharedWorld } from "../../fixtures/shared-world.js";
const worlds: World[] = [];
afterAll(() => worlds.forEach(world => removeDir(world.dir)));
const setup = (name: string) => sharedWorld(name, worlds);

describe.concurrent("one task across products", () => {
  it("keeps cleanup awake until every product copy is removed without starting a system process", async () => {
    const { shop, api, start } = await setup("cleanup-awake");
    const paths: string[] = [];
    const activity: { active: boolean; copies: number }[] = [];
    const engine = start({ awakeObserver: (active) => activity.push({ active, copies: paths.filter((path) => existsSync(path)).length }) });
    try {
      engine.setPoolPaused(true);
      const first = await engine.addProduct(shop.clone), second = await engine.addProduct(api.clone, "API");
      const id = engine.addTask({ productId: first, title: "Saved shared cleanup", backlog: true });
      const task = engine.task(id)!;
      task.repositories = [];
      for (const productId of [first, second]) {
        const product = engine.getState().products.find((entry) => entry.id === productId)!;
        const worktree = join(shop.data, "worktrees", productId, id);
        const branch = `petrina/${id}`;
        await ensureWorktree(product.path!, worktree, branch, "main");
        paths.push(worktree);
        task.repositories.push({ productId, worktree, branch, delivery: "local", completedStages: [], source: { product: { ...product, path: product.path! }, start: { kind: "default", branch: "main" }, destination: { mode: "local", kind: "branch", repo: product.repo, branch: "main" }, confirmed: true } });
      }
      task.activeProductId = first;
      // A crash can remove a review folder before its Git registration is cleaned up.
      for (const work of task.repositories) {
        const copy = join(shop.data, "worktrees", work.productId, `${id}.copies`, "review-0");
        await addCopy(work.source!.product.path!, copy, await git(work.worktree!, "rev-parse", "HEAD"));
        rmSync(copy, { recursive: true });
      }
      task.state = "cancelled";
      task.repositories[0]!.report = { summary: "Saved before cleanup", changes: [], tests: "Not run" };
      engine.commitNow();
      expect(task.repositories[0]!.report?.summary).toBe("Saved before cleanup");
      expect(activity).toEqual([]);
      await engine["cleanup"].removeCopy(id);
      expect(task.repositories.every((work) => work.cleanup?.removedAt !== undefined)).toBe(true);
      expect(paths.some((path) => existsSync(path))).toBe(false);
      expect(activity).toEqual([{ active: true, copies: 2 }, { active: false, copies: 0 }]);
      expect(engine.cleanupJobs.size).toBe(0);
      for (const world of [shop, api]) expect(await git(world.clone, "worktree", "list", "--porcelain")).not.toContain(`${id}.copies`);
    } finally { await engine.shutdown(); }
  });
});

describe("explicit repository execution contexts", () => {
  it("discards saved screen copies through their approved repository roots, including an excluded product", async () => {
    await withRepositoryRecords("screen-owner-roots", {}, async ({ engine, task }) => {
      const owners = task.repositories!;
      const paths = owners.map(work => work.worktree!);
      owners.forEach((work, index) => { work.source = { product: { ...engine.s.products[index]!, path: paths[index]! }, start: { kind: "default", branch: "main" }, destination: { kind: "branch", mode: "local", repo: "acme/demo", branch: "main" }, confirmed: true }; });
      task.excludedRepositories = [owners.pop()!];
      engine.s.products.forEach(product => { product.path = "/a/different/clone"; });
      task.hunt = { stageId: "review", round: 1, reported: {}, findings: 0, screenTurns: { "review-0": {
            copy: "saved", reason: "Check the page", at: 1,
            conversation: { roleId: "code-reviewer", profileId: "sol-high", sessionId: "saved", toolId: "codex", model: "sol", step: "review", startedAt: 1 },
      } } };
      const cleanup = spyOn(gitOps, "removeCopies");
      try {
        cleanup.mockResolvedValue(undefined);

        engine.discardScreenTurns(task);
        await engine.copyCleanups.get(task.id);
        expect(cleanup.mock.calls.map(call => call[0])).toEqual(paths);
        expect(task.hunt!.screenTurns).toBeUndefined();

      } finally { cleanup.mockRestore(); }
    });
  });

  it("waits for every owner's screen-copy cleanup even when one fails", async () => {
    await withRepositoryRecords("concurrent-screen-cleanup", {}, async ({ engine, task, run: ownRun }) => {
      const paths = task.repositories!.map(work => work.worktree!);
      task.hunt = { stageId: "review", round: 1, reported: {}, findings: 0, screenTurns: { "review-0": {
            copy: "saved", reason: "Check the page", at: 1,
            conversation: { roleId: "code-reviewer", profileId: "sol-high", sessionId: "saved", toolId: "codex", model: "sol", step: "review", startedAt: 1 },
      } } };
      const gates = paths.map(() => Promise.withResolvers<void>());
      let pending: Promise<void> | undefined;
      const cleanup = spyOn(gitOps, "removeCopies");
      try {
        cleanup.mockImplementation(async root => gates[paths.indexOf(root)]!.promise);

        const settle = async () => { gates.forEach(gate => gate.resolve()); await pending;
        };
        await setupWithCleanup(async () => {
          pending = ownRun(() => {
            engine.discardScreenTurns(task);
            return engine.copyCleanups.get(task.id)!;
          });
          await waitFor(() => cleanup.mock.calls.length === 2, "both owners to begin cleanup", undefined, { during: pending });
          gates[0]!.reject(new Error("First owner cleanup failed"));
          await Promise.resolve(); await Promise.resolve();
          expect(engine.copyCleanups.get(task.id)).toBe(pending);
          gates[1]!.resolve();
          await pending;
          expect(engine.copyCleanups.has(task.id)).toBe(false);
          expect(task.timeline.some(line => line.text.includes("First owner cleanup failed"))).toBe(true);

        }, settle);
        await settle();
      } finally { cleanup.mockRestore(); }
    });
  });

  it("cleans each included and excluded repository's review copies once using its own clone", async () => {
    await withRepositoryRecords("cleanup-roots", {}, async ({ engine, task, run: ownRun }) => {

      await engine.waitUntilReady(); await completeAll([...engine.backgroundWork]);
      task.state = "cancelled";
      task.excludedRepositories = [{ ...structuredClone(task.repositories![0]!), productId: "excluded" }];
      const works = [...task.repositories!, ...task.excludedRepositories];
      for (const work of works) {
        const product = engine.s.products.find((product) => product.id === work.productId) ?? engine.s.products[0]!;
        work.source = { product: { ...product, id: work.productId }, confirmed: true, start: { kind: "default", branch: "main" }, destination: { mode: "local", repo: product.repo, branch: "main", kind: "branch" } };
        work.worktree = join(engine.dataDir, "worktrees", work.productId, task.id);
      }
      const copies = spyOn(gitOps, "removeFinishedCopies");
      try {
        copies.mockResolvedValue(true);

        const main = spyOn(gitOps, "removeWorktree");
        try {
          main.mockResolvedValue(true);

          await ownRun(() => new Cleanup(engine).removeCopy(task.id));
          expect(copies.mock.calls).toEqual(works.map((work) => [work.source!.product.path!, join(engine.dataDir, "worktrees", work.productId, `${task.id}.copies`), engine.files]));
          expect(main.mock.calls).toEqual(works.map((work) => [work.source!.product.path!, work.worktree!, engine.files]));
          expect(works.every((work) => work.cleanup?.reviewCopiesRemovedAt !== undefined)).toBe(true);
          const times = works.map(work => ({ ...work.cleanup }));
          copies.mockClear(); main.mockClear();
          const commit = spyOn(engine, "commitNow");
          try {
            const archive = spyOn(engine, "saveArchivedTask");
            try {

              await ownRun(() => new Cleanup(engine).removeCopy(task.id, true));
              expect(copies).not.toHaveBeenCalled(); expect(main).not.toHaveBeenCalled();
              expect(commit).not.toHaveBeenCalled(); expect(archive).not.toHaveBeenCalled();
              expect(works.map(work => work.cleanup)).toEqual(times);

            } finally { archive.mockRestore(); }
          } finally { commit.mockRestore(); }
        } finally { main.mockRestore(); }
      } finally { copies.mockRestore(); }
    });
  });

  it("continues shared cleanup after a missing source or failed save, logging each repository failure once", async () => {
    await withRepositoryRecords("cleanup-missing-source", {}, async ({ engine, task }) => {
      await engine.waitUntilReady(); await completeAll([...engine.backgroundWork]);
      task.state = "cancelled";
      const [first, second] = task.repositories!;
      const extra = { ...structuredClone(first!), productId: "excluded" };
      task.excludedRepositories = [extra];
      const works = [first!, second!, extra];
      for (const work of works) work.worktree = join(engine.dataDir, "worktrees", work.productId, task.id);
      delete engine.s.products.find(product => product.id === "second")!.path;
      extra.source = { product: { ...engine.s.products[0]!, id: extra.productId }, confirmed: true, start: { kind: "default", branch: "main" }, destination: { mode: "local", repo: "acme/first", branch: "main", kind: "branch" } };
      const clone = spyOn(gitOps, "mainClone");
      try {
        clone.mockResolvedValue(undefined);

        const copies = spyOn(gitOps, "removeFinishedCopies");
        try {
          copies.mockResolvedValue(true);

          const main = spyOn(gitOps, "removeWorktree");
          try {
            main.mockResolvedValue(true);

            const save = spyOn(engine, "commitNow");
            try {
              save.mockImplementationOnce(() => { throw new Error("Disk full"); });

              const cleanup = new Cleanup(engine);
              await cleanup.removeCopy(task.id, true);
              expect(copies).toHaveBeenCalledTimes(2); expect(main).toHaveBeenCalledTimes(2);
              expect(first!.cleanup?.removedAt).toBeDefined(); expect(extra.cleanup?.removedAt).toBeDefined();
              expect(second!.cleanup?.error).toBe("the product's repository could not be found");
              expect(task.timeline.filter(line => line.tone === "warn" && line.productId === "second")).toHaveLength(1);
              copies.mockClear(); main.mockClear();
              await cleanup.removeCopy(task.id, true);
              expect(copies).not.toHaveBeenCalled(); expect(main).not.toHaveBeenCalled();
              expect(task.timeline.filter(line => line.tone === "warn" && line.productId === "second")).toHaveLength(1);

            } finally { save.mockRestore(); }
          } finally { main.mockRestore(); }
        } finally { copies.mockRestore(); }
      } finally { clone.mockRestore(); }
    });
  });
});
