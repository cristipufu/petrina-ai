import type { CoordinationResult as Result } from "@petrina/core";
import { fingerprint } from "@petrina/storage/receipt-identity";
import { executeCoordinationMutation } from "./coordination-mutations.js";
import { executeCoordinationQuery } from "./coordination-queries.js";
import { drainStatus, type LifecycleControl } from "./coordination-views.js";
import { watchCoordination } from "./coordination-watch.js";
import type { Engine } from "./engine.js";
import {
  operation,
  type MutationOperationName,
  type OperationInput,
  type QueryOperationName,
} from "./operations.js";
import { ReleaseStore } from "./release-store.js";

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
  ) {}

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
    if (spec.name === "watch.wait") {
      return watchCoordination(
        this.engine,
        this.lifecycle,
        parsed.data as OperationInput<"watch.wait">,
        signal,
        () => this.call("engine.status", {}),
      );
    }
    if (spec.name === "watch.events") {
      const args = parsed.data as OperationInput<"watch.events">;
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
          kinds: args.kinds,
          cursor: args.cursor,
          from: args.from,
          limit: args.limit,
          timeoutMs: args.timeoutMs,
        },
        signal,
      );
    }
    if (spec.name.startsWith("engine.")) {
      if (this.lifecycle) {
        return spec.name === "engine.status"
          ? this.lifecycle.status()
          : this.lifecycle.request(spec.name.slice(7), parsed.data as Record<string, unknown>);
      }
      if (spec.name === "engine.status") {
        return {
          outcome: "completed",
          status: this.engine.draining ? "draining" : this.engine.s.pool.paused ? "paused" : "running",
          scheduling: this.engine.s.pool.paused ? "paused" : "running",
          boot: this.engine.boot,
          ...drainStatus(this.engine),
        };
      }
      if (spec.name === "engine.releases") {
        return { outcome: "completed", ...new ReleaseStore(this.engine.dataDir).list() };
      }
    }

    const applied: Result = await serial<Result>(this.engine, async () => {
      if (!spec.changes) {
        return executeCoordinationQuery(
          this.engine,
          spec.name as QueryOperationName,
          parsed.data as OperationInput<QueryOperationName>,
        );
      }
      const mutationName = spec.name as MutationOperationName;
      const mutationArgs = parsed.data as OperationInput<MutationOperationName>;
      const { requestId } = mutationArgs;
      if (this.lifecycle?.receipt?.(requestId)) {
        return { outcome: "conflict", requestId, message: "That reference belongs to a lifecycle request." };
      }
      const store = this.engine.store;
      const hashInput =
        mutationName === "validation.run"
          ? (() => {
              const { wait: _wait, timeoutMs: _timeout, ...details } =
                mutationArgs as OperationInput<"validation.run">;
              return details;
            })()
          : mutationArgs;
      const hash = fingerprint([mutationName, hashInput]);
      const old = store.readReceipt(requestId);
      if (old) {
        return old.fingerprint === hash
          ? mutationName === "validation.run"
            ? (this.engine.extraValidations.get(requestId) ?? (JSON.parse(old.result) as Result))
            : (JSON.parse(old.result) as Result)
          : { outcome: "conflict", requestId, message: "That request reference was used with different arguments." };
      }
      // Sync decisions and their receipts commit with the state in one database transaction. Async
      // validations are serialized too; the existing commands keep their own saved request identities.
      let result: Result;
      const itemId =
        "itemId" in mutationArgs && typeof mutationArgs.itemId === "string" ? mutationArgs.itemId : undefined;
      const save = (savedResult: Result) => {
        if (
          itemId
          && ["completed", "pending"].includes(savedResult.outcome)
          && !this.engine.s.inbox.some((item) => item.id === itemId)
        ) {
          store.noteHandled([itemId]);
        }
        this.engine.save();
        store.saveReceipt(requestId, hash, JSON.stringify(savedResult));
      };
      const errorResult = (error: unknown): Result => ({
        outcome: "invalid",
        requestId,
        message: error instanceof Error ? error.message : "The operation could not be applied.",
      });
      if (mutationName === "validation.run") {
        const validationArgs = mutationArgs as OperationInput<"validation.run">;
        try {
          result = await this.engine.extraValidations.submit(validationArgs, save);
        } catch (error) {
          result = errorResult(error);
          store.inTransaction(() => save(result));
        }
      } else if (mutationName === "task.track-finding") {
        const trackArgs = mutationArgs as OperationInput<"task.track-finding">;
        try {
          result = await this.engine.trackFinding(
            trackArgs.taskId,
            trackArgs.findingId,
            trackArgs.targetTaskId,
            (link) => {
              const savedResult: Result = { outcome: "completed", ...link, requestId };
              save(savedResult);
              return savedResult;
            },
          );
        } catch (error) {
          result = errorResult(error);
          store.inTransaction(() => save(result));
        }
      } else if (spec.submissionReceipt) {
        // Save submission before asynchronous validation, so a crash never blindly repeats it.
        save({
          outcome: "pending",
          requestId,
          message:
            "Submitted. Inspect the task before making a new request if the engine stops before its outcome is recorded.",
        });
        try {
          result = { ...(await executeCoordinationMutation(this.engine, mutationName, mutationArgs)), requestId };
        } catch (error) {
          result = errorResult(error);
        }
        store.inTransaction(() => save(result));
      } else {
        result = store.inTransaction(() => {
          let savedResult: Result;
          try {
            savedResult = {
              ...(executeCoordinationMutation(this.engine, mutationName, mutationArgs) as Result),
              requestId,
            };
          } catch (error) {
            savedResult = errorResult(error);
          }
          save(savedResult);
          return savedResult;
        });
      }
      // Task creation and its retry receipt are durable before the first admission pass.
      if (spec.schedulesOn && spec.schedulesOn === result.outcome) {
        this.engine.schedule();
      }
      return clone(result);
    });

    if (spec.name !== "validation.run") {
      return applied;
    }
    const validationArgs = parsed.data as OperationInput<"validation.run">;
    if (!validationArgs.wait || applied.outcome !== "pending" || validationArgs.timeoutMs === 0) {
      return applied;
    }
    const { requestId } = validationArgs;
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
      const timer = setTimeout(abort, validationArgs.timeoutMs);
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
