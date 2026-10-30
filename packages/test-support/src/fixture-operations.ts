import type { ProcessDeadline } from "@petrina/platform/process-capabilities";

export interface FixtureOperationEffects {
  /** Request the actual owners to stop. Resolution is observed separately from every started operation. */
  stop(): void | Promise<void>;
  /** Dispose private resources only after stop and every owned operation fulfilled. */
  dispose(): void | Promise<void>;
  arm: ProcessDeadline;
  allowanceMs: number;
  label: string;
}

interface Settlement { failed: boolean; error?: unknown }

/** Test-owned operations omitted from an application's own drain; callers retain their actual result promises. */
export class FixtureOperations {
  private readonly settlements = new Set<Promise<Settlement>>();
  private readonly errors: unknown[] = [];
  private accepting = true;
  private closing?: Promise<void>;

  constructor(private readonly effects: FixtureOperationEffects) {
    if (!(Number.isFinite(effects.allowanceMs) && effects.allowanceMs > 0 && effects.allowanceMs <= 2_147_483_647))
      throw new RangeError("Fixture operations need a finite positive cleanup allowance");
  }

  private observe(work: Promise<unknown>): Promise<Settlement> {
    return work.then(() => ({ failed: false }), error => {
      this.errors.push(error);
      return { failed: true, error };
    });
  }

  run<T>(start: () => Promise<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(new Error(`${this.effects.label} is closing; no new operation may start`));
    let publish!: (result: Settlement) => void;
    // start may synchronously request close; ownership must already exist at that point.
    const settlement = new Promise<Settlement>(resolve => { publish = resolve; });
    this.settlements.add(settlement);
    let work: Promise<T>;
    try { work = start(); }
    catch (error) { work = Promise.reject(error); }
    // Settlement records fulfill even for rejection; the original promise still rejects to its caller.
    void this.observe(work).then(publish);
    return work;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    // Publish both closed admission and the closing identity before stop can re-enter either method.
    this.accepting = false;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    this.closing = new Promise<void>((done, failed) => {
      resolve = done;
      reject = failed;
    });
    // stop is still requested synchronously; only its completion is asynchronous.
    void this.finish().then(resolve, reject);
    return this.closing;
  }

  private async finish(): Promise<void> {
    let stop: Promise<void>;
    try { stop = Promise.resolve(this.effects.stop()); }
    catch (error) { stop = Promise.reject(error); }
    // Observe stop and all operations even when the deadline wins or one rejects first.
    const all = Promise.all([...this.settlements, this.observe(stop)]);
    const expired = Symbol("fixture operations cleanup expired");
    let cancel = () => {};
    let outcomes: Settlement[] | typeof expired;
    try {
      outcomes = await Promise.race([all, new Promise<typeof expired>(resolve => {
        cancel = this.effects.arm(() => resolve(expired), this.effects.allowanceMs);
      })]);
    } catch (error) {
      throw new AggregateError([...this.errors, error], `${this.effects.label}: cleanup could not be confirmed; resources retained`);
    } finally { cancel(); }
    if (outcomes === expired)
      throw new AggregateError(
        [
        ...this.errors,
        new Error("Owned fixture operations did not settle within their cleanup allowance")
      ],
        `${this.effects.label}: cleanup could not be confirmed; resources retained`
      );
    if (outcomes.some(result => result.failed))
      throw new AggregateError(
        outcomes.filter(result => result.failed).map(result => result.error),
        `${this.effects.label}: cleanup failed; resources retained`
      );
    await this.effects.dispose();
  }
}
