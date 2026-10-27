import { afterEach, expect, it, spyOn } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { completeAll } from "@petrina/core";
import * as fixtureCommands from "../../fixtures.js";
import { removeFixtureRoot } from "@petrina/test-support/fixture-roots";
import { rejectionOf } from "@petrina/test-support/rejections";
import { reviewContextFixtures } from "../../fixtures/review-context.js";

const leaves = (error: unknown): unknown[] => error instanceof AggregateError ? error.errors.flatMap(leaves) : [error];
const attemptAll = (...steps: (() => unknown)[]) => completeAll(steps.map(async step => { await step(); })).then(() => undefined);
const owners = new Set<() => Promise<void>>();
afterEach(() => completeAll([...owners].map(async close => close())));
function fixture(release: () => void = () => {}) {
  const f = reviewContextFixtures();
  const close = () => attemptAll(release, () => f.close());
  owners.add(close);
  return { ...f, acknowledgeClosed: () => owners.delete(close) };
}

it("releases a confirmed review Engine owner before removing its private root", async () => {
  const f = fixture();
  let completedStop: ReturnType<typeof spyOn> | undefined;
  try {
    const world = await f.bare(async world => world);
    await world.shutdown();
    completedStop = spyOn(world.engine, "shutdown").mockImplementation(() => { throw new Error("A completed review Engine was retained"); });
    expect(existsSync(world.root)).toBe(true);
    await f.close();
    expect(completedStop.mock.calls).toEqual([]);
    expect(existsSync(world.root)).toBe(false);
  } finally { await attemptAll(() => completedStop?.mockRestore(), () => f.close()); f.acknowledgeClosed(); }
});

it("settles actual peer review Engines and retains the root whose shutdown rejected", async () => {
  const f = fixture(), failure = new Error("The review Engine stop could not be confirmed");
  let first: Parameters<Parameters<typeof f.bare>[0]>[0] | undefined, peer: typeof first;
  let stop: ReturnType<typeof spyOn> | undefined;
  let actualStop: (() => Promise<void>) | undefined, verifiedFailure = false;
  try {
    first = await f.bare(async world => world); peer = await f.bare(async world => world);
    actualStop = first.engine.shutdown.bind(first.engine);
    stop = spyOn(first.engine, "shutdown").mockImplementation(() => Promise.reject(failure));
    expect(leaves(await rejectionOf(f.close()))).toEqual([failure]);
    verifiedFailure = true;
    expect(existsSync(first.root)).toBe(true);
    expect(peer.engine.stopped).toBe(true);
    expect(existsSync(peer.root)).toBe(false);
  } finally {
    // Confirm actual cleanup before removing the intentionally retained diagnostic root.
    await attemptAll(() => stop?.mockRestore(), () => actualStop?.(), () => peer?.shutdown(), async () => {
      try { await f.close(); }
      catch (error) { if (!verifiedFailure || !leaves(error).every(leaf => leaf === failure)) throw error; }
    });
    if (first) removeFixtureRoot(first.root);
    f.acknowledgeClosed();
  }
});

it("joins repository setup and refuses a late Engine after review fixture admission closes", async () => {
  const released = Promise.withResolvers<void>();
  let restore = () => {};
  const f = fixture(() => { released.resolve(); restore(); });
  const original = fixtureCommands.makeProduct;
  let root: string | undefined, handedOut = 0, closeFinished = false;
  const observed = <T>(work: Promise<T>) => work.then(value => ({ kind: "value" as const, value }), error => ({ kind: "error" as const, error }));
  let opened: ReturnType<typeof observed<void>> | undefined, closed: typeof opened;
  try {
    const make = spyOn(fixtureCommands, "makeProduct");
    restore = () => make.mockRestore();
    make.mockImplementation(async (...args) => {
      const repo = await original(...args);
      root = args[0];
      await released.promise;
      return repo;
    });
    const opening = f.bare(async () => { handedOut++; });
    opened = observed(opening);
    await fixtureCommands.waitFor(() => root, "the actual repository setup before Engine construction", undefined, { during: opening });
    closed = observed(f.close().finally(() => { closeFinished = true; }));
    // Drain queued microtasks without guessing how many the owner/cleanup chain uses.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(closeFinished).toBe(false);
    expect(existsSync(root!)).toBe(true);
    released.resolve();
    const [startResult, closeResult] = await Promise.all([opened, closed]);
    expect(startResult.kind).toBe("error"); expect(closeResult.kind).toBe("error");
    if (startResult.kind !== "error" || closeResult.kind !== "error") throw new Error("Closed setup handed out an Engine or discarded its failed owner");
    const failed = leaves(closeResult.error);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toBeInstanceOf(Error);
    expect((failed[0] as Error).message).toBe("Direct-driver fixture is closing; no Engine may open");
    expect(leaves(startResult.error).every(error => error === failed[0])).toBe(true);
    expect(handedOut).toBe(0);
    expect(existsSync(join(root!, "data"))).toBe(false);
    expect(existsSync(root!)).toBe(true);
    // The real Git setup and both observed calls settled, and no Engine was admitted.
    // These independent facts allow disposal of this deliberately retained negative-control root.
    removeFixtureRoot(root!);
    f.acknowledgeClosed();
  } finally {
    await attemptAll(() => released.resolve(), restore, () => opened, () => closed);
  }
});
