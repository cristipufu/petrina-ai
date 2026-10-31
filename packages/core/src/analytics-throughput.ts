// End-to-end throughput, time/wait phases, shared capacity, repeat work and live bottlenecks.
// Evaluates strictly at `ctx.now` so paged coordinator reads remain deterministic across clock ticks.

import type { Names, UsageContext, UsagePeriod } from "./analytics-squad.js";
import {
  classifyTaskOutcome,
  deliveryTimestamp,
  distributionOf,
  isLiveActiveState,
  taskInvolvesProduct,
  terminalTimestamp,
} from "./analytics-throughput-intervals.js";
import { computePhasesAndCapacity } from "./analytics-throughput-phases.js";
import {
  throughputTaskRecord,
  type AnalyticsThroughput,
  type ThroughputTaskRecord,
} from "./analytics-throughput-record.js";
import { computeHoldingUpNow, computeRepeatedWork } from "./analytics-throughput-repeats.js";
import type { Id } from "./model.js";
import { count } from "./numbers.js";
import type { WorkLogReader, WorkMoment, WorkTurn } from "./worklog.js";

const DAY_MS = 86_400_000;
const MIN_RATE_WINDOW_MS = 3_600_000;

function collectTasks(
  log: WorkLogReader,
  ctx: UsageContext,
  from: number,
  to: number,
  productId: Id | undefined,
): {
  allTasks: ThroughputTaskRecord[];
  scopedTasks: ThroughputTaskRecord[];
  liveCount: number;
  archivedCount: number;
  windowTurns: WorkTurn[];
  windowMoments: WorkMoment[];
} {
  const filter = { from, to, ...(productId ? { productId } : {}) };
  const rawTurns = log.turns(filter);
  const seenTurnIds = new Set(rawTurns.map((turn) => turn.id));
  const openCrossBoundary: WorkTurn[] = [];
  for (const liveTask of ctx.state.tasks) {
    if (!liveTask.agent && !liveTask.helpers?.length) continue;
    for (const turn of log.turns({ taskId: liveTask.id })) {
      if (turn.end === undefined && !seenTurnIds.has(turn.id) && (!productId || turn.productId === productId)) {
        seenTurnIds.add(turn.id);
        openCrossBoundary.push(turn);
      }
    }
  }
  const windowTurns = [...openCrossBoundary, ...rawTurns];
  const windowMoments = log.moments(filter);

  const liveRecords = ctx.state.tasks.map(throughputTaskRecord);
  const liveIds = new Set(liveRecords.map((task) => task.id));
  const extraIds = new Set<Id>();
  for (const turn of windowTurns) if (!liveIds.has(turn.taskId)) extraIds.add(turn.taskId);
  for (const moment of windowMoments) if (!liveIds.has(moment.taskId)) extraIds.add(moment.taskId);

  const archivedRecords = ctx.archivedThroughputTasks
    ? ctx
        .archivedThroughputTasks({ from, ...(productId ? { productId } : {}), taskIds: [...extraIds] })
        .filter((task) => !liveIds.has(task.id))
    : [];

  const allTasks = [...liveRecords, ...archivedRecords];
  const scopedTasks = allTasks.filter((task) => taskInvolvesProduct(task, productId));
  const liveCount = scopedTasks.filter(isLiveActiveState).length;
  const archivedCount = scopedTasks.length - liveCount;
  return { allTasks, scopedTasks, liveCount, archivedCount, windowTurns, windowMoments };
}

function collectMomentEnds(
  moments: readonly WorkMoment[],
): Map<Id, { deliveredAt?: number; cancelledAt?: number; settledAt?: number }> {
  const map = new Map<Id, { deliveredAt?: number; cancelledAt?: number; settledAt?: number }>();
  for (const moment of moments) {
    if (moment.kind !== "task-end") continue;
    const entry = map.get(moment.taskId) ?? {};
    if (moment.outcome === "delivered" || moment.outcome === "merged") {
      entry.deliveredAt = Math.max(entry.deliveredAt ?? -Infinity, moment.at);
      entry.settledAt = Math.max(entry.settledAt ?? -Infinity, moment.at);
    } else if (moment.outcome === "cancelled") {
      entry.cancelledAt = Math.max(entry.cancelledAt ?? -Infinity, moment.at);
      entry.settledAt = Math.max(entry.settledAt ?? -Infinity, moment.at);
    } else {
      entry.settledAt = Math.max(entry.settledAt ?? -Infinity, moment.at);
    }
    map.set(moment.taskId, entry);
  }
  return map;
}

export function throughputView(
  log: WorkLogReader,
  request: { period: UsagePeriod; productId?: Id },
  range: { from: number; to: number },
  ctx: UsageContext,
  lookup: Names,
  beforeTracking: boolean,
): AnalyticsThroughput {
  const winStart = range.from;
  const winEnd = Math.max(range.from, Math.min(ctx.now, range.to));
  const windowElapsedMs = Math.max(0, winEnd - winStart);
  const { allTasks, scopedTasks, liveCount, archivedCount, windowTurns, windowMoments } = collectTasks(
    log,
    ctx,
    range.from,
    range.to,
    request.productId,
  );
  const byId = new Map(allTasks.map((task) => [task.id, task]));
  const momentEnds = collectMomentEnds(windowMoments);

  let landed = 0;
  let sharedLanded = 0;
  let awaitingMerge = 0;
  let prsOpenedInWindow = 0;
  let noChanges = 0;
  let markedDone = 0;
  let closedWithoutMerge = 0;
  let cancelled = 0;
  let combined = 0;
  let inProgress = 0;
  let queued = 0;
  let unfinishedPushes = 0;
  const createdToStartVals: number[] = [];
  const startToDeliveryVals: number[] = [];
  const createdToDeliveryVals: number[] = [];
  let missingStartCount = 0;

  for (const task of scopedTasks) {
    if (task.createdAt > ctx.now) continue;
    const scopedDeliveries = request.productId
      ? task.deliveries.filter((work) => work.productId === request.productId)
      : task.deliveries;
    if (scopedDeliveries.some((work) => work.pr && work.pr.openedAt >= winStart && work.pr.openedAt <= winEnd)) {
      prsOpenedInWindow += 1;
    }
    const outcome = classifyTaskOutcome(task, request.productId);
    if (outcome === "awaiting-merge") {
      awaitingMerge += 1;
      continue;
    }
    if (outcome === "unfinished-push") {
      inProgress += 1;
      unfinishedPushes += 1;
      continue;
    }
    if (outcome === "open") {
      if (task.state !== "backlog") {
        inProgress += 1;
        if (task.state === "queued" || task.startedAt === undefined) queued += 1;
      }
      continue;
    }
    if (outcome === "landed") {
      const deliveredAt = deliveryTimestamp(task, momentEnds);
      if (deliveredAt !== undefined && deliveredAt >= winStart && deliveredAt <= winEnd) {
        landed += 1;
        const publishingCount = task.deliveries.filter((work) => !work.nothingToPublish).length;
        if (task.sharedScope && publishingCount > 1) sharedLanded += 1;
        if (deliveredAt >= task.createdAt) createdToDeliveryVals.push(deliveredAt - task.createdAt);
        if (task.startedAt !== undefined && Number.isFinite(task.startedAt)) {
          if (task.startedAt >= task.createdAt) createdToStartVals.push(task.startedAt - task.createdAt);
          if (deliveredAt >= task.startedAt) startToDeliveryVals.push(deliveredAt - task.startedAt);
        } else {
          missingStartCount += 1;
        }
      }
      continue;
    }
    const endedAt = terminalTimestamp(task, momentEnds);
    if (endedAt === undefined || endedAt < winStart || endedAt > winEnd) continue;
    if (outcome === "no-changes") noChanges += 1;
    else if (outcome === "marked-done") markedDone += 1;
    else if (outcome === "closed") closedWithoutMerge += 1;
    else if (outcome === "combined") combined += 1;
    else if (outcome === "cancelled") cancelled += 1;
  }

  const landedPerDay =
    windowElapsedMs >= MIN_RATE_WINDOW_MS ? Math.round((landed / (windowElapsedMs / DAY_MS)) * 10) / 10 : undefined;

  const { phases, capacity, lostTurnsInWindow, inboxByTask } = computePhasesAndCapacity({
    scopedTasks,
    byId,
    windowTurns,
    windowMoments,
    ctx,
    ...(request.productId ? { productId: request.productId } : {}),
    winStart,
    winEnd,
    windowElapsedMs,
    beforeTracking,
  });

  const repeatedWork = computeRepeatedWork({
    scopedTasks,
    windowMoments,
    lookup,
    ...(request.productId ? { productId: request.productId } : {}),
    winStart,
    winEnd,
  });

  const holdingUpNow = computeHoldingUpNow({
    allTasks,
    scopedTasks,
    byId,
    inboxByTask,
    ctx,
    lookup,
    ...(request.productId ? { productId: request.productId } : {}),
  });

  const untrackedSet = log.untracked();
  const untrackedTasks = scopedTasks.filter((task) => untrackedSet.has(task.id)).length;
  const logOnlyFinishedIds = new Set(
    windowMoments
      .filter((m) => m.kind === "task-end" && m.at >= winStart && m.at <= winEnd && !byId.has(m.taskId))
      .map((m) => m.taskId),
  );
  const coverageNotes: string[] = [];
  if (beforeTracking) coverageNotes.push("This period starts before Petrina began recording the work log.");
  if (untrackedTasks > 0) coverageNotes.push(`${count(untrackedTasks, "task")} started before work-log tracking began.`);
  if (lostTurnsInWindow > 0) {
    coverageNotes.push(`${count(lostTurnsInWindow, "agent turn")} ended without a duration when Petrina stopped.`);
  }
  if (missingStartCount > 0) {
    coverageNotes.push(`${count(missingStartCount, "landed task")} had no recorded start time and stay out of start-split medians.`);
  }
  if (logOnlyFinishedIds.size > 0) {
    coverageNotes.push(
      `${count(logOnlyFinishedIds.size, "finished task")} without surviving task history (such as removed products) appear in work-log totals only.`,
    );
  }

  return {
    coverage: {
      asOf: ctx.now,
      from: winStart,
      to: winEnd,
      windowElapsedMs,
      trackingSince: log.since(),
      beforeTracking,
      liveTasks: liveCount,
      archivedTasks: archivedCount,
      untrackedTasks,
      lostTurnsInWindow,
      notes: coverageNotes,
    },
    delivery: {
      landed,
      sharedLanded,
      ...(landedPerDay !== undefined ? { landedPerDay } : {}),
      awaitingMerge,
      prsOpenedInWindow,
      noChanges,
      unconfirmedOrClosed: markedDone + closedWithoutMerge,
      markedDone,
      closedWithoutMerge,
      cancelled,
      combined,
      inProgress,
      queued,
      unfinishedPushes,
      windowElapsedMs,
      createdToStart: distributionOf(createdToStartVals, missingStartCount),
      startToDelivery: distributionOf(startToDeliveryVals, missingStartCount),
      createdToDelivery: distributionOf(createdToDeliveryVals),
    },
    phases,
    capacity,
    repeatedWork,
    holdingUpNow,
  };
}
