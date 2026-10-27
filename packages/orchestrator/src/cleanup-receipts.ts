interface Failure { error: unknown }
interface CleanupBlocker {
  taskId: string;
  resource?: string;
  state: "pending" | "failed";
  failure?: Failure;
}
function completion() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
  return { promise, resolve, reject };
}
interface Receipt {
  taskId: string;
  resource?: string;
  done: ReturnType<typeof completion>;
  native?: Promise<void>;
  stop?: Promise<void>;
  stopSettled?: boolean;
  pending: boolean;
  nativeFailure?: Failure;
  stopFailure?: Failure;
  incomplete?: Failure;
  combined?: { native: Failure; stop: Failure; failure: Failure };
}

/** Resource cleanup authority survives the agent's scheduling entry and belongs to one task. */
export class CleanupReceipts {
  private readonly owners = new WeakMap<object, Receipt>();
  private readonly active = new Set<Receipt>();

  private receipt(taskId: string, owner: object, resource?: string): Receipt {
    const previous = this.owners.get(owner);
    if (previous) {
      if (previous.taskId !== taskId || previous.resource !== resource) throw new Error("A cleanup owner cannot move to another task or working copy");
      return previous;
    }
    const receipt: Receipt = { taskId, ...(resource !== undefined ? { resource } : {}), done: completion(), pending: true };
    void receipt.done.promise.catch(() => undefined);
    this.owners.set(owner, receipt);
    this.active.add(receipt);
    return receipt;
  }

  private failure(receipt: Receipt): Failure | undefined {
    if (receipt.nativeFailure && receipt.stopFailure && !Object.is(receipt.nativeFailure.error, receipt.stopFailure.error)) {
      if (receipt.combined?.native !== receipt.nativeFailure || receipt.combined.stop !== receipt.stopFailure) {
        receipt.combined = { native: receipt.nativeFailure, stop: receipt.stopFailure,
          failure: { error: new AggregateError([receipt.nativeFailure.error, receipt.stopFailure.error], "Native cleanup and its stop both failed") } };
      }
      return receipt.combined.failure;
    }
    return receipt.stopFailure ?? receipt.nativeFailure ?? receipt.incomplete;
  }

  private settle(receipt: Receipt): void {
    const failure = this.failure(receipt);
    receipt.pending = !!receipt.stop && !receipt.stopSettled;
    if (failure) { this.active.add(receipt); receipt.done.reject(failure.error); }
    else { this.active.delete(receipt); receipt.done.resolve(); }
  }

  /** The adapter's completion confirms all native ownership, including a failed opening. */
  observe(taskId: string, owner: object, gone: Promise<void>, resource?: string): void {
    const receipt = this.receipt(taskId, owner, resource);
    if (receipt.native) {
      if (receipt.native !== gone) throw new Error("A cleanup owner reported two different native completions");
      return;
    }
    receipt.native = gone;
    void gone.then(() => {
      if (!receipt.stop) this.settle(receipt);
    }, error => {
      receipt.nativeFailure = { error };
      // A failed bounded stop can leave the native exit pending forever. Failure
      // releases the waiter with uncertainty, never with permission to delete files.
      this.settle(receipt);
    });
  }

  incomplete(taskId: string, owner: object, resource?: string): void {
    const receipt = this.receipt(taskId, owner, resource);
    receipt.incomplete ??= { error: new Error("Agent cleanup was not confirmed") };
    this.settle(receipt);
  }

  /** Publish before invoking stop, preserve its receiver at the caller, and request it only once. */
  request(taskId: string, owner: object, stop: () => Promise<boolean>, resource?: string): Promise<void> {
    const receipt = this.receipt(taskId, owner, resource);
    if (receipt.stop) return receipt.stop;
    const result = completion();
    receipt.stop = result.promise;
    receipt.pending = true;
    this.active.add(receipt);
    void result.promise.catch(() => undefined);
    // Known uncertainty must wake callers even if the adapter's raw stop or native
    // exit never settles. The raw operation stays observed and its owner retained.
    void receipt.done.promise.catch(error => result.reject(error));
    const finish = (failure?: Failure) => {
      receipt.stopSettled = true;
      if (failure) receipt.stopFailure = failure;
      this.settle(receipt);
      const error = this.failure(receipt);
      if (error) result.reject(error.error);
      else result.resolve();
    };
    try {
      void Promise.resolve(stop()).then(confirmed => {
        if (confirmed !== true) receipt.incomplete ??= { error: new Error("Agent cleanup was not confirmed") };
        finish();
      }, error => finish({ error }));
    } catch (error) { finish({ error }); }
    return result.promise;
  }

  /** Join all selected receipts, including any stop registered while the first snapshot settled. */
  async wait(taskId?: string, resource?: string): Promise<void> {
    const matches = (receipt: Receipt) => (taskId === undefined || receipt.taskId === taskId)
      && (resource === undefined || receipt.resource === resource);
    const seen = new Set<Promise<void>>();
    for (;;) {
      const pending = [...this.active].filter(matches).map(receipt => receipt.stop ?? receipt.done.promise).filter(work => !seen.has(work));
      if (!pending.length) break;
      pending.forEach(work => seen.add(work));
      await Promise.allSettled(pending);
    }
    const failure = this.snapshot(taskId, resource).failure;
    if (failure) throw failure.error;
  }

  /** In-memory failure is retained ownership, rather than work that can finish by waiting. */
  snapshot(taskId?: string, resource?: string): { waiting: number; blockers: CleanupBlocker[]; failure?: Failure } {
    const blockers: CleanupBlocker[] = [...this.active]
      .filter(receipt => (taskId === undefined || receipt.taskId === taskId) && (resource === undefined || receipt.resource === resource))
      .map(receipt => {
        const failure = this.failure(receipt);
        return { taskId: receipt.taskId, ...(receipt.resource !== undefined ? { resource: receipt.resource } : {}),
          state: failure ? "failed" : "pending", ...(failure ? { failure } : {}) };
      });
    const errors = blockers.flatMap(blocker => blocker.failure ? [blocker.failure.error] : []);
    const failure = errors.length === 1 ? { error: errors[0] } : errors.length
      ? { error: new AggregateError(errors, "Agent cleanup was not confirmed for every owner") } : undefined;
    return { waiting: blockers.length - errors.length, blockers, ...(failure ? { failure } : {}) };
  }

  has(taskId: string): boolean { return [...this.active].some(receipt => receipt.taskId === taskId); }
  get size(): number { return this.active.size; }
  get pending(): number { return [...this.active].filter(receipt => receipt.pending).length; }
}
