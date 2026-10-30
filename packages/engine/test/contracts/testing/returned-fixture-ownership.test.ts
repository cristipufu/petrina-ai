import { expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createTaskState, type Product } from "@petrina/core";
import type { RuntimeTask } from "@petrina/orchestrator";
import { rejectionOf } from "@petrina/test-support/rejections";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import * as gitSteps from "@petrina/repositories/git";
import { changesOf, versionsOf } from "../../../src/repositories.js";
import { proofRequestFixtures } from "../../fixtures/proof-requests.js";
import { requiredGapFixtures } from "../../fixtures/required-gaps.js";
import { directDrivers, removeFixtureRoot } from "../../fixtures/direct-drivers.js";
import { makeProduct, tempDir, waitFor } from "../../fixtures.js";

function containsFailure(value: unknown, failure: unknown): boolean {
  return value === failure || value instanceof AggregateError && value.errors.some(error => containsFailure(error, failure));
}

for (const helper of ["advance", "request", "recordPass"] as const) it(`owns returned ${helper} work before close${helper === "advance" ? ", bound to its current generation after restart" : ""}`, async () => {
  const f = await proofRequestFixtures().fixture();
  const release = Promise.withResolvers<void>();
  let held = false, closed = false, nativeCompleted = false, helperCompleted = false;
  let nativeCompletedAtClose: boolean | undefined, helperCompletedAtClose: boolean | undefined;
  let running: Promise<unknown> | undefined, closing: Promise<void> | undefined;
  let restore = () => {};
  try {
    // Real callers replace the returned Engine. Ownership must not remain on its stopped predecessor.
    if (helper === "advance") {
      await f.stop(f.engine);
      f.engine = f.open(f.engine.dataDir, { agentCommand: () => undefined, terminals: () => [] });
      f.engine.schedule = () => {};
      await f.run(f.engine, () => f.engine.waitUntilReady());
    }
    if (helper === "advance") {
      const original = gitSteps.commitChanges;
      const spy = spyOn(gitSteps, "commitChanges");
      restore = () => spy.mockRestore();
      spy.mockImplementation((path, message) => {
        if (path !== f.products[0]!.path || held) return original(path, message);
        held = true;
        return release.promise.then(async () => { const value = await original(path, message); nativeCompleted = true; return value; });
      });
    } else {
      const original = gitSteps.treeOf;
      const spy = spyOn(gitSteps, "treeOf");
      restore = () => spy.mockRestore();
      spy.mockImplementation((path, ref) => {
        if (path !== f.scope.work.worktree || held) return original(path, ref);
        held = true;
        return release.promise.then(async () => { const value = await original(path, ref); nativeCompleted = true; return value; });
      });
    }
    running = f[helper]();
    void running.then(() => { helperCompleted = true; }, () => {});
    await waitFor(() => held, `the actual returned ${helper} observation`, undefined, { during: running });
    closing = f.close();
    const observeClose = () => { closed = true; nativeCompletedAtClose = nativeCompleted; helperCompletedAtClose = helperCompleted; };
    void closing.then(observeClose, observeClose);
    await f.engine.shutdown();
    expect(closed).toBe(false); expect(existsSync(f.root)).toBe(true);
    release.resolve(); await running;
    expect(nativeCompleted).toBe(true);
    await closing;
    expect(nativeCompletedAtClose).toBe(true); expect(helperCompletedAtClose).toBe(true);
    expect(existsSync(f.root)).toBe(false);
  } finally {
    release.resolve(); restore();
    const settled = await Promise.allSettled([running, closing, f.close()]);
    const failed = settled.filter(result => result.status === "rejected");
    if (failed.length) throw new AggregateError(failed.map(result => result.reason), "Returned operation or cleanup failed; root retained");
  }
});

for (const failure of [new Error("Controlled first main read failed"), undefined]) it(`settles every actual mains peer and retains its exact rejected result (${failure === undefined ? "undefined" : "Error"})`, async () => {
  const f = await requiredGapFixtures("Ownership control").fixture({ shared: true });
  const release = Promise.withResolvers<void>(), peerReady = Promise.withResolvers<void>();
  const original = gitSteps.revParse;
  let peer: Promise<string | undefined> | undefined, closed = false, peerCompleted = false, restore = () => {};
  let peerCompletedAtReport: boolean | undefined;
  let running: Promise<string[]> | undefined, closing: Promise<void> | undefined;
  try {
    const spy = spyOn(gitSteps, "revParse");
    restore = () => spy.mockRestore();
    spy.mockImplementation((path, ref) => {
      if (ref !== "main") return original(path, ref);
      if (path === f.products[0]!.path) return peerReady.promise.then(() => { throw failure; });
      if (path !== f.products[1]!.path) return original(path, ref);
      peer = release.promise.then(async () => { const value = await original(path, ref); peerCompleted = true; return value; });
      peerReady.resolve();
      return peer;
    });
    running = f.mains();
    const observeReport = () => { peerCompletedAtReport = peerCompleted; };
    void running.then(observeReport, observeReport);
    await waitFor(() => peer !== undefined, "the independently held main read", undefined, { during: running });
    closing = f.close();
    void closing.then(() => { closed = true; }, () => { closed = true; });
    await f.engine.shutdown();
    expect(closed).toBe(false); expect(existsSync(f.root)).toBe(true);
    release.resolve();
    expect(await rejectionOf(running)).toBe(failure);
    expect(await peer).toMatch(/^[a-f0-9]{40,64}$/);
    expect(peerCompletedAtReport).toBe(true);
    const error = await rejectionOf(closing);
    expect(error).toBeInstanceOf(AggregateError); expect(containsFailure(error, failure)).toBe(true);
    // Strict retention preserves this controlled rejection; the successful peer is confirmed separately.
    expect(existsSync(f.root)).toBe(true);
  } finally {
    release.resolve(); peerReady.resolve(); restore();
    const settled = await Promise.allSettled([running, peer, f.engine.shutdown(), f.close()]);
    if (!running || !peer || settled[0]!.status !== "rejected" || settled[0]!.reason !== failure
      || settled[1]!.status !== "fulfilled" || settled[2]!.status !== "fulfilled"
      || settled[3]!.status !== "rejected" || !containsFailure(settled[3]!.reason, failure))
      throw new AggregateError(settled.filter(result => result.status === "rejected").map(result => result.reason), "Expected-error peer control could not confirm native completion; root retained");
    // The actual canonical Git result and actual Engine shutdown now prove no control remains live.
    removeFixtureRoot(f.root);
  }
});

it("owns restart across its old-generation stop and keeps a refused replacement's failure through close", async () => {
  const f = await requiredGapFixtures("Ownership control").fixture();
  const previous = f.engine, release = Promise.withResolvers<void>(), original = previous.shutdown.bind(previous);
  let held = false, restore = () => {};
  let actualShutdown: Promise<void> | undefined;
  let restarting: Promise<void> | undefined, closing: Promise<void> | undefined, refused: unknown;
  try {
    const spy = spyOn(previous, "shutdown");
    restore = () => spy.mockRestore();
    spy.mockImplementation(() => {
      actualShutdown ??= original();
      return actualShutdown.then(() => { held = true; return release.promise; });
    });
    restarting = f.restart();
    await waitFor(() => held, "the actual old-generation shutdown", undefined, { during: restarting });
    closing = f.close();
    expect(existsSync(f.root)).toBe(true);
    release.resolve(); refused = await rejectionOf(restarting);
    expect(refused).toBeInstanceOf(Error); expect((refused as Error).message).toContain("closing; no Engine may open");
    const error = await rejectionOf(closing);
    expect(error).toBeInstanceOf(AggregateError); expect(containsFailure(error, refused)).toBe(true);
    expect(f.engine).toBe(previous); expect(existsSync(f.root)).toBe(true);
  } finally {
    release.resolve(); restore();
    const settled = await Promise.allSettled([restarting, actualShutdown ?? original(), f.close()]);
    if (!restarting || settled[0]!.status !== "rejected" || !(settled[0]!.reason instanceof Error)
      || !settled[0]!.reason.message.includes("closing; no Engine may open") || settled[1]!.status !== "fulfilled"
      || settled[2]!.status !== "rejected" || !containsFailure(settled[2]!.reason, settled[0]!.reason))
      throw new AggregateError(settled.filter(result => result.status === "rejected").map(result => result.reason), "Restart control could not confirm native shutdown; root retained");
    removeFixtureRoot(f.root);
  }
});

/** Real repositories only: these two production projections do not need an Engine, agents or SQLite. */
async function queryFixture() {
  const root = tempDir("petrina-query-peers-"), owner = directDrivers(root);
  return setupWithCleanup(() => owner.prepare(async () => {
    const products: Product[] = [], repositories: NonNullable<RuntimeTask["repositories"]> = [], trees: Record<string, string> = {};
    for (const id of ["second", "first"]) {
      const folder = join(root, id); mkdirSync(folder);
      const path = await makeProduct(folder), version = await gitSteps.commitVersion(path);
      if (!version.head || !version.tree) throw new Error("Private query fixture needs an observed commit and tree");
      trees[id] = version.tree;
      products.push({ id, name: id, repo: `local/${id}`, tone: "blue", path });
      repositories.push({ productId: id, delivery: "local", worktree: path, baseSha: version.head, completedStages: [] });
    }
    const task: RuntimeTask = createTaskState({ productId: "second", title: "Observe private versions", backlog: true }, products, { id: "query-task", timelineId: "created", now: 1, priority: 0 });
    delete task.repository; task.repositories = repositories;
    return { root, owner, task, trees };
  }), owner.close);
}

for (const [kind, failure] of [["versions", undefined], ["changes", new Error("Controlled change observation failed")]] as const) it(`settles all ${kind} observations before preserving a peer's exact rejection`, async () => {
  const f = await queryFixture(), release = Promise.withResolvers<void>(), peerReady = Promise.withResolvers<void>();
  let peer: Promise<string | undefined> | undefined;
  let peerCompleted = false, peerCompletedAtReport: boolean | undefined;
  let restore = () => {};
  let running: Promise<Record<string, string>> | undefined;
  try {
    // Real positive observations preserve membership order and the existing unavailable defaults.
    expect(await f.owner.prepare(() => versionsOf(f.task))).toEqual(f.trees);
    const currentChanges = await f.owner.prepare(() => changesOf(f.task));
    expect(Object.keys(currentChanges)).toEqual(["second", "first"]);
    expect(currentChanges).toEqual({ second: "empty", first: "empty" });
    const last = f.task.repositories![1]!, saved = last.worktree;
    last.worktree = undefined;
    expect(await f.owner.prepare(() => versionsOf(f.task))).toEqual({ second: f.trees.second!, first: "unavailable" });
    expect(await f.owner.prepare(() => changesOf(f.task))).toEqual({ second: "empty", first: "unavailable" });
    last.worktree = saved;
    const first = f.task.repositories![0]!.worktree!, second = last.worktree!;
    if (kind === "versions") {
      const original = gitSteps.treeOf;
      const spy = spyOn(gitSteps, "treeOf");
      restore = () => spy.mockRestore();
      spy.mockImplementation((path, ref) => {
        if (path === first) return peerReady.promise.then(() => { throw failure; });
        if (path !== second) return original(path, ref);
        peer = release.promise.then(async () => { const value = await original(path, ref); peerCompleted = true; return value; }); peerReady.resolve(); return peer;
      });
    } else {
      const original = gitSteps.patchId;
      const spy = spyOn(gitSteps, "patchId");
      restore = () => spy.mockRestore();
      spy.mockImplementation((path, from, to) => {
        if (path === first) return peerReady.promise.then(() => { throw failure; });
        if (path !== second) return original(path, from, to);
        peer = release.promise.then(async () => { const value = await original(path, from, to); peerCompleted = true; return value; }); peerReady.resolve(); return peer;
      });
    }
    running = f.owner.prepare(() => kind === "versions" ? versionsOf(f.task) : changesOf(f.task));
    const observeReport = () => { peerCompletedAtReport = peerCompleted; };
    void running.then(observeReport, observeReport);
    await waitFor(() => peer !== undefined, `the independent native ${kind} peer`, undefined, { during: running });
    release.resolve(); expect(await rejectionOf(running)).toBe(failure);
    if (kind === "versions") expect(await peer).toMatch(/^[a-f0-9]{40,64}$/);
    else expect(await peer).toBe("empty");
    expect(peerCompletedAtReport).toBe(true);
    const error = await rejectionOf(f.owner.close());
    expect(error).toBeInstanceOf(AggregateError); expect(containsFailure(error, failure)).toBe(true);
    expect(existsSync(f.root)).toBe(true);
  } finally {
    release.resolve(); peerReady.resolve(); restore();
    const settled = await Promise.allSettled([running, peer, f.owner.close()]);
    if (!running || !peer || settled[0]!.status !== "rejected" || settled[0]!.reason !== failure
      || settled[1]!.status !== "fulfilled" || settled[2]!.status !== "rejected" || !containsFailure(settled[2]!.reason, failure))
      throw new AggregateError(settled.filter(result => result.status === "rejected").map(result => result.reason), "Query control could not confirm all native peers; root retained");
    removeFixtureRoot(f.root);
  }
});
