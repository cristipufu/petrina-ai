import type { Engine } from "./engine.js";
import { LifecycleStore } from "@petrina/storage/lifecycle-store";
import { drainStatus, serial, type Result, type LifecycleControl } from "./coordination.js";
import { ReleaseStore, validateReleaseVersion } from "./release-store.js";
import type { LifecycleTransitionAction } from "./release-transition.js";

const HANDOFF_KINDS = ["stop", "restart", "promote", "rollback"];

export class EngineLifecycle implements LifecycleControl {
  private timer: ReturnType<typeof setInterval>;
  private finishing = false;
  constructor(
    readonly engine: Engine,
    readonly store: LifecycleStore,
    private readonly stop: (restart: boolean, action?: LifecycleTransitionAction) => Promise<void>,
    private readonly onHandoff?: (active: boolean) => void,
  ) {
    const current = store.current;
    if (current?.kind === "stop") engine.drainReason = "stop";
    else if (current && ["restart", "promote", "rollback"].includes(current.kind)) engine.drainReason = "restart";
    if (current && !["completed", "failed"].includes(current.phase)) engine.draining = current.kind !== "pause";
    if (current && HANDOFF_KINDS.includes(current.kind) && ["draining", "stopping"].includes(current.phase)) onHandoff?.(true);
    this.timer = setInterval(() => void this.settle(), 100);
  }
  ready(): void {
    const rollbackMsg = process.env.PETRINA_AUTO_ROLLBACK_MESSAGE;
    if (rollbackMsg) {
      const restoredVersion = process.env.PETRINA_AUTO_ROLLBACK_VERSION ?? "previous";
      delete process.env.PETRINA_AUTO_ROLLBACK_MESSAGE;
      delete process.env.PETRINA_AUTO_ROLLBACK_VERSION;
      this.store.finishRollbackRecovery(rollbackMsg, restoredVersion);
      this.engine.draining = false;
      this.engine.schedule();
      return;
    }
    const op = this.store.current;
    if (!op || op.phase === "starting" || ["completed", "failed"].includes(op.phase)) {
      this.engine.draining = false;
      if (op?.phase === "starting") this.store.finish("completed");
      this.engine.schedule();
    }
  }
  status(): Result {
    const engine = this.engine;
    const operation = this.store.current;
    const drain = drainStatus(engine);
    return {
      outcome: "completed",
      status:
        operation?.phase === "failed"
          ? "failed"
          : engine.draining || (engine.s.pool.paused && !drain.drained)
            ? "draining"
            : engine.s.pool.paused
              ? "paused"
              : "running",
      scheduling: engine.s.pool.paused ? "paused" : "running",
      operation: operation ?? null,
      boot: engine.boot,
      ...drain,
    };
  }
  request(name: string, args: Record<string, unknown>): Promise<Result> {
    return serial(this.engine, async () => {
      const engine = this.engine;
      if (name === "releases") {
        return { outcome: "completed", ...new ReleaseStore(engine.dataDir).list() };
      }
      const requestId = String(args.requestId);
      if (engine.store.hasReceipt(requestId))
        return { outcome: "conflict", requestId, message: "That reference belongs to another coordination request." };

      let cleanVersion: string | undefined;
      const sourcePath = typeof args.sourcePath === "string" ? args.sourcePath : undefined;
      if (name === "promote") {
        try {
          cleanVersion = validateReleaseVersion(String(args.version ?? ""));
        } catch (error) {
          return {
            outcome: "invalid",
            requestId,
            message: error instanceof Error ? error.message : "Invalid engine release version.",
          };
        }
        const existingReceipt = this.store.receipt(requestId);
        if (!existingReceipt) {
          const releaseStore = new ReleaseStore(engine.dataDir);
          if (sourcePath && !releaseStore.hasVersion(cleanVersion)) {
            try {
              releaseStore.stage(cleanVersion, sourcePath);
            } catch (error) {
              return {
                outcome: "invalid",
                requestId,
                message: error instanceof Error ? error.message : "Could not stage engine release.",
              };
            }
          }
          if (!releaseStore.hasVersion(cleanVersion)) {
            return {
              outcome: "missing",
              requestId,
              message: `Engine release version ${cleanVersion} is not staged. Provide sourcePath to stage it.`,
            };
          }
        }
      } else if (name === "rollback" && !this.store.receipt(requestId)) {
        const releaseStore = new ReleaseStore(engine.dataDir);
        if (!releaseStore.readPrevious()) {
          return {
            outcome: "invalid",
            requestId,
            message: "No previous engine release is available to roll back to.",
          };
        }
      }

      const result = this.store.begin(
        name,
        {
          requestId,
          ...(cleanVersion !== undefined ? { version: cleanVersion } : {}),
          ...(sourcePath !== undefined ? { sourcePath } : {}),
        },
        name === "pause" ? "paused" : name === "resume" ? "running" : engine.s.pool.paused ? "paused" : "running",
        () => {
          if (name === "pause") engine.setPoolPaused(true);
          else if (name === "resume") engine.setPoolPaused(false);
          else if (HANDOFF_KINDS.includes(name)) {
            engine.drainReason = name === "stop" ? "stop" : "restart";
            engine.draining = true;
            engine.stopRequested.abort();
            engine.checkQueue.pump();
            engine.commitNow();
          }
        },
      );
      const current = this.store.current;
      if (current && current.kind === name && HANDOFF_KINDS.includes(name) && ["draining", "stopping"].includes(current.phase)) this.onHandoff?.(true);
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
      if (HANDOFF_KINDS.includes(op.kind)) this.onHandoff?.(false);
      return;
    }
    if (!drain.drained) return;
    if (op.kind === "pause") {
      this.store.finish("completed");
      this.engine.commitNow();
      return;
    }
    if (!HANDOFF_KINDS.includes(op.kind)) return;
    this.finishing = true;
    this.store.finish("stopping");
    const action: LifecycleTransitionAction =
      op.kind === "stop"
        ? { kind: "stop" }
        : op.kind === "promote"
          ? { kind: "promote", version: op.version! }
          : op.kind === "rollback"
            ? { kind: "rollback" }
            : { kind: "restart" };
    try {
      await this.stop(op.kind !== "stop", action);
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
