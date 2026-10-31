// Pure interval algebra, percentile summaries and delivery classification for throughput analytics.

import type {
  ThroughputDeliveryRecord,
  ThroughputDistribution,
  ThroughputTaskRecord,
} from "./analytics-throughput-record.js";
import type { Id } from "./model.js";

export type Interval = readonly [number, number];

export function clipInterval(start: number, end: number, winStart: number, winEnd: number): Interval | undefined {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  const s = Math.max(winStart, start);
  const e = Math.min(winEnd, end);
  return e > s ? [s, e] : undefined;
}

export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  if (intervals.length <= 1) return intervals.filter((item) => item[1] > item[0]);
  const sorted = [...intervals].filter((item) => item[1] > item[0]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (!sorted.length) return [];
  const merged: [number, number][] = [[sorted[0]![0], sorted[0]![1]]];
  for (let i = 1; i < sorted.length; i += 1) {
    const [start, end] = sorted[i]!;
    const last = merged[merged.length - 1]!;
    if (start <= last[1]) {
      if (end > last[1]) last[1] = end;
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

export function subtractIntervals(base: readonly Interval[], cut: readonly Interval[]): Interval[] {
  const mergedBase = mergeIntervals(base);
  const mergedCut = mergeIntervals(cut);
  if (!mergedBase.length || !mergedCut.length) return mergedBase;
  const out: Interval[] = [];
  let cutIdx = 0;
  for (const [bStart, bEnd] of mergedBase) {
    let cursor = bStart;
    while (cutIdx < mergedCut.length && mergedCut[cutIdx]![1] <= cursor) cutIdx += 1;
    let scan = cutIdx;
    while (scan < mergedCut.length && mergedCut[scan]![0] < bEnd) {
      const [cStart, cEnd] = mergedCut[scan]!;
      if (cStart > cursor) out.push([cursor, Math.min(bEnd, cStart)]);
      cursor = Math.max(cursor, cEnd);
      if (cursor >= bEnd) break;
      scan += 1;
    }
    if (cursor < bEnd) out.push([cursor, bEnd]);
  }
  return out;
}

export function totalMs(intervals: readonly Interval[]): number {
  let sum = 0;
  for (const [start, end] of intervals) {
    if (end > start) sum += end - start;
  }
  return Math.round(sum);
}

export function distributionOf(values: readonly number[], missingStartCount = 0): ThroughputDistribution {
  const valid = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (!valid.length) {
    return { count: 0, ...(missingStartCount > 0 ? { missingStartCount } : {}) };
  }
  const mid = Math.floor(valid.length / 2);
  const medianMs = valid.length % 2 ? valid[mid]! : Math.round((valid[mid - 1]! + valid[mid]!) / 2);
  const p90Idx = Math.min(valid.length - 1, Math.max(0, Math.ceil(valid.length * 0.9) - 1));
  const p90Ms = valid[p90Idx]!;
  return {
    count: valid.length,
    medianMs,
    p90Ms,
    ...(missingStartCount > 0 ? { missingStartCount } : {}),
  };
}

export type ClassifiedOutcome =
  | "landed"
  | "awaiting-merge"
  | "no-changes"
  | "marked-done"
  | "closed"
  | "cancelled"
  | "combined"
  | "unfinished-push"
  | "open";

function singleDeliveryOutcome(task: ThroughputTaskRecord, work: ThroughputDeliveryRecord): ClassifiedOutcome {
  if (task.state === "cancelled") return task.combinedInto ? "combined" : "cancelled";
  if (task.noProductChanges || work.nothingToPublish) return task.state === "done" ? "no-changes" : "open";
  if (work.pr?.state !== "open" && (work.localUpdatePushed === false || work.shippingActive)) return "unfinished-push";
  const pr = work.markedDone ? undefined : work.pr;
  if (work.hasRelease || (work.hasLanded && work.localUpdatePushed !== false) || pr?.state === "merged") return "landed";
  if (pr && (pr.state === "closed" || task.state === "done")) return "closed";
  if (pr && (pr.state === "open" || task.state === "pr-open")) return "awaiting-merge";
  return task.state === "done" ? "marked-done" : "open";
}

function repositoryDeliveredRecord(work: ThroughputDeliveryRecord): boolean {
  return Boolean(work.nothingToPublish || work.pr || work.hasRelease || (work.hasLanded && work.localUpdatePushed !== false));
}

export function classifyTaskOutcome(task: ThroughputTaskRecord, productId?: Id): ClassifiedOutcome {
  if (task.state === "cancelled") return task.combinedInto ? "combined" : "cancelled";
  if (task.state === "done" && task.noProductChanges) return "no-changes";
  const deliveries = task.deliveries;
  if (!deliveries.length) return task.state === "done" ? "marked-done" : "open";
  const outcomes = deliveries.map((work) => singleDeliveryOutcome(task, work));
  if (outcomes.includes("unfinished-push")) return "unfinished-push";
  for (const kind of ["closed", "marked-done"] as const) {
    if (outcomes.includes(kind)) {
      if (kind === "closed" && deliveries.length > 1) {
        const unacceptedClosed = deliveries.some((work) => !work.markedDone && work.pr?.state === "closed" && !work.landingAccepted);
        if (!unacceptedClosed && outcomes.some((entry) => entry === "landed")) continue;
      }
      return kind;
    }
  }
  if (deliveries.length > 1 && deliveries.some((work) => !repositoryDeliveredRecord(work) || work.companionPending)) {
    return "open";
  }
  if (outcomes.includes("awaiting-merge")) return "awaiting-merge";
  if (outcomes.includes("open")) return "open";
  if (productId !== undefined) {
    const scoped = deliveries.find((work) => work.productId === productId);
    if (scoped?.nothingToPublish) return "no-changes";
    return scoped ? singleDeliveryOutcome(task, scoped) : "no-changes";
  }
  return outcomes.every((entry) => entry === "no-changes") ? "no-changes" : "landed";
}

export function isLiveActiveState(task: ThroughputTaskRecord): boolean {
  return task.state !== "done" && task.state !== "cancelled";
}

export function taskInvolvesProduct(task: ThroughputTaskRecord, productId: Id | undefined): boolean {
  if (!productId) return true;
  return task.productId === productId || task.productIds.includes(productId) || task.deliveries.some((d) => d.productId === productId);
}

export function deliveryTimestamp(
  task: ThroughputTaskRecord,
  momentEnds: ReadonlyMap<Id, { deliveredAt?: number; cancelledAt?: number; settledAt?: number }>,
): number | undefined {
  const publishing = task.deliveries.filter((work) => !work.nothingToPublish);
  if (publishing.length > 0 && publishing.every((work) => work.confirmedAt !== undefined)) {
    return Math.max(...publishing.map((work) => work.confirmedAt!));
  }
  if (task.finishedAt !== undefined) return task.finishedAt;
  const lastDeliveryStep = task.journey.findLast((step) => step.kind === "petrina" && step.work === "delivery" && step.endedAt !== undefined && step.end === "done");
  if (lastDeliveryStep?.endedAt !== undefined) return lastDeliveryStep.endedAt;
  return momentEnds.get(task.id)?.deliveredAt;
}

export function terminalTimestamp(
  task: ThroughputTaskRecord,
  momentEnds: ReadonlyMap<Id, { deliveredAt?: number; cancelledAt?: number; settledAt?: number }>,
): number | undefined {
  if (task.finishedAt !== undefined) return task.finishedAt;
  const moments = momentEnds.get(task.id);
  if (task.state === "cancelled") return moments?.cancelledAt ?? moments?.settledAt;
  return moments?.settledAt ?? moments?.deliveredAt;
}
