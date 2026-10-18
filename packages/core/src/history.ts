// Finished work is read a page at a time. The live board never needs its conversations or plans.
import type { Id, State, StepRecord, Task } from "./model.js";
import type { ReviewStats } from "./reviews.js";

export interface HistoryQuery { productId?: Id; query?: string; cursor?: string; limit?: number }
export type HistoryItem = Pick<Task, "id" | "productId" | "title" | "kind" | "state" | "createdAt" | "finishedAt" | "statusLine" | "delivery" | "pr" | "release" | "landed" | "localUpdate"> & { state: "done" | "cancelled" };
export interface HistoryPage { items: readonly HistoryItem[]; nextCursor?: string; total: number }
export interface HistoryMetadata {
  revision: number;
  total: number;
  products: readonly { productId: Id; done: number; cancelled: number }[];
  reviews: ReviewStats;
  reviewsByProduct: Readonly<Record<Id, ReviewStats>>;
  steps: readonly StepRecord[];
  /** Only finished tasks named by live tasks' dependencies, without their conversations. */
  dependencies?: readonly HistoryItem[];
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
  const { id, productId, title, kind, state, createdAt, finishedAt, statusLine, delivery, pr, release, landed, localUpdate } = task;
  return { id, productId, title, kind, state: state as HistoryItem["state"], createdAt, finishedAt, statusLine, delivery, pr, release, landed, localUpdate };
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
  const matches = state.tasks.filter((task) => finishedTask(task) && (!request.productId || task.productId === request.productId) && historyMatches(task.title, request.query ?? ""));
  const after = matches.filter((task) => !cursor || historyAt(task) < cursor.at || (historyAt(task) === cursor.at && task.id < cursor.id));
  after.sort((a, b) => historyAt(b) - historyAt(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const size = Math.max(1, Math.min(100, Math.floor(request.limit ?? 24)));
  const items = after.slice(0, size).map(historyItem);
  return { items, total: matches.length, ...(after.length > size && items.length ? { nextCursor: historyCursor(items.at(-1)!) } : {}) };
}
