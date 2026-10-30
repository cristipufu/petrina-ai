import type { UsageInfo } from "./failures.js";
import type { Pool } from "@petrina/core";
import type { UsageReadContext } from "./usage-process.js";

type ReadStatus = NonNullable<Pool["usageReads"]>[string];

/** One account reader shared by scheduling and Analytics. It never starts an AI turn. */
export class UsageReader {
  private reading: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private readonly cleanups = new Map<Promise<void>, { failure?: { error: unknown }; pending: boolean }>();
  private failure: string | undefined;
  private stopped = false;
  private closing: Promise<void> | undefined;
  private at = -Infinity;
  private status: ReadStatus | undefined;

  constructor(private readonly options: {
    name: string;
    read: (context: UsageReadContext) => Promise<UsageInfo[]>;
    record: (reports: UsageInfo[]) => void;
    log: (text: string) => void;
    changed?: () => void;
  }) {}

  snapshot(): ReadStatus | undefined { return this.status; }

  refresh(gap = 0): Promise<void> {
    if (this.stopped || [...this.cleanups.values()].some(entry => entry.failure)) return Promise.resolve();
    if (this.reading) return this.reading;
    if (this.cleanups.size) return Promise.resolve();
    if (Date.now() - this.at < gap) return Promise.resolve();
    this.at = Date.now();
    this.status = { at: this.at, state: "reading" };
    const controller = this.controller = new AbortController();
    const done = Promise.withResolvers<void>();
    // Publish the entire read before provider callbacks or host notification can reenter stop/refresh.
    this.reading = done.promise;
    void done.promise.catch(() => undefined);
    void this.read(controller).then(done.resolve, done.reject);
    void done.promise.then(
      () => { if (this.reading === done.promise) this.reading = undefined; },
      () => { if (this.reading === done.promise) this.reading = undefined; }
    );
    this.options.changed?.();
    return done.promise;
  }

  private async read(controller: AbortController): Promise<void> {
    try {
      if (controller.signal.aborted) return;
      const reports = await this.options.read({ signal: controller.signal, onGone: cleanup => {
        if (this.cleanups.has(cleanup)) return;
        const entry = { pending: true } as { failure?: { error: unknown }; pending: boolean };
        this.cleanups.set(cleanup, entry);
        void cleanup.then(() => {
          entry.pending = false;
          this.cleanups.delete(cleanup);
        }, error => {
          entry.pending = false;
          entry.failure = { error };
        });
      } });
      await this.settledCleanups();
      this.failure = undefined;
      if (reports.length && !this.stopped) this.options.record(reports);
      if (!this.stopped) this.status = { at: this.at, state: reports.length ? "reported" : "unavailable" };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (reason !== this.failure && !this.stopped) this.options.log(`Could not read ${this.options.name}'s usage (${reason}). Petrina goes by what ${this.options.name} says when a turn fails instead.`);
      this.failure = reason;
      if (!this.stopped) this.status = { at: this.at, state: "unavailable" };
    } finally {
      if (this.controller === controller) this.controller = undefined;
      if (!this.stopped) this.options.changed?.();
    }
  }

  private async settledCleanups(): Promise<void> {
    const seen = new Set<Promise<void>>();
    for (;;) {
      const pending = [...this.cleanups.keys()].filter(work => !seen.has(work));
      if (!pending.length) break;
      pending.forEach(work => seen.add(work));
      await Promise.allSettled(pending);
    }
    const failures = [...this.cleanups.values()].flatMap(entry => entry.failure ? [entry.failure.error] : []);
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, "Account readers did not confirm cleanup");
  }

  stop(): Promise<void> {
    if (this.closing) return this.closing;
    const done = Promise.withResolvers<void>();
    this.closing = done.promise;
    void done.promise.catch(() => undefined);
    this.stopped = true;
    const read = this.reading;
    const failures: unknown[] = [];
    try { this.controller?.abort(); } catch (error) { failures.push(error); }
    void (async () => {
      const result = await Promise.allSettled(read ? [read] : []);
      for (const outcome of result) if (outcome.status === "rejected") failures.push(outcome.reason);
      try { await this.settledCleanups(); } catch (error) { failures.push(error); }
      if (failures.length === 1) throw failures[0];
      if (failures.length) throw new AggregateError(failures, "Account readers did not confirm cleanup");
    })().then(done.resolve, done.reject);
    return done.promise;
  }
}
