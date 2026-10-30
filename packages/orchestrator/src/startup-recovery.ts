import { withdrawAsks, type DeepMutable, type Id, type InboxItem } from "@petrina/core";
import type { RuntimeTask } from "./model.js";
import { executionFor } from "./repository-context.js";

export interface StartupRecoveryEffects {
  readonly now?: () => number;
  readonly onDroppedPermission?: (task: RuntimeTask, item: DeepMutable<InboxItem>) => void;
}

export function keepRecoveredInboxItem(
  item: DeepMutable<InboxItem>,
  findTask: (taskId: Id) => RuntimeTask | undefined,
): boolean {
  if (!item.blocking || item.kind === "maintenance-settings") return true;
  const task = findTask(item.taskId);
  return (
    item.kind === "question"
    && task?.state === "needs-you"
    && (executionFor(task).work.conversation?.asked?.itemId === item.id
      || task.queued.some((message) =>
        Object.values(message.deliveries ?? {}).some((receipt) => receipt.decisionId === item.id),
      ))
  );
}

/**
 * After a restart, nothing is running: put interrupted work back in line. A question stays in the
 * inbox for the conversation that asked it, without a slot; an open permission request goes.
 */
export function recoverStartupWork(
  tasks: readonly RuntimeTask[],
  inbox: readonly DeepMutable<InboxItem>[],
  effects: StartupRecoveryEffects = {},
): DeepMutable<InboxItem>[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const findTask = (taskId: Id) => byId.get(taskId);
  const keep = (item: DeepMutable<InboxItem>) => keepRecoveredInboxItem(item, findTask);
  const now = effects.now?.() ?? Date.now();
  for (const item of inbox.filter((entry) => !keep(entry))) {
    const task = findTask(item.taskId);
    if (!task) continue;
    // On the journey too: what went unanswered hangs under its step as withdrawn.
    withdrawAsks(task, [item.id], now);
    if (item.kind === "permission") effects.onDroppedPermission?.(task, item);
  }
  const kept = inbox.filter(keep);
  for (const task of tasks) {
    if (task.workValidating) {
      task.workValidating = false;
      task.workError = "Validation was interrupted. Apply the saved choices to check them again.";
    }
    if (task.driving) {
      // Still in the coordinator's hands: the step keeps its seat, and Hand back works as before.
      task.state = "needs-you";
      task.holdsSlot = true;
      continue;
    }
    if (kept.some((item) => item.taskId === task.id && item.blocking)) {
      task.statusLine = "Waiting for your answer";
      delete task.agent;
    } else if (
      ["running", "waiting"].includes(task.state)
      || (task.state === "needs-you" && !kept.some((item) => item.taskId === task.id))
    ) {
      task.state = "waiting";
      task.statusLine = "Waiting for a free slot";
      delete task.agent;
    }
    task.holdsSlot = false;
    // Nothing runs after a restart: agents that worked beside the main one are gone too.
    delete task.helpers;
  }
  return kept;
}
