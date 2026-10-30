import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { completeAll } from "@petrina/core";
import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import * as gitOps from "@petrina/repositories/git";
import { addCopy, ensureWorktree } from "@petrina/repositories/git";
import { git, waitFor } from "../../support.js";
import { Cleanup } from "../../../src/cleanup.js";
import { withRepositoryRecords } from "../../fixtures/shared-records.js";
import { sharedWorldFixtures } from "../../fixtures/shared-world.js";
import * as worldBoundary from "../../support.js";
import { removeFixtureRoot } from "../../fixtures/direct-drivers.js";
import type { CommandResult } from "@petrina/test-support/commands";
import { tempDir, type World } from "../../support.js";
import { rejectionOf } from "@petrina/test-support/rejections";
import { coordinatorLifetimes } from "../../fixtures/coordinator-lifetime.js";
const fixtures = sharedWorldFixtures();
afterAll(() => fixtures.close());

describe.concurrent("one task across products", () => {
  it("keeps cleanup awake until every product copy is removed without starting a system process", async () => {
    await fixtures.world("cleanup-awake", async ({ shop, api, engine: withEngine }) => {
    const paths: string[] = [];
    const activity: { active: boolean; copies: number }[] = [];

    await withEngine(async engine => {

      engine.setPoolPaused(true);
      const first = await shop.preparedProduct(engine), second = await api.preparedProduct(engine);
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
        await addCopy(work.source!.product.path!, copy, (await gitOps.head(work.worktree!))!);
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

    }, { awakeObserver: (active) => activity.push({ active, copies: paths.filter((path) => existsSync(path)).length }) });
    });
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

const actualMakeWorld = worldBoundary.makeWorld;
type SetupMode = { kind: "close" } | { kind: "reject"; error: unknown };

async function observeSharedSetup(family: ReturnType<typeof sharedWorldFixtures>, tag: string, mode: SetupMode,
  acceptCloseFailure: (error: unknown) => void, registerCleanup: (cleanup: () => Promise<void>) => void) {
  const ready = Promise.withResolvers<void>(), held = Promise.withResolvers<void>();
  const nativeWork: Promise<World>[] = [], worlds: World[] = [];
  let root: string | undefined, restore: (() => void) | undefined, peerReturned = false, callbacks = 0;
  let running: Promise<{ error: unknown; peerAtReport: boolean } | { value: unknown; peerAtReport: boolean }> | undefined;
  let closing: Promise<{ error: unknown; peerAtClose: boolean } | { value: undefined; peerAtClose: boolean }> | undefined;
  let probe: Promise<string> | undefined, closeReported = false;
  const close = async () => {
    held.resolve();
    // Join the original producer receipts and every real native call, even if a subject assertion failed.
    const records = await Promise.allSettled([running, closing, ...nativeWork, probe,
      Promise.resolve().then(() => restore?.()),
    ]);
    const native = records.slice(2, 2 + nativeWork.length), restored = records.at(-1)!, probed = records[2 + nativeWork.length]!;
    const failures = [...native, records[2 + nativeWork.length]!, restored].filter(result => result.status === "rejected");
    if (nativeWork.length === 2 && native.every(result => result.status === "fulfilled") && callbacks === 0 && restored.status === "fulfilled" && probed.status === "fulfilled" && root)
      removeFixtureRoot(root);
    if (failures.length) throw new AggregateError(failures.map(result => (result as PromiseRejectedResult).reason), "Shared setup control cleanup was not confirmed");
  };
  // Bun can end a timed-out callback without unwinding it; the file hook still owns this gate and spy.
  registerCleanup(close);
  await setupWithCleanup(async () => {
    const forwarded = spyOn(worldBoundary, "makeWorld");
    restore = () => forwarded.mockRestore();
    forwarded.mockImplementation(async (name, options) => {
      if (name !== `shared-shop-${tag}` && name !== `shared-api-${tag}`) return actualMakeWorld(name, options);
      if (!options?.owner) throw new Error("Shared setup did not supply its required root owner");
      root ??= dirname(options.owner.root);
      const work = Promise.resolve().then(() => actualMakeWorld(name, options));
      nativeWork.push(work);
      let world: World;
      try { world = await work; }
      catch (error) { ready.reject(error); throw error; }
      worlds.push(world);
      if (worlds.length === 2) ready.resolve();
      if (name === `shared-api-${tag}`) { await held.promise; peerReturned = true; }
      if (mode.kind === "reject" && name === `shared-shop-${tag}`) throw mode.error;
      return world;
    });
    running = family.world(tag, async fixture => { callbacks++; await fixture.engine(async () => undefined); }).then(
      value => ({ value, peerAtReport: peerReturned }), error => ({ error, peerAtReport: peerReturned }),
    );
    await ready.promise;
    if (mode.kind === "close") {
      closing = family.close().then(
        () => { closeReported = true; return { value: undefined, peerAtClose: peerReturned }; },
        error => { closeReported = true; return { error, peerAtClose: peerReturned }; },
      );
    }
    const shop = worlds.find(world => world.dir.endsWith("shop"))!;
    // A real command completion is an event boundary, not an arbitrary continuation budget.
    probe = git(shop.clone, "rev-parse", "HEAD");
    expect(await probe).toBe(shop.initial);
    if (mode.kind === "close") expect(closeReported).toBe(false);
    expect(existsSync(root!)).toBe(true);
    expect(callbacks).toBe(0);
    held.resolve();
    const reported = await running;
    expect("error" in reported).toBe(true);
    if (!("error" in reported)) throw new Error("The rejected shared setup handed a fixture to its caller");
    expect(reported.peerAtReport).toBe(true);
    expect(reported.error).toBeInstanceOf(AggregateError);
    expect((reported.error as AggregateError).errors).toHaveLength(2);
    if (mode.kind === "reject") expect((reported.error as AggregateError).errors[0]).toBe(mode.error);
    else expect(((reported.error as AggregateError).errors[0] as Error).message).toContain("ownership is closing");
    closing ??= family.close().then(() => ({ value: undefined, peerAtClose: peerReturned }), error => ({ error, peerAtClose: peerReturned }));
    const stopped = await closing;
    expect("error" in stopped).toBe(true);
    if (!("error" in stopped)) throw new Error("The failed shared setup unexpectedly permitted root disposal");
    acceptCloseFailure(stopped.error);
    expect(stopped.peerAtClose).toBe(true);
    expect(existsSync(root!)).toBe(true);
    expect(callbacks).toBe(0);
    const late = await rejectionOf(family.world(`${tag}-late`, async () => { callbacks++; }));
    expect(late).toBeInstanceOf(Error);
    expect(nativeWork).toHaveLength(2);
  }, close);
  await close();
}

for (const mode of [{ kind: "close" }, { kind: "reject", error: new Error("shared setup rejected") }, { kind: "reject", error: undefined }] as const) {
  describe(`shared setup ownership: ${mode.kind === "close" ? "close while a peer is held" : String(mode.error)}`, () => {
    const family = sharedWorldFixtures();
    let expectedClose: { error: unknown } | undefined;
    let cleanup: (() => Promise<void>) | undefined;
    afterAll(async () => {
      // Request closed admission before independently releasing and joining the controlled setup peer.
      const closing = family.close();
      const settled = await Promise.allSettled([closing, Promise.resolve().then(() => cleanup?.())]);
      const failures = settled.flatMap((result, index) => result.status === "rejected"
        && !(index === 0 && expectedClose && result.reason === expectedClose.error) ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, "Shared setup control could not all be closed");
    });
    it("joins both actual setups before reporting, prevents late handoff and retains uncertain roots", async () => {
      const tag = `ownership-${mode.kind}-${mode.kind === "reject" && mode.error === undefined ? "undefined" : "error"}`;
      await observeSharedSetup(family, tag, mode, error => { expectedClose = { error }; }, close => { cleanup = close; });
    });
  });
}

describe("shared generation manual-operation ownership", () => {
  const family = sharedWorldFixtures();
  const actors = coordinatorLifetimes();
  let controlRoot: string | undefined, command: Promise<CommandResult> | undefined;
  let running: Promise<void> | undefined;
  const close = async () => {
    const failures: unknown[] = [];
    const settled = await Promise.allSettled([actors.close(), family.close(), running]);
    for (const result of settled) if (result.status === "rejected") failures.push(result.reason);
    if (failures.length) throw new AggregateError(failures, "Shared manual native operation cleanup was not confirmed");
    if (controlRoot) { removeFixtureRoot(controlRoot); controlRoot = undefined; }
  };
  afterAll(close);
  it("joins an actual leased command and its output before disposing the world after Engine shutdown", async () => {
    const ready = Promise.withResolvers<void>(), stoppedEngine = Promise.withResolvers<void>();
    let nativeCompleted = false, completedAtClose = false, closeReported = false;
    let parent: string | undefined, shop: Omit<World, "start"> | undefined;
    let lateEngine: import("../../fixtures/shared-world.js").SharedFixture["engine"] | undefined;
    controlRoot = tempDir("petrina-shared-operation-control-");
    await setupWithCleanup(async () => {
      const lifetime = await actors.open(controlRoot!);
      const actor = lifetime.program("owned-command.ts", 'console.log("owned command ready"); for await (const line of console) { if (line === "finish") process.exit(78); }');
      let peer: ReturnType<typeof lifetime.start> | undefined;
      running = family.world("owned-manual-command", async fixture => {
        shop = fixture.shop; parent = dirname(shop.dir); lateEngine = fixture.engine;
        expect("start" in fixture.shop).toBe(false); expect("start" in fixture.api).toBe(false);
        await fixture.engine(async engine => {
          engine.setPoolPaused(true);
          const shutdown = engine.shutdown.bind(engine);
          let restore: (() => void) | undefined;
          try {
            const observed = spyOn(engine, "shutdown");
            restore = () => observed.mockRestore();
            observed.mockImplementation(async () => { await shutdown(); stoppedEngine.resolve(); });
            peer = lifetime.start(controlRoot!, [actor]);
            command = peer.completion;
            void peer.line().then(line => { if (line === "owned command ready") ready.resolve(); else ready.reject(new Error("The owned native command did not report readiness")); }, error => ready.reject(error));
            const result = await command;
            nativeCompleted = true;
            expect(result.code).toBe(78);
          } finally { restore?.(); }
        });
      });
      await waitFor(() => !!shop && !!command, "the owned native operation to start", undefined, { during: running });
      await Promise.race([ready.promise, running.then(() => { throw new Error("The command owner ended before native readiness"); })]);
      const closing = family.close().then(() => { closeReported = true; completedAtClose = nativeCompleted; });
      await Promise.race([stoppedEngine.promise, closing.then(() => { throw new Error("The fixture closed before actual Engine shutdown was observed"); })]);
      expect(await git(shop!.clone, "rev-parse", "HEAD")).toBe(shop!.initial);
      expect(existsSync(parent!)).toBe(true);
      expect(closeReported).toBe(false);
      peer!.write("finish\n");
      await completeAll([running, closing]);
      expect(completedAtClose).toBe(true);
      expect(nativeCompleted).toBe(true);
      expect(existsSync(parent!)).toBe(false);
      let admitted = false;
      expect(await rejectionOf(lateEngine!(async () => { admitted = true; }))).toBeInstanceOf(Error);
      expect(admitted).toBe(false);
    }, close);
    await close();
  });
});
