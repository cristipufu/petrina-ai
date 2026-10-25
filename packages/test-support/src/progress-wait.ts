export type Completion = { failed: false } | { failed: true; error: unknown };

/** One completion observation for both predicate and file progress; rejection with undefined is still failure. */
export function completionOf(during?: PromiseLike<unknown>) {
  if (!during) return undefined;
  let current: Completion | undefined;
  const listeners = new Set<() => void>();
  const finish = (completed: Completion) => {
    current = completed;
    for (const listener of listeners) listener();
    listeners.clear();
  };
  void Promise.resolve(during).then(
    () => finish({ failed: false }),
    error => finish({ failed: true, error }),
  );
  return { current: () => current, subscribe(listener: () => void) {
    if (current) { listener(); return () => {}; }
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  } };
}

export function completedBeforeProgress(completed: Completion, message: string): never {
  if (completed.failed) throw completed.error;
  throw new Error(message);
}

/** The fixture adapter owns native time; policy tests advance this clock without elapsed-time waits. */
export interface ProgressClock {
  now(): number;
  slow(): number;
  arm(expired: () => void, ms: number): () => void;
  sleep(ms: number): Promise<void>;
}

/** Bound a pending predicate too; the caller still owns cancellation of the underlying operation. */
export async function waitForProgress<T>(check: () => T | undefined | false | Promise<T | undefined | false>, what: string,
  ms: number, { during }: { during?: PromiseLike<unknown> }, clock: ProgressClock): Promise<T> {
  if (!(Number.isFinite(ms) && ms >= 0)) throw new RangeError("A fixture wait needs a finite, nonnegative timeout");
  const owner = completionOf(during), ended = Symbol("owner completed"), timedOut = Symbol("wait timed out");
  const started = clock.now();
  for (;;) {
    // Progress is observed first, including already recorded progress after owner completion.
    const checking = check();
    let unsubscribe = () => {}, cancel = () => {}, stopped = false;
    const deadline = new Promise<typeof timedOut>(resolve => {
      const expire = () => {
        if (stopped) return;
        const left = ms * clock.slow() - (clock.now() - started);
        if (left < 0) resolve(timedOut);
        else cancel = clock.arm(expire, Math.max(1, Math.min(2_147_483_647, left + 1)));
      };
      expire();
    });
    let value: T | undefined | false | typeof ended | typeof timedOut;
    try {
      const contenders: Promise<T | undefined | false | typeof ended | typeof timedOut>[] = [Promise.resolve(checking), deadline];
      if (owner) contenders.push(new Promise<typeof ended>(resolve => {
        unsubscribe = owner.subscribe(() => resolve(ended));
      }));
      value = await Promise.race(contenders);
    } finally { stopped = true; cancel(); unsubscribe(); }
    if (value === ended) completedBeforeProgress(owner!.current()!, "The operation completed before " + what);
    if (value === timedOut) throw new Error("Timed out waiting for " + what);
    if (value) return value as T;
    const completed = owner?.current();
    if (completed) completedBeforeProgress(completed, "The operation completed before " + what);
    if (clock.now() - started > ms * clock.slow()) throw new Error("Timed out waiting for " + what);
    await clock.sleep(50);
  }
}
