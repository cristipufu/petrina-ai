import type { ChildProcess } from "node:child_process";
import type { UsageInfo } from "./usage.js";

/** One account reader shared by scheduling and Analytics. It never starts an AI turn. */
export class UsageReader {
  private reading: Promise<void> | undefined;
  private child: ChildProcess | undefined;
  private failure: string | undefined;
  private stopped = false;
  private at = -Infinity;

  constructor(private readonly options: {
    name: string;
    read: (onProcess: (child: ChildProcess) => void) => Promise<UsageInfo[]>;
    record: (reports: UsageInfo[]) => void;
    log: (text: string) => void;
  }) {}

  refresh(gap = 0): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.reading) return this.reading;
    if (Date.now() - this.at < gap) return Promise.resolve();
    this.at = Date.now();
    this.reading = this.read().finally(() => { this.reading = undefined; });
    return this.reading;
  }

  private async read(): Promise<void> {
    try {
      const reports = await this.options.read((child) => { this.child = child; });
      this.failure = undefined;
      if (reports.length && !this.stopped) this.options.record(reports);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (reason !== this.failure && !this.stopped) this.options.log(`Could not read ${this.options.name}'s usage (${reason}). Petrina goes by what ${this.options.name} says when a turn fails instead.`);
      this.failure = reason;
    } finally {
      this.child = undefined;
    }
  }

  stop(): void {
    this.stopped = true;
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      const force = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 2000);
      child.once("exit", () => clearTimeout(force));
    }
  }
}
