// Durable lifecycle receipts outlive both the caller and an engine replacement.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { LifecycleOperation, CoordinationResult as Result } from "@petrina/core";
import { fingerprint } from "./receipt-identity.js";

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
  begin(kind: string, a: { readonly requestId: string }, scheduling: "paused" | "running", apply: () => void = () => {}, launcherPid?: number): Result {
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
  follow(kind: string, a: { readonly requestId: string }, observed: LifecycleOperation): Result {
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
  close() {
    this.db.close();
  }
}
