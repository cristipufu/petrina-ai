/** In-process fixture coordination: explicit releases, with no polling or shared files. */
export class ReleaseEvents {
  private readonly released = new Set<string>();
  private readonly waiting = new Map<string, Set<() => void>>();

  wait(key: string, signal: AbortSignal): Promise<void> {
    const cancelled = () => new Error("The scripted release was cancelled");
    if (signal.aborted) return Promise.reject(cancelled());
    if (this.released.has(key)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const listeners = this.waiting.get(key) ?? new Set<() => void>();
      const cleanup = () => {
        signal.removeEventListener("abort", abort);
        listeners.delete(release);
        if (!listeners.size) this.waiting.delete(key);
      };
      const release = () => { cleanup(); resolve(); };
      const abort = () => { cleanup(); reject(cancelled()); };
      listeners.add(release);
      this.waiting.set(key, listeners);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  release(key: string): void {
    this.released.add(key);
    for (const release of [...this.waiting.get(key) ?? []]) release();
  }
}
