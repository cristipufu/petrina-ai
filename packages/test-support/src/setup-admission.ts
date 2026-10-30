/**
 * A worker can receive many finished Git commands at once. Their callers must not immediately run
 * a whole batch of synchronous engine constructors: SQLite can wait for storage in every one.
 * Admit just one synchronous setup step per turn, servicing native completions and timers between
 * steps. Tests and the programs they await keep running concurrently.
 */
export class SetupSteps {
  private readonly line: { go(release: () => void): void; stop(): void }[] = [];
  private busy = false;

  constructor(private readonly defer: (work: () => void) => void) {}

  async run<T>(work: () => T, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const release = await new Promise<() => void>((resolve, reject) => {
      const entry = {
        go: (release: () => void) => {
          signal?.removeEventListener("abort", entry.stop);
          resolve(release);
        },
        stop: () => {
          const index = this.line.indexOf(entry);
          if (index >= 0) this.line.splice(index, 1);
          signal?.removeEventListener("abort", entry.stop);
          reject(signal?.reason);
        },
      };
      this.line.push(entry);
      signal?.addEventListener("abort", entry.stop, { once: true });
      this.next();
    });
    try {
      signal?.throwIfAborted();
      return work();
    } finally { release(); }
  }

  private next(): void {
    if (this.busy || !this.line.length) return;
    this.busy = true;
    // One pause in every caller would still release the entire batch together. Only the current
    // step grants the next turn; the timer and immediate leave a native poll between admissions.
    this.defer(() => {
      const entry = this.line.shift();
      if (!entry) {
        this.busy = false;
        return;
      }
      let released = false;
      entry.go(() => {
        if (released) return;
        released = true;
        this.busy = false;
        this.next();
      });
    });
  }
}
