import { expect, it } from "bun:test";
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
