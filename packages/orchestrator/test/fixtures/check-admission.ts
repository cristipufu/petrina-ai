import { CheckQueue } from "../../src/check-queue.js";
import { acquireCheckPlace } from "../../src/check-admission.js";
export class Aborted extends Error {}
export class WaitingForUsage extends Error {}

/** Explicit admission observations, not a fake Engine or repository. */
export function checkAdmission(limit = 1) {
 const listeners = new Set<() => void>();
 let paused = false;
 const state = { draining: false };
 const queue = new CheckQueue(() => limit, () => paused || state.draining ? "Waiting for the pool to resume" : undefined,
   () => state.draining, { aborted: () => new Aborted(), unavailable: words => new WaitingForUsage(words) });
 return { state, queue,
  pause(value: boolean) { paused = value; for (const listener of listeners) listener(); queue.pump(); },
  acquire(signal = new AbortController().signal) { return acquireCheckPlace(queue, signal, queue.reserveOrder(), {
   stopped: () => false, prerequisite: () => false, closed: () => paused || state.draining,
   draining: () => state.draining, reason: () => "Waiting for the pool to resume",
   subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
   onWait() {}, admitted() {},
  }); },
 };
}
