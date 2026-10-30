// Usage limits over time. The pool keeps only the latest report per tool and kind of limit, so
// a bounded history of readings sits beside the work log: thirty days, and a reading identical to
// the one before it for the same limit is not written again. Only each limit's percentage, status,
// length and reset time are kept, with when the tool said so.

import type { UsageReport } from "./model.js";

export const USAGE_HISTORY_DAYS = 30;
export const USAGE_HISTORY_MS = USAGE_HISTORY_DAYS * 24 * 60 * 60_000;

export interface UsageHistoryFilter {
  /** Readings at or after this time. */
  from?: number;
  /** Readings before this time. */
  to?: number;
}

/** The same limit: the same tool, kind and model family. */
export function sameLimit(a: Pick<UsageReport, "toolId" | "kind" | "model">, b: Pick<UsageReport, "toolId" | "kind" | "model">): boolean {
  return a.toolId === b.toolId && a.kind === b.kind && (a.model ?? "") === (b.model ?? "");
}

/** The same reading of the same limit: only the time it was reported differs. */
export function sameReading(a: UsageReport, b: UsageReport): boolean {
  return sameLimit(
    a,
    b
  ) && a.status === b.status && (a.utilization ?? -1) === (b.utilization ?? -1) && (a.resetsAt ?? 0) === (b.resetsAt ?? 0) && (a.windowMinutes ?? 0) === (b.windowMinutes ?? 0) && (a.name ?? "") === (b.name ?? "");
}

/**
 * Add one reading to a history kept in time order, in place. Readings older than thirty days before
 * it are dropped, and a reading identical to the latest one of its limit is not added. True when
 * the history changed.
 */
export function recordReading(history: UsageReport[], report: UsageReport): boolean {
  const keepFrom = report.at - USAGE_HISTORY_MS;
  let drop = 0;
  while (drop < history.length && history[drop]!.at < keepFrom) drop += 1;
  if (drop > 0) history.splice(0, drop);
  const latest = history.findLast((entry) => sameLimit(entry, report));
  if (latest && sameReading(latest, report)) return drop > 0;
  // Reports arrive in time order, but a late one still lands in its place.
  let index = history.length;
  while (index > 0 && history[index - 1]!.at > report.at) index -= 1;
  history.splice(index, 0, { ...report });
  return true;
}

/** The readings in a period, oldest first. */
export function readingsIn(history: readonly UsageReport[], filter: UsageHistoryFilter): UsageReport[] {
  return history.filter((entry) => (filter.from === undefined || entry.at >= filter.from) && (filter.to === undefined || entry.at < filter.to));
}
