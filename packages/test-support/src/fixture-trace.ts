type ObservedProcess = Pick<ReturnType<typeof Bun.spawn>, "pid" | "exited" | "exitCode" | "signalCode" | "killed" | "stdout" | "stderr">;
type ProcessObservation = { phase: string; child: ObservedProcess; exitWait: "pending" | "completed" | "rejected"; error?: string };

/** Test-only progress that reaches the check log before an outer timeout can discard the stack. */
export class FixtureTrace {
  snapshot: () => unknown = () => undefined;
  private readonly started: number;
  private readonly pending = new Map<number, { phase: string; since: number }>();
  private readonly progress: { phase: string; elapsedMs: number }[] = [];
  private readonly processes = new Map<number, ProcessObservation>();
  private next = 0;
  private readonly timer: ReturnType<typeof setInterval>;
  private phase = "Starting fixture";

  constructor(private readonly label: string, private readonly output = (line: string) => console.warn(line), private readonly now = Date.now, intervalMs = 15_000) {
    this.started = now();
    // Reporting only: never resolves, rejects, cancels or retries the fixture's work.
    this.timer = setInterval(() => this.report("still waiting"), intervalMs);
    this.timer.unref();
  }

  mark(phase: string): void {
    this.phase = phase;
    this.progress.push({ phase, elapsedMs: this.now() - this.started });
    if (this.progress.length > 12) this.progress.shift();
  }

  async during<T>(phase: string, work: () => Promise<T>): Promise<T> {
    // Concurrent calls can have the same label. Finishing one must not erase a held peer.
    const id = this.next++;
    this.pending.set(id, { phase, since: this.now() });
    this.mark(phase);
    try {
      const result = await work();
      this.pending.delete(id);
      this.mark(`${phase}: complete`);
      return result;
    } catch (error) {
      this.report("failed", error);
      throw error;
    } finally { this.pending.delete(id); }
  }

  /** Observe the original handle without consuming its pipes, polling, or changing its deadline. */
  async duringProcess<T>(phase: string, work: (capture: (child: ObservedProcess) => void) => Promise<T>): Promise<T> {
    const id = this.next++;
    try {
      return await this.during(phase, () => work((child) => {
        const record: ProcessObservation = { phase, child, exitWait: "pending" };
        this.processes.set(id, record);
        void child.exited.then(() => { record.exitWait = "completed"; }, (error) => {
          record.exitWait = "rejected"; record.error = String(error);
        });
      }));
    } finally { this.processes.delete(id); }
  }

  report(event: string, error?: unknown): void {
    // A missing startup file, partially written JSON or broken diagnostic must not hide the phase
    // or replace the test's own error. Write synchronously to stderr, not to disposable fixture files.
    try {
      const at = this.now();
      let details;
      try { details = this.snapshot(); }
      catch (failure) { details = { unavailable: String(failure) }; }
      this.output(`${this.label}: ${JSON.stringify({
        event, at: new Date(at).toISOString(), elapsedMs: at - this.started, workerPid: process.pid,
        phase: [...this.pending.values()].at(-1)?.phase ?? this.phase, lastProgress: this.phase,
        pending: [...this.pending.values()].map(({ phase, since }) => ({ phase, elapsedMs: at - since })),
        processes: [...this.processes.values()].map(({ phase, child, exitWait, error }) => ({
          phase, pid: child.pid, exitWait, exitCode: child.exitCode, signalCode: child.signalCode, hasExited: child.killed,
          stdoutLocked: child.stdout instanceof ReadableStream ? child.stdout.locked : undefined,
          stderrLocked: child.stderr instanceof ReadableStream ? child.stderr.locked : undefined,
          ...(error === undefined ? {} : { error }),
        })),
        progress: this.progress,
        ...(error === undefined ? {} : { error: error instanceof Error ? error.stack ?? error.message : String(error) }),
        details,
      })}`);
    } catch { /* Diagnostic failures never change the fixture result. */ }
  }

  close(): void { clearInterval(this.timer); }
}
