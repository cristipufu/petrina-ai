import { afterEach, expect, it, spyOn } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { Store } from "@petrina/storage/store";
import { completeAll } from "@petrina/core";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { waitFor } from "@petrina/test-support/fixtures";
import { rejectionOf } from "@petrina/test-support/rejections";
import { removeFixtureRoot } from "@petrina/test-support/fixture-roots";
import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { coordinatorApiFixtures } from "../../fixtures/coordinator-api.js";
import { coordinatorRecordFixtures } from "../../fixtures/coordinator-records.js";

const cleanup = new Set<() => Promise<void>>();
afterEach(async () => {
  const pending = [...cleanup]; cleanup.clear();
  await completeAll(pending.map(close => Promise.resolve().then(close)));
});

it("keeps explicit private database folders separate and restarts on the declared folder", async () => {
  const owners = engineCaseFixtures(), close = () => owners.close();
  cleanup.add(close);
  let root: string | undefined;
  await setupWithCleanup(() => owners.use("petrina-case-folders-", async owner => {
    root = owner.root;
    const options = { admissionsClosed: true, agentCommand: () => undefined };
    const firstDir = join(owner.root, "first"), secondDir = join(owner.root, "second");
    const first = owner.open(firstDir, options);
    first.s.products.push({ id: "first-only", name: "First", repo: "local/first", tone: "blue" });
    first.commitNow();
    expect(first.dataDir).toBe(firstDir);
    expect(() => owner.open(secondDir, options)).toThrow("Stop and settle");
    await owner.stop(first);
    const second = owner.open(secondDir, options);
    expect(second.dataDir).toBe(secondDir);
    expect(second.s.products.some(product => product.id === "first-only")).toBe(false);
    const reopened = await owner.restart(second, secondDir, options);
    expect(reopened.dataDir).toBe(secondDir);
    expect(reopened.s.products.some(product => product.id === "first-only")).toBe(false);
    await owner.stop(reopened);
    const original = owner.open(firstDir, options);
    expect(original.s.products.some(product => product.id === "first-only")).toBe(true);
  }), close);
  expect(existsSync(root!)).toBe(false);
  await close(); cleanup.delete(close);
});

it("owns simultaneous private Engines only when their case explicitly permits overlap", async () => {
  const owners = engineCaseFixtures(), close = () => owners.close();
  cleanup.add(close);
  let root: string | undefined;
  await setupWithCleanup(() => owners.use("petrina-case-overlap-", async owner => {
    root = owner.root;
    const options = { admissionsClosed: true, agentCommand: () => undefined };
    const first = owner.open(join(owner.root, "first"), options), second = owner.open(join(owner.root, "second"), options);
    first.s.products.push({ id: "one", name: "One", repo: "local/one", tone: "blue" });
    second.s.products.push({ id: "two", name: "Two", repo: "local/two", tone: "blue" });
    first.commitNow(); second.commitNow();
    expect(first.stopped).toBe(false); expect(second.stopped).toBe(false);
    expect(first.store.load()!.products.map(product => product.id)).toEqual(["one"]);
    expect(second.store.load()!.products.map(product => product.id)).toEqual(["two"]);
  }, { allowOverlap: true }), close);
  expect(existsSync(root!)).toBe(false);
  await close(); cleanup.delete(close);
});

it("closes admission before releasing a held setup and joins its body before disposing the root", async () => {
  const owners = engineCaseFixtures(), release = Promise.withResolvers<void>();
  const events: string[] = [];
  let root: string | undefined, stopObserved = false, ended = false;
  let reentered: Promise<void> | undefined, closing: Promise<void> | undefined;
  const fallback = async () => { release.resolve(); await owners.close(); };
  cleanup.add(fallback);
  const running = owners.use("petrina-coordinator-held-", async owner => {
    root = owner.root;
    owner.onStop(() => { events.push("stop"); stopObserved = true; reentered = owners.close(); });
    owner.afterBody(() => { events.push("dispose peer"); });
    await release.promise;
    expect(() => owner.open(owner.root, { agentCommand: () => undefined })).toThrow("closing");
    events.push("body settled");
  });
  void running.catch(() => undefined);
  await setupWithCleanup(async () => {
    await waitFor(() => root !== undefined, "the registered coordinator setup", undefined, { during: running });
    closing = owners.close();
    const observed = closing.then(() => { ended = true; });
    await waitFor(() => stopObserved, "the actual close to request its release", undefined, { during: closing });
    expect(ended).toBe(false);
    expect(existsSync(root!)).toBe(true);
    expect(events).toEqual(["stop"]);
    release.resolve();
    await completeAll([running, closing, observed]);
    expect(reentered).toBe(closing);
    expect(events).toEqual(["stop", "body settled", "dispose peer"]);
    expect(existsSync(root!)).toBe(false);
  }, async () => { release.resolve(); await completeAll([running, owners.close()]); });
  cleanup.delete(fallback);
});

const leaves = (error: unknown): unknown[] => error instanceof AggregateError ? error.errors.flatMap(leaves) : [error];
for (const failure of [new Error("Controlled coordinator release failure"), undefined]) {
  it(`joins every peer and retains the root after an exact release rejection ${String(failure)}`, async () => {
    const owners = engineCaseFixtures(), events: string[] = [];
    let root: string | undefined;
    cleanup.add(() => owners.close());
    const running = owners.use("petrina-coordinator-release-", async owner => {
      root = owner.root;
      owner.onStop(() => { events.push("first"); throw failure; });
      owner.onStop(() => { events.push("second"); });
      owner.afterBody(() => { events.push("records closed"); });
    });
    const error = await rejectionOf(running);
    expect(events).toEqual(["first", "second", "records closed"]);
    const errors = leaves(error);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every(error => error === failure)).toBe(true);
    expect(owners.retained.has(root!)).toBe(true);
    expect(existsSync(root!)).toBe(true);
    // No Engine or native actor was admitted; all explicit effects above have settled.
    removeFixtureRoot(root!);
    expect(existsSync(root!)).toBe(false);
  });
}

it("keeps the API's paused live facade and joins both real SQLite generations on restart", async () => {
  const owners = coordinatorApiFixtures();
  cleanup.add(() => owners.close());
  let root: string | undefined;
  await owners.use(async ({ e, home, taskId, owner }) => {
    root = home;
    expect(e.draining).toBe(false);
    expect(e.s.pool.paused).toBe(true);
    expect(e.s.products.map(product => product.id)).toEqual(["product"]);
    const title = e.task(taskId)!.title;
    await owner.stop(e);
    const next = await owner.restart(e, owner.root, { admissionsClosed: true, agentCommand: () => undefined });
    expect(next.task(taskId)!.title).toBe(title);
    expect(next.draining).toBe(true);
  });
  expect(existsSync(root!)).toBe(false);
});

it("keeps the records recipe's closed admissions and backlog input under the same owner", async () => {
  const owners = coordinatorRecordFixtures();
  cleanup.add(() => owners.close());
  let root: string | undefined;
  await owners.use(async fixture => {
    root = fixture.root;
    expect(fixture.engine.draining).toBe(true);
    expect(fixture.engine.s.pool.paused).toBe(true);
    expect(fixture.engine.s.products.map(product => product.id)).toEqual(["p"]);
    expect(fixture.task.state).toBe("backlog");
    expect(fixture.scope.task).toBe(fixture.task);
  });
  expect(existsSync(root!)).toBe(false);
});

it("closes extra records after the actual late-born Engine shutdown when a constructor reenters close", async () => {
  const owners = engineCaseFixtures(), recover = Promise.withResolvers<void>(), returned = Promise.withResolvers<void>();
  let root: string | undefined, recoveryStarted = false, storeClosed = false, finalized = false;
  let running: Promise<void> | undefined, restore: (() => void) | undefined;
  const fallback = async () => {
    recover.resolve(); returned.resolve();
    try { await completeAll([...(running ? [running] : []), owners.close()]); }
    finally { restore?.(); }
  };
  cleanup.add(fallback);
  const closeStore = Store.prototype.close;
  await setupWithCleanup(async () => {
    const spy = spyOn(Store.prototype, "close"); restore = () => spy.mockRestore();
    spy.mockImplementation(function (this: Store) { closeStore.call(this); storeClosed = true; });
    running = owners.use("petrina-coordinator-late-birth-", async owner => {
      root = owner.root;
      owner.afterBody(() => { expect(storeClosed).toBe(true); finalized = true; });
      expect(() => owner.open(owner.root, { agentCommand: () => undefined,
        terminals() { void owners.close().catch(() => undefined); return []; },
        browserRecovery: async () => { recoveryStarted = true; await recover.promise; },
      })).toThrow("closed during Engine construction");
      await returned.promise;
    });
    void running.catch(() => undefined);
    await waitFor(() => recoveryStarted, "the real late Engine startup recovery", undefined, { during: running });
    expect(storeClosed).toBe(false);
    returned.resolve(); await returned.promise;
    // Drain queued body/finalizer reactions while the actual Engine recovery is still held.
    await setImmediate();
    expect(finalized).toBe(false);
    expect(storeClosed).toBe(false);
    recover.resolve();
    await running;
    expect(finalized).toBe(true);
    expect(storeClosed).toBe(true);
    expect(existsSync(root!)).toBe(false);
  }, fallback);
  await fallback(); cleanup.delete(fallback);
});
