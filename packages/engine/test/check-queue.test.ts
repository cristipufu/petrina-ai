import { expect, it } from "bun:test";
import { CheckQueue } from "../src/check-queue.js";
import { Aborted } from "../src/kernel.js";
import { WaitingForUsage } from "../src/usage.js";

for (const limit of [1, 2]) for (const extra of [false, true]) for (const finishesDuringPause of [false, true]) {
  it(`keeps waiting checks in order when capacity frees ${finishesDuringPause ? "during" : "after"} a pause, including arrivals while closed (limit ${limit}, extra ${extra})`, async () => {
    let closed: string | undefined;
    const queue = new CheckQueue(() => limit, () => closed);
    const controller = new AbortController();
    const places: (() => void)[] = [];
    const outcomes: string[] = [];
    const enter = (name: string, persistent = false) => queue.acquire(controller.signal, persistent).then(place => {
      places.push(place); outcomes.push(name); return place;
    }, () => { outcomes.push(`${name} rejected`); return undefined; });
    try {
      for (let i = 0; i < limit; i++) places.push(await queue.acquire(controller.signal));
      const waiting = enter("waiting product check");
      const laterExtra = extra ? enter("extra validation", true) : undefined;
      closed = "Waiting for the pool to resume"; queue.pump();
      if (finishesDuringPause) places[0]!();
      const arrival = enter("product check arriving while closed");
      // Observations need only a continuation, never a real pause or a guessed sleep.
      await Promise.resolve();
      expect(outcomes).toEqual([]);
      expect(queue.running).toBe(limit - Number(finishesDuringPause));
      expect(queue.waiting).toBe(extra ? 3 : 2);
      closed = undefined; queue.pump();
      expect(outcomes).toEqual([]);
      if (!finishesDuringPause) places[0]!();
      const productPlace = await waiting;
      expect(productPlace).toBeDefined();
      expect(outcomes).toEqual(["waiting product check"]);
      expect(queue.running).toBe(limit);
      productPlace!();
      if (laterExtra) {
        const extraPlace = await laterExtra;
        expect(extraPlace).toBeDefined();
        expect(outcomes).toEqual(["waiting product check", "extra validation"]);
        expect(queue.running).toBe(limit);
        extraPlace!();
      }
      (await arrival)!();
      expect(outcomes).toEqual(["waiting product check", ...(extra ? ["extra validation"] : []), "product check arriving while closed"]);
    } finally {
      controller.abort();
      places.forEach(release => release());
    }
    expect(queue.running).toBe(0);
    expect(queue.waiting).toBe(0);
  });
}

for (const heldCleanup of [false, true]) it(`drains ordinary waiters after a pause, leaving durable extra work queued${heldCleanup ? " even while cleanup holds capacity" : ""}`, async () => {
  let closed: string | undefined;
  let draining = false;
  const queue = new CheckQueue(() => 1, () => closed, () => draining);
  const controller = new AbortController();
  const first = await queue.acquire(controller.signal);
  const ordinary = queue.acquire(controller.signal).then(() => undefined, error => error);
  const extra = queue.acquire(controller.signal, true);
  closed = "Waiting for the pool to resume";
  first();
  await Promise.resolve();
  expect(queue.waiting).toBe(2);
  expect(queue.running).toBe(0);
  const releaseHeld = heldCleanup ? queue.hold() : () => {};
  const unblock = heldCleanup ? queue.block() : () => {};
  draining = true; closed = "Waiting: Petrina is restarting"; queue.pump();
  expect(await ordinary).toBeInstanceOf(WaitingForUsage);
  expect(queue.running).toBe(Number(heldCleanup));
  expect(queue.waiting).toBe(1);
  releaseHeld(); unblock();
  expect(queue.running).toBe(0);
  draining = false; closed = undefined; queue.pump();
  (await extra)();
  expect(queue.running).toBe(0);
});

it("removes a cancelled product waiter during a pause without consuming or reordering capacity", async () => {
  let closed: string | undefined = "Waiting for the pool to resume";
  const queue = new CheckQueue(() => 1, () => closed);
  const cancelled = new AbortController();
  const product = queue.acquire(cancelled.signal).then(() => undefined, error => error);
  const extra = queue.acquire(new AbortController().signal, true);
  cancelled.abort();
  expect(await product).toBeInstanceOf(Aborted);
  expect(queue.running).toBe(0);
  expect(queue.waiting).toBe(1);
  closed = undefined; queue.pump();
  (await extra)();
  expect(queue.running).toBe(0);
});
