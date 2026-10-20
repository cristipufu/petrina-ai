import { fingerprint } from "./evidence-read.js";
// Durable lifecycle receipts outlive both the caller and an engine replacement.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Engine } from "./engine.js";
import { type FolderLock, processAlive, readConnection } from "./instance.js";
import { drainStatus, serial, type Result, type LifecycleControl } from "./coordination.js";

export interface LifecycleOperation {
  id: string;
  kind: string;
  phase: "starting" | "draining" | "stopping" | "completed" | "failed";
  scheduling: "paused" | "running";
  error?: string;
  launcherPid?: number;
}
export class LifecycleStore {
  private readonly db: Database;
  constructor(home: string) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    this.db = new Database(join(home, "lifecycle.db"), { create: true });
    this.db.run("PRAGMA busy_timeout = 3000");
    this.db.run("CREATE TABLE IF NOT EXISTS lifecycle (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.db.run("CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL)");
  }
  get current(): LifecycleOperation | undefined {
    const row = this.db.query<{ value: string }, []>("SELECT value FROM lifecycle WHERE key='operation'").get();
    return row ? JSON.parse(row.value) : undefined;
  }
  set current(value: LifecycleOperation | undefined) {
    if (value) this.db.query("INSERT INTO lifecycle VALUES ('operation',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(value));
  }
  begin(kind: string, a: Record<string, any>, scheduling: "paused" | "running", apply: () => void = () => {}, launcherPid?: number): Result {
    return this.db.transaction((): Result => {
      // Waiting options belong to the caller, not the effect being retried.
      const hash = fingerprint({ kind, requestId: a.requestId });
      const old = this.db.query<{ fingerprint: string; result: string }, [string]>("SELECT fingerprint,result FROM receipts WHERE id=?").get(a.requestId);
      if (old)
        return old.fingerprint === hash
          ? this.receipt(a.requestId)!
          : { outcome: "conflict", message: "That request reference belongs to another lifecycle request." };
      const current = this.current;
      let result: Result;
      const unfinished = current && !["completed", "failed"].includes(current.phase);
      const replacesPause = unfinished && current.kind === "pause" && ["resume", "stop", "restart"].includes(kind);
      if (unfinished && !replacesPause) {
        const follows = kind === current.kind && ["restart", "pause"].includes(kind);
        result = {
          outcome: kind === "start" && current.kind === "pause" ? "completed" : follows ? "pending" : "conflict",
          requestId: a.requestId,
          operation: current,
          message: kind === "start" && current.kind === "pause" ? "The engine is already running with scheduling paused." : follows ? "Following the lifecycle operation already under way." : "Another lifecycle operation is already under way; this request was not applied.",
        };
      } else {
        apply();
        if (replacesPause) this.updateReceipts(current, "superseded", `The pause's drain wait was superseded by ${kind}. Inspect engine status for the operation now under way.`, a.requestId);
        const operation: LifecycleOperation = { id: a.requestId, kind, phase: launcherPid === undefined ? "draining" : "starting", scheduling, ...(launcherPid === undefined ? {} : { launcherPid }) };
        this.current = operation;
        result = { outcome: "pending", requestId: a.requestId, operation };
      }
      this.db.query("INSERT INTO receipts VALUES (?,?,?)").run(a.requestId, hash, JSON.stringify(result));
      return result;
    })();
  }
  /** A disconnected follower may join an operation, but must never create a new effect. */
  follow(kind: string, a: Record<string, any>, observed: LifecycleOperation): Result {
    return this.db.transaction((): Result => {
      if (this.receipt(a.requestId)) return this.begin(kind, a, observed.scheduling);
      const current = this.current;
      if (current?.id !== observed.id || current.kind !== kind || !["pause", "restart"].includes(kind) || ["completed", "failed"].includes(current.phase))
        return { outcome: "disconnected", requestId: a.requestId, message: "The lifecycle operation changed before this request was confirmed. Retry with its original reference." };
      return this.begin(kind, a, current.scheduling);
    })();
  }
  finish(phase: LifecycleOperation["phase"], error?: string, launcherPid?: number): void {
    this.db.transaction(() => {
      const op = this.current;
      if (!op) return;
      op.phase = phase;
      if (phase === "starting" && launcherPid !== undefined) op.launcherPid = launcherPid;
      if (error) op.error = error;
      this.current = op;
      this.updateReceipts(op, phase === "failed" ? "failed" : phase === "completed" ? "completed" : "pending", error);
    })();
  }
  private updateReceipts(op: LifecycleOperation, outcome: Result["outcome"], message?: string, supersededBy?: string): void {
    // Followers keep their own request identity and advance with the operation they joined.
    const rows = this.db.query<{ id: string }, [string]>("SELECT id FROM receipts WHERE json_extract(result, '$.operation.id') = ? AND json_extract(result, '$.outcome') = 'pending'").all(op.id);
    for (const { id } of rows) this.db.query("UPDATE receipts SET result=? WHERE id=?").run(JSON.stringify({ outcome, requestId: id, operation: op, ...(message ? { message } : {}), ...(supersededBy ? { supersededBy } : {}) }), id);
  }
  receipt(id: string): Result | undefined {
    const row = this.db.query<{ result: string }, [string]>("SELECT result FROM receipts WHERE id=?").get(id);
    if (!row) return undefined;
    const saved: Result = JSON.parse(row.result);
    const operation = saved.operation as LifecycleOperation | undefined;
    // Older saved followers may predate propagation. Their original receipt is authoritative.
    if (saved.outcome === "pending" && operation && operation.id !== id) {
      const original = this.db.query<{ result: string }, [string]>("SELECT result FROM receipts WHERE id=?").get(operation.id);
      if (original) return { ...JSON.parse(original.result), requestId: id };
    }
    return saved;
  }
  noteLauncher(pid: number): void {
    this.db.transaction(() => {
      const operation = this.current;
      if (operation?.phase === "starting") this.current = { ...operation, launcherPid: pid };
    })();
  }
  failIfUnchanged(observed: LifecycleOperation, message: string): boolean {
    return this.db.transaction(() => {
      const current = this.current;
      // Ownership can pass between a status read and checking the old process. Never let
      // that stale observation overwrite a replacement which is already starting or ready.
      if (!current || current.id !== observed.id || current.phase !== observed.phase || current.launcherPid !== observed.launcherPid) return false;
      this.finish("failed", message);
      return true;
    })();
  }
  /** The caller must own the folder. A quiet or starting owner must never be replaced. */
  failAbandoned(home: string, _ownership: FolderLock): boolean {
    const operation = this.current;
    if (!operation || ["completed", "failed"].includes(operation.phase)) return false;
    // During the release-to-launch gap the previous owner is still alive. Afterwards the
    // recorded launcher owns startup, even before it has a connection or the folder lock.
    const pid = operation.phase === "starting" ? operation.launcherPid ?? readConnection(home)?.pid : readConnection(home)?.pid;
    // Older launchers did not record a process. Absence alone cannot prove startup failed.
    if (operation.phase === "starting" && !pid) return false;
    if (pid && processAlive(pid)) return false;
    return this.failIfUnchanged(operation, "The engine process exited before this lifecycle operation completed. Saved work is preserved.");
  }
  close() {
    this.db.close();
  }
}
export class EngineLifecycle implements LifecycleControl {
  private timer: ReturnType<typeof setInterval>;
  private finishing = false;
  constructor(
    readonly engine: Engine,
    readonly store: LifecycleStore,
    private readonly stop: (restart: boolean) => Promise<void>,
    private readonly onHandoff?: (active: boolean) => void,
  ) {
    const current = store.current;
    if (current?.kind === "stop" || current?.kind === "restart") engine.drainReason = current.kind;
    if (current && !["completed", "failed"].includes(current.phase)) engine.draining = current.kind !== "pause";
    if (current && ["stop", "restart"].includes(current.kind) && ["draining", "stopping"].includes(current.phase)) onHandoff?.(true);
    this.timer = setInterval(() => void this.settle(), 100);
  }
  ready(): void {
    const op = this.store.current;
    if (!op || op.phase === "starting" || ["completed", "failed"].includes(op.phase)) {
      this.engine.draining = false;
      if (op?.phase === "starting") this.store.finish("completed");
      this.engine.schedule();
    }
  }
  status(): Result {
    const e = this.engine,
      operation = this.store.current,
      drain = drainStatus(e);
    return {
      outcome: "completed",
      status:
        operation?.phase === "failed" ? "failed" : e.draining || (e.s.pool.paused && !drain.drained) ? "draining" : e.s.pool.paused ? "paused" : "running",
      scheduling: e.s.pool.paused ? "paused" : "running",
      operation: operation ?? null,
      boot: e.boot,
      ...drain,
    };
  }
  request(name: string, a: Record<string, any>): Promise<Result> {
    return serial(this.engine, async () => {
      const e = this.engine;
      if (e.store.database.query("SELECT id FROM coordination_receipts WHERE id = ?").get(a.requestId))
        return { outcome: "conflict", requestId: a.requestId, message: "That reference belongs to another coordination request." };
      const result = this.store.begin(name, a, name === "pause" ? "paused" : name === "resume" ? "running" : e.s.pool.paused ? "paused" : "running", () => {
        if (name === "pause") e.setPoolPaused(true);
        else if (name === "resume") e.setPoolPaused(false);
        else if (name === "stop" || name === "restart") {
          e.drainReason = name;
          e.draining = true;
          e.commitNow();
        }
      });
      const current = this.store.current;
      if (current && current.kind === name && ["stop", "restart"].includes(name) && ["draining", "stopping"].includes(current.phase)) this.onHandoff?.(true);
      if (
        result.outcome === "pending" &&
        current &&
        current.id === a.requestId &&
        current.kind === name &&
        ["resume", "start"].includes(name) &&
        current.phase !== "completed"
      )
        this.store.finish("completed");
      void this.settle();
      const receipt = this.store.receipt(a.requestId) ?? result;
      return receipt.outcome === "pending" ? { ...receipt, progress: this.status() } : receipt;
    });
  }
  receipt(id: string): Result | undefined {
    return this.store.receipt(id);
  }
  private async settle(): Promise<void> {
    if (this.finishing) return;
    const op = this.store.current;
    if (!op || op.phase !== "draining" || !drainStatus(this.engine).drained) return;
    if (op.kind === "pause") {
      this.store.finish("completed");
      this.engine.commitNow();
      return;
    }
    if (!["stop", "restart"].includes(op.kind)) return;
    this.finishing = true;
    this.store.finish("stopping");
    try {
      await this.stop(op.kind === "restart");
    } catch {
      this.store.finish("failed", "Petrina could not complete its lifecycle handoff.");
      this.onHandoff?.(false);
      this.finishing = false;
    }
  }
  close() {
    clearInterval(this.timer);
  }
}
