import { expect, it } from "bun:test";
import { rejectionOf } from "../../../src/rejections.js";
import { setupWithCleanup } from "../../../src/setup-with-cleanup.js";

it("transfers successful values, including undefined, without cleaning the returned owner", async () => {
  const owner = { ready: true };
  let cleaned = 0;
  const cleanup = () => { cleaned++; };
  expect(await setupWithCleanup(() => owner, cleanup)).toBe(owner);
  expect(await setupWithCleanup(async () => owner, cleanup)).toBe(owner);
  expect(await setupWithCleanup(async () => undefined, cleanup)).toBeUndefined();
  expect(cleaned).toBe(0);
});

it("waits for the actual asynchronous cleanup before returning the original setup failure", async () => {
  const error = new Error("Setup refused"), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const order: string[] = [];
  let settled = false;
  const owner = { stopped: false, async stop() { order.push("cleanup started"); entered.resolve(); await release.promise; this.stopped = true; order.push("cleanup completed"); } };
  const work = setupWithCleanup(async () => { order.push("setup"); throw error; }, () => owner.stop());
  const failed = rejectionOf(work).then(reason => { settled = true; return reason; });
  await entered.promise;
  expect(order).toEqual(["setup", "cleanup started"]);
  expect(settled).toBe(false);
  expect(owner.stopped).toBe(false);
  release.resolve();
  expect(await failed).toBe(error);
  expect(order).toEqual(["setup", "cleanup started", "cleanup completed"]);
  expect(owner.stopped).toBe(true);
});

it("cleans up a synchronous setup rejection even when the rejection value is undefined", async () => {
  let cleaned = 0;
  const reason = await rejectionOf(setupWithCleanup(() => { throw undefined; }, () => { cleaned++; }));
  expect(cleaned).toBe(1);
  expect(reason).toBeUndefined();
});

it("preserves both failures when synchronous cleanup throws", async () => {
  const setupError = new Error("Setup failed"), cleanupError = new Error("Stop unconfirmed");
  const error = await rejectionOf(setupWithCleanup(() => { throw setupError; }, () => { throw cleanupError; }));
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors).toEqual([setupError, cleanupError]);
});

for (const cleanupError of [undefined, new Error("Async stop unconfirmed")]) it(`preserves ordered async cleanup rejection ${String(cleanupError)}`, async () => {
  const setupError = new Error("Setup failed"), order: string[] = [];
  const error = await rejectionOf(setupWithCleanup(async () => { order.push("setup"); throw setupError; }, async () => { order.push("cleanup"); throw cleanupError; }));
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors).toEqual([setupError, cleanupError]);
  expect(order).toEqual(["setup", "cleanup"]);
});
