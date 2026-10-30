import type {
  CoordinationResult as Result,
  InboxItem,
  NewTaskInput,
  ScreenMode,
} from "@petrina/core";
import { messageRemovalText, offeredLessons } from "@petrina/core";
import { executionFor } from "@petrina/orchestrator";
import {
  decisionsForRequest,
  drainStatus,
  requestRevision,
  type CoordinationArgs,
} from "./coordination-views.js";
import type { Engine } from "./engine.js";
import type { RuntimeTask } from "./kernel.js";

interface InboxMutationContext {
  readonly engine: Engine;
  readonly item: InboxItem;
  readonly itemId: string;
  readonly itemTask: RuntimeTask;
  readonly args: CoordinationArgs;
  readonly done: (more?: Record<string, unknown>) => Result;
  readonly unavailable: (message: string) => Result;
}

type InboxMutationHandler = (context: InboxMutationContext) => Result | Promise<Result> | void;

interface StateMutationContext {
  readonly engine: Engine;
  readonly task: RuntimeTask | undefined;
  readonly name: string;
  readonly args: CoordinationArgs;
  readonly done: (more?: Record<string, unknown>) => Result;
  readonly unavailable: (message: string) => Result;
}

type StateMutationHandler = (context: StateMutationContext) => Result | Promise<Result> | void;

const declineInboxItem: InboxMutationHandler = ({ engine, itemId }) => {
  engine.decline(itemId);
};

export const INBOX_MUTATION_HANDLERS: Readonly<Record<string, InboxMutationHandler>> = {
  "inbox.answer": ({ engine, itemId, args }) => {
    engine.answer(itemId, args.answer!, { clientId: args.requestId });
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
    engine.requestChanges(itemId, args.note!);
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
    const positions = args.positions!;
    const count = offeredLessons(item.body).length;
    if (
      !positions.length
      || positions.some((position) => position >= count)
      || new Set(positions).size !== positions.length
    ) {
      return unavailable("Select one or more valid zero-based lesson positions from this offer.");
    }
    engine.addLessons(itemId, positions);
  },
  "learning.decline": declineInboxItem,
  "review-guide.decline": declineInboxItem,
  "review-guide.accept": ({ engine, item, itemId, unavailable }) => {
    if (!item.body?.trim()) {
      return unavailable("This proposal has no point to accept.");
    }
    engine.approve(itemId);
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

const updateTaskHold: StateMutationHandler = ({ engine, task, name, args, unavailable }) => {
  if (task!.state !== "queued") {
    return unavailable("Only queued tasks can be held or released.");
  }
  engine.setHeld(args.taskId!, name === "task.hold");
};

const updatePlanAssignment: StateMutationHandler = ({ engine, task, name, args, unavailable }) => {
  const at = task!.plan?.stages.findIndex((stage) => stage.id === args.stageId) ?? -1;
  const stage = task!.plan?.stages[at];
  if (!stage || at <= task!.stageIndex || !engine.profile(args.profileId!)) {
    return unavailable("Choose a valid profile and a future stage.");
  }
  if (name === "plan.assign") {
    const list = args.list ?? "profileIds";
    const ids = stage[list];
    if (!ids || (args.index ?? 0) >= ids.length) {
      return unavailable("That assignment does not exist.");
    }
    engine.setStageProfile(args.taskId!, args.stageId!, list, args.index!, args.profileId!);
    return;
  }
  if (stage.kind !== "review-chain") {
    return unavailable("This stage does not accept extra reviewers.");
  }
  engine.addReviewer(args.taskId!, args.stageId!, args.profileId!);
};

export const STATE_MUTATION_HANDLERS: Readonly<Record<string, StateMutationHandler>> = {
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
    const taskId = engine.addTask({ ...(input as unknown as NewTaskInput), clientId: requestId }, false);
    return done({ taskId });
  },
  "task.queue": ({ engine, task, args, unavailable }) => {
    if (task!.state !== "backlog") {
      return unavailable("Only backlog requests can be queued for work.");
    }
    engine.queueTask(args.taskId!);
  },
  "task.backlog": ({ engine, task, args, unavailable }) => {
    if (task!.state !== "queued" || task!.startedAt !== undefined) {
      return unavailable("Only queued tasks that have never started can return to backlog.");
    }
    engine.moveToBacklog(args.taskId!);
  },
  "task.update-backlog": ({ engine, task, args, unavailable }) => {
    if (task!.state !== "backlog") {
      return unavailable("Only backlog requests can be edited before work starts.");
    }
    engine.updateBacklog(args.taskId!, { title: args.title!, description: args.description! });
  },
  "task.hold": updateTaskHold,
  "task.unhold": updateTaskHold,
  "task.pause": ({ engine, task, args, unavailable }) => {
    if (!["running", "needs-you", "waiting"].includes(task!.state)) {
      return unavailable("This task cannot be paused in its current state.");
    }
    engine.pause(args.taskId!);
  },
  "task.resume": ({ engine, task, args, unavailable }) => {
    if (task!.state !== "paused") {
      return unavailable("This task is not paused.");
    }
    engine.resume(args.taskId!);
  },
  "task.cancel": ({ engine, task, args, unavailable }) => {
    if (["done", "cancelled"].includes(task!.state)) {
      return unavailable("This task has already finished or been cancelled.");
    }
    engine.cancel(args.taskId!);
  },
  "task.dependencies": ({ engine, args }) => {
    engine.setAfter(args.taskId!, args.after!);
  },
  "task.wait": ({ engine, task, args, done }) => {
    const after = args.after!;
    const changed = engine.setRuntimeWait(args.taskId!, after, args.reason!, args.requestId!);
    return done({
      taskId: args.taskId!,
      unchanged: !changed,
      message: changed
        ? after.length
          ? "Wait saved. Already-admitted work finishes before the task waits."
          : "Wait cleared. Ordinary scheduling and checks still apply."
        : !after.length && task!.runtimeWait?.releasedAt !== undefined
          ? "Unchanged. This prerequisite wait has already ended."
          : task!.runtimeWait
            ? "Unchanged. This prerequisite wait is already saved."
            : "Unchanged. This task has no prerequisite wait to clear.",
    });
  },
  "task.reorder": ({ engine, task, args, unavailable }) => {
    if (task!.state !== "queued") {
      return unavailable("Only queued tasks can be reordered.");
    }
    if (args.anchorId && args.side) {
      if (engine.placeInQueue(args.taskId!, args.anchorId, args.side) < 0) {
        return unavailable("Choose a different queued task as the reorder anchor.");
      }
      return;
    }
    if (args.position !== undefined) {
      engine.moveInQueue(args.taskId!, args.position);
      return;
    }
    return unavailable("Supply a position, or an anchor and side.");
  },
  "task.source": ({ engine, task, args, done, unavailable }) =>
    engine.setTaskStart(args.taskId!, args.choice!).then(() =>
      task!.workError ? { ...unavailable(task!.workError), taskId: args.taskId! } : done({ taskId: args.taskId! }),
    ),
  "task.message": ({ engine, task, args, done, unavailable }) => {
    if (["done", "cancelled"].includes(task!.state)) {
      return unavailable("This task has finished.");
    }
    const messageId = engine.sendMessage(
      args.taskId!,
      args.text!,
      (args.mode as "now" | "queue" | "interrupt" | undefined) ?? "now",
      args.requestId,
    );
    if (!messageId) {
      return unavailable("The message was not queued. Supply text and a new request reference.");
    }
    return done({ taskId: args.taskId!, messageId });
  },
  "task.remove-message": ({ engine, task, args, unavailable }) => {
    const queued = task!.queued.find((message) => message.id === args.messageId);
    if (!queued) {
      return unavailable("That message is no longer queued.");
    }
    const kept = messageRemovalText(queued);
    if (kept) {
      return unavailable(kept);
    }
    engine.removeQueued(args.taskId!, args.messageId!);
  },
  "plan.assign": updatePlanAssignment,
  "plan.add-reviewer": updatePlanAssignment,
  "product.settings": ({ engine, args }) => {
    const { productId, requestId: _requestId, ...settings } = args;
    engine.updateProduct(productId!, settings as unknown as Parameters<Engine["updateProduct"]>[1]);
  },
  "product.checks": ({ engine, args }) => {
    engine.setProductChecks(args.productId!, args.checks ?? null);
  },
  "product.check-setup": ({ engine, args }) => {
    engine.setProductCheckSetup(args.productId!, args.requirements!);
  },
  "pool.limit": ({ engine, args }) => {
    engine.setPoolLimit(args.limit!);
  },
  "tools.cap": ({ engine, args }) => {
    engine.setToolCap(args.toolId!, args.cap!);
  },
  "tools.check": ({ engine }) => {
    void engine.checkTools();
    return { outcome: "pending", message: "Readiness checks started." };
  },
  "screen.set": ({ engine, args }) => {
    engine.setScreenUse(args.mode as ScreenMode);
  },
  "screen.task": ({ engine, args }) => {
    engine.setTaskScreen(args.taskId!, args.allowed!);
  },
};

export function executeCoordinationMutation(
  engine: Engine,
  name: string,
  args: CoordinationArgs,
): Result | Promise<Result> {
  if (args.productId && !engine.s.products.some((product) => product.id === args.productId)) {
    return { outcome: "missing", message: "That product does not exist." };
  }
  const task = args.taskId ? engine.task(args.taskId) : undefined;
  if (args.taskId && !task) {
    return { outcome: "missing", message: "That task does not exist." };
  }
  const done = (more: Record<string, unknown> = {}): Result => ({ outcome: "completed", ...more });
  const unavailable = (message: string): Result => ({ outcome: "invalid", message });
  if (args.itemId) {
    const itemId = args.itemId;
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
    if (requestRevision(engine, item as InboxItem) !== args.revision) {
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
    const handler = INBOX_MUTATION_HANDLERS[name];
    if (!handler) {
      return unavailable(`That is a ${item.kind} request. Use its available decisions.`);
    }
    const outcome = handler({ engine, item: item as InboxItem, itemId, itemTask, args, done, unavailable });
    return outcome ?? done({ itemId });
  }
  const handler = STATE_MUTATION_HANDLERS[name];
  if (!handler) {
    return unavailable("This operation requires the running engine's lifecycle host.");
  }
  const outcome = handler({ engine, task, name, args, done, unavailable });
  return outcome ?? done(args.taskId ? { taskId: args.taskId } : {});
}
