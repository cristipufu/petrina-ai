import { expect, it } from "bun:test";
import { runtimeClock } from "../../../src/clock.js";
import { SLOW } from "@petrina/test-support/slow";

it("delivers native deadlines after the current operation and cancels an earlier due callback", async () => {
  let delivered = false, cancelled = false;
  const before = runtimeClock.now(), cancel = runtimeClock.after(0, () => { cancelled = true; });
  cancel(); cancel();
  const delivery = new Promise<void>(resolve => { runtimeClock.after(3, () => { delivered = true; resolve(); }); });
  expect(delivered).toBe(false); await Promise.resolve(); expect(delivered).toBe(false);
  await delivery; expect(delivered).toBe(true); expect(cancelled).toBe(false); expect(runtimeClock.now()).toBeGreaterThanOrEqual(before);
}, 30_000 * SLOW);
