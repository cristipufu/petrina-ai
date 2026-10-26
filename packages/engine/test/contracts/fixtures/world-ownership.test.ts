import { afterEach, expect, it, spyOn } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { completeAll, createDemoState } from "@petrina/core";
import { Store } from "@petrina/storage/store";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { createProcessLease, type ProcessLease } from "@petrina/test-support/process-lease";
import { rejectionOf } from "@petrina/test-support/rejections";
import { engineProcessCases, tempDir, waitFor } from "../../support.js";
import { repositoryWorldFixtures, type RepositoryWorldScope } from "../../fixtures/repository-worlds.js";
import { removeFixtureRoot } from "../../fixtures/direct-drivers.js";

type Outcome<T> = { value: T } | { error: unknown };
const capture = <T>(body: () => T): Outcome<T> => {
  try { return { value: body() }; } catch (error) { return { error }; }
};
const fixtures = repositoryWorldFixtures(), peers = engineProcessCases();
const finalizers = new Set<() => Promise<void>>();
afterEach(async () => {
  const pending = [...finalizers].map(async finish => { await finish(); finalizers.delete(finish); });
  await completeAll([...pending, fixtures.close(), peers.close()]);
});

for (const failure of [new Error("finished repository case failed"), undefined]) it("retains a failed finished World root without replaying its error into the next case: " + String(failure), async () => {
  const local = repositoryWorldFixtures();
  let failed: RepositoryWorldScope | undefined;
  let outcome: Promise<Outcome<unknown>> | undefined;
  const finish = async () => {
    const settled = await Promise.allSettled([outcome, local.close()]);
    const errors = settled.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Actor-free World collection cleanup failed");
    // This control starts no native work. Its registered body and close have both settled.
    if (failed) removeFixtureRoot(failed.root);
  };
  finalizers.add(finish);
  const running = local.use("world-retained-case", async scope => { failed = scope; throw failure; });
  outcome = running.then(value => ({ value }), (error: unknown) => ({ error }));
  await setupWithCleanup(async () => {
    const result = await outcome!;
    expect("error" in result).toBe(true);
    if (!("error" in result) || !(result.error instanceof AggregateError)) throw new Error("The failed case lost its strict cleanup rejection");
    expect(result.error.errors[0]).toBe(failure);
    expect(existsSync(failed!.root)).toBe(true);
    await local.close();
    expect(local.retained.has(failed!.root)).toBe(true);
    let admitted = 0;
    expect(await rejectionOf(failed!.run(async () => { admitted++; }))).toBeInstanceOf(Error);
    expect(admitted).toBe(0);
    const next = await local.use("world-independent-next", async scope => scope.root);
    await local.close();
    expect(next).not.toBe(failed!.root);
    expect(existsSync(next)).toBe(false);
    expect(local.retained.has(next)).toBe(false);
    expect(existsSync(failed!.root)).toBe(true);
    expect(local.retained.has(failed!.root)).toBe(true);
  }, finish);
  await finish(); finalizers.delete(finish);
});

for (const failure of [new Error("prepared peer failed"), undefined]) it("settles every prepared World peer and retains its exact rejected value: " + String(failure), async () => {
  const local = repositoryWorldFixtures();
  let root: string | undefined, ready = false, peerCompleted = false, peerAtReport: boolean | undefined, bodySettled = false;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let prepared: ReturnType<RepositoryWorldScope["make"]> | undefined;
  let closed: Promise<Outcome<void>> | undefined;
  let outcome: Promise<Outcome<void>> | undefined;
  const finish = async () => {
    release();
    closed ??= local.close().then(value => ({ value }), (error: unknown) => ({ error }));
    // An ordinary rejection stays strict. Manual disposal needs independent fulfilled native setup.
    if (prepared) await prepared;
    await outcome; await closed;
    if (root) removeFixtureRoot(root);
  };
  finalizers.add(finish);
  const running = local.use("world-rejected-peer", async scope => {
    root = scope.root;
    prepared = scope.make("actual-git-world");
    await prepared;
    const rejected = scope.run(async () => { throw failure; });
    const peer = scope.run(async () => { ready = true; await held; peerCompleted = true; });
    const all = completeAll([rejected, peer]);
    void all.then(() => { peerAtReport = peerCompleted; }, () => { peerAtReport = peerCompleted; });
    try { await all; } finally { bodySettled = true; }
  });
  outcome = running.then(value => ({ value }), (error: unknown) => ({ error }));
  await setupWithCleanup(async () => {
    await waitFor(() => ready, "the actual World setup and held peer", undefined, { during: running });
    let bodyAtClose: boolean | undefined;
    closed = local.close().then(value => { bodyAtClose = bodySettled; return { value }; }, (error: unknown) => { bodyAtClose = bodySettled; return { error }; });
    expect(existsSync(root!)).toBe(true);
    release();
    const result = await outcome, cleanup = await closed;
    expect(peerAtReport).toBe(true);
    expect(bodyAtClose).toBe(true);
    expect("error" in result).toBe(true);
    if (!("error" in result) || !(result.error instanceof AggregateError)) throw new Error("The original fixture failure was not retained");
    expect(result.error.errors).toHaveLength(2);
    expect(result.error.errors[0]).toBe(failure);
    expect("error" in cleanup).toBe(true);
    expect(existsSync(root!)).toBe(true);
  }, finish);
  await finish(); finalizers.delete(finish);
});

it("independently stops a real held peer and joins its drained result before reporting a failed World body", async () => {
  let lease: ProcessLease | undefined;
  const local = repositoryWorldFixtures(), peerRoot = tempDir("petrina-world-independent-peer-");
  const native = peers.open(peerRoot, { stopPeers: () => lease?.close() });
  const failure = new Error("World body failed after native readiness"), gate = join(peerRoot, "release-peer");
  let root: string | undefined, ready = false, nativeEnded = false, nativeAtReport: boolean | undefined, attempted = false;
  let peer: ReturnType<typeof native.command> | undefined;
  let prepared: ReturnType<RepositoryWorldScope["make"]> | undefined;
  let closing: Promise<Outcome<void>> | undefined, outcome: Promise<Outcome<void>> | undefined;
  let failBody!: () => void;
  const failureGate = new Promise<void>(resolve => { failBody = resolve; });
  const stop = { calls: 0, stopPeers() { this.calls++; peer?.write("stop\n"); peer?.endInput(); } };
  const finish = async () => {
    failBody();
    // The independent owner and gate stay available if the subject stop effect fails.
    const release = capture(() => writeFileSync(gate, "release"));
    const input = capture(() => peer?.endInput());
    closing ??= local.close().then(value => ({ value }), (error: unknown) => ({ error }));
    const settlements = await Promise.allSettled([
      native.close(),
      Promise.resolve(prepared).then(() => undefined), Promise.resolve(peer?.completion).then(() => undefined),
      Promise.resolve(outcome).then(() => undefined), closing.then(() => undefined),
    ]);
    const errors = [release, input].flatMap(result => "error" in result ? [result.error] : []);
    errors.push(...settlements.flatMap(result => result.status === "rejected" ? [result.reason] : []));
    if (attempted && !peer) errors.push(new Error("The independent native owner did not return a command record; World files retained"));
    if (errors.length) throw new AggregateError(errors, "Independent native fixture cleanup failed; World files retained");
    if (root) removeFixtureRoot(root);
  };
  finalizers.add(finish);
  const running = local.use("world-held-native", async scope => {
    root = scope.root;
    const program = await native.prepare(async () => {
      lease = await createProcessLease();
      if (native.signal.aborted) { await lease.close(); throw new Error("The independent peer owner closed while its lease was opening"); }
      const file = join(peerRoot, "held-peer.ts");
      writeFileSync(file, lease.program("const { existsSync } = await import('node:fs'); console.log('ready'); for await (const line of console) { if (line === 'stop') { console.log('stopping'); while (!existsSync(" + JSON.stringify(gate) + ")) await Bun.sleep(5); break; } }"));
      return file;
    });
    prepared = scope.make("actual-git-world"); await prepared;
    const command = scope.run(() => {
      attempted = true;
      peer = native.command(peerRoot, [program]);
      return peer.completion;
    });
    void command.then(() => { nativeEnded = true; }, () => undefined);
    await peer!.line();
    expect(peer!.exitCode).toBeNull();
    ready = true;
    await failureGate;
    // Deliberately do not await command here: scope.run itself must retain the live native work.
    throw failure;
  }, stop);
  outcome = running.then(value => { nativeAtReport = nativeEnded; return { value }; }, (error: unknown) => { nativeAtReport = nativeEnded; return { error }; });
  await setupWithCleanup(async () => {
    await waitFor(() => ready, "the actual held native peer", undefined, { during: running });
    failBody();
    expect(await peer!.line()).toBe("stopping");
    expect(existsSync(root!)).toBe(true);
    // The fixture cannot release this gate; native completion must remain independently owned.
    writeFileSync(gate, "release");
    const result = await outcome;
    closing = local.close().then(value => ({ value }), (error: unknown) => ({ error }));
    await closing;
    expect(stop.calls).toBe(1);
    expect(nativeAtReport).toBe(true);
    expect(await peer!.completion).toMatchObject({ code: 0, stdout: "ready\nstopping\n", stderr: "" });
    expect("error" in result).toBe(true);
    if (!("error" in result) || !(result.error instanceof AggregateError)) throw new Error("The failed native body was not retained");
    expect(result.error.errors).toHaveLength(2);
    expect(result.error.errors[0]).toBe(failure);
    expect(existsSync(root!)).toBe(true);
  }, finish);
  await finish(); finalizers.delete(finish);
});

async function savedWorld(scope: RepositoryWorldScope) {
  const world = await scope.make("saved-state"), file = join(world.data, "petrina.db");
  const seed = new Store(file);
  try { seed.save({ ...createDemoState(1), products: [], tasks: [], inbox: [], tools: [], setup: undefined, history: undefined, extraValidations: undefined }, []); }
  finally { seed.close(); }
  return { world, file };
}
function readSaved(file: string) {
  const store = new Store(file);
  try { return store.load()!; } finally { store.close(); }
}

/** Observe the real SQLite instance and restore every boundary even when the body or restoration fails. */
function observeEdit<T>(body: (opened: Set<Store>, closed: Set<Store>) => T, closeFailure?: { error: unknown }): T {
  const opened = new Set<Store>(), closed = new Set<Store>();
  const load = Store.prototype.load, close = Store.prototype.close;
  let restoreLoad: (() => void) | undefined, restoreClose: (() => void) | undefined;
  let result: Outcome<T>;
  try {
    const reading = spyOn(Store.prototype, "load"); restoreLoad = () => reading.mockRestore();
    reading.mockImplementation(function (this: Store) { opened.add(this); return load.call(this); });
    const closing = spyOn(Store.prototype, "close"); restoreClose = () => closing.mockRestore();
    closing.mockImplementation(function (this: Store) {
      close.call(this); closed.add(this);
      if (closeFailure) throw closeFailure.error;
    });
    result = capture(() => body(opened, closed));
  } catch (error) { result = { error }; }
  const cleanup: unknown[] = [];
  for (const restore of [restoreClose, restoreLoad]) try { restore?.(); } catch (error) { cleanup.push(error); }
  for (const store of opened) if (!closed.has(store)) try { close.call(store); closed.add(store); } catch (error) { cleanup.push(error); }
  if (cleanup.length) throw new AggregateError([...("error" in result ? [result.error] : []), ...cleanup], "World Store observation cleanup failed");
  if ("error" in result) throw result.error;
  return result.value;
}
function expectClosed(opened: Set<Store>, closed: Set<Store>) {
  expect(opened.size).toBe(1);
  const store = [...opened][0]!;
  expect(closed.has(store)).toBe(true);
  expect(() => store.database.query("SELECT 1").get()).toThrow();
}
function expectThrown(result: Outcome<unknown>, failure: unknown) {
  expect("error" in result).toBe(true);
  if (!("error" in result)) throw new Error("The synchronous failure was reported as a return value");
  expect(result.error).toBe(failure);
}

it("edits saved state synchronously through its actual Store and closes before returning", async () => fixtures.use("world-edit-success", async scope => {
  const { world, file } = await savedWorld(scope);
  expect("start" in world).toBe(false);
  observeEdit((opened, closed) => {
    const result = world.editSaved(state => { state.now = 2; });
    expect(result).toBeUndefined();
    expectClosed(opened, closed);
  });
  expect(readSaved(file).now).toBe(2);
}));

for (const failure of [new Error("edit callback failed"), undefined]) it("closes the actual Store when its synchronous edit callback throws: " + String(failure), async () => fixtures.use("world-edit-callback", async scope => {
  const { world, file } = await savedWorld(scope);
  observeEdit((opened, closed) => {
    const result = capture(() => world.editSaved(() => { throw failure; }));
    expectThrown(result, failure);
    expectClosed(opened, closed);
  });
  expect(readSaved(file).now).toBe(1);
}));

it("closes the actual Store when native snapshot loading fails", async () => fixtures.use("world-edit-load", async scope => {
  const { world, file } = await savedWorld(scope), source = new Store(file);
  try {
    const saved = JSON.parse(source.database.query<{ value: string }, []>("SELECT value FROM kv WHERE key='state'").get()!.value);
    source.database.query("INSERT INTO active_tasks(id,body) VALUES(?,?)").run("corrupt-world-task", "{");
    source.database.query("UPDATE kv SET value=? WHERE key='state'").run(JSON.stringify({ ...saved, taskIds: ["corrupt-world-task"] }));
  } finally { source.close(); }
  observeEdit((opened, closed) => {
    const result = capture(() => world.editSaved(() => { throw new Error("An unreadable snapshot cannot reach the callback"); }));
    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("Malformed native snapshot unexpectedly loaded");
    expect(result.error).toBeInstanceOf(SyntaxError);
    expectClosed(opened, closed);
  });
}));

it("closes the actual Store and preserves native save failure without publishing the edit", async () => fixtures.use("world-edit-save", async scope => {
  const { world, file } = await savedWorld(scope), source = new Store(file);
  try { source.database.run("CREATE TRIGGER reject_world_edit BEFORE UPDATE ON kv BEGIN SELECT RAISE(ABORT, 'World snapshot refused'); END"); }
  finally { source.close(); }
  observeEdit((opened, closed) => {
    const result = capture(() => world.editSaved(state => { state.now = 2; }));
    expect("error" in result).toBe(true);
    if (!("error" in result) || !(result.error instanceof Error)) throw new Error("Native save failure was not reported");
    expect(result.error.message).toContain("World snapshot refused");
    expectClosed(opened, closed);
  });
  expect(readSaved(file).now).toBe(1);
}));

for (const failure of [new Error("Store close failed"), undefined]) it("preserves a synchronous close failure after the actual Store closed: " + String(failure), async () => fixtures.use("world-edit-close", async scope => {
  const { world, file } = await savedWorld(scope);
  observeEdit((opened, closed) => {
    expectThrown(capture(() => world.editSaved(state => { state.now = 2; })), failure);
    expectClosed(opened, closed);
  }, { error: failure });
  expect(readSaved(file).now).toBe(2);
}));

for (const failure of [new Error("callback and close failed"), undefined]) it("keeps original edit and close failures in order: " + String(failure), async () => fixtures.use("world-edit-both", async scope => {
  const { world, file } = await savedWorld(scope), closeFailure = new Error("Store close observation failed");
  observeEdit((opened, closed) => {
    const result = capture(() => world.editSaved(() => { throw failure; }));
    expect("error" in result).toBe(true);
    if (!("error" in result) || !(result.error instanceof AggregateError)) throw new Error("Both synchronous failures were not retained");
    expect(result.error.errors).toEqual([failure, closeFailure]);
    expectClosed(opened, closed);
  }, { error: closeFailure });
  expect(readSaved(file).now).toBe(1);
}));
