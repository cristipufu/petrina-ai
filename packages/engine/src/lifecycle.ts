import type { Engine } from "./engine.js";
import { LifecycleStore } from "@petrina/storage/lifecycle-store";
import { drainStatus, serial, type Result, type LifecycleControl } from "./coordination.js";

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
  request(name: string, a: Record<string, unknown>): Promise<Result> {
    return serial(this.engine, async () => {
      const e = this.engine;
      const requestId = String(a.requestId);
      if (e.store.database.query("SELECT id FROM coordination_receipts WHERE id = ?").get(requestId))
        return { outcome: "conflict", requestId, message: "That reference belongs to another coordination request." };
      const result = this.store.begin(name, { requestId }, name === "pause" ? "paused" : name === "resume" ? "running" : e.s.pool.paused ? "paused" : "running", () => {
        if (name === "pause") e.setPoolPaused(true);
        else if (name === "resume") e.setPoolPaused(false);
        else if (name === "stop" || name === "restart") {
          e.drainReason = name;
          e.draining = true;
          e.stopRequested.abort();
          e.checkQueue.pump();
          e.commitNow();
        }
      });
      const current = this.store.current;
      if (current && current.kind === name && ["stop", "restart"].includes(name) && ["draining", "stopping"].includes(current.phase)) this.onHandoff?.(true);
      if (
        result.outcome === "pending" &&
        current &&
        current.id === requestId &&
        current.kind === name &&
        ["resume", "start"].includes(name) &&
        current.phase !== "completed"
      )
        this.store.finish("completed");
      void this.settle();
      const receipt = this.store.receipt(requestId) ?? result;
      return receipt.outcome === "pending" ? { ...receipt, progress: this.status() } : receipt;
    });
  }
  receipt(id: string): Result | undefined {
    return this.store.receipt(id);
  }
  private async settle(): Promise<void> {
    if (this.finishing) return;
    const op = this.store.current;
    if (!op || op.phase !== "draining") return;
    const drain = drainStatus(this.engine);
    if (drain.pendingWork || drain.blockerCount) return;
    if (drain.cleanupFailureCount) {
      this.store.finish("failed", "Agent cleanup was not confirmed. Its working files were kept.");
      if (["stop", "restart"].includes(op.kind)) this.onHandoff?.(false);
      return;
    }
    if (!drain.drained) return;
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
