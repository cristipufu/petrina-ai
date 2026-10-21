import { displayTask } from "./repositories.js";
// Finished work is read a page at a time. The live board never needs its conversations or plans.
import type { Id, State, StepRecord, Task } from "./model.js";
import type { ReviewStats } from "./reviews.js";
import { involvesProduct, taskProductIds } from "./repositories.js";

export interface HistoryQuery { status?: HistoryStatus; routineId?: Id; productId?: Id; query?: string; cursor?: string; limit?: number; states?: readonly ("done" | "cancelled")[]; taskId?: Id; held?: boolean }
export type HistoryItem = Pick<Task, "id" | "productId" | "title" | "kind" | "state" | "createdAt" | "finishedAt" | "statusLine" | "delivery" | "pr" | "release" | "landed" | "localUpdate" | "combinedInto"> & {
  state: "done" | "cancelled";
  maintenance?: Pick<NonNullable<Task["maintenance"]>, "noProductChanges">;
  productIds?: readonly Id[];
  products?: readonly { id: Id; name: string }[];
  deliveries?: readonly (Pick<Task, "productId" | "delivery" | "pr" | "release" | "landed" | "localUpdate"> & { nothingToPublish?: boolean })[];
};
/** Final outcomes, based on delivery evidence rather than the broad done/cancelled state. */
export const HISTORY_STATUSES = {
  cancelled: "Cancelled", committed: "Committed", released: "Released", merged: "Pull request merged",
  closed: "Pull request closed", "no-changes": "No product changes", "marked-done": "Marked as done",
  combined: "Combined into another task", mixed: "Mixed delivery outcomes",
} as const;
export type HistoryStatus = keyof typeof HISTORY_STATUSES;
export function historyStatus(item: HistoryItem): HistoryStatus {
  if (item.combinedInto) return "combined";
  if (item.state === "cancelled") return "cancelled";
  if (item.maintenance?.noProductChanges) return "no-changes";
  if (item.deliveries?.length) {
    const statuses = new Set(item.deliveries.map(work => work.nothingToPublish ? "no-changes" : historyStatus(historyDeliveryItem(item, work))));
    // A repository with no changes adds no separate delivery outcome to a shared task.
    if (statuses.size > 1) statuses.delete("no-changes");
    return statuses.size === 1 ? [...statuses][0]! : "mixed";
  }
  if (item.release) return "released";
  if (item.landed) return "committed";
  if (item.pr) return item.pr.state === "merged" ? "merged" : "closed";
  return "marked-done";
}
/** Missing fields in a saved companion delivery must never inherit the lead's evidence. */
export function historyDeliveryItem(item: HistoryItem, work: NonNullable<HistoryItem["deliveries"]>[number]): HistoryItem {
  return { ...item, productId: work.productId, delivery: work.delivery, pr: work.pr, release: work.release, landed: work.landed, localUpdate: work.localUpdate, deliveries: undefined };
}
export interface HistoryPage { items: readonly HistoryItem[]; nextCursor?: string; total: number }
export type HistoryDependency = HistoryItem & { blocksDependents: boolean };
export interface HistoryMetadata {
  revision: number;
  total: number;
  products: readonly { productId: Id; done: number; cancelled: number; shared?: number; blocked?: number }[];
  reviews: ReviewStats;
  reviewsByProduct: Readonly<Record<Id, ReviewStats>>;
  steps: readonly StepRecord[];
  /** Only finished tasks named by live tasks' dependencies, without their conversations. */
  dependencies?: readonly HistoryDependency[];
}

export const finishedTask = (task: Pick<Task, "state">): boolean => task.state === "done" || task.state === "cancelled";
export const historyAt = (task: Pick<Task, "finishedAt" | "createdAt">): number => task.finishedAt ?? task.createdAt;
/** Match the indexed title search: each query word starts a word in the task title. */
export function historyMatches(title: string, query: string): boolean {
  const words = (text: string) => (text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const tokens = words(title);
  return words(query).every((term) => tokens.some((token) => token.startsWith(term)));
}
export function historyItem(task: Task): HistoryItem {
  task = displayTask(task);
  const { id, productId, title, kind, state, createdAt, finishedAt, statusLine, delivery, pr, release, landed, localUpdate, combinedInto } = task;
  const productIds = taskProductIds(task);
  const products = task.repositories?.map((work) => ({ id: work.productId, name: work.source?.product.name ?? work.workProduct?.name ?? work.productId })) ?? task.workRows?.map((row) => ({ id: row.source?.product.id ?? row.choice.productId, name: row.source?.product.name ?? row.choice.productId })) ?? productIds.map((id) => ({ id, name: id }));
  const deliveries = task.repositories?.map(({ productId, delivery, pr, release, landed, localUpdate, nothingToPublish }) => ({ productId, delivery, pr, release, landed, localUpdate, nothingToPublish }));
  return { id, productId, title, kind, state: state as HistoryItem["state"], createdAt, finishedAt, statusLine, delivery, pr, release, landed, localUpdate, ...(task.maintenance?.noProductChanges ? { maintenance: { noProductChanges: true } } : {}), ...(combinedInto ? { combinedInto } : {}), ...(task.repositories || productIds.length > 1 ? { productIds, products, deliveries } : {}) };
}
export function historyCursor(item: Pick<Task, "id" | "finishedAt" | "createdAt">): string {
  return encodeURIComponent(JSON.stringify([historyAt(item), item.id]));
}
export function readHistoryCursor(cursor: string): { at: number; id: Id } {
  try {
    const pair: unknown = JSON.parse(decodeURIComponent(cursor));
    if (Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "number" && Number.isFinite(pair[0]) && typeof pair[1] === "string") return { at: pair[0], id: pair[1] };
  } catch { /* A malformed bookmark is reported in plain words. */ }
  throw new Error("This history page is unavailable. Start from the first page.");
}

/** The simulator has its small scripted history in memory; the real engine uses an indexed query. */
export function demoHistoryPage(state: Pick<State, "tasks" | "products">, request: HistoryQuery): HistoryPage {
  const cursor = request.cursor ? readHistoryCursor(request.cursor) : undefined;
  const matches = state.tasks.filter((task) => finishedTask(task) && (!request.routineId || task.maintenance?.routineId === request.routineId) && (!request.productId || involvesProduct(task, request.productId)) && (!request.taskId || task.id === request.taskId) && (!request.states || request.states.includes(task.state as "done" | "cancelled")) && (request.held === undefined || task.held === request.held) && (!request.status || historyStatus(historyItem(task)) === request.status) && historyMatches(task.title, request.query ?? ""));
  const after = matches.filter((task) => !cursor || historyAt(task) < cursor.at || (historyAt(task) === cursor.at && task.id < cursor.id));
  after.sort((a, b) => historyAt(b) - historyAt(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const size = Math.max(1, Math.min(100, Math.floor(request.limit ?? 24)));
  const items = after.slice(0, size).map(historyItem);
  return { items, total: matches.length, ...(after.length > size && items.length ? { nextCursor: historyCursor(items.at(-1)!) } : {}) };
}
