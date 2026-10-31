// Time/wait phase intervals and shared check-slot / agent-pool capacity metrics for throughput analytics.

import type { UsageContext } from "./analytics-squad.js";
import {
  clipInterval,
  distributionOf,
  isLiveActiveState,
  mergeIntervals,
  subtractIntervals,
  totalMs,
  type Interval,
} from "./analytics-throughput-intervals.js";
import type {
  ThroughputCapacity,
  ThroughputExtraValidation,
  ThroughputPhase,
  ThroughputTaskRecord,
} from "./analytics-throughput-record.js";
import type { Id, InboxItem } from "./model.js";
import { count } from "./numbers.js";
import type { WorkMoment, WorkTurn } from "./worklog.js";

const BLOCKING_INBOX_KINDS: ReadonlySet<InboxItem["kind"]> = new Set([
  "question",
  "permission",
  "plan",
  "design",
  "delivery",
  "disagreement",
  "stuck",
  "screen",
]);

function pushMap(map: Map<Id, Interval[]>, taskId: Id, interval: Interval | undefined): void {
  if (!interval) return;
  const list = map.get(taskId);
  if (list) list.push(interval);
  else map.set(taskId, [interval]);
}

function summarizeTaskMap(map: ReadonlyMap<Id, readonly Interval[]>): {
  wallMs: number;
  summedMs: number;
  taskCount: number;
} {
  const allMergedPerTask: Interval[] = [];
  let summedMs = 0;
  let taskCount = 0;
  for (const [, list] of map) {
    const merged = mergeIntervals(list);
    const ms = totalMs(merged);
    if (ms > 0) {
      taskCount += 1;
      summedMs += ms;
      allMergedPerTask.push(...merged);
    }
  }
  return { wallMs: totalMs(mergeIntervals(allMergedPerTask)), summedMs, taskCount };
}

export function computePhasesAndCapacity(input: {
  scopedTasks: readonly ThroughputTaskRecord[];
  byId: ReadonlyMap<Id, ThroughputTaskRecord>;
  windowTurns: readonly WorkTurn[];
  windowMoments: readonly WorkMoment[];
  ctx: UsageContext;
  productId?: Id;
  winStart: number;
  winEnd: number;
  windowElapsedMs: number;
  beforeTracking: boolean;
}): {
  phases: ThroughputPhase[];
  capacity: ThroughputCapacity;
  lostTurnsInWindow: number;
  inboxByTask: Map<Id, InboxItem[]>;
} {
  const { scopedTasks, byId, windowTurns, windowMoments, ctx, productId, winStart, winEnd, windowElapsedMs, beforeTracking } =
    input;
  const permissionRawByTask = new Map<Id, Interval[]>();
  const decisionRawByTask = new Map<Id, Interval[]>();
  const checkExecIntervals: Interval[] = [];
  const checkExecTasks = new Set<Id>();
  const checkWaitByTask = new Map<Id, Interval[]>();
  const prereqByTask = new Map<Id, Interval[]>();
  const availByTask = new Map<Id, Interval[]>();
  const completedBatchDurations: number[] = [];

  const inboxByTask = new Map<Id, InboxItem[]>();
  for (const item of ctx.state.inbox) {
    const list = inboxByTask.get(item.taskId);
    if (list) list.push(item);
    else inboxByTask.set(item.taskId, [item]);
  }

  for (const moment of windowMoments) {
    if (moment.kind !== "ask") continue;
    const task = byId.get(moment.taskId);
    const active = task ? isLiveActiveState(task) && task.state !== "pr-open" : false;
    const stillOpen = active && (inboxByTask.get(moment.taskId) ?? []).some((item) => item.at === moment.at);
    const rawEnd = moment.durationMs !== undefined ? moment.at + moment.durationMs : stillOpen ? winEnd : moment.at;
    if (rawEnd <= moment.at) continue;
    if (moment.ask === "permission") pushMap(permissionRawByTask, moment.taskId, [moment.at, rawEnd]);
    pushMap(decisionRawByTask, moment.taskId, clipInterval(moment.at, rawEnd, winStart, winEnd));
  }

  const extraSeen = new Set<Id>();
  const allExtras: ThroughputExtraValidation[] = [];
  for (const ev of ctx.state.extraValidations ?? []) {
    if (productId && ev.productId !== productId) continue;
    extraSeen.add(ev.id);
    allExtras.push({
      id: ev.id,
      taskId: ev.taskId,
      productId: ev.productId,
      state: ev.state,
      ...(ev.result ? { result: ev.result } : {}),
      queuedAt: ev.queuedAt,
      ...(ev.startedAt !== undefined ? { startedAt: ev.startedAt } : {}),
      ...(ev.endedAt !== undefined ? { endedAt: ev.endedAt } : {}),
    });
  }

  for (const task of scopedTasks) {
    const active = isLiveActiveState(task);
    const runningOrWaiting = active && task.state !== "pr-open";
    for (const item of inboxByTask.get(task.id) ?? []) {
      if (!item.blocking && !BLOCKING_INBOX_KINDS.has(item.kind)) continue;
      if (item.kind === "permission") pushMap(permissionRawByTask, task.id, [item.at, winEnd]);
      pushMap(decisionRawByTask, task.id, clipInterval(item.at, winEnd, winStart, winEnd));
    }

    for (const wait of task.runtimeWaitIntervals ?? []) {
      pushMap(
        prereqByTask,
        task.id,
        clipInterval(wait.startedAt, wait.endedAt ?? (active ? winEnd : wait.startedAt), winStart, winEnd),
      );
    }
    if (active && task.state === "waiting") {
      for (const rw of task.readinessWaits ?? []) {
        pushMap(availByTask, task.id, clipInterval(rw.at, winEnd, winStart, winEnd));
      }
    }
    if (active && task.checkActivity && ["waiting", "held", "paused"].includes(task.checkActivity.phase)) {
      if (!productId || !task.checkActivity.productId || task.checkActivity.productId === productId) {
        pushMap(checkWaitByTask, task.id, clipInterval(task.checkActivity.since, winEnd, winStart, winEnd));
      }
    }

    for (const step of task.journey) {
      if (step.kind === "you") {
        pushMap(
          decisionRawByTask,
          task.id,
          clipInterval(step.startedAt, step.endedAt ?? (runningOrWaiting ? winEnd : step.startedAt), winStart, winEnd),
        );
      } else if (step.kind === "wait") {
        pushMap(
          prereqByTask,
          task.id,
          clipInterval(step.startedAt, step.endedAt ?? (active ? winEnd : step.startedAt), winStart, winEnd),
        );
      }
      for (const ask of step.asks ?? []) {
        const askEnd = ask.endedAt ?? (runningOrWaiting ? winEnd : ask.at);
        if (ask.kind === "permission" && askEnd > ask.at) pushMap(permissionRawByTask, task.id, [ask.at, askEnd]);
        pushMap(decisionRawByTask, task.id, clipInterval(ask.at, askEnd, winStart, winEnd));
      }
      for (const recheck of step.readinessRechecks ?? []) {
        if (recheck.endedAt !== undefined && recheck.endedAt > recheck.at) {
          pushMap(availByTask, task.id, clipInterval(recheck.at, recheck.endedAt, winStart, winEnd));
        }
      }
      for (const batch of step.checkBatches ?? []) {
        if (productId && batch.productId && batch.productId !== productId) continue;
        if (batch.queuedAt !== undefined) {
          const waitEnd = batch.startedAt ?? batch.endedAt ?? (active ? winEnd : batch.queuedAt);
          pushMap(checkWaitByTask, task.id, clipInterval(batch.queuedAt, waitEnd, winStart, winEnd));
        }
        if (batch.startedAt !== undefined) {
          const execEnd = batch.endedAt ?? (batch.outcome === "running" && active ? winEnd : undefined);
          if (execEnd !== undefined) {
            const clipped = clipInterval(batch.startedAt, execEnd, winStart, winEnd);
            if (clipped) {
              checkExecIntervals.push(clipped);
              checkExecTasks.add(task.id);
            }
          }
          if (
            batch.endedAt !== undefined &&
            batch.outcome !== "running" &&
            batch.endedAt >= winStart &&
            batch.endedAt <= winEnd &&
            batch.endedAt >= batch.startedAt
          ) {
            completedBatchDurations.push(batch.endedAt - batch.startedAt);
          }
        }
      }
      for (const setup of step.setupAttempts ?? []) {
        if (productId && setup.productId !== productId) continue;
        const waitEnd = setup.startedAt ?? setup.endedAt ?? (active ? winEnd : setup.queuedAt);
        pushMap(checkWaitByTask, task.id, clipInterval(setup.queuedAt, waitEnd, winStart, winEnd));
        if (setup.startedAt !== undefined) {
          const execEnd = setup.endedAt ?? (active ? winEnd : undefined);
          const clipped = execEnd !== undefined ? clipInterval(setup.startedAt, execEnd, winStart, winEnd) : undefined;
          if (clipped) {
            checkExecIntervals.push(clipped);
            checkExecTasks.add(task.id);
          }
        }
      }
      for (const ev of step.extraValidations ?? []) {
        if (productId && ev.productId !== productId) continue;
        if (extraSeen.has(ev.id)) continue;
        extraSeen.add(ev.id);
        allExtras.push(ev);
      }
    }
  }

  for (const ev of allExtras) {
    const active =
      ev.state === "queued" ||
      ev.state === "preparing" ||
      ev.state === "running" ||
      ev.state === "stopping" ||
      ev.state === "held";
    const waitEnd = ev.startedAt ?? ev.endedAt ?? (active ? winEnd : ev.queuedAt);
    pushMap(checkWaitByTask, ev.taskId, clipInterval(ev.queuedAt, waitEnd, winStart, winEnd));
    if (ev.startedAt !== undefined) {
      const execEnd = ev.endedAt ?? (ev.state === "running" || ev.state === "stopping" ? winEnd : undefined);
      const clipped = execEnd !== undefined ? clipInterval(ev.startedAt, execEnd, winStart, winEnd) : undefined;
      if (clipped) {
        checkExecIntervals.push(clipped);
        checkExecTasks.add(ev.taskId);
      }
    }
  }

  // Subtract recorded permission waits per task so parallel agent turns sum cleanly without double-counting waits.
  const agentIntervals: Interval[] = [];
  let summedAgentMs = 0;
  const agentTasks = new Set<Id>();
  let lostTurnsInWindow = 0;
  for (const turn of windowTurns) {
    if (turn.end === "lost") {
      lostTurnsInWindow += 1;
      continue;
    }
    const task = byId.get(turn.taskId);
    const active = task ? isLiveActiveState(task) && task.activeAgents > 0 : false;
    const rawEnd = turn.endedAt ?? (turn.end === undefined && active ? winEnd : undefined);
    if (rawEnd === undefined || rawEnd <= turn.startedAt) continue;
    const perms = permissionRawByTask.get(turn.taskId) ?? [];
    const activeSegments = perms.length
      ? subtractIntervals([[turn.startedAt, rawEnd]], perms)
      : ([[turn.startedAt, rawEnd]] as Interval[]);
    const rawActiveMs = totalMs(activeSegments);
    const scale =
      turn.endedAt !== undefined && turn.workMs !== undefined && rawActiveMs > 0 && turn.workMs < rawActiveMs
        ? turn.workMs / rawActiveMs
        : 1;
    let turnClippedMs = 0;
    for (const [segStart, segEnd] of activeSegments) {
      const clipped = clipInterval(segStart, segEnd, winStart, winEnd);
      if (clipped) {
        agentIntervals.push(clipped);
        turnClippedMs += clipped[1] - clipped[0];
      }
    }
    if (turnClippedMs > 0) {
      summedAgentMs += Math.round(turnClippedMs * scale);
      agentTasks.add(turn.taskId);
    }
  }

  const agentWallMs = totalMs(mergeIntervals(agentIntervals));
  const checkExecWallMs = totalMs(mergeIntervals(checkExecIntervals));
  const checkExecSummedMs = totalMs(checkExecIntervals);
  const checkWaitSummary = summarizeTaskMap(checkWaitByTask);
  const decisionSummary = summarizeTaskMap(decisionRawByTask);
  const prereqSummary = summarizeTaskMap(prereqByTask);
  const availSummary = summarizeTaskMap(availByTask);

  const limitHits = windowMoments.filter(
    (m) => m.kind === "failure" && m.outcome === "limit" && m.at >= winStart && m.at <= winEnd,
  ).length;
  const retries = windowMoments.filter((m) => m.kind === "retry" && m.at >= winStart && m.at <= winEnd).length;
  const availNoteParts = [
    limitHits ? count(limitHits, "usage-limit stop") : "",
    retries ? count(retries, "retry", "retries") : "",
    "slot-queue waits between turns have no separate start timestamp",
  ].filter(Boolean);

  const phases: ThroughputPhase[] = [
    {
      key: "agent-work",
      label: "Agent work",
      wallMs: agentWallMs,
      summedMs: summedAgentMs,
      taskCount: agentTasks.size,
      available: true,
      ...(beforeTracking || lostTurnsInWindow > 0 ? { partial: true } : {}),
    },
    {
      key: "check-execution",
      label: "Check execution",
      wallMs: checkExecWallMs,
      summedMs: checkExecSummedMs,
      taskCount: checkExecTasks.size,
      available: true,
    },
    {
      key: "waiting-for-checks",
      label: "Waiting for checks",
      wallMs: checkWaitSummary.wallMs,
      summedMs: checkWaitSummary.summedMs,
      taskCount: checkWaitSummary.taskCount,
      available: true,
    },
    {
      key: "coordinator-decisions",
      label: "Your decisions",
      wallMs: decisionSummary.wallMs,
      summedMs: decisionSummary.summedMs,
      taskCount: decisionSummary.taskCount,
      available: true,
    },
    {
      key: "prerequisites",
      label: "Prerequisites",
      wallMs: prereqSummary.wallMs,
      summedMs: prereqSummary.summedMs,
      taskCount: prereqSummary.taskCount,
      available: true,
    },
    {
      key: "availability",
      label: "Tool and limit waits",
      wallMs: availSummary.wallMs,
      summedMs: availSummary.summedMs,
      taskCount: availSummary.taskCount,
      available: availSummary.taskCount > 0 || limitHits > 0 || retries > 0,
      partial: true,
      note: availNoteParts.join(" · "),
    },
  ];

  const configuredCheckSlots = Math.max(1, ctx.checkSlots ?? 1);
  const batchDist = distributionOf(completedBatchDurations);
  const currentPoolLimit = Math.max(1, ctx.state.pool.limit);
  const capacity: ThroughputCapacity = {
    checkSlot: {
      configuredSlots: configuredCheckSlots,
      occupiedWallMs: checkExecWallMs,
      ...(windowElapsedMs > 0
        ? { occupancyShare: Math.min(1, checkExecWallMs / (configuredCheckSlots * windowElapsedMs)) }
        : {}),
      completedBatches: batchDist.count,
      ...(batchDist.medianMs !== undefined ? { medianBatchMs: batchDist.medianMs } : {}),
      ...(batchDist.p90Ms !== undefined ? { p90BatchMs: batchDist.p90Ms } : {}),
    },
    agentPool: {
      currentPoolLimit,
      poolPausedNow: ctx.state.pool.paused,
      activeWallMs: agentWallMs,
      summedAgentMs,
      ...(windowElapsedMs > 0 ? { wallShare: Math.min(1, agentWallMs / windowElapsedMs) } : {}),
      ...(windowElapsedMs > 0
        ? { slotShare: Math.min(1, summedAgentMs / (currentPoolLimit * windowElapsedMs)) }
        : {}),
      ...(agentWallMs > 0
        ? { meanConcurrencyWhenBusy: Math.round((summedAgentMs / agentWallMs) * 10) / 10 }
        : {}),
    },
  };

  return { phases, capacity, lostTurnsInWindow, inboxByTask };
}
