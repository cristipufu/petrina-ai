export type CheckPlace = (() => void) & { waited: boolean };
type Entry = { order: number; signal: AbortSignal; persistent: boolean; go: (place: CheckPlace) => void; fail: (error: Error) => void; stop: () => void; waited: boolean; onWait?: (closed?: string) => void };

/** One FIFO for every host check workload. Handoff reserves capacity synchronously. */
export interface CheckQueueErrors { aborted(): Error; unavailable(reason: string): Error }

export class CheckQueue {
  running = 0;
  private readonly line: Entry[] = [];
  private blocked = 0;
  private order = 0;
  constructor(private readonly limit: () => number, private readonly closed: () => string | undefined, private readonly draining: () => boolean, readonly errors: CheckQueueErrors) {}

  get waiting(): number { return this.line.length; }
  get position(): number { return this.running + this.line.length + 1; }
  positionFor(order: number): number { return this.running + this.line.filter(entry => entry.order < order).length + 1; }

  reserveOrder(): number { return ++this.order; }
  restoreOrder(order: number): void { this.order = Math.max(this.order, order); }

  acquire(signal: AbortSignal, persistent = false, order = this.reserveOrder(), onWait?: Entry["onWait"]): Promise<CheckPlace> {
    if (signal.aborted) return Promise.reject(this.errors.aborted());
    const closed = this.closed();
    return new Promise((go, fail) => {
      const entry: Entry = { order, signal, persistent, go, fail, onWait, waited: !!closed || !!this.blocked || this.running >= this.limit() || !!this.line.length,
        stop: () => {
          const index = this.line.indexOf(entry);
          if (index >= 0) { this.line.splice(index, 1); fail(this.errors.aborted()); }
        } };
      this.line.push(entry);
      this.line.sort((a, b) => a.order - b.order);
      signal.addEventListener("abort", entry.stop, { once: true });
      this.pump();
    });
  }

  /** A recovered or unconfirmed workload owns capacity even while the engine is paused. */
  hold(): () => void {
    this.running++;
    return this.release();
  }

  block(): () => void {
    this.blocked++;
    let done = false;
    return () => { if (!done) { done = true; this.blocked--; this.pump(); } };
  }

  pump(): void {
    const closed = this.closed();
    if (closed) {
      // Pausing preserves every entry, even after capacity frees. A stop/restart drains
      // ordinary callers; durable extra requests remain queued for the next start.
      if (!this.draining()) {
        for (const entry of [...this.line]) entry.onWait?.(closed);
        return;
      }
      for (const entry of [...this.line]) if (!entry.persistent) {
        this.line.splice(this.line.indexOf(entry), 1);
        entry.signal.removeEventListener("abort", entry.stop);
        entry.fail(this.errors.unavailable(closed));
      }
      return;
    }
    while (!this.blocked && this.running < Math.max(1, this.limit()) && this.line.length) {
      const entry = this.line.shift()!;
      entry.signal.removeEventListener("abort", entry.stop);
      if (entry.signal.aborted) { entry.fail(this.errors.aborted()); continue; }
      this.running++;
      entry.go(Object.assign(this.release(), { waited: entry.waited }));
    }
    // Retaining a place must not hide changes to the reason it cannot start.
    for (const entry of [...this.line]) entry.onWait?.();
  }

  private release(): () => void {
    let done = false;
    return () => { if (!done) { done = true; this.running--; this.pump(); } };
  }
}
