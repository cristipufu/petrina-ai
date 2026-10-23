import { blocksDependents, displayTask } from "./repositories.js";
// Finished work is read a page at a time. The live board never needs its conversations or plans.
import type { Cleanup, Id, State, StepRecord, Task } from "./model.js";
import type { ReviewStats } from "./reviews.js";
import { involvesProduct, taskProductIds } from "./repositories.js";
import { markedDoneUnconfirmed } from "./cleanup.js";
import { taskUsageSummaries, type TaskUsageSummary } from "./analytics.js";
import type { WorkLogReader } from "./worklog.js";

export interface HistoryQuery { status?: HistoryStatus; routineId?: Id; productId?: Id; query?: string; cursor?: string; limit?: number; states?: readonly ("done" | "cancelled")[]; taskId?: Id; held?: boolean; includeUsage?: boolean }
export type HistoryItem = Pick<Task, "id" | "productId" | "title" | "kind" | "state" | "createdAt" | "finishedAt" | "statusLine" | "delivery" | "pr" | "release" | "landed" | "localUpdate" | "combinedInto"> & {
  state: "done" | "cancelled";
  /** Opt-in whole-task figures; never conversations or per-turn records. */
  usage?: TaskUsageSummary;
  /** Compact scheduling evidence; older summaries are refreshed by the archive reader. */
  blocksDependents?: boolean;
  maintenance?: Pick<NonNullable<Task["maintenance"]>, "noProductChanges">;
  /** You marked one product's work done without a confirmed delivery; a pull request found later does not change that. */
  cleanup?: Pick<Cleanup, "markedDone">;
  productIds?: readonly Id[];
  products?: readonly { id: Id; name: string }[];
  deliveries?: readonly (Pick<Task, "productId" | "delivery" | "pr" | "release" | "landed" | "localUpdate"> & { nothingToPublish?: boolean; cleanup?: Pick<Cleanup, "markedDone"> })[];
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
  if (item.pr && !markedDoneUnconfirmed(item, item)) return item.pr.state === "merged" ? "merged" : "closed";
  return "marked-done";
}
/** Missing fields in a saved companion delivery must never inherit the lead's evidence. */
export function historyDeliveryItem(item: HistoryItem, work: NonNullable<HistoryItem["deliveries"]>[number]): HistoryItem {
  return { ...item, productId: work.productId, delivery: work.delivery, pr: work.pr, release: work.release, landed: work.landed, localUpdate: work.localUpdate, cleanup: work.cleanup, deliveries: undefined };
}
export interface HistoryPage { items: readonly HistoryItem[]; nextCursor?: string; total: number }
/** Attach just this page's whole-task totals, independent of its product filter. */
export function historyPageUsage(page: HistoryPage, log: WorkLogReader): HistoryPage {
  const usage = taskUsageSummaries(log, page.items.map(item => item.id));
  return { ...page, items: page.items.map(item => ({ ...item, usage: usage.get(item.id)! })) };
}
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
  const deliveries = task.repositories?.map((work) => {
    const { productId, delivery, pr, release, landed, localUpdate, nothingToPublish } = work;
    return { productId, delivery, pr, release, landed, localUpdate, nothingToPublish, ...(markedDoneUnconfirmed(task, work) ? { cleanup: { markedDone: true } } : {}) };
  });
  return { blocksDependents: blocksDependents(task), id, productId, title, kind, state: state as HistoryItem["state"], createdAt, finishedAt, statusLine, delivery, pr, release, landed, localUpdate, ...(task.maintenance?.noProductChanges ? { maintenance: { noProductChanges: true } } : {}), ...(!task.repositories && markedDoneUnconfirmed(task, task) ? { cleanup: { markedDone: true } } : {}), ...(combinedInto ? { combinedInto } : {}), ...(task.repositories || productIds.length > 1 ? { productIds, products, deliveries } : {}) };
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
