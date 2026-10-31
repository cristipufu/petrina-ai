// Repeated check/repair/review attribution and live bottleneck diagnostics for throughput analytics.

import type { Names, UsageContext } from "./analytics-squad.js";
import { classifyTaskOutcome, isLiveActiveState } from "./analytics-throughput-intervals.js";
import type {
  BuilderReturnCauseKey,
  ThroughputBlocker,
  ThroughputCyclingTask,
  ThroughputPressure,
  ThroughputRepeatedWork,
  ThroughputTaskRecord,
} from "./analytics-throughput-record.js";
import { checkActivityLine, inCheckLine } from "./check-activity.js";
import { quoteTitles } from "./journey-words.js";
import type { Id, InboxItem } from "./model.js";
import { count, durationText } from "./numbers.js";
import type { WorkMoment } from "./worklog.js";

const FRESH_REASON_LABELS: Readonly<Record<string, string>> = {
  code: "Code changed",
  requested: "You asked to rerun checks",
  start: "Starting branch moved",
  definitions: "Check commands or setup changed",
  hooks: "Commit hooks needed to run",
  edits: "Working-copy edits present",
  incomplete: "Earlier run did not finish",
  "first-run": "First check run on task",
  unrecorded: "Reason not recorded",
};

const BUILDER_CAUSE_ORDER: readonly { key: BuilderReturnCauseKey; label: string }[] = [
  { key: "review", label: "Review findings" },
  { key: "checks", label: "Automated checks" },
  { key: "acceptance", label: "Acceptance testing" },
  { key: "main-update", label: "Branch updates and ports" },
  { key: "coordinator", label: "Your change requests" },
  { key: "unrecorded", label: "Cause not recorded" },
];

const INBOX_WAIT_WORDS: Readonly<Record<InboxItem["kind"], string>> = {
  plan: "Plan check",
  design: "Design check",
  delivery: "Delivery check",
  disagreement: "Design call",
  question: "Agent question",
  permission: "Permission request",
  screen: "Screen request",
  stuck: "Stuck task decision",
  guide: "Review guide suggestion",
  learnings: "Learnings suggestion",
  driving: "Driving task",
  "maintenance-settings": "Routine settings",
  shipping: "Shipping decision",
};

function builderReturnCause(task: ThroughputTaskRecord, index: number, lookup: Names): BuilderReturnCauseKey {
  const step = task.journey[index]!;
  const causeStep = step.triggerAfter
    ? task.journey.find((entry) => entry.id === step.triggerAfter)
    : task.journey.slice(0, index).findLast((entry) => entry.kind !== "wait");
  if (step.update || (causeStep?.kind === "petrina" && causeStep.work === "update")) return "main-update";
  if (
    step.hasCheckRepairs ||
    (causeStep?.kind === "petrina" && (causeStep.work === "checks" || causeStep.work === "check-reuse"))
  ) {
    return "checks";
  }
  if (
    causeStep?.kind === "agent" &&
    (causeStep.hasFailedAcceptance || (causeStep.roleId && lookup.roleResult(causeStep.roleId) === "checks"))
  ) {
    return "acceptance";
  }
  if (
    causeStep?.kind === "you" &&
    causeStep.work !== "review-decision" &&
    (causeStep.outcome === "Changes asked" || causeStep.reason === "changes asked" || step.triggerReason === "changes asked")
  ) {
    return "coordinator";
  }
  if (
    step.hasFindings ||
    (causeStep?.kind === "you" && causeStep.work === "review-decision") ||
    (causeStep?.kind === "agent" &&
      causeStep.roleId &&
      ["findings", "votes", "guide"].includes(lookup.roleResult(causeStep.roleId) ?? ""))
  ) {
    return "review";
  }
  if (step.triggerReason === "changes asked" || step.triggerReason === "your changes") return "coordinator";
  return "unrecorded";
}

function blockerBlocksDependents(task: ThroughputTaskRecord): boolean {
  if (
    task.deliveries.some(
      (d) =>
        d.pr?.state === "open" ||
        (d.pr?.state === "closed" && !d.landingAccepted) ||
        d.shippingActive ||
        d.localUpdatePushed === false,
    )
  ) {
    return true;
  }
  return task.state !== "done" && task.state !== "cancelled";
}

export function computeRepeatedWork(input: {
  scopedTasks: readonly ThroughputTaskRecord[];
  windowMoments: readonly WorkMoment[];
  lookup: Names;
  productId?: Id;
  winStart: number;
  winEnd: number;
}): ThroughputRepeatedWork {
  const { scopedTasks, windowMoments, lookup, productId, winStart, winEnd } = input;
  let executedBatches = 0;
  let failedBatches = 0;
  let interruptedOrUnverifiedBatches = 0;
  let reusedPassedBatches = 0;
  let reusedFailedBatches = 0;
  const freshReasonCounts = new Map<string, number>();

  let builderReturnTotal = 0;
  let unchangedSourceReturns = 0;
  const builderCauseCounts = new Map<BuilderReturnCauseKey, number>();

  let reopenedFindings = 0;
  let mainUpdates = 0;
  let portReviews = 0;
  const cyclingCandidates: ThroughputCyclingTask[] = [];

  for (const task of scopedTasks) {
    let taskCheckBatches = 0;
    let taskFailedBatches = 0;
    let taskReusedFailed = 0;
    let taskBuilderReturns = 0;
    const seenProductsWithCheck = new Set<string>();
    const recordedReuseTimestamps = new Set<string>();
    const completedBuildStages = new Set<string>();

    for (const step of task.journey) {
      for (const reuse of step.reuses ?? []) {
        if (productId && reuse.productId && reuse.productId !== productId) continue;
        recordedReuseTimestamps.add(`${reuse.productId ?? ""}:${reuse.at}`);
        if (reuse.at >= winStart && reuse.at <= winEnd) {
          if (reuse.passed) reusedPassedBatches += 1;
          else {
            reusedFailedBatches += 1;
            taskReusedFailed += 1;
          }
        }
      }
    }

    for (let idx = 0; idx < task.journey.length; idx += 1) {
      const step = task.journey[idx]!;
      const stepInWindow =
        (step.startedAt >= winStart && step.startedAt <= winEnd) ||
        (step.endedAt !== undefined && step.endedAt >= winStart && step.endedAt <= winEnd);

      if (step.reopenedFindings && stepInWindow) reopenedFindings += step.reopenedFindings;
      if (step.kind === "petrina" && step.work === "update" && stepInWindow) mainUpdates += 1;
      if (step.kind === "agent" && step.port && stepInWindow) portReviews += 1;

      if (
        step.kind === "petrina" &&
        step.work === "check-reuse" &&
        step.startedAt >= winStart &&
        step.startedAt <= winEnd
      ) {
        const key = `${task.productId}:${step.startedAt}`;
        if (
          !recordedReuseTimestamps.has(key) &&
          ![...recordedReuseTimestamps].some((entry) => entry.endsWith(`:${step.startedAt}`))
        ) {
          const failed = Boolean(step.outcome && /failed|unverified|incomplete/i.test(step.outcome));
          if (failed) {
            reusedFailedBatches += 1;
            taskReusedFailed += 1;
          } else {
            reusedPassedBatches += 1;
          }
        }
      }

      for (const batch of step.checkBatches ?? []) {
        if (productId && batch.productId && batch.productId !== productId) continue;
        const prodKey = batch.productId ?? task.productId;
        const hadEarlier = seenProductsWithCheck.has(prodKey);
        seenProductsWithCheck.add(prodKey);
        const batchAt = batch.startedAt ?? step.startedAt;
        const batchEnd = batch.endedAt ?? step.endedAt;
        const inWindow =
          (batchAt >= winStart && batchAt <= winEnd) ||
          (batchEnd !== undefined && batchEnd >= winStart && batchEnd <= winEnd);
        if (!inWindow) continue;

        executedBatches += 1;
        taskCheckBatches += 1;
        if (batch.outcome === "failed") {
          failedBatches += 1;
          taskFailedBatches += 1;
        } else if (batch.outcome === "interrupted") {
          interruptedOrUnverifiedBatches += 1;
        }

        const matchedReason =
          step.checkReasons?.find(
            (entry) =>
              (entry.attemptId ? entry.attemptId === batch.attemptId : true) &&
              (entry.productId && batch.productId ? entry.productId === batch.productId : true),
          ) ?? (step.checkReasons?.length === 1 ? step.checkReasons[0] : undefined);
        if (matchedReason?.changed.length) {
          for (const reasonKey of matchedReason.changed) {
            freshReasonCounts.set(reasonKey, (freshReasonCounts.get(reasonKey) ?? 0) + 1);
          }
        } else {
          const fallbackKey = hadEarlier ? "unrecorded" : "first-run";
          freshReasonCounts.set(fallbackKey, (freshReasonCounts.get(fallbackKey) ?? 0) + 1);
        }
      }

      for (const setup of step.setupAttempts ?? []) {
        if (productId && setup.productId !== productId) continue;
        const setupAt = setup.startedAt ?? setup.queuedAt;
        if (setupAt >= winStart && setupAt <= winEnd && (setup.failed || setup.interrupted) && !step.checkBatches?.length) {
          executedBatches += 1;
          taskCheckBatches += 1;
          if (setup.failed) {
            failedBatches += 1;
            taskFailedBatches += 1;
          } else {
            interruptedOrUnverifiedBatches += 1;
          }
        }
      }

      if (step.kind === "agent" && step.roleId && lookup.roleResult(step.roleId) === "build") {
        const stageKey = step.stageId ?? "__task__";
        const isReturn =
          Boolean(step.fixing) ||
          Boolean(step.update) ||
          Boolean(step.hasCheckRepairs) ||
          Boolean(step.hasFindings) ||
          completedBuildStages.has(stageKey) ||
          (completedBuildStages.size > 0 && step.round > 1);
        if ((step.end ?? "done") === "done" && step.endedAt !== undefined) {
          completedBuildStages.add(stageKey);
        }
        if (isReturn && step.startedAt >= winStart && step.startedAt <= winEnd) {
          if (!productId || !step.builderProductId || step.builderProductId === productId) {
            builderReturnTotal += 1;
            taskBuilderReturns += 1;
            if (step.builderChanged === false) unchangedSourceReturns += 1;
            const cause = builderReturnCause(task, idx, lookup);
            builderCauseCounts.set(cause, (builderCauseCounts.get(cause) ?? 0) + 1);
          }
        }
      }
    }

    if (taskCheckBatches >= 2 || taskBuilderReturns >= 2 || (taskFailedBatches >= 1 && taskReusedFailed >= 1)) {
      const product = lookup.product(productId ?? task.productId);
      const parts = [
        taskCheckBatches ? count(taskCheckBatches, "check run") : "",
        taskFailedBatches ? `${taskFailedBatches} failed` : "",
        taskReusedFailed ? count(taskReusedFailed, "reused failure") : "",
        taskBuilderReturns ? count(taskBuilderReturns, "Builder return") : "",
      ].filter(Boolean);
      cyclingCandidates.push({
        taskId: task.id,
        title: task.title,
        productId: productId ?? task.productId,
        productLabel: product.label,
        removedProduct: product.removed,
        state: task.state,
        checkBatches: taskCheckBatches,
        failedCheckBatches: taskFailedBatches,
        reusedFailedBatches: taskReusedFailed,
        builderReturns: taskBuilderReturns,
        summary: parts.join(" · "),
      });
    }
  }

  const reviewEndsInWindow = windowMoments.filter((m) => m.kind === "review-end" && m.at >= winStart && m.at <= winEnd);
  let reviewRounds = reviewEndsInWindow.length;
  let reviewSendBacks = reviewEndsInWindow.filter((m) => m.outcome === "sent-back").length;
  if (reviewRounds === 0) {
    for (const task of scopedTasks) {
      const reviewStageIds = new Set(task.planStages?.filter((s) => s.kind === "review-chain").map((s) => s.id) ?? []);
      for (const step of task.journey) {
        const isReview =
          step.kind === "agent" &&
          ((step.stageId && reviewStageIds.has(step.stageId)) ||
            (step.roleId && lookup.roleResult(step.roleId) === "findings"));
        if (isReview && step.endedAt !== undefined && step.endedAt >= winStart && step.endedAt <= winEnd) {
          reviewRounds += 1;
          if (step.tone === "back" || (step.reason && step.reason.startsWith("sent back"))) reviewSendBacks += 1;
        }
      }
    }
  }

  cyclingCandidates.sort(
    (a, b) =>
      b.builderReturns + b.failedCheckBatches + b.checkBatches - (a.builderReturns + a.failedCheckBatches + a.checkBatches) ||
      b.failedCheckBatches - a.failedCheckBatches ||
      a.title.localeCompare(b.title),
  );

  const freshReasons = [...freshReasonCounts.entries()]
    .map(([key, value]) => ({ key, label: FRESH_REASON_LABELS[key] ?? key, count: value }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  const byCause = BUILDER_CAUSE_ORDER.map(({ key, label }) => ({
    key,
    label,
    count: builderCauseCounts.get(key) ?? 0,
  })).filter((entry) => entry.count > 0);

  return {
    checks: {
      executedBatches,
      failedBatches,
      interruptedOrUnverifiedBatches,
      reusedPassedBatches,
      reusedFailedBatches,
      freshReasons,
    },
    builderReturns: {
      total: builderReturnTotal,
      unchangedSourceReturns,
      byCause,
    },
    reviewsAndUpdates: {
      reviewRounds,
      reviewSendBacks,
      reopenedFindings,
      mainUpdates,
      portReviews,
    },
    cyclingTasks: cyclingCandidates.slice(0, 5),
  };
}

export function computeHoldingUpNow(input: {
  allTasks: readonly ThroughputTaskRecord[];
  scopedTasks: readonly ThroughputTaskRecord[];
  byId: ReadonlyMap<Id, ThroughputTaskRecord>;
  inboxByTask: ReadonlyMap<Id, readonly InboxItem[]>;
  ctx: UsageContext;
  lookup: Names;
  productId?: Id;
}): { pressures: ThroughputPressure[]; tasks: ThroughputBlocker[] } {
  const { allTasks, scopedTasks, byId, inboxByTask, ctx, lookup, productId } = input;
  const pressures: ThroughputPressure[] = [];
  const blockerCandidates: { priority: number; sortAge: number; item: ThroughputBlocker }[] = [];
  const configuredCheckSlots = Math.max(1, ctx.checkSlots ?? 1);
  const currentPoolLimit = Math.max(1, ctx.state.pool.limit);

  const occupiedSlotsNow =
    ctx.state.tasks.reduce(
      (sum, task) => sum + (task.holdsSlot ? Math.max(1, (task.agent ? 1 : 0) + (task.helpers?.length ?? 0)) : 0),
      0,
    ) + (ctx.state.backgroundAgents?.length ?? 0);
  const activeLimits = (ctx.state.pool.limited ?? []).filter((entry) => entry.until > ctx.now);

  const dependentsOfPr = new Map<Id, number>();
  for (const task of allTasks) {
    if (!isLiveActiveState(task)) continue;
    for (const depId of [...(task.after ?? []), ...(task.activeRuntimeWait?.after ?? [])]) {
      dependentsOfPr.set(depId, (dependentsOfPr.get(depId) ?? 0) + 1);
    }
  }

  let checkWaitingNow = 0;
  let checkHeldOwner: string | undefined;
  let coordinatorWaitingNow = 0;
  let slotWaitingNow = 0;
  let activeCyclingNow = 0;

  for (const task of scopedTasks) {
    if (task.createdAt > ctx.now || task.state === "cancelled" || task.state === "backlog") continue;
    const outcome = classifyTaskOutcome(task, productId);
    if (task.state === "done" && outcome !== "unfinished-push") continue;
    if (outcome === "awaiting-merge" && !dependentsOfPr.get(task.id)) continue;

    const product = lookup.product(productId ?? task.productId);
    const startedAgeMs = task.startedAt !== undefined ? Math.max(0, ctx.now - task.startedAt) : undefined;
    const queuedAgeMs = task.startedAt === undefined ? Math.max(0, ctx.now - task.createdAt) : undefined;
    const sortAge = startedAgeMs ?? queuedAgeMs ?? 0;
    const taskInbox = inboxByTask.get(task.id) ?? [];
    const blockingItem = taskInbox.find(
      (item) =>
        item.blocking ||
        ["plan", "design", "delivery", "disagreement", "question", "permission", "stuck", "screen"].includes(item.kind),
    );
    const taskExecChecks = task.journey.reduce((sum, step) => sum + (step.checkBatches?.length ?? 0), 0);
    if (isLiveActiveState(task) && taskExecChecks >= 3) activeCyclingNow += 1;

    const addBlocker = (
      priority: number,
      kind: ThroughputBlocker["kind"],
      label: string,
      detail: string,
      evidence: string,
      hypothesis?: boolean,
    ) => {
      blockerCandidates.push({
        priority,
        sortAge,
        item: {
          taskId: task.id,
          title: task.title,
          productId: productId ?? task.productId,
          productLabel: product.label,
          removedProduct: product.removed,
          kind,
          label,
          ...(startedAgeMs !== undefined ? { startedAgeMs } : {}),
          ...(queuedAgeMs !== undefined ? { queuedAgeMs } : {}),
          detail,
          evidence,
          ...(hypothesis ? { hypothesis: true } : {}),
        },
      });
    };

    if (outcome === "unfinished-push") {
      addBlocker(
        90,
        "unfinished-push",
        "Unfinished push",
        "Local delivery updated, but pushing or publishing has not finished.",
        "Overview · Delivery",
      );
      continue;
    }
    if (outcome === "awaiting-merge") {
      const blockedCount = dependentsOfPr.get(task.id) ?? 0;
      addBlocker(
        75,
        "prerequisites",
        "Awaiting PR merge",
        `Open pull request is holding up ${count(blockedCount, "dependent task")}. Petrina never merges pull requests.`,
        "Overview · Delivery",
      );
      continue;
    }
    if (task.state === "failed" || blockingItem?.kind === "stuck") {
      const waitWords = blockingItem ? ` for ${durationText(Math.max(0, ctx.now - blockingItem.at))}` : "";
      addBlocker(
        95,
        "stuck",
        "Stuck",
        `Stopped and waiting${waitWords} for your decision before retrying.`,
        "Inbox · Stuck decision",
      );
      coordinatorWaitingNow += 1;
      continue;
    }
    const checkActivity = task.checkActivity;
    if (checkActivity && inCheckLine(checkActivity)) {
      checkWaitingNow += 1;
      if (checkActivity.holds?.length && !checkHeldOwner) {
        checkHeldOwner = checkActivity.holds[0]!.owner.title;
      }
      const line = checkActivityLine(checkActivity) ?? "Waiting in the shared check line";
      const waited = durationText(Math.max(0, ctx.now - checkActivity.since));
      addBlocker(85, "checks-line", "Check line", `${line} (${waited}).`, "Journey · Automated checks");
      continue;
    }
    if (blockingItem) {
      coordinatorWaitingNow += 1;
      const what = INBOX_WAIT_WORDS[blockingItem.kind] ?? "Your decision";
      const waited = durationText(Math.max(0, ctx.now - blockingItem.at));
      addBlocker(80, "coordinator", "Needs you", `${what} waiting ${waited}.`, `Inbox · ${what}`);
      continue;
    }
    const lastStep = task.journey.at(-1);
    if (lastStep?.kind === "you" && lastStep.endedAt === undefined && task.state !== "pr-open") {
      coordinatorWaitingNow += 1;
      const waited = durationText(Math.max(0, ctx.now - lastStep.startedAt));
      addBlocker(80, "coordinator", "Needs you", `Waiting ${waited} for your decision.`, "Journey · Current checkpoint");
      continue;
    }

    const depIds = [...new Set([...(task.activeRuntimeWait?.after ?? []), ...(task.after ?? [])])];
    const blockingDeps = depIds
      .map((id) => byId.get(id))
      .filter((dep): dep is ThroughputTaskRecord => dep !== undefined && blockerBlocksDependents(dep));
    if (task.activeRuntimeWait || blockingDeps.length > 0) {
      const titles = blockingDeps.slice(0, 2).map((dep) => dep.title);
      const named = titles.length ? quoteTitles(titles) : count(depIds.length || 1, "prerequisite task");
      const more = blockingDeps.length > 2 ? ` and ${blockingDeps.length - 2} more` : "";
      addBlocker(70, "prerequisites", "Prerequisites", `Waiting for ${named}${more} to land first.`, "Overview · Prerequisites");
      continue;
    }

    const activeCap = task.modelCapacity?.find((mc) => mc.until > ctx.now);
    const activeReadiness = task.state === "waiting" ? task.readinessWaits?.[0] : undefined;
    if (activeCap || activeReadiness || task.capacityPaused || (task.state === "waiting" && /usage|limit|readiness/i.test(task.statusLine))) {
      const detail = activeReadiness
        ? `Checking ${lookup.tool(activeReadiness.toolId)} readiness (${durationText(Math.max(0, ctx.now - activeReadiness.at))}).`
        : activeCap
          ? `Model capacity full on ${lookup.tool(activeCap.toolId)}; retrying automatically.`
          : "Waiting for tool allowance or readiness.";
      addBlocker(68, "tool-or-limit", "Tool or limit", detail, "Journey · Current step");
      continue;
    }

    if (task.held || task.state === "paused" || ctx.state.pool.paused) {
      const why = task.held
        ? "On hold by your choice."
        : ctx.state.pool.paused
          ? "Waiting while the agent pool is paused."
          : "Task is paused.";
      addBlocker(45, "paused", "Paused", why, "Board · Queue");
      continue;
    }

    if ((task.state === "queued" || task.state === "waiting") && !task.holdsSlot) {
      const poolFull = occupiedSlotsNow >= currentPoolLimit;
      if (poolFull) slotWaitingNow += 1;
      addBlocker(
        poolFull ? 60 : 35,
        "active",
        "Waiting for slot",
        poolFull
          ? `Waiting while all ${count(currentPoolLimit, "agent slot")} are busy.`
          : "Queued and ready for the next scheduling pass.",
        "Board · Queue",
        poolFull,
      );
      continue;
    }

    if (task.checkActivity?.phase === "running" || task.checkActivity?.phase === "starting") {
      const elapsed = durationText(Math.max(0, ctx.now - task.checkActivity.since));
      addBlocker(40, "checks-line", "Running checks", `Occupying a shared check slot for ${elapsed}.`, "Journey · Automated checks");
      continue;
    }

    if (startedAgeMs !== undefined) {
      addBlocker(30, "active", "Running", `In progress (${task.column}) for ${durationText(startedAgeMs)}.`, "Journey · Current step");
    }
  }

  if (
    ctx.state.pool.paused &&
    scopedTasks.some((t) => isLiveActiveState(t) && t.state !== "backlog" && t.state !== "pr-open")
  ) {
    pressures.push({
      key: "pool-paused",
      label: "Agent pool is paused",
      detail: "No new agent turns or queued check runs start until the pool resumes.",
    });
  }
  if (checkHeldOwner) {
    pressures.push({
      key: "check-line-held",
      label: "Shared check line is held",
      detail: `Waiting runs cannot start until Petrina confirms extra validation cleanup on “${checkHeldOwner}”.`,
    });
  } else if (checkWaitingNow > 0) {
    pressures.push({
      key: "check-line-queue",
      label: "Shared check line has queued runs",
      detail: `${count(checkWaitingNow, "task")} waiting for ${count(configuredCheckSlots, "check slot")}.`,
    });
  }
  if (coordinatorWaitingNow > 0) {
    pressures.push({
      key: "coordinator-inbox",
      label: "Waiting on your decisions",
      detail: `${count(coordinatorWaitingNow, "active task")} cannot move on until answered in Inbox.`,
    });
  }
  if (activeLimits.length > 0) {
    const tools = [...new Set(activeLimits.map((entry) => lookup.tool(entry.toolId)))].join(", ");
    pressures.push({
      key: "usage-limits",
      label: "Tool usage limit active",
      detail: `${tools} reported an active allowance restriction.`,
    });
  }
  if (!ctx.state.pool.paused && slotWaitingNow > 0 && occupiedSlotsNow >= currentPoolLimit) {
    pressures.push({
      key: "slot-contention",
      label: "Agent pool slots are full",
      detail: `All ${count(
        currentPoolLimit,
        "slot"
      )} are occupied while ${count(
        slotWaitingNow,
        "task"
      )} wait to start or resume; adding slots can still queue behind the shared check line.`,
      hypothesis: true,
    });
  }
  if (activeCyclingNow > 0) {
    pressures.push({
      key: "repeat-cycles",
      label: "Repeated check and repair cycles on active work",
      detail: `${count(activeCyclingNow, "active task")} ran checks 3 or more times; repeats can reflect real defects, test fixtures or setup issues.`,
      hypothesis: true,
    });
  }

  blockerCandidates.sort(
    (a, b) => b.priority - a.priority || b.sortAge - a.sortAge || a.item.title.localeCompare(b.item.title),
  );
  return { pressures, tasks: blockerCandidates.slice(0, 6).map((entry) => entry.item) };
}
