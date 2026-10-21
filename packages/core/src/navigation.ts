import { taskProductIds } from "./repositories.js";
import { boardSections } from "./board.js";
import type { InboxItem, State, Task } from "./model.js";

export type Page = "board" | "history" | "products" | "routines" | "agents" | "analytics" | "library" | "settings";
export type KeyArea = "board" | "inbox";
export type TaskList = KeyArea | "history" | undefined;

export function keyArea(page: Page, inboxOpen: boolean, owner: KeyArea, taskOpen: boolean): "task" | KeyArea | undefined {
  if (taskOpen) return "task";
  if (inboxOpen && owner === "inbox") return "inbox";
  return page === "board" || page === "history" ? "board" : undefined;
}

/** Every word may match either the title or the product, regardless of board filters. */
export function matchesWords(query: string, ...fields: string[]): boolean {
  const text = fields.join(" ").toLocaleLowerCase();
  return query.trim().toLocaleLowerCase().split(/\s+/).every((word) => text.includes(word));
}

export function searchTasks(state: State, query: string): Task[] {
  const names = new Map(state.products.map((product) => [product.id, product.name]));
  const rank = (task: Task) => task.state === "needs-you" || task.state === "failed" ? 0 : task.state === "done" || task.state === "cancelled" ? 2 : 1;
  return state.tasks.filter((task) => matchesWords(query, task.title, ...taskProductIds(task).map((id) => names.get(id) ?? "")))
    .sort((a, b) => rank(a) - rank(b) || a.priority - b.priority || a.createdAt - b.createdAt);
}

export function boardOrder(tasks: readonly Task[], visible: (task: Task) => boolean, showDone: boolean): string[] {
  const sections = boardSections(tasks, visible);
  return [...sections["needs-you"], ...sections.working, ...sections.waiting, ...sections.queue, ...sections.backlog, ...(showDone ? sections.done : [])].map((task) => task.id);
}

/** Agents kept waiting first, then by task priority and age. Quiet screen requests come after everything else. */
export function inboxOrder(state: State): InboxItem[] {
  const started = new Map(state.tasks.map((task) => [task.id, task.startedAt ?? 0]));
  const rank = (item: InboxItem) => (item.blocking ? 0 : item.kind === "screen" ? 2 : 1);
  return [...state.inbox].sort((a, b) => rank(a) - rank(b) || (started.get(a.taskId) ?? 0) - (started.get(b.taskId) ?? 0) || a.at - b.at);
}

/**
 * The line under "Needs you": agents waiting on the coordinator, tasks stuck until they act, and what
 * waits at a checkpoint. "Nobody is stuck" only when nothing is. A quiet screen request is none of these.
 */
export function inboxSummary(items: readonly InboxItem[]): string {
  const counted = items.filter((item) => item.kind !== "screen");
  if (counted.length === 0) return "You're not blocking anyone.";
  const waiting = counted.filter((item) => item.blocking).length;
  const stuck = counted.filter((item) => !item.blocking && item.kind === "stuck").length;
  const rest = counted.length - waiting - stuck;
  const parts: string[] = [];
  if (waiting) parts.push(`${waiting} agent${waiting === 1 ? " is" : "s are"} waiting on you.`);
  if (stuck) parts.push(`${stuck} task${stuck === 1 ? " is" : "s are"} stuck until you act on ${stuck === 1 ? "it" : "them"}.`);
  if (rest) parts.push(parts.length ? "The rest wait at checkpoints." : "Nobody is stuck. These wait at checkpoints.");
  return parts.join(" ");
}

export function inboxTab(kind: InboxItem["kind"]): "plan" | "design" | "review" | "session" {
  if (kind === "plan") return "plan";
  if (kind === "design" || kind === "disagreement") return "design";
  if (kind === "delivery" || kind === "guide" || kind === "learnings") return "review";
  return "session";
}

/** Keep the task, not its position. Only a removed task hands its place to its neighbour. */
export function reconcileHighlight(previous: readonly string[], next: readonly string[], id: string | undefined): string | undefined {
  if (!id || next.includes(id)) return id;
  return next[Math.min(Math.max(0, previous.indexOf(id)), next.length - 1)];
}

export function stepHighlight(ids: readonly string[], id: string | undefined, direction: -1 | 1, previous: readonly string[] = ids): string | undefined {
  if (!ids.length) return undefined;
  if (!id) return ids[0];
  const index = ids.indexOf(id);
  if (index >= 0) return ids[Math.max(0, Math.min(ids.length - 1, index + direction))];
  // An open task can outlive its card or request. Walk from its last known neighbours,
  // skipping others that also left, and stop at the end instead of restarting the list.
  const oldIndex = previous.indexOf(id);
  if (oldIndex < 0) return undefined;
  const remaining = new Set(ids);
  for (let next = oldIndex + direction; next >= 0 && next < previous.length; next += direction) {
    if (remaining.has(previous[next]!)) return previous[next];
  }
  return undefined;
}

/** Insert beside the visible neighbour after removing the moved card. Hidden cards keep order. */
export function queuePlacement(queue: readonly string[], taskId: string, anchorId: string, side: "before" | "after"): number | undefined {
  if (taskId === anchorId || !queue.includes(taskId)) return undefined;
  const rest = queue.filter((id) => id !== taskId);
  const anchor = rest.indexOf(anchorId);
  return anchor < 0 ? undefined : anchor + Number(side === "after");
}

export function queueNeighbour(queue: readonly string[], visibleIds: readonly string[], taskId: string, direction: -1 | 1): string | undefined {
  const visible = new Set(visibleIds);
  const ids = queue.filter((id) => visible.has(id));
  const index = ids.indexOf(taskId);
  return index < 0 ? undefined : ids[index + direction];
}

export function draftFor(drafts: Readonly<Record<string, string>>, taskId: string): string {
  return drafts[taskId] ?? "";
}

export function withDraft(drafts: Readonly<Record<string, string>>, taskId: string, text: string): Record<string, string> {
  const next = { ...drafts };
  if (text) next[taskId] = text;
  else delete next[taskId];
  return next;
}
