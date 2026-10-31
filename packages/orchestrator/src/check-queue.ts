export type CheckPlace = (() => void) & { waited: boolean };
/** Whose turn a place is: a task's ordinary checks or one extra validation. Read only to describe the line. */
export interface CheckOwner {
  taskId: string;
  productId?: string;
  kind: "checks" | "extra";
  validationId?: string;
}
type Entry = {
  order: number;
  signal: AbortSignal;
  persistent: boolean;
  owner?: CheckOwner;
  go: (place: CheckPlace) => void;
  fail: (error: Error) => void;
  stop: () => void;
  waited: boolean;
  onWait?: (closed?: string) => void;
};
type Held = { owner?: CheckOwner; hold?: true };

/** Who holds each place, the cleanup blocks and who waits, in order. Describing the line never changes it. */
export interface CheckLineView {
  limit: number;
  closed?: string;
  /** Admitted places, and places a recovered or unconfirmed workload holds (`hold`). */
  running: readonly Held[];
  /** Cleanup blocks: no place is handed out while any remains. */
  blocks: readonly (CheckOwner | undefined)[];
  waiting: readonly { order: number; owner?: CheckOwner }[];
}

/** One FIFO for every host check workload. Handoff reserves capacity synchronously. */
export interface CheckQueueErrors {
  aborted(): Error;
  unavailable(reason: string): Error;
}

export class CheckQueue {
  running = 0;
  private readonly line: Entry[] = [];
  private readonly places = new Set<Held>();
  private readonly blocks = new Set<{ owner?: CheckOwner }>();
  private order = 0;
  constructor(
    private readonly limit: () => number,
    private readonly closed: () => string | undefined,
    private readonly draining: () => boolean,
    readonly errors: CheckQueueErrors,
  ) {}

  get waiting(): number {
    return this.line.length;
  }
  get position(): number {
    return this.running + this.line.length + 1;
  }
  positionFor(order: number): number {
    return this.running + this.line.filter((entry) => entry.order < order).length + 1;
  }
  /** Whether this arrival order is a real member of the line now, waiting for a place. */
  has(order: number): boolean {
    return this.line.some((entry) => entry.order === order);
  }

  view(): CheckLineView {
    const closed = this.closed();
    return {
      limit: Math.max(1, this.limit()),
      ...(closed ? { closed } : {}),
      running: [...this.places],
      blocks: [...this.blocks].map((block) => block.owner),
      waiting: this.line.map((entry) => ({ order: entry.order, ...(entry.owner ? { owner: entry.owner } : {}) })),
    };
  }

  reserveOrder(): number {
    return ++this.order;
  }
  restoreOrder(order: number): void {
    this.order = Math.max(this.order, order);
  }

  acquire(signal: AbortSignal, persistent = false, order = this.reserveOrder(), onWait?: Entry["onWait"], owner?: CheckOwner): Promise<CheckPlace> {
    if (signal.aborted) return Promise.reject(this.errors.aborted());
    const closed = this.closed();
    return new Promise((go, fail) => {
      const entry: Entry = {
        order,
        signal,
        persistent,
        owner,
        go,
        fail,
        onWait,
        waited: !!closed || !!this.blocks.size || this.running >= this.limit() || !!this.line.length,
        stop: () => {
          const index = this.line.indexOf(entry);
          if (index >= 0) {
            this.line.splice(index, 1);
            fail(this.errors.aborted());
            this.refresh();
          }
        },
      };
      this.line.push(entry);
      this.line.sort((a, b) => a.order - b.order);
      signal.addEventListener("abort", entry.stop, { once: true });
      this.pump();
    });
  }

  /** A recovered or unconfirmed workload owns capacity even while the engine is paused. */
  hold(owner?: CheckOwner): () => void {
    const place: Held = { ...(owner ? { owner } : {}), hold: true };
    this.places.add(place);
    this.running++;
    this.refresh();
    return this.release(place);
  }

  block(owner?: CheckOwner): () => void {
    const block = { ...(owner ? { owner } : {}) };
    this.blocks.add(block);
    this.refresh();
    let done = false;
    return () => {
      if (!done) {
        done = true;
        this.blocks.delete(block);
        this.pump();
      }
    };
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
      for (const entry of [...this.line])
        if (!entry.persistent) {
          this.line.splice(this.line.indexOf(entry), 1);
          entry.signal.removeEventListener("abort", entry.stop);
          entry.fail(this.errors.unavailable(closed));
        }
      return;
    }
    while (!this.blocks.size && this.running < Math.max(1, this.limit()) && this.line.length) {
      const entry = this.line.shift()!;
      entry.signal.removeEventListener("abort", entry.stop);
      if (entry.signal.aborted) {
        entry.fail(this.errors.aborted());
        continue;
      }
      const place: Held = { ...(entry.owner ? { owner: entry.owner } : {}) };
      this.places.add(place);
      this.running++;
      entry.go(Object.assign(this.release(place), { waited: entry.waited }));
    }
    // Retaining a place must not hide changes to the reason it cannot start.
    for (const entry of [...this.line]) entry.onWait?.();
  }

  /** Tell every waiter the line changed, without handing out a place or changing order. */
  refresh(): void {
    const closed = this.closed();
    if (closed && this.draining()) return;
    for (const entry of [...this.line]) entry.onWait?.(closed);
  }

  private release(place: Held): () => void {
    let done = false;
    return () => {
      if (!done) {
        done = true;
        this.places.delete(place);
        this.running--;
        this.pump();
      }
    };
  }
}
