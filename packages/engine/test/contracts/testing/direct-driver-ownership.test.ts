import { expect, it, spyOn } from "bun:test";
import { Store } from "@petrina/storage/store";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rejectionOf } from "@petrina/test-support/rejections";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { directDrivers, closeDirectDrivers, removeFixtureRoot } from "../../fixtures/direct-drivers.js";
import { tempDir } from "../../fixtures.js";

it("cleans failed setup before a generation opens without replacing an undefined rejection", async () => {
  const root = tempDir("petrina-direct-setup-"), owner = directDrivers(root);
  const failure = await rejectionOf(setupWithCleanup(() => { throw undefined; }, owner.close));
  expect(failure).toBeUndefined();
  expect(existsSync(root)).toBe(false);
  await owner.close();
});

it("registers work before a reentrant stop and drains the old generation before reopening its files", async () => {
  const root = tempDir("petrina-direct-generation-"), owner = directDrivers(root), data = join(root, "data");
  const engine = owner.open(data);
  const release = Promise.withResolvers<void>();
  let stopping: Promise<void> | undefined;
  const work = owner.run(engine, () => {
    stopping = owner.stop(engine);
    return release.promise.then(() => { writeFileSync(join(root, "last-write.txt"), "Finished the actual operation"); });
  });
  try {
    await engine.shutdown();
    expect(existsSync(root)).toBe(true);
    expect(() => owner.open(data)).toThrow("Stop and settle");
    release.resolve(); await work; await stopping;
    expect(readFileSync(join(root, "last-write.txt"), "utf8")).toBe("Finished the actual operation");
    const replacement = owner.open(data);
    await replacement.waitUntilReady();
    await owner.stop(engine);
    expect(replacement.stopped).toBe(false);
    await owner.close();
    expect(existsSync(root)).toBe(false);
  } finally { release.resolve(); await owner.close(); }
});

it("settles peer generations and retains a rejected owner's root instead of deleting uncertain resources", async () => {
  const failedRoot = tempDir("petrina-direct-rejected-"), peerRoot = tempDir("petrina-direct-peer-");
  const failed = directDrivers(failedRoot), peer = directDrivers(peerRoot);
  const first = failed.open(join(failedRoot, "data")), second = peer.open(join(peerRoot, "data"));
  const release = Promise.withResolvers<void>(), failure = new Error("Actual owned operation failed");
  const broken = failed.run(first, () => Promise.reject(failure));
  const held = peer.run(second, () => release.promise.then(() => { writeFileSync(join(peerRoot, "last-write.txt"), "Settled"); }));
  let closing: Promise<void> | undefined;
  try {
    expect(await rejectionOf(broken)).toBe(failure);
    closing = closeDirectDrivers([failed, peer]);
    let finished = false;
    void closing.then(() => { finished = true; }, () => { finished = true; });
    await first.shutdown(); await second.shutdown();
    expect(finished).toBe(false);
    expect(existsSync(failedRoot)).toBe(true); expect(existsSync(peerRoot)).toBe(true);
    release.resolve(); await held;
    const error = await rejectionOf(closing);
    expect(error).toBeInstanceOf(AggregateError);
    expect(existsSync(failedRoot)).toBe(true); expect(existsSync(peerRoot)).toBe(false);
  } finally {
    release.resolve();
    const settled = await Promise.allSettled([broken, held, closing, first.shutdown(), second.shutdown()]);
    const shutdowns = settled.slice(3);
    const unconfirmed = shutdowns.filter(result => result.status === "rejected");
    if (unconfirmed.length) throw new AggregateError(unconfirmed.map(result => result.reason), "Ownership control could not confirm native shutdown; roots retained");
    // Both real shutdowns and actual operations are now settled; this expected-error control owns the retained folder.
    removeFixtureRoot(failedRoot); removeFixtureRoot(peerRoot);
  }
});


it("owns preparation before an Engine opens, including a synchronous reentrant close", async () => {
  const root = tempDir("petrina-direct-preparation-"), owner = directDrivers(root), release = Promise.withResolvers<void>();
  let closing: Promise<void> | undefined, finished = false;
  const work = owner.prepare(() => {
    closing = owner.close();
    void closing.then(() => { finished = true; }, () => { finished = true; });
    return release.promise.then(() => {
      const file = join(root, "prepared.txt");
      writeFileSync(file, "The actual prepared operation finished before disposal");
      return readFileSync(file, "utf8");
    });
  });
  try {
    await Promise.resolve();
    expect(finished).toBe(false); expect(existsSync(root)).toBe(true);
    expect(() => owner.open(join(root, "data"))).toThrow("closing");
    release.resolve();
    expect(await work).toBe("The actual prepared operation finished before disposal");
    await closing;
    expect(finished).toBe(true); expect(existsSync(root)).toBe(false);
  } finally {
    release.resolve();
    const settled = await Promise.allSettled([work, owner.close()]);
    const failed = settled.filter(result => result.status === "rejected");
    if (failed.length) throw new AggregateError(failed.map(result => result.reason), "Prepared operation cleanup was not confirmed; root retained");
  }
});

for (const failure of [new Error("Preparation failed before opening an Engine"), undefined]) it(`retains rejected preparation and its private root before an Engine opens (${failure === undefined ? "undefined" : "Error"})`, async () => {
  const root = tempDir("petrina-direct-prepare-rejection-"), owner = directDrivers(root);
  try {
    const result = await rejectionOf(setupWithCleanup(() => owner.prepare(() => Promise.reject(failure)), owner.close));
    expect(result).toBeInstanceOf(AggregateError);
    if (result instanceof AggregateError) {
      expect(result.errors[0]).toBe(failure);
      expect(result.errors[1]).toBeInstanceOf(AggregateError);
      if (result.errors[1] instanceof AggregateError) expect(result.errors[1].errors).toEqual([failure]);
    }
    expect(existsSync(root)).toBe(true);
  } finally {
    await Promise.allSettled([owner.close()]);
    // The controlled rejection started no Engine, program or asynchronous writer; its expected-error root is ours.
    removeFixtureRoot(root);
  }
});

it("reserves the current birth before a constructor callback tries to open another Engine", async () => {
  const root = tempDir("petrina-direct-birth-"), owner = directDrivers(root), data = join(root, "data");
  let nested: { error: unknown } | undefined;
  try {
    const engine = owner.open(data, { terminals() {
      try { owner.open(data); } catch (error) { nested = { error }; }
      return [];
    } });
    expect(nested?.error).toBeInstanceOf(Error);
    expect((nested!.error as Error).message).toContain("Stop and settle");
    await owner.close();
    expect(engine.stopped).toBe(true);
    expect(existsSync(root)).toBe(false);
  } finally { await owner.close(); }
});

for (const failure of [new Error("Engine construction failed"), undefined]) it(`preserves the original synchronous constructor rejection and retains its failed birth (${failure === undefined ? "undefined" : "Error"})`, async () => {
  const root = tempDir("petrina-direct-birth-failure-"), owner = directDrivers(root);
  const stores = new Set<Store>(), closedStores = new Set<Store>();
  const load = Store.prototype.loadActive, closeStore = Store.prototype.close;
  let restoreLoad: (() => void) | undefined, restoreClose: (() => void) | undefined, recoveries = 0;
  let thrown: { error: unknown } | undefined;
  const finish = async () => {
    await Promise.allSettled([owner.close()]);
    const errors: unknown[] = [];
    for (const store of stores) if (!closedStores.has(store)) {
      try { closeStore.call(store); closedStores.add(store); } catch (error) { errors.push(error); }
    }
    for (const restore of [restoreClose, restoreLoad]) try { restore?.(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Failed-construction Store cleanup was not confirmed; root retained");
    removeFixtureRoot(root);
  };
  await setupWithCleanup(async () => {
    const reading = spyOn(Store.prototype, "loadActive"); restoreLoad = () => reading.mockRestore();
    reading.mockImplementation(function (this: Store, ...args) { stores.add(this); return load.apply(this, args); });
    const closing = spyOn(Store.prototype, "close"); restoreClose = () => closing.mockRestore();
    closing.mockImplementation(function (this: Store) { closeStore.call(this); closedStores.add(this); });
    try { owner.open(join(root, "data"), { terminals() { throw failure; }, browserRecovery: async () => { recoveries++; } }); }
    catch (error) { thrown = { error }; }
    expect(thrown).toBeDefined();
    expect(thrown!.error).toBe(failure);
    expect(stores.size).toBe(1);
    for (const store of stores) {
      expect(closedStores.has(store)).toBe(true);
      expect(() => store.database.query("SELECT 1").get()).toThrow();
    }
    expect(recoveries).toBe(0);
    const closed = await rejectionOf(owner.close());
    expect(closed).toBeInstanceOf(AggregateError);
    if (closed instanceof AggregateError) expect(closed.errors).toContain(failure);
    expect(existsSync(root)).toBe(true);
  }, finish);
  await finish();
});
