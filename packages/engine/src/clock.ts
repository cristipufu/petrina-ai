import type { ScreenClock } from "@petrina/orchestrator";

/** Native timer handles stay in the host; controllers receive only a cancellation operation. */
export const runtimeClock: ScreenClock = {
  now: () => Date.now(),
  after(ms, callback) {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
};
