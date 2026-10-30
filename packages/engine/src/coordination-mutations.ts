import type {
  CoordinationResult as Result,
  InboxItem,
} from "@petrina/core";
import { messageRemovalText, offeredLessons } from "@petrina/core";
import { executionFor } from "@petrina/orchestrator";
import {
  decisionsForRequest,
  drainStatus,
  requestRevision,
} from "./coordination-views.js";
import type { Engine } from "./engine.js";
import type { RuntimeTask } from "./kernel.js";
import type { MutationOperationName, OperationInput } from "./operations.js";

export type LifecycleOnlyMutationName =
  | "engine.start"
  | "engine.stop"
  | "engine.restart"
  | "engine.promote"
  | "engine.rollback";
export type DirectMutationName = "validation.run" | "task.track-finding";
export type DelegatedMutationName = Exclude<
  MutationOperationName,
  LifecycleOnlyMutationName | DirectMutationName
>;

type InboxMutationName =
  | "inbox.answer"
  | "inbox.allow"
  | "inbox.deny"
  | "inbox.approve"
  | "inbox.changes"
  | "inbox.rerun-checks"
  | "inbox.retry"
  | "inbox.recovery"
  | "learning.accept"
  | "learning.decline"
  | "review-guide.accept"
  | "review-guide.decline"
  | "screen.allow";

type StateMutationName = Exclude<DelegatedMutationName, InboxMutationName>;

type TaskMutationName = {
  [K in StateMutationName]: OperationInput<K> extends { taskId: string } ? K : never;
}[StateMutationName];

type GlobalMutationName = Exclude<StateMutationName, TaskMutationName>;

interface InboxMutationContext<K extends InboxMutationName> {
  readonly engine: Engine;
  readonly item: InboxItem;
  readonly itemId: string;
  readonly itemTask: RuntimeTask;
  readonly args: OperationInput<K>;
  readonly done: (more?: Record<string, unknown>) => Result;
  readonly unavailable: (message: string) => Result;
}

type InboxMutationHandler<K extends InboxMutationName> = (
  context: InboxMutationContext<K>,
) => Result | Promise<Result> | undefined | void;

interface TaskMutationContext<K extends TaskMutationName> {
  readonly engine: Engine;
  readonly task: RuntimeTask;
  readonly name: K;
  readonly args: OperationInput<K>;
  readonly done: (more?: Record<string, unknown>) => Result;
  readonly unavailable: (message: string) => Result;
}

type TaskMutationHandler<K extends TaskMutationName> = (
  context: TaskMutationContext<K>,
) => Result | Promise<Result> | undefined | void;

interface GlobalMutationContext<K extends GlobalMutationName> {
  readonly engine: Engine;
  readonly name: K;
  readonly args: OperationInput<K>;
  readonly done: (more?: Record<string, unknown>) => Result;
  readonly unavailable: (message: string) => Result;
}

type GlobalMutationHandler<K extends GlobalMutationName> = (
  context: GlobalMutationContext<K>,
) => Result | Promise<Result> | undefined | void;

export const INBOX_MUTATION_HANDLERS: { readonly [K in InboxMutationName]: InboxMutationHandler<K> } = {
  "inbox.answer": ({ engine, itemId, args }) => {
    engine.answer(itemId, args.answer, { clientId: args.requestId });
  },
  "inbox.allow": ({ engine, itemId }) => {
    engine.allow(itemId, "once");
  },
  "inbox.deny": ({ engine, itemId, args }) => {
    engine.deny(itemId, args.note, { clientId: args.requestId });
  },
  "inbox.approve": ({ engine, itemId }) => {
    engine.approve(itemId);
  },
  "inbox.changes": ({ engine, itemId, args }) => {
    engine.requestChanges(itemId, args.note);
  },
  "inbox.rerun-checks": ({ engine, itemId }) => {
    engine.rerunChecks(itemId);
  },
  "inbox.retry": ({ engine, itemId, done }) =>
    engine.retry(itemId).then(() =>
      engine.s.inbox.some((candidate) => candidate.id === itemId)
        ? { outcome: "pending", message: "Retry checked the tool; the request is still open." }
        : done(),
    ),
  "inbox.recovery": ({ engine, itemId, itemTask, args, unavailable }) => {
    if (args.decision === "check" && executionFor(itemTask).work.shipping?.carriedOver) {
      return unavailable(
        "Petrina cannot automatically check this older delivery. Inspect GitHub, then choose ship again or mark done.",
      );
    }
    if (args.decision === "check") {
      engine.checkShipping(itemId);
    } else if (args.decision === "ship-again") {
      engine.shipAgain(itemId);
    } else {
      engine.markDone(itemId);
    }
    return {
      outcome: "pending",
      message:
        args.decision === "mark-done"
          ? "Marked done; delivery remains unconfirmed."
          : "Recovery decision accepted; inspect the task for its result.",
    };
  },
  "learning.accept": ({ engine, item, itemId, args, unavailable }) => {
    const { positions } = args;
    const count = offeredLessons(item.body).length;
    if (
      !positions.length
      || positions.some((position) => position >= count)
      || new Set(positions).size !== positions.length
    ) {
      return unavailable("Select one or more valid zero-based lesson positions from this offer.");
    }
    engine.addLessons(itemId, positions);
    return undefined;
  },
  "learning.decline": ({ engine, itemId }) => {
    engine.decline(itemId);
  },
  "review-guide.decline": ({ engine, itemId }) => {
    engine.decline(itemId);
  },
  "review-guide.accept": ({ engine, item, itemId, unavailable }) => {
    if (!item.body?.trim()) {
      return unavailable("This proposal has no point to accept.");
    }
    engine.approve(itemId);
    return undefined;
  },
  "screen.allow": ({ engine, item, itemTask, unavailable }) => {
    if (!itemTask.screen || itemTask.screen.allowed || itemTask.screen.granted) {
      return unavailable("This task has no screen request still needing permission.");
    }
    engine.allowScreen(item.taskId);
    return {
      outcome: "pending",
      message: "Screen request allowed; existing screen and pool rules still apply.",
    };
  },
};

const updateTaskHold =
  (held: boolean) =>
  ({ engine, task, args, unavailable }: {
    engine: Engine;
    task: RuntimeTask;
    args: { taskId: string };
    unavailable: (message: string) => Result
  }): Result | undefined => {
    if (task.state !== "queued") {
      return unavailable("Only queued tasks can be held or released.");
    }
    engine.setHeld(args.taskId, held);
    return undefined;
  };

export const TASK_MUTATION_HANDLERS: { readonly [K in TaskMutationName]: TaskMutationHandler<K> } = {
  "task.queue": ({ engine, task, args, unavailable }) => {
    if (task.state !== "backlog") {
      return unavailable("Only backlog requests can be queued for work.");
    }
    engine.queueTask(args.taskId);
    return undefined;
  },
  "task.backlog": ({ engine, task, args, unavailable }) => {
    if (task.state !== "queued" || task.startedAt !== undefined) {
      return unavailable("Only queued tasks that have never started can return to backlog.");
    }
    engine.moveToBacklog(args.taskId);
    return undefined;
  },
  "task.update-backlog": ({ engine, task, args, unavailable }) => {
    if (task.state !== "backlog") {
      return unavailable("Only backlog requests can be edited before work starts.");
    }
    engine.updateBacklog(args.taskId, { title: args.title, description: args.description });
    return undefined;
  },
  "task.hold": updateTaskHold(true),
  "task.unhold": updateTaskHold(false),
  "task.pause": ({ engine, task, args, unavailable }) => {
    if (!["running", "needs-you", "waiting"].includes(task.state)) {
      return unavailable("This task cannot be paused in its current state.");
    }
    engine.pause(args.taskId);
    return undefined;
  },
  "task.resume": ({ engine, task, args, unavailable }) => {
    if (task.state !== "paused") {
      return unavailable("This task is not paused.");
    }
    engine.resume(args.taskId);
    return undefined;
  },
  "task.cancel": ({ engine, task, args, unavailable }) => {
    if (["done", "cancelled"].includes(task.state)) {
      return unavailable("This task has already finished or been cancelled.");
    }
    engine.cancel(args.taskId);
    return undefined;
  },
  "task.dependencies": ({ engine, args }) => {
    engine.setAfter(args.taskId, args.after);
  },
  "task.wait": ({ engine, task, args, done }) => {
    const { after } = args;
    const changed = engine.setRuntimeWait(args.taskId, after, args.reason, args.requestId);
    return done({
      taskId: args.taskId,
      unchanged: !changed,
      message: changed
        ? after.length
          ? "Wait saved. Already-admitted work finishes before the task waits."
          : "Wait cleared. Ordinary scheduling and checks still apply."
        : !after.length && task.runtimeWait?.releasedAt !== undefined
          ? "Unchanged. This prerequisite wait has already ended."
          : task.runtimeWait
            ? "Unchanged. This prerequisite wait is already saved."
            : "Unchanged. This task has no prerequisite wait to clear.",
    });
  },
  "task.reorder": ({ engine, task, args, unavailable }) => {
    if (task.state !== "queued") {
      return unavailable("Only queued tasks can be reordered.");
    }
    if (args.anchorId && args.side) {
      if (engine.placeInQueue(args.taskId, args.anchorId, args.side) < 0) {
        return unavailable("Choose a different queued task as the reorder anchor.");
      }
      return undefined;
    }
    if (args.position !== undefined) {
      engine.moveInQueue(args.taskId, args.position);
      return undefined;
    }
    return unavailable("Supply a position, or an anchor and side.");
  },
  "task.source": ({ engine, task, args, done, unavailable }) =>
    engine.setTaskStart(args.taskId, args.choice).then(() =>
      task.workError ? { ...unavailable(task.workError), taskId: args.taskId } : done({ taskId: args.taskId }),
    ),
  "task.message": ({ engine, task, args, done, unavailable }) => {
    if (["done", "cancelled"].includes(task.state)) {
      return unavailable("This task has finished.");
    }
    const messageId = engine.sendMessage(args.taskId, args.text, args.mode, args.requestId);
    if (!messageId) {
      return unavailable("The message was not queued. Supply text and a new request reference.");
    }
    return done({ taskId: args.taskId, messageId });
  },
  "task.remove-message": ({ engine, task, args, unavailable }) => {
    const queued = task.queued.find((message) => message.id === args.messageId);
    if (!queued) {
      return unavailable("That message is no longer queued.");
    }
    const kept = messageRemovalText(queued);
    if (kept) {
      return unavailable(kept);
    }
    engine.removeQueued(args.taskId, args.messageId);
    return undefined;
  },
  "plan.assign": ({ engine, task, args, unavailable }) => {
    const at = task.plan?.stages.findIndex((stage) => stage.id === args.stageId) ?? -1;
    const stage = task.plan?.stages[at];
    if (!stage || at <= task.stageIndex || !engine.profile(args.profileId)) {
      return unavailable("Choose a valid profile and a future stage.");
    }
    const ids = stage[args.list];
    if (!ids || args.index >= ids.length) {
      return unavailable("That assignment does not exist.");
    }
    engine.setStageProfile(args.taskId, args.stageId, args.list, args.index, args.profileId);
    return undefined;
  },
  "plan.add-reviewer": ({ engine, task, args, unavailable }) => {
    const at = task.plan?.stages.findIndex((stage) => stage.id === args.stageId) ?? -1;
    const stage = task.plan?.stages[at];
    if (!stage || at <= task.stageIndex || !engine.profile(args.profileId)) {
      return unavailable("Choose a valid profile and a future stage.");
    }
    if (stage.kind !== "review-chain") {
      return unavailable("This stage does not accept extra reviewers.");
    }
    engine.addReviewer(args.taskId, args.stageId, args.profileId);
    return undefined;
  },
  "screen.task": ({ engine, args }) => {
    engine.setTaskScreen(args.taskId, args.allowed);
  },
};

export const GLOBAL_MUTATION_HANDLERS: { readonly [K in GlobalMutationName]: GlobalMutationHandler<K> } = {
  "engine.pause": ({ engine, done }) => {
    engine.setPoolPaused(true);
    return done({ ...drainStatus(engine) });
  },
  "engine.resume": ({ engine, done }) => {
    engine.setPoolPaused(false);
    return done();
  },
  "task.add": ({ engine, args, done }) => {
    const { requestId, ...input } = args;
    const taskId = engine.addTask({ ...input, clientId: requestId }, false);
    return done({ taskId });
  },
  "product.settings": ({ engine, args }) => {
    const { productId, requestId: _requestId, ...settings } = args;
    engine.updateProduct(productId, settings);
  },
  "product.checks": ({ engine, args }) => {
    engine.setProductChecks(args.productId, args.checks);
  },
  "product.check-setup": ({ engine, args }) => {
    engine.setProductCheckSetup(args.productId, args.requirements);
  },
  "product.remote-checks": ({ engine, args }) => {
    engine.setProductRemoteChecks(args.productId, args.checks);
  },
  "pool.limit": ({ engine, args }) => {
    engine.setPoolLimit(args.limit);
  },
  "tools.cap": ({ engine, args }) => {
    engine.setToolCap(args.toolId, args.cap);
  },
  "tools.check": ({ engine }) => {
    void engine.checkTools();
    return { outcome: "pending", message: "Readiness checks started." };
  },
  "screen.set": ({ engine, args }) => {
    engine.setScreenUse(args.mode);
  },
};

const isInboxMutation = (name: MutationOperationName): name is InboxMutationName =>
  Object.hasOwn(INBOX_MUTATION_HANDLERS, name);
const isTaskMutation = (name: MutationOperationName): name is TaskMutationName =>
  Object.hasOwn(TASK_MUTATION_HANDLERS, name);
const isGlobalMutation = (name: MutationOperationName): name is GlobalMutationName =>
  Object.hasOwn(GLOBAL_MUTATION_HANDLERS, name);

export function executeCoordinationMutation(
  engine: Engine,
  name: MutationOperationName,
  args: OperationInput<MutationOperationName>,
): Result | Promise<Result> {
  const payload = args as Record<string, unknown>;
  const productId = typeof payload["productId"] === "string" ? payload["productId"] : undefined;
  if (productId && !engine.s.products.some((product) => product.id === productId)) {
    return { outcome: "missing", message: "That product does not exist." };
  }
  const done = (more: Record<string, unknown> = {}): Result => ({ outcome: "completed", ...more });
  const unavailable = (message: string): Result => ({ outcome: "invalid", message });

  if (isInboxMutation(name)) {
    const inboxArgs = args as OperationInput<InboxMutationName>;
    const { itemId } = inboxArgs;
    const item = engine.s.inbox.find((candidate) => candidate.id === itemId);
    if (!item) {
      return {
        outcome: engine.store.handled(itemId) ? "handled" : "missing",
        message: engine.store.handled(itemId) ? "That request was already handled." : "That request does not exist.",
      };
    }
    const itemTask = engine.task(item.taskId);
    if (!itemTask || (["learnings", "guide"].includes(item.kind) && !engine.productOf(itemTask))) {
      return { outcome: "missing", message: "This request's task or product is no longer available." };
    }
    if (requestRevision(engine, item) !== inboxArgs.revision) {
      return { outcome: "changed", message: "The request changed. Inspect it again before deciding." };
    }
    if (
      !decisionsForRequest(item.kind, {
        ...executionFor(itemTask).work,
        repositories: itemTask.repositories,
        reviewDecision: itemTask.reviewDecision,
        journey: itemTask.journey,
      }).includes(name)
    ) {
      return unavailable(`That is a ${item.kind} request. Use its available decisions.`);
    }
    const handler = INBOX_MUTATION_HANDLERS[name] as (
      context: InboxMutationContext<InboxMutationName>,
    ) => Result | Promise<Result> | void;
    const outcome = handler({
      engine,
      item,
      itemId,
      itemTask,
      args: inboxArgs,
      done,
      unavailable,
    });
    return outcome ?? done({ itemId });
  }

  if (isTaskMutation(name)) {
    const taskArgs = args as OperationInput<TaskMutationName>;
    const task = engine.task(taskArgs.taskId);
    if (!task) {
      return { outcome: "missing", message: "That task does not exist." };
    }
    const handler = TASK_MUTATION_HANDLERS[name] as (
      context: TaskMutationContext<TaskMutationName>,
    ) => Result | Promise<Result> | void;
    const outcome = handler({
      engine,
      task,
      name,
      args: taskArgs,
      done,
      unavailable,
    });
    return outcome ?? done({ taskId: taskArgs.taskId });
  }

  if (isGlobalMutation(name)) {
    const globalArgs = args as OperationInput<GlobalMutationName>;
    const handler = GLOBAL_MUTATION_HANDLERS[name] as (
      context: GlobalMutationContext<GlobalMutationName>,
    ) => Result | Promise<Result> | void;
    const outcome = handler({
      engine,
      name,
      args: globalArgs,
      done,
      unavailable,
    });
    return outcome ?? done();
  }

  return unavailable("This operation requires the running engine's lifecycle host.");
}
