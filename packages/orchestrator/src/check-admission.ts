import type { CheckPlace, CheckQueue } from "./check-queue.js";

/** Observations and notices are bound to the requesting task before admission can yield. */
export interface CheckAdmissionEffects {
  stopped(): boolean;
  prerequisite(): boolean;
  closed(): boolean;
  draining(): boolean;
  reason(): string;
  subscribe(changed: () => void): () => void;
  onWait(closed?: string): void;
  admitted(): void;
}

/** Reserve and recheck the original FIFO position; a pool pause does not create a new arrival. */
export async function acquireCheckPlace(queue: CheckQueue, signal: AbortSignal, order: number, effects: CheckAdmissionEffects): Promise<CheckPlace> {
  if (signal.aborted || effects.stopped()) throw queue.errors.aborted();
  if (effects.prerequisite()) throw queue.errors.unavailable(effects.reason());
  const prerequisite = new AbortController();
  const admissionSignal = AbortSignal.any([signal, prerequisite.signal]);
  const unsubscribe = effects.subscribe(() => { if (effects.prerequisite()) prerequisite.abort(); });
  let waited = false;
  try {
    for (;;) {
      const finished = await queue.acquire(admissionSignal, false, order, effects.onWait.bind(effects));
      waited ||= finished.waited;
      if (signal.aborted || effects.stopped()) {
        finished();
        throw queue.errors.aborted();
      }
      if (!effects.closed()) {
        effects.admitted();
        return Object.assign(finished, { waited });
      }
      finished();
      if (effects.prerequisite() || effects.draining()) throw queue.errors.unavailable(effects.reason());
      waited = true;
    }
  } catch (error) {
    if (prerequisite.signal.aborted && !signal.aborted && !effects.stopped()) throw queue.errors.unavailable(effects.reason());
    throw error;
  } finally { unsubscribe(); }
}
