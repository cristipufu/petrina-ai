import type { CoordinationResult as Result } from "@petrina/core";
import { fingerprint } from "@petrina/storage/receipt-identity";
import { executeCoordinationQuery } from "./coordination-queries.js";
import { drainStatus, taskSummary, type LifecycleControl } from "./coordination-views.js";
import type { Engine } from "./engine.js";
import { paginate } from "./evidence-read.js";
import type { OperationInput } from "./operations.js";

export async function watchCoordination(
  engine: Engine,
  lifecycle: LifecycleControl | undefined,
  args: OperationInput<"watch.wait">,
  signal: AbortSignal | undefined,
  engineStatus: () => Promise<Result> | Result,
): Promise<Result> {
  const deadline = Date.now() + args.timeoutMs;
  let selected: ReturnType<typeof taskSummary>[] | undefined;
  const snapshot = async (): Promise<Result> => {
    if (args.target === "engine") {
      return lifecycle?.status() ?? engineStatus();
    }
    if (args.target === "pool") {
      return { outcome: "completed", pool: engine.s.pool, ...drainStatus(engine) };
    }
    if (args.target === "inbox") {
      return executeCoordinationQuery(engine, "inbox.list", {
        productId: args.productId,
        taskId: args.taskId,
        search: args.search,
        kinds: args.kinds,
        limit: args.limit,
        cursor: args.cursor,
      });
    }
    const ids: string[] = args.taskIds ?? (args.taskId ? [args.taskId] : []);
    if (!ids.length) {
      return { outcome: "invalid", message: "Choose taskId or taskIds for a focused task wait." };
    }
    const tasks = ids.flatMap((id) => {
      const task = engine.taskDetails(id);
      return task ? [task] : [];
    });
    if (tasks.length !== ids.length) {
      return { outcome: "missing", message: "A selected task does not exist." };
    }
    selected = tasks.map((task) => taskSummary(engine, task));
    return paginate(
      args.condition === "decision" ? selected.filter((task) => task.inbox.length > 0) : selected,
      args,
      ["watch", ids],
    );
  };
  // Subscribe before the first read. No change between setup and snapshot can be lost.
  let wake: (() => void) | undefined;
  let dirty = false;
  const off = engine.subscribe(() => {
    dirty = true;
    wake?.();
  });
  try {
    let baseline = args.marker;
    for (;;) {
      dirty = false;
      const current = await snapshot();
      if (current.outcome !== "completed") {
        return current;
      }
      const marker = `${engine.boot}.${fingerprint([current, selected])}`;
      if (baseline && !baseline.startsWith(`${engine.boot}.`)) {
        return {
          outcome: "continuity-lost",
          marker,
          result: current,
          message: "The engine restarted. Inspect this focused result and begin a new watch.",
        };
      }
      baseline ??= marker;
      // Pagination bounds the reply, never the set whose condition the caller selected.
      const items = selected ?? (current.items as ReturnType<typeof taskSummary>[] | undefined);
      const matches =
        args.condition === "change"
          ? marker !== baseline
          : args.condition === "drained"
            ? current.drained === true
            : args.condition === "decision"
              ? args.target === "inbox"
                ? Boolean(items?.length)
                : Boolean(items?.some((task) => task.inbox.length > 0))
              : args.condition === "state"
                ? Boolean(items?.length && items.every((task) => args.states?.includes(task.state)))
                : args.condition === "landed"
                  ? Boolean(items?.length && items.every((task) => task.landing === "landed"))
                  : Boolean(items?.length && items.every((task) => task.deliveryConfirmed));
      if (matches) {
        return { outcome: "completed", marker, result: current };
      }
      if (engine.stopped) {
        return { outcome: "disconnected", marker, result: current };
      }
      if (signal?.aborted) {
        return { outcome: "disconnected", marker, result: current, message: "The wait was cancelled." };
      }
      if (Date.now() >= deadline) {
        return { outcome: "timed-out", marker, result: current, message: "The deadline ended this wait. Work continues." };
      }
      if (dirty) {
        continue;
      }
      await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          wake = undefined;
          resolve();
        };
        wake = done;
        signal?.addEventListener("abort", done, { once: true });
        timer = setTimeout(done, Math.min(1_000, Math.max(0, deadline - Date.now())));
      });
    }
  } finally {
    off();
  }
}
