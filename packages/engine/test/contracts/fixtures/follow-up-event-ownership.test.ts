import { afterEach, expect, it, spyOn } from "bun:test";
import { existsSync } from "node:fs";
import { createFollowUpFixtures, type World } from "../../fixtures/follow-up-native.js";
import { createWorkflowEventFixtures } from "../../fixtures/workflow-event-native.js";
import { removeFixtureRoot } from "@petrina/test-support/fixture-roots";
import { rejectionOf } from "@petrina/test-support/rejections";
import type { Engine } from "../../engine.js";

const leaves = (error: unknown): unknown[] => error instanceof AggregateError ? error.errors.flatMap(leaves) : [error];
const observe = (work: Promise<unknown>) => { void work.catch(() => undefined); return work; };
const finalizers = new Set<() => Promise<void>>();
afterEach(async () => {
  const settled = await Promise.allSettled([...finalizers].map(finish => finish()));
  const errors = settled.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "Owned fixture controls could not finish cleanup");
});
async function expectedCleanup(work: readonly Promise<unknown>[], cleanup: readonly (() => Promise<unknown>)[], failure: unknown): Promise<void> {
  const outcomes = await Promise.allSettled(work);
  const independent = await Promise.allSettled(cleanup.map(effect => Promise.resolve().then(effect)));
  const errors = [
    ...outcomes.flatMap(outcome => outcome.status === "rejected" && !leaves(outcome.reason).every(leaf => leaf === failure) ? [outcome.reason] : []),
    ...independent.flatMap(outcome => outcome.status === "rejected" ? [outcome.reason] : []),
  ];
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "Independent fixture cleanup did not all settle");
}

it("releases confirmed old follow-up Engines and shuts down the actual reopened owner before removing its root", async () => {
  const f = createFollowUpFixtures();
  let oldShutdown!: ReturnType<typeof spyOn>;
  let world!: World, current!: Engine;
  let finishing: Promise<void> | undefined;
  const finish = (): Promise<void> => finishing ??= Promise.resolve().then(async () => {
    try { await f.close(); }
    finally { oldShutdown?.mockRestore(); }
    finalizers.delete(finish);
  });
  finalizers.add(finish);
  const running = observe(f.use(async owner => {
    world = await f.open(owner);
    const old = world.engine;
    await f.reopen(world);
    oldShutdown = spyOn(old, "shutdown");
    oldShutdown.mockImplementation(() => { throw new Error("A completed Engine was retained"); });
    current = world.engine;
    expect(existsSync(world.root)).toBe(true);
  }));
  try {
    await running;
    await f.close();
    expect(oldShutdown.mock.calls).toEqual([]);
    expect(current.stopped).toBe(true);
    expect(existsSync(world.root)).toBe(false);
  } finally { await finish(); }
});

it("settles peer follow-up shutdowns and retains the root whose actual shutdown rejected", async () => {
  const f = createFollowUpFixtures(), failure = new Error("The owned Engine stop could not be confirmed");
  const released = Promise.withResolvers<void>(), firstReady = Promise.withResolvers<void>(), secondReady = Promise.withResolvers<void>();
  let first!: World, second!: World;
  let actualFirstStop: (() => Promise<void>) | undefined, actualSecondStop: (() => Promise<void>) | undefined;
  let stop: ReturnType<typeof spyOn> | undefined;
  let finishing: Promise<void> | undefined;
  const finish = (): Promise<void> => finishing ??= Promise.resolve().then(async () => {
    released.resolve();
    await expectedCleanup([f.close()], [async () => { stop?.mockRestore(); }, ...(actualFirstStop ? [actualFirstStop] : []), ...(actualSecondStop ? [actualSecondStop] : [])], failure);
    if (first) removeFixtureRoot(first.root);
    finalizers.delete(finish);
  });
  finalizers.add(finish);
  const firstRun = observe(f.use(async owner => {
    owner.onStop(() => released.resolve());
    first = await f.open(owner);
    actualFirstStop = first.engine.shutdown.bind(first.engine);
    stop = spyOn(first.engine, "shutdown");
    owner.afterBody(() => stop?.mockRestore());
    stop.mockImplementation(() => Promise.reject(failure));
    firstReady.resolve();
    await released.promise;
  }));
  const secondRun = observe(f.use(async owner => {
    owner.onStop(() => released.resolve());
    second = await f.open(owner);
    actualSecondStop = second.engine.shutdown.bind(second.engine);
    secondReady.resolve();
    await released.promise;
  }));
  try {
    await Promise.race([firstReady.promise, firstRun.then(() => { throw new Error("The first follow-up owner never became ready"); })]);
    await Promise.race([secondReady.promise, secondRun.then(() => { throw new Error("The peer follow-up owner never became ready"); })]);
    expect(leaves(await rejectionOf(f.close()))).toEqual([failure]);
    expect(existsSync(first.root)).toBe(true);
    expect(second.engine.stopped).toBe(true);
    expect(existsSync(second.root)).toBe(false);
  } finally { await finish(); }
});

it("awaits the actual served stop while settling every Engine and retaining cleanup failures", async () => {
  const f = createWorkflowEventFixtures(), failure = new Error("The first event Engine stop could not be confirmed");
  const released = Promise.withResolvers<void>(), stopping = Promise.withResolvers<void>(), bodies = Promise.withResolvers<void>();
  const firstReady = Promise.withResolvers<void>(), peerReady = Promise.withResolvers<void>();
  let first!: Awaited<ReturnType<typeof f.served>>, peer!: ReturnType<typeof f.fixture>;
  let actualFirstStop: (() => Promise<void>) | undefined, actualPeerStop: (() => Promise<void>) | undefined;
  let engineStop: ReturnType<typeof spyOn> | undefined, serverStop: ReturnType<typeof spyOn> | undefined;
  let closing: Promise<void> | undefined, finishing: Promise<void> | undefined;
  const finish = (): Promise<void> => finishing ??= Promise.resolve().then(async () => {
    released.resolve(); bodies.resolve();
    await expectedCleanup([f.close()], [
      async () => { engineStop?.mockRestore(); serverStop?.mockRestore(); },
      async () => { if (first) await first.server.stop(true); },
      ...(actualFirstStop ? [actualFirstStop] : []), ...(actualPeerStop ? [actualPeerStop] : []),
    ], failure);
    if (first) removeFixtureRoot(first.home);
    finalizers.delete(finish);
  });
  finalizers.add(finish);
  const firstRun = observe(f.use("petrina-events-", async owner => {
    owner.onStop(() => bodies.resolve());
    first = await f.served(owner);
    actualFirstStop = first.e.shutdown.bind(first.e);
    firstReady.resolve();
    await bodies.promise;
  }));
  const peerRun = observe(f.use("petrina-events-", async owner => {
    owner.onStop(() => bodies.resolve());
    peer = f.fixture(owner);
    actualPeerStop = peer.e.shutdown.bind(peer.e);
    peerReady.resolve();
    await bodies.promise;
  }));
  try {
    await Promise.race([firstReady.promise, firstRun.then(() => { throw new Error("The served owner never became ready"); })]);
    await Promise.race([peerReady.promise, peerRun.then(() => { throw new Error("The peer event owner never became ready"); })]);
    const actualStop = first.server.stop.bind(first.server);
    serverStop = spyOn(first.server, "stop");
    serverStop.mockImplementation(async (active?: boolean) => {
      await actualStop(active); stopping.resolve(); await released.promise;
    });
    engineStop = spyOn(first.e, "shutdown");
    engineStop.mockImplementation(() => Promise.reject(failure));
    let closed = false;
    closing = f.close().finally(() => { closed = true; });
    void closing.catch(() => undefined);
    await Promise.race([stopping.promise, closing.then(() => { throw new Error("The real served stop never started"); })]);
    expect(closed).toBe(false);
    expect(existsSync(first.home)).toBe(true);
    released.resolve(); bodies.resolve();
    expect(leaves(await rejectionOf(closing))).toEqual([failure]);
    expect(serverStop.mock.calls).toEqual([[true]]);
    expect(peer.e.stopped).toBe(true);
    expect(existsSync(peer.home)).toBe(false);
    expect(existsSync(first.home)).toBe(true);
  } finally { await finish(); }
});
