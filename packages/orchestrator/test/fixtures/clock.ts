import type { ScreenClock, ToolCheckClock } from "../../src/index.js";

/** Private deterministic deadlines. Advancing snapshots due work; new zero-delay jobs wait for the next advance. */
export class ControlledClock implements ScreenClock, ToolCheckClock {
  at = 100;
  readonly pending = new Set<{ at: number; finish(): void }>();
  now = () => this.at;

  after(ms: number, callback: () => undefined): () => void {
    const entry = { at: this.at + ms, finish: () => {
      if (!this.pending.delete(entry)) return;
      callback();
    } };
    this.pending.add(entry);
    return () => { this.pending.delete(entry); };
  }

  wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      let cancel = () => {};
      const finish = (): undefined => { signal.removeEventListener("abort", finish); cancel(); resolve(); };
      cancel = this.after(ms, finish);
      signal.addEventListener("abort", finish, { once: true });
      if (signal.aborted) finish();
    });
  }

  advance(ms: number): void {
    this.at += ms;
    const due = [...this.pending].filter(entry => entry.at <= this.at).sort((a, b) => a.at - b.at);
    for (const entry of due) entry.finish();
  }
}
