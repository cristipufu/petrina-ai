import type {
  CoordinationResult as Result,
  WorkflowEventKind,
} from "@petrina/core";
import { fingerprint } from "@petrina/storage/receipt-identity";
import { executeCoordinationMutation } from "./coordination-mutations.js";
import { executeCoordinationQuery, watchCoordination } from "./coordination-queries.js";
import {
  drainStatus,
  type CoordinationArgs,
  type LifecycleControl,
} from "./coordination-views.js";
import type { Engine } from "./engine.js";
import type { ExtraRequest } from "./extra-validations.js";
import { operation } from "./operations.js";

export type { CoordinationOutcome as Outcome, CoordinationResult as Result } from "@petrina/core";
export { drainStatus, requestRevision, taskSummary, type LifecycleControl } from "./coordination-views.js";

const clone = <T>(value: T): T => structuredClone(value);
const queues = new WeakMap<Engine, Promise<unknown>>();

/** App actions and new decisions share this queue: inspecting a revision and applying it cannot race an edit. */
export function serial<T>(engine: Engine, run: () => T | Promise<T>): Promise<T> {
  const next = (queues.get(engine) ?? Promise.resolve()).then(run);
  queues.set(
    engine,
    next.catch(() => undefined),
  );
  return next;
}

export class Coordination {
  constructor(
    readonly engine: Engine,
    readonly lifecycle?: LifecycleControl,
  ) {
    engine.store.database.run(
      "CREATE TABLE IF NOT EXISTS coordination_receipts (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL)",
    );
  }

  /** `signal`: the caller went away or cancelled; a wait releases its subscription and timer at once. */
  async call(name: string, raw: unknown, signal?: AbortSignal): Promise<Result> {
    const spec = operation(name);
    if (!spec) {
      return { outcome: "invalid", message: "Unknown coordination operation. Use help or tools/list." };
    }
    const parsed = spec.schema.safeParse(raw);
    if (!parsed.success) {
      return {
        outcome: "invalid",
        message: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      };
    }
    const args = parsed.data as CoordinationArgs;
    if (name === "watch.wait") {
      return watchCoordination(this.engine, this.lifecycle, args, signal, () => this.call("engine.status", {}));
    }
    if (name === "watch.events") {
      if (args.taskIds && args.productId) {
        return { outcome: "invalid", message: "Choose selected tasks or a product, not both." };
      }
      if (args.productId && !this.engine.s.products.some((product) => product.id === args.productId)) {
        return { outcome: "missing", message: "That product does not exist." };
      }
      // Existence only: a quiet renewal over many archived tasks must never read their complete bodies.
      for (const id of args.taskIds ?? []) {
        if (!this.engine.taskKnown(id)) {
          return { outcome: "missing", message: `Task ${id} does not exist.` };
        }
      }
      return this.engine.events.wait(
        {
          taskIds: args.taskIds,
          productId: args.productId,
          kinds: args.kinds as WorkflowEventKind[] | undefined,
          cursor: args.cursor,
          from: args.from ?? "now",
          limit: args.limit ?? 25,
          timeoutMs: args.timeoutMs ?? 30_000,
        },
        signal,
      );
    }
    if (name.startsWith("engine.")) {
      if (this.lifecycle) {
        return name === "engine.status" ? this.lifecycle.status() : this.lifecycle.request(name.slice(7), args);
      }
      if (name === "engine.status") {
        return {
          outcome: "completed",
          status: this.engine.draining ? "draining" : this.engine.s.pool.paused ? "paused" : "running",
          scheduling: this.engine.s.pool.paused ? "paused" : "running",
          boot: this.engine.boot,
          ...drainStatus(this.engine),
        };
      }
    }
    const applied: Result = await serial<Result>(this.engine, async () => {
      if (!spec.changes) {
        return executeCoordinationQuery(this.engine, name, args);
      }
      const requestId = args.requestId!;
      if (this.lifecycle?.receipt?.(requestId)) {
        return { outcome: "conflict", requestId, message: "That reference belongs to a lifecycle request." };
      }
      const db = this.engine.store.database;
      const { wait: _wait, timeoutMs: _timeout, ...details } = args;
      const hash = fingerprint([name, name === "validation.run" ? details : args]);
      const old = db
        .query<{ fingerprint: string; result: string }, [string]>(
          "SELECT fingerprint, result FROM coordination_receipts WHERE id = ?",
        )
        .get(requestId);
      if (old) {
        return old.fingerprint === hash
          ? name === "validation.run"
            ? (this.engine.extraValidations.get(requestId) ?? (JSON.parse(old.result) as Result))
            : (JSON.parse(old.result) as Result)
          : { outcome: "conflict", requestId, message: "That request reference was used with different arguments." };
      }
      // Sync decisions and their receipts commit with the state in one database transaction. Async
      // validations are serialized too; the existing commands keep their own saved request identities.
      let result: Result;
      const save = (savedResult: Result) => {
        if (
          args.itemId
          && ["completed", "pending"].includes(savedResult.outcome)
          && !this.engine.s.inbox.some((item) => item.id === args.itemId)
        ) {
          this.engine.store.noteHandled([args.itemId]);
        }
        this.engine.save();
        db.query(
          "INSERT INTO coordination_receipts VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET result=excluded.result",
        ).run(requestId, hash, JSON.stringify(savedResult));
      };
      const errorResult = (error: unknown): Result => ({
        outcome: "invalid",
        requestId,
        message: error instanceof Error ? error.message : "The operation could not be applied.",
      });
      if (name === "validation.run") {
        try {
          result = await this.engine.extraValidations.submit(args as unknown as ExtraRequest, save);
        } catch (error) {
          result = errorResult(error);
          db.transaction(() => save(result))();
        }
      } else if (name === "task.track-finding") {
        try {
          result = await this.engine.trackFinding(args.taskId!, args.findingId!, args.targetTaskId!, (link) => {
            const savedResult: Result = { outcome: "completed", ...link, requestId };
            save(savedResult);
            return savedResult;
          });
        } catch (error) {
          result = errorResult(error);
          db.transaction(() => save(result))();
        }
      } else if (["task.source", "inbox.retry"].includes(name)) {
        // Save submission before asynchronous validation, so a crash never blindly repeats it.
        save({
          outcome: "pending",
          requestId,
          message:
            "Submitted. Inspect the task before making a new request if the engine stops before its outcome is recorded.",
        });
        try {
          result = { ...(await executeCoordinationMutation(this.engine, name, args)), requestId };
        } catch (error) {
          result = errorResult(error);
        }
        db.transaction(() => save(result))();
      } else {
        result = db.transaction(() => {
          let savedResult: Result;
          try {
            savedResult = { ...(executeCoordinationMutation(this.engine, name, args) as Result), requestId };
          } catch (error) {
            savedResult = errorResult(error);
          }
          save(savedResult);
          return savedResult;
        })();
      }
      // Task creation and its retry receipt are durable before the first admission pass.
      if (
        (["task.add", "task.wait"].includes(name) && result.outcome === "completed")
        || (name === "validation.run" && result.outcome === "pending")
      ) {
        this.engine.schedule();
      }
      return clone(result);
    });
    if (name !== "validation.run" || !args.wait || applied.outcome !== "pending" || args.timeoutMs === 0) {
      return applied;
    }
    const requestId = args.requestId!;
    // Waiting is outside the decision queue and belongs only to this caller.
    return new Promise<Result>((resolve) => {
      let unsubscribe = () => {};
      const finish = (result: Result) => {
        clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener("abort", abort);
        resolve(result);
      };
      const current = () => this.engine.extraValidations.get(requestId) ?? applied;
      const check = () => {
        const result = current();
        if (result.outcome !== "pending" || this.engine.stopped) {
          finish(result);
        }
      };
      const abort = () =>
        finish({
          ...current(),
          outcome: "pending",
          message: "Still pending. Retry the same request reference; caller cancellation does not stop the run.",
        });
      const timer = setTimeout(abort, args.timeoutMs ?? 30_000);
      unsubscribe = this.engine.subscribe(check);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
      } else {
        check();
      }
    });
  }
}
