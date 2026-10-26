import { expect, it, spyOn } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as commands from "@petrina/test-support/commands";
import * as files from "@petrina/test-support/fixtures";
import { rejectionOf } from "@petrina/test-support/rejections";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import * as scriptedAcceptance from "../../fixtures/acceptance-agents.js";
import { acceptanceRepairFixtures } from "../../fixtures/acceptance-repairs.js";
import { removeFixtureRoot } from "../../fixtures/direct-drivers.js";
import { Coordination } from "../../../src/coordination.js";

type Fixtures = ReturnType<typeof acceptanceRepairFixtures>;
type Fixture = Awaited<ReturnType<Fixtures["fixture"]>>;
function containsFailure(value: unknown, failure: unknown): boolean {
  return value === failure || value instanceof AggregateError && value.errors.some(error => containsFailure(error, failure));
}

it("owns acceptance setup before any Engine exists and refuses an Engine opened after close", async () => {
  let fixtures: Fixtures | undefined;
  const restorers: (() => void)[] = [];
  let root: string | undefined, closing: Promise<void> | undefined, setup: Promise<unknown> | undefined, cleaning: Promise<void> | undefined;
  let failure: unknown;
  const cleanup = () => cleaning ??= Promise.resolve().then(async () => {
    const restored = await Promise.allSettled(restorers.map(restore => Promise.resolve().then(restore)));
    const settled = await Promise.allSettled([() => setup, () => closing, () => fixtures?.close()].map(stop => Promise.resolve().then(stop)));
    const restoreFailures = restored.filter(result => result.status === "rejected");
    if (!setup) {
      const failed = [...restoreFailures, ...settled.filter(result => result.status === "rejected")];
      if (failed.length) throw new AggregateError(failed.map(result => result.reason), "Unfinished setup acquisition cleanup failed");
      return;
    }
    if (restoreFailures.length || !root || !closing || settled[0]!.status !== "rejected" || settled[1]!.status !== "rejected"
      || settled[2]!.status !== "rejected" || existsSync(join(root, "data")))
      throw new AggregateError([...restoreFailures, ...settled.filter(result => result.status === "rejected")].map(result => result.reason), "Setup control did not confirm the absence of an Engine; root retained");
    removeFixtureRoot(root);
  });
  await setupWithCleanup(async () => {
    fixtures = acceptanceRepairFixtures();
    const originalDir = files.tempDir, originalResponses = scriptedAcceptance.acceptanceAgents;
    const directory = spyOn(files, "tempDir"); restorers.push(() => directory.mockRestore());
    directory.mockImplementation(prefix => {
      const path = originalDir(prefix);
      if (prefix === "petrina-acceptance-repair-") root = path;
      return path;
    });
    const responses = spyOn(scriptedAcceptance, "acceptanceAgents"); restorers.push(() => responses.mockRestore());
    responses.mockImplementation(() => { closing = fixtures!.close(); return originalResponses(); });
    setup = fixtures.fixture({ gate: true });
    failure = await rejectionOf(setup);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(String(failure)).toContain("Setup failed");
    const refused = (failure as AggregateError).errors[0];
    expect(refused).toBeInstanceOf(Error); expect(refused.message).toContain("closing; no Engine may open");
    expect(root).toBeDefined(); expect(existsSync(root!)).toBe(true);
    expect(existsSync(join(root!, "data"))).toBe(false);
    const closed = await rejectionOf(closing!);
    expect(closed).toBeInstanceOf(AggregateError);
    expect(containsFailure(failure, (closed as AggregateError).errors[0])).toBe(true);
  }, cleanup);
  await cleanup();
});

it("joins all actual acceptance mains reads and retains the original failure until every peer settles", async () => {
  let fixtures: Fixtures | undefined, acquired: Fixture | undefined, cleaning: Promise<void> | undefined;
  const release = Promise.withResolvers<void>(), ready = Promise.withResolvers<void>(), restorers: (() => void)[] = [];
  const failure = new Error("Controlled first acceptance main read failed");
  let peer: Promise<string> | undefined, running: Promise<string[]> | undefined, closing: Promise<void> | undefined;
  let peerCompleted = false, peerCompletedAtReport: boolean | undefined, closed = false;
  const cleanup = () => cleaning ??= Promise.resolve().then(async () => {
    release.resolve(); ready.resolve();
    const restored = await Promise.allSettled(restorers.map(restore => Promise.resolve().then(restore)));
    const settled = await Promise.allSettled([() => running, () => peer, () => acquired?.engine.shutdown(), () => acquired?.close(), () => fixtures?.close()].map(stop => Promise.resolve().then<unknown>(stop)));
    const restoreFailures = restored.filter(result => result.status === "rejected");
    if (!running) {
      const failed = [...restoreFailures, ...settled.filter(result => result.status === "rejected")];
      if (failed.length) throw new AggregateError(failed.map(result => result.reason), "Acceptance mains acquisition cleanup failed; root retained");
      return;
    }
    if (restoreFailures.length || !acquired || !peer || settled[0]!.status !== "rejected" || settled[0]!.reason !== failure
      || settled[1]!.status !== "fulfilled" || settled[2]!.status !== "fulfilled" || settled[3]!.status !== "rejected"
      || !containsFailure(settled[3]!.reason, failure) || settled[4]!.status !== "rejected" || !containsFailure(settled[4]!.reason, failure))
      throw new AggregateError([...restoreFailures, ...settled.filter(result => result.status === "rejected")].map(result => result.reason), "Acceptance mains control could not confirm every native owner; root retained");
    removeFixtureRoot(acquired.root);
  });
  await setupWithCleanup(async () => {
    fixtures = acceptanceRepairFixtures();
    const f = acquired = await fixtures.fixture({ gate: true }), original = commands.git;
    const spy = spyOn(commands, "git"); restorers.push(() => spy.mockRestore());
    spy.mockImplementation((path, ...args) => {
      if (args[0] !== "rev-parse" || args[1] !== "main") return original(path, ...args);
      if (path === f.products[0]!.path) return ready.promise.then(() => { throw failure; });
      if (path !== f.products[1]!.path) return original(path, ...args);
      peer = release.promise.then(async () => { const value = await original(path, ...args); peerCompleted = true; return value; });
      ready.resolve(); return peer;
    });
    running = f.mains();
    const reported = () => { peerCompletedAtReport = peerCompleted; };
    void running.then(reported, reported);
    await files.waitFor(() => peer !== undefined, "the independently held acceptance main read", undefined, { during: running });
    closing = f.close(); void closing.then(() => { closed = true; }, () => { closed = true; });
    await f.engine.shutdown();
    expect(closed).toBe(false); expect(existsSync(f.root)).toBe(true);
    release.resolve(); expect(await rejectionOf(running)).toBe(failure);
    expect(await peer).toMatch(/^[a-f0-9]{40,64}$/); expect(peerCompletedAtReport).toBe(true);
    const error = await rejectionOf(closing);
    expect(error).toBeInstanceOf(AggregateError); expect(containsFailure(error, failure)).toBe(true);
    expect(existsSync(f.root)).toBe(true);
  }, cleanup);
  await cleanup();
});

it("keeps returned acceptance review-log work on its current generation until its real read completes", async () => {
  let fixtures: Fixtures | undefined, acquired: Fixture | undefined, cleaning: Promise<void> | undefined;
  const release = Promise.withResolvers<void>(), restorers: (() => void)[] = [];
  let held = false, nativeCompleted = false, helperCompleted = false, closed = false;
  let nativeCompletedAtClose: boolean | undefined, helperCompletedAtClose: boolean | undefined;
  let running: ReturnType<Fixture["reviewReports"]> | undefined, closing: Promise<void> | undefined;
  const cleanup = () => cleaning ??= Promise.resolve().then(async () => {
    release.resolve();
    const restored = await Promise.allSettled(restorers.map(restore => Promise.resolve().then(restore)));
    const settled = await Promise.allSettled([() => running, () => closing, () => acquired?.engine.shutdown(), () => acquired?.close(), () => fixtures?.close()].map(stop => Promise.resolve().then<unknown>(stop)));
    const failed = [...restored, ...settled].filter(result => result.status === "rejected");
    if (failed.length) throw new AggregateError(failed.map(result => result.reason), "Acceptance review-log work or cleanup failed; root retained");
  });
  await setupWithCleanup(async () => {
    fixtures = acceptanceRepairFixtures();
    const f = acquired = await fixtures.fixture({ gate: true }), original = Coordination.prototype.call;
    const spy = spyOn(Coordination.prototype, "call"); restorers.push(() => spy.mockRestore());
    spy.mockImplementation(async function (this: Coordination, name, raw, signal) {
      const value = await original.call(this, name, raw, signal);
      if (name !== "watch.events" || held) return value;
      held = true; await release.promise; nativeCompleted = true; return value;
    });
    running = f.reviewReports(); void running.then(() => { helperCompleted = true; }, () => {});
    await files.waitFor(() => held, "the actual acceptance review-event read", undefined, { during: running });
    closing = f.close();
    const finished = () => { closed = true; nativeCompletedAtClose = nativeCompleted; helperCompletedAtClose = helperCompleted; };
    void closing.then(finished, finished);
    await f.engine.shutdown();
    expect(closed).toBe(false); expect(existsSync(f.root)).toBe(true);
    release.resolve(); expect(await running).toEqual([]); await closing;
    expect(nativeCompletedAtClose).toBe(true); expect(helperCompletedAtClose).toBe(true);
    expect(existsSync(f.root)).toBe(false);
  }, cleanup);
  await cleanup();
});

it("owns acceptance restart across old-generation shutdown and refuses its replacement after close", async () => {
  let fixtures: Fixtures | undefined, acquired: Fixture | undefined, original: (() => Promise<void>) | undefined, cleaning: Promise<void> | undefined;
  const release = Promise.withResolvers<void>(), restorers: (() => void)[] = [];
  let held = false, actualShutdown: Promise<void> | undefined, restarting: Promise<void> | undefined, closing: Promise<void> | undefined;
  const cleanup = () => cleaning ??= Promise.resolve().then(async () => {
    release.resolve();
    const restored = await Promise.allSettled(restorers.map(restore => Promise.resolve().then(restore)));
    const settled = await Promise.allSettled([() => restarting, () => actualShutdown ?? original?.(), () => acquired?.close(), () => fixtures?.close()].map(stop => Promise.resolve().then(stop)));
    const restoreFailures = restored.filter(result => result.status === "rejected");
    if (!restarting) {
      const failed = [...restoreFailures, ...settled.filter(result => result.status === "rejected")];
      if (failed.length) throw new AggregateError(failed.map(result => result.reason), "Acceptance restart acquisition cleanup failed; root retained");
      return;
    }
    if (restoreFailures.length || !acquired || settled[0]!.status !== "rejected" || !(settled[0]!.reason instanceof Error)
      || !settled[0]!.reason.message.includes("closing; no Engine may open") || settled[1]!.status !== "fulfilled"
      || settled[2]!.status !== "rejected" || !containsFailure(settled[2]!.reason, settled[0]!.reason)
      || settled[3]!.status !== "rejected" || !containsFailure(settled[3]!.reason, settled[0]!.reason))
      throw new AggregateError([...restoreFailures, ...settled.filter(result => result.status === "rejected")].map(result => result.reason), "Acceptance restart control could not confirm actual shutdown; root retained");
    removeFixtureRoot(acquired.root);
  });
  await setupWithCleanup(async () => {
    fixtures = acceptanceRepairFixtures();
    const f = acquired = await fixtures.fixture({ gate: true }), previous = f.engine;
    original = previous.shutdown.bind(previous);
    const spy = spyOn(previous, "shutdown"); restorers.push(() => spy.mockRestore());
    spy.mockImplementation(() => {
      actualShutdown ??= original!();
      return actualShutdown.then(() => { held = true; return release.promise; });
    });
    restarting = f.restart();
    await files.waitFor(() => held, "the actual old acceptance generation's shutdown", undefined, { during: restarting });
    closing = f.close(); expect(existsSync(f.root)).toBe(true);
    release.resolve(); const refused = await rejectionOf(restarting);
    expect(refused).toBeInstanceOf(Error); expect((refused as Error).message).toContain("closing; no Engine may open");
    const error = await rejectionOf(closing);
    expect(error).toBeInstanceOf(AggregateError); expect(containsFailure(error, refused)).toBe(true);
    expect(f.engine).toBe(previous); expect(existsSync(f.root)).toBe(true);
  }, cleanup);
  await cleanup();
});
