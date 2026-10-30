import { CHECK_NAMES, type CheckId } from "@petrina/core";
import type { ToolCheckClock, ToolCheckHost, ToolProbe, ToolProbeResult } from "./ports/tool-checks.js";

/** Maximum wait for a previous probe's owned programs before refusing another start. */
export const TOOL_CHECK_LINGER_MS = 3_000;

/** Shared probe admission and ownership; it never opens a native tool or consults the machine. */
export class ToolCheckCoordinator {
  private readonly checking = new Map<CheckId, Promise<void>>();
  private readonly lingering = new Map<CheckId, Set<Promise<void>>>();
  private readonly stopping = new AbortController();

  constructor(private readonly host: ToolCheckHost, private readonly probe: ToolProbe, private readonly clock: ToolCheckClock) {}

  check(id: CheckId): Promise<void> {
    if (this.stopping.signal.aborted || this.host.stopped()) return Promise.resolve();
    const running = this.checking.get(id);
    if (running) return running;
    const absent = this.probe.absent(id);
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const job = new Promise<void>((done, failed) => {
      resolve = done;
      reject = failed;
    });
    // Register before publishing: a subscriber can synchronously ask for this very check.
    this.checking.set(id, job);
    const finish = () => { if (this.checking.get(id) === job) this.checking.delete(id); };
    try {
      if (absent) {
        this.host.publish({ id, status: "not-installed", at: this.clock.now() });
        finish();
        resolve();
        return job;
      }
      this.host.publish({ ...this.host.current(id), checking: true });
    } catch (error) {
      finish();
      reject(error);
      return job;
    }
    void this.observe(id).then(result => {
      try {
        this.host.publish({ id, ...result, at: this.clock.now() });
        finish();
        resolve();
      }
      catch (error) {
        finish();
        reject(error);
      }
    }, error => {
      finish();
      reject(error);
    });
    return job;
  }

  running(id: CheckId): Promise<void> | undefined { return this.checking.get(id); }

  /** Diagnostic ownership facts without exposing mutable registries or native process handles. */
  pending(): { checking: CheckId[]; stopping: CheckId[] } {
    return { checking: [...this.checking.keys()], stopping: [...this.lingering.keys()] };
  }

  /** The host names checks whose request lifecycle must drain; every registered cleanup also drains. */
  async shutdown(drain?: readonly CheckId[]): Promise<void> {
    this.stopping.abort();
    await Promise.allSettled([...this.checking].filter(([id]) => !drain || drain.includes(id)).map(([, job]) => job));
    const outcomes = await Promise.allSettled([...this.lingering.values()].flatMap(gone => [...gone]));
    const failures = outcomes.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, "Tool probe cleanup was not confirmed for every owner");
  }

  private async observe(id: CheckId): Promise<ToolProbeResult> {
    try {
      const before = this.lingering.get(id);
      if (before?.size) {
        const deadline = new AbortController();
        try {
          await Promise.race([Promise.all([...before]), this.clock.wait(TOOL_CHECK_LINGER_MS, AbortSignal.any([deadline.signal, this.stopping.signal]))]);
        } finally { deadline.abort(); }
      }
      if (this.stopping.signal.aborted || this.host.stopped()) return { status: "unknown", detail: "The tools check stopped before this probe could start." };
      if (this.lingering.get(id)?.size) return {
        status: "unknown",
        detail: `${CHECK_NAMES[id]} is still stopping after its last check, so try Check again in a moment.`
      };
      return await this.probe.run(id, { signal: this.stopping.signal, onGone: gone => this.own(id, gone) });
    } catch (error) { return { status: "unknown", detail: error instanceof Error ? error.message : String(error) }; }
  }

  private own(id: CheckId, gone: Promise<void>): void {
    const owned = this.lingering.get(id) ?? new Set<Promise<void>>();
    owned.add(gone);
    this.lingering.set(id, owned);
    void gone.then(() => {
      owned.delete(gone);
      if (!owned.size && this.lingering.get(id) === owned) this.lingering.delete(id);
    }, () => { /* A rejected observation does not confirm cleanup or permit a replacement. */ });
  }
}
