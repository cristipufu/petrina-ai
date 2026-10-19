// CLI and MCP use the same focused API and connection discovery. Secrets stay in headers.
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { existsSync, mkdirSync } from "node:fs";
import { readConnection, FolderLock } from "./instance.js";
import { LifecycleStore } from "./lifecycle.js";
import type { Result } from "./coordination.js";
import { operation } from "./operations.js";

export const defaultHome = () => process.env.PETRINA_HOME || join(homedir(), ".petrina");
function coordinationReceipt(home: string, id: string): boolean | undefined {
  const path = join(home, "petrina.db");
  if (!existsSync(path)) return false;
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    if (!db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='coordination_receipts'").get()) return false;
    return !!db.query("SELECT id FROM coordination_receipts WHERE id=?").get(id);
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}
function savedScheduling(home: string): "paused" | "running" | undefined {
  const path = join(home, "petrina.db");
  if (!existsSync(path)) return undefined;
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    const saved = db.query<{ paused: number }, []>("SELECT json_extract(value, '$.pool.paused') AS paused FROM kv WHERE key='state'").get();
    return saved ? (saved.paused ? "paused" : "running") : undefined;
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}
export class EngineClient {
  constructor(
    readonly home = defaultHome(),
    private readonly start: () => number | void = () => {
      const prior = readConnection(home);
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "cli.ts"), "serve", "--managed"], {
        env: { ...process.env, PETRINA_HOME: home, PETRINA_PORT: prior ? new URL(prior.api).port : "0" },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        detached: true,
        windowsHide: true,
      });
      child.unref();
      return child.pid;
    },
  ) {}
  private async request(name: string, args: Record<string, unknown>): Promise<Result> {
    const connection = readConnection(this.home);
    if (!connection) return { outcome: "disconnected", message: "The engine has no local connection. Use engine start explicitly." };
    try {
      const response = await fetch(`${connection.api}/api/coordinate`, {
        method: "POST",
        headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/json" },
        body: JSON.stringify({ name, args }),
        signal: AbortSignal.timeout(name === "watch.wait" ? Number(args.timeoutMs ?? 30000) + 3000 : 10000),
      });
      if (!response.ok)
        return {
          outcome: "failed",
          message:
            response.status === 401
              ? "The local connection changed. Inspect engine status and retry with the same request reference."
              : "The engine refused this coordination request.",
        };
      return (await response.json()) as Result;
    } catch {
      return { outcome: "disconnected", message: "The engine did not answer. A change may have been saved: retry with its original request reference." };
    }
  }
  async call(name: string, raw: Record<string, unknown> = {}): Promise<Result> {
    const spec = operation(name),
      parsed = spec?.schema.safeParse(raw);
    if (!spec || !parsed?.success)
      return {
        outcome: "invalid",
        message: parsed && !parsed.success ? parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : "Unknown operation.",
      };
    const args = parsed.data as Record<string, unknown>;
    if (name === "watch.wait") return this.watch(args);
    let result = await this.request(name, args);
    if (name.startsWith("engine.") && result.outcome === "disconnected") {
      mkdirSync(this.home, { recursive: true, mode: 0o700 });
      const lock = FolderLock.take(this.home);
      const store = new LifecycleStore(this.home);
      try {
        let current = store.current;
        const scheduling = savedScheduling(this.home) ?? current?.scheduling ?? "running";
        if (lock && store.failAbandoned(this.home, lock)) {
          current = store.current;
        }
        if (name === "engine.status")
          return {
            outcome: "completed",
            status: !lock
              ? current?.phase === "starting"
                ? "starting"
                : "unresponsive"
              : current?.phase === "failed"
                ? "failed"
                : current && !["completed", "failed"].includes(current.phase)
                  ? current.phase === "starting" ? "starting" : "unresponsive"
                  : "stopped",
            operation: current ?? null,
            scheduling,
          };
        const known = store.receipt(String(args.requestId));
        // A known lifecycle receipt is authoritative during handoff, even while the old
        // task database is closing its WAL. Do not turn a saved effect into "not submitted".
        const coordinated = known ? false : coordinationReceipt(this.home, String(args.requestId));
        if (coordinated === undefined) return { outcome: "failed", message: "Saved request references could not be read. No lifecycle change was submitted." };
        if (coordinated) return { outcome: "conflict", requestId: args.requestId, message: "That reference belongs to another coordination request." };
        if (known) result = store.begin(name.slice(7), args, scheduling);
        else if (!lock) {
          // Only the engine can apply scheduling and admission changes. A lost reply may
          // leave its request queued: reserving a receipt here would make that queued request
          // skip its effects. Following an existing restart/pause has no new engine effect.
          if (current && !["completed", "failed"].includes(current.phase) && current.kind === name.slice(7) && ["restart", "pause"].includes(current.kind))
            result = store.follow(name.slice(7), args, current);
          else
            return {
              outcome: "disconnected",
              requestId: args.requestId,
              status: "unresponsive",
              operation: current ?? null,
              message: "An engine owns this folder but did not confirm this request. Retry with the same request reference; no replacement was started.",
            };
        } else if (!["engine.start", "engine.restart"].includes(name))
          return { outcome: "invalid", status: "stopped", message: "The engine is stopped. Start it explicitly before changing scheduling." };
        else {
          if (current && !["starting", "completed", "failed"].includes(current.phase))
            return { outcome: "disconnected", requestId: args.requestId, status: "unresponsive", operation: current, message: "The previous engine process is still alive. Its lifecycle change cannot be confirmed; no replacement was started." };
          // Reserve the spawning caller before it can be interrupted without a connection.
          result = store.begin(name.slice(7), args, scheduling, undefined, process.pid);
          if ((result.operation as { id?: string })?.id === args.requestId) {
            try {
              const pid = this.start();
              if (pid) store.noteLauncher(pid);
            } catch {
              store.finish("failed", "The engine launcher could not start. Saved work is unchanged.");
              result = store.receipt(String(args.requestId))!;
            }
          }
        }
      } finally {
        lock?.release();
        store.close();
      }
    }
    if (!name.startsWith("engine.") || name === "engine.status" || !args.wait || !["completed", "pending"].includes(result.outcome)) return result;
    const opId = (result.operation as { id?: string } | undefined)?.id ?? args.requestId;
    const deadline = Date.now() + Number(args.timeoutMs);
    for (;;) {
      const store = new LifecycleStore(this.home);
      let receipt: Result | undefined;
      try {
        const lock = FolderLock.take(this.home);
        try { if (lock) store.failAbandoned(this.home, lock); } finally { lock?.release(); }
        receipt = store.receipt(String(args.requestId)) ?? store.receipt(String(opId));
      } finally {
        store.close();
      }
      if (receipt && ["completed", "failed", "superseded"].includes(receipt.outcome)) return receipt;
      if (Date.now() >= deadline)
        return {
          outcome: "timed-out",
          requestId: args.requestId,
          operation: result.operation,
          message: "The deadline ended only this wait. Draining continues; no forced stop or second launch.",
        };
      await Bun.sleep(Math.min(100, Math.max(0, deadline - Date.now())));
    }
  }

  private async watch(args: Record<string, unknown>): Promise<Result> {
    const deadline = Date.now() + Number(args.timeoutMs);
    let marker = args.marker;
    let disconnected = false;
    for (;;) {
      const remaining = Math.max(0, deadline - Date.now());
      const result = await this.request("watch.wait", { ...args, ...(marker ? { marker } : {}), timeoutMs: marker ? remaining : 0 });
      if (result.outcome === "disconnected") {
        disconnected = true;
        if (!marker || Date.now() >= deadline) return { ...result, marker };
        await Bun.sleep(Math.min(100, Math.max(0, deadline - Date.now())));
        continue;
      }
      if (result.outcome !== "timed-out" || Date.now() >= deadline) return { ...result, ...(disconnected ? { reconnected: true } : {}) };
      marker = result.marker;
    }
  }
}
