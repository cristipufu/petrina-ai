import type { AgentStopEffects, AgentStopSignal, AgentStopTarget, StopDiagnostic } from "../../src/agent-stop.js";

export interface StopProcess {
  pid: number;
  parent: number;
  group: number;
  state: "S" | "T" | "Z";
  term: "exit" | "ignore";
  pendingTerm?: boolean;
}
export interface StopSignalReceipt { target: number; signal: AgentStopSignal; delivered: boolean }

/** Scripted external process observations. This model never launches or claims to observe a native process. */
export class AgentStopFixture implements AgentStopEffects {
  readonly selfPid = 100;
  readonly rootPid = 200;
  readonly workerPid = 201;
  readonly unrelatedPid = 300;
  time = 0;
  readonly rows = new Map<number, StopProcess>();
  readonly signals: StopSignalReceipt[] = [];
  readonly notes: StopDiagnostic[] = [];
  readonly parentAllowances: number[] = [];
  readonly groupAllowances: number[] = [];
  readonly pendingReads = new Set<number>();
  private readId = 0;
  parents?: (timeout: number, index: number) => Promise<string | undefined>;
  groups?: (timeout: number, index: number) => Promise<string | undefined>;
  onSignal?: (target: number, signal: AgentStopSignal) => void;

  constructor(rootTerm: "exit" | "ignore" = "ignore") {
    this.add({ pid: this.selfPid, parent: 1, group: this.selfPid, state: "S", term: "ignore" });
    this.add({ pid: this.rootPid, parent: this.selfPid, group: this.rootPid, state: "S", term: rootTerm });
    this.add({ pid: this.unrelatedPid, parent: this.selfPid, group: this.selfPid, state: "S", term: "ignore" });
  }
  target(): AgentStopTarget { return { pid: this.rootPid, running: () => this.rows.has(this.rootPid) }; }
  add(row: StopProcess) { this.rows.set(row.pid, row); }
  now() { return this.time; }
  async sleep(ms: number) { this.time += ms; }
  alive(target: number) { return target < 0 ? [...this.rows.values()].some(row => row.group === -target) : this.rows.has(target); }
  possiblyPresent(target: number) { return this.alive(target); }
  signal(target: number, signal: AgentStopSignal) {
    const receipt: StopSignalReceipt = { target, signal, delivered: false };
    this.signals.push(receipt);
    const rows = target < 0 ? [...this.rows.values()].filter(row => row.group === -target) : [this.rows.get(target)].filter((row): row is StopProcess => !!row);
    if (!rows.length) throw new Error("The scripted process is absent");
    receipt.delivered = true;
    for (const row of rows) {
      if (row.state === "Z") continue;
      if (signal === "SIGSTOP") row.state = "T";
      if (signal === "SIGCONT") {
        row.state = "S";
        if (row.pendingTerm && row.term === "exit") this.rows.delete(row.pid);
        row.pendingTerm = false;
      }
      if (signal === "SIGTERM") {
        if (row.state === "T") row.pendingTerm = true;
        else if (row.term === "exit") this.rows.delete(row.pid);
      }
      if (signal === "SIGKILL") this.rows.delete(row.pid);
    }
    this.onSignal?.(target, signal);
  }
  parentSnapshot() { return [...this.rows.values()].map(row => `${row.pid} ${row.parent} ${row.state}`).join("\n"); }
  groupSnapshot() { return [...this.rows.values()].map(row => `${row.pid} ${row.group} ${row.state}`).join("\n"); }
  private async observedRead(start: () => Promise<string | undefined>) {
    const id = ++this.readId;
    this.pendingReads.add(id);
    try { return await start(); } finally { this.pendingReads.delete(id); }
  }
  readParents(timeout: number) {
    const index = this.parentAllowances.push(timeout);
    return this.observedRead(() => this.parents ? this.parents(timeout, index) : Promise.resolve(this.parentSnapshot()));
  }
  readGroups(timeout: number) {
    const index = this.groupAllowances.push(timeout);
    return this.observedRead(() => this.groups ? this.groups(timeout, index) : Promise.resolve(this.groupSnapshot()));
  }
  incomplete(facts: StopDiagnostic) { this.notes.push(facts); }
}
