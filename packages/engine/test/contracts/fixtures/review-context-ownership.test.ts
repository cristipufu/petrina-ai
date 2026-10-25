import { expect, it, spyOn } from "bun:test";
import { existsSync } from "node:fs";
import { removeDir } from "@petrina/test-support/fixtures";
import { rejectionOf } from "@petrina/test-support/rejections";
import { reviewContextFixtures } from "../../fixtures/review-context.js";

const leaves = (error: unknown): unknown[] => error instanceof AggregateError ? error.errors.flatMap(leaves) : [error];

it("releases a confirmed review Engine owner before removing its private root", async () => {
  const f = reviewContextFixtures();
  let completedStop: ReturnType<typeof spyOn> | undefined;
  try {
    const world = await f.bare();
    await world.shutdown();
    completedStop = spyOn(world.engine, "shutdown").mockImplementation(() => { throw new Error("A completed review Engine was retained"); });
    expect(existsSync(world.root)).toBe(true);
    await f.close();
    expect(completedStop.mock.calls).toEqual([]);
    expect(existsSync(world.root)).toBe(false);
  } finally { completedStop?.mockRestore(); await f.close(); }
});

it("settles actual peer review Engines and retains the root whose shutdown rejected", async () => {
  const f = reviewContextFixtures(), failure = new Error("The review Engine stop could not be confirmed");
  let first: Awaited<ReturnType<typeof f.bare>> | undefined, peer: typeof first;
  let stop: ReturnType<typeof spyOn> | undefined;
  try {
    first = await f.bare(); peer = await f.bare();
    stop = spyOn(first.engine, "shutdown").mockImplementation(() => Promise.reject(failure));
    expect(leaves(await rejectionOf(f.close()))).toEqual([failure]);
    expect(existsSync(first.root)).toBe(true);
    expect(peer.engine.stopped).toBe(true);
    expect(existsSync(peer.root)).toBe(false);
  } finally {
    stop?.mockRestore();
    // Confirm actual cleanup before removing the intentionally retained diagnostic root.
    if (first) await first.shutdown();
    if (peer) await peer.shutdown();
    try { await f.close(); }
    catch (error) { if (!leaves(error).every(leaf => leaf === failure)) throw error; }
    if (first) removeDir(first.root);
  }
});
