import { expect, it, spyOn } from "bun:test";
import { existsSync } from "node:fs";
import { createFollowUpFixtures } from "../../fixtures/follow-up-native.js";
import { createWorkflowEventFixtures } from "../../fixtures/workflow-event-native.js";
import { removeDir } from "@petrina/test-support/fixtures";
import { rejectionOf } from "@petrina/test-support/rejections";

const leaves = (error: unknown): unknown[] => error instanceof AggregateError ? error.errors.flatMap(leaves) : [error];

it("releases confirmed old follow-up Engines and shuts down the actual reopened owner before removing its root", async () => {
  const f = createFollowUpFixtures();
  let oldShutdown: ReturnType<typeof spyOn> | undefined;
  try {
    const world = await f.open(), old = world.engine;
    await f.reopen(world);
    oldShutdown = spyOn(old, "shutdown").mockImplementation(() => { throw new Error("A completed Engine was retained"); });
    const current = world.engine;
    expect(existsSync(world.root)).toBe(true);
    await f.close();
    expect(oldShutdown.mock.calls).toEqual([]);
    expect(current.stopped).toBe(true);
    expect(existsSync(world.root)).toBe(false);
  } finally { oldShutdown?.mockRestore(); await f.close(); }
});

it("settles peer follow-up shutdowns and retains the root whose actual shutdown rejected", async () => {
  const f = createFollowUpFixtures(), failure = new Error("The owned Engine stop could not be confirmed");
  let first: Awaited<ReturnType<typeof f.open>> | undefined, second: typeof first;
  let stop: ReturnType<typeof spyOn> | undefined;
  try {
    first = await f.open(); second = await f.open();
    stop = spyOn(first.engine, "shutdown").mockImplementation(() => Promise.reject(failure));
    expect(leaves(await rejectionOf(f.close()))).toEqual([failure]);
    expect(existsSync(first.root)).toBe(true);
    expect(second.engine.stopped).toBe(true);
    expect(existsSync(second.root)).toBe(false);
  } finally {
    stop?.mockRestore();
    // Restore and await actual cleanup before removing this intentionally retained diagnostic root.
    if (first) await f.shutdown(first.engine);
    if (second) await f.shutdown(second.engine);
    try { await f.close(); }
    catch (error) { if (!leaves(error).every(leaf => leaf === failure)) throw error; }
    if (first) removeDir(first.root);
  }
});

it("awaits the actual served stop while settling every Engine and retaining cleanup failures", async () => {
  const f = createWorkflowEventFixtures(), failure = new Error("The first event Engine stop could not be confirmed");
  const released = Promise.withResolvers<void>(), stopping = Promise.withResolvers<void>();
  let first: Awaited<ReturnType<typeof f.served>> | undefined, peer: ReturnType<typeof f.fixture> | undefined;
  let engineStop: ReturnType<typeof spyOn> | undefined, serverStop: ReturnType<typeof spyOn> | undefined;
  let closing: Promise<void> | undefined;
  try {
    first = await f.served(); peer = f.fixture();
    const actualStop = first.server.stop.bind(first.server);
    serverStop = spyOn(first.server, "stop").mockImplementation(async (active?: boolean) => {
      await actualStop(active); stopping.resolve(); await released.promise;
    });
    engineStop = spyOn(first.e, "shutdown").mockImplementation(() => Promise.reject(failure));
    let closed = false;
    closing = f.close().finally(() => { closed = true; });
    void closing.catch(() => undefined);
    await Promise.race([stopping.promise, closing.then(() => { throw new Error("The real served stop never started"); })]);
    expect(closed).toBe(false);
    expect(existsSync(first.home)).toBe(true);
    released.resolve();
    expect(leaves(await rejectionOf(closing))).toEqual([failure]);
    expect(serverStop.mock.calls).toEqual([[true]]);
    expect(peer.e.stopped).toBe(true);
    expect(existsSync(peer.home)).toBe(false);
    expect(existsSync(first.home)).toBe(true);
  } finally {
    released.resolve();
    if (closing) await closing.catch(() => undefined);
    engineStop?.mockRestore(); serverStop?.mockRestore();
    if (first) { await f.stopServer(first.server); await f.shutdown(first.e); }
    if (peer) await f.shutdown(peer.e);
    try { await f.close(); }
    catch (error) { if (!leaves(error).every(leaf => leaf === failure)) throw error; }
    if (first) removeDir(first.home);
  }
});
