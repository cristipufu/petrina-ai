// Compact task projection and view types for system throughput and bottleneck analytics.
// Excludes conversations, prompt bodies, tool invocations, paths, commands and git hashes.

import { checkEntryResult } from "./check-evidence.js";
import { markedDoneUnconfirmed } from "./cleanup.js";
import type { ExtraValidation } from "./extra-validation.js";
import type {
  CheckActivity,
  CheckRunReason,
  Column,
  DeliveryMode,
  Id,
  JourneyCheckReuse,
  JourneyProductCheck,
  JourneyStep,
  JourneyWait,
  JourneyWork,
  RepositoryState,
  RunState,
  RuntimeWait,
  StageKind,
  Task,
  TaskRepository,
} from "./model.js";
import type { ReadinessRecheck, ReadinessWait } from "./readiness.js";
import { displayTask, taskProductIds } from "./repositories.js";

export interface ThroughputDeliveryRecord {
  productId: Id;
  delivery: DeliveryMode;
  nothingToPublish?: boolean;
  markedDone?: boolean;
  landingAccepted?: boolean;
  companionPending?: boolean;
  pr?: { state: "open" | "merged" | "closed"; openedAt: number };
  hasRelease?: boolean;
  hasLanded?: boolean;
  confirmedAt?: number;
  localUpdatePushed?: boolean;
  shippingActive?: boolean;
}

export interface ThroughputCheckBatch {
  attemptId: string;
  productId?: Id;
  queuedAt?: number;
  startedAt?: number;
  endedAt?: number;
  inFlightSince?: number;
  outcome: "passed" | "failed" | "interrupted" | "running";
}

export interface ThroughputSetupAttempt {
  id: Id;
  productId: Id;
  queuedAt: number;
  startedAt?: number;
  endedAt?: number;
  failed?: boolean;
  interrupted?: boolean;
}

export interface ThroughputExtraValidation {
  id: Id;
  taskId: Id;
  productId: Id;
  state: ExtraValidation["state"];
  result?: ExtraValidation["result"];
  queuedAt: number;
  startedAt?: number;
  endedAt?: number;
}

export interface ThroughputJourneyStep {
  id: Id;
  kind: JourneyStep["kind"];
  stageId?: Id;
  round: number;
  sub: number;
  roleId?: Id;
  fixing?: boolean;
  hasFindings?: boolean;
  update?: boolean;
  port?: boolean;
  call?: boolean;
  work?: JourneyWork;
  waitsFor?: JourneyWait;
  startedAt: number;
  endedAt?: number;
  end?: "done" | "failed" | "cancelled";
  outcome?: string;
  reason?: string;
  tone?: "on" | "back" | "stuck";
  triggerAfter?: Id;
  triggerReason?: string;
  builderChanged?: boolean;
  builderProductId?: Id;
  hasCheckRepairs?: boolean;
  reopenedFindings?: number;
  hasFailedAcceptance?: boolean;
  asks?: readonly { id: Id; kind: "question" | "permission"; at: number; endedAt?: number }[];
  readinessRechecks?: readonly { at: number; endedAt?: number; toolId: Id; outcome: ReadinessRecheck["outcome"] }[];
  reuses?: readonly { at: number; productId?: Id; purpose: JourneyCheckReuse["purpose"]; basis: JourneyCheckReuse["basis"]; passed: boolean }[];
  checkReasons?: readonly { attemptId?: string; productId?: Id; purpose: CheckRunReason["purpose"]; changed: CheckRunReason["changed"] }[];
  checkBatches?: readonly ThroughputCheckBatch[];
  setupAttempts?: readonly ThroughputSetupAttempt[];
  extraValidations?: readonly ThroughputExtraValidation[];
}

export interface ThroughputTaskRecord {
  id: Id;
  title: string;
  productId: Id;
  productIds: readonly Id[];
  sharedScope: boolean;
  state: RunState;
  column: Column;
  held: boolean;
  holdsSlot: boolean;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  combinedInto?: Id;
  noProductChanges?: boolean;
  sentBack?: number;
  after?: readonly Id[];
  activeAgents: number;
  statusLine: string;
  checkActivity?: CheckActivity;
  runtimeWaitIntervals?: readonly { startedAt: number; endedAt?: number }[];
  activeRuntimeWait?: { after: readonly Id[]; reason: string; since?: number };
  readinessWaits?: readonly ReadinessWait[];
  modelCapacity?: readonly { toolId: Id; modelId: string; until: number }[];
  capacityPaused?: number;
  planStages?: readonly { id: Id; kind: StageKind; roleId: Id }[];
  deliveries: readonly ThroughputDeliveryRecord[];
  journey: readonly ThroughputJourneyStep[];
}

export interface ThroughputDistribution {
  count: number;
  medianMs?: number;
  p90Ms?: number;
  missingStartCount?: number;
}

export interface ThroughputDelivery {
  landed: number;
  sharedLanded: number;
  landedPerDay?: number;
  awaitingMerge: number;
  prsOpenedInWindow: number;
  noChanges: number;
  unconfirmedOrClosed: number;
  markedDone: number;
  closedWithoutMerge: number;
  cancelled: number;
  combined: number;
  inProgress: number;
  queued: number;
  unfinishedPushes: number;
  windowElapsedMs: number;
  createdToStart: ThroughputDistribution;
  startToDelivery: ThroughputDistribution;
  createdToDelivery: ThroughputDistribution;
}

export type ThroughputPhaseKey =
  | "agent-work"
  | "check-execution"
  | "waiting-for-checks"
  | "coordinator-decisions"
  | "prerequisites"
  | "availability";

export interface ThroughputPhase {
  key: ThroughputPhaseKey;
  label: string;
  wallMs: number;
  summedMs: number;
  taskCount: number;
  available: boolean;
  partial?: boolean;
  note?: string;
}

export interface ThroughputCapacity {
  checkSlot: {
    configuredSlots: number;
    occupiedWallMs: number;
    occupancyShare?: number;
    completedBatches: number;
    medianBatchMs?: number;
    p90BatchMs?: number;
  };
  agentPool: {
    currentPoolLimit: number;
    poolPausedNow: boolean;
    activeWallMs: number;
    summedAgentMs: number;
    wallShare?: number;
    slotShare?: number;
    meanConcurrencyWhenBusy?: number;
  };
}

export type BuilderReturnCauseKey = "review" | "checks" | "acceptance" | "main-update" | "coordinator" | "unrecorded";

export interface ThroughputCyclingTask {
  taskId: Id;
  title: string;
  productId: Id;
  productLabel: string;
  removedProduct: boolean;
  state: RunState;
  checkBatches: number;
  failedCheckBatches: number;
  reusedFailedBatches: number;
  builderReturns: number;
  summary: string;
}

export interface ThroughputRepeatedWork {
  checks: {
    executedBatches: number;
    failedBatches: number;
    interruptedOrUnverifiedBatches: number;
    reusedPassedBatches: number;
    reusedFailedBatches: number;
    freshReasons: { key: string; label: string; count: number }[];
  };
  builderReturns: {
    total: number;
    unchangedSourceReturns: number;
    byCause: { key: BuilderReturnCauseKey; label: string; count: number }[];
  };
  reviewsAndUpdates: {
    reviewRounds: number;
    reviewSendBacks: number;
    reopenedFindings: number;
    mainUpdates: number;
    portReviews: number;
  };
  cyclingTasks: ThroughputCyclingTask[];
}

export type ThroughputBlockerKind =
  | "coordinator"
  | "checks-line"
  | "prerequisites"
  | "unfinished-push"
  | "tool-or-limit"
  | "stuck"
  | "paused"
  | "active";

export interface ThroughputBlocker {
  taskId: Id;
  title: string;
  productId: Id;
  productLabel: string;
  removedProduct: boolean;
  kind: ThroughputBlockerKind;
  label: string;
  startedAgeMs?: number;
  queuedAgeMs?: number;
  detail: string;
  evidence: string;
  hypothesis?: boolean;
}

export interface ThroughputPressure {
  key: string;
  label: string;
  detail: string;
  hypothesis?: boolean;
}

export interface ThroughputCoverage {
  asOf: number;
  from: number;
  to: number;
  windowElapsedMs: number;
  trackingSince: number;
  beforeTracking: boolean;
  liveTasks: number;
  archivedTasks: number;
  untrackedTasks: number;
  lostTurnsInWindow: number;
  notes: string[];
}

export interface AnalyticsThroughput {
  coverage: ThroughputCoverage;
  delivery: ThroughputDelivery;
  phases: ThroughputPhase[];
  capacity: ThroughputCapacity;
  repeatedWork: ThroughputRepeatedWork;
  holdingUpNow: {
    pressures: ThroughputPressure[];
    tasks: ThroughputBlocker[];
  };
}

function extractRuntimeWait(wait: RuntimeWait | undefined): {
  intervals?: { startedAt: number; endedAt?: number }[];
  active?: { after: readonly Id[]; reason: string; since?: number };
} {
  if (!wait) return {};
  const intervals: { startedAt: number; endedAt?: number }[] = [];
  let openStart: number | undefined;
  for (const change of wait.changes ?? []) {
    if (change.after.length > 0 && openStart === undefined) openStart = change.at;
    else if (change.after.length === 0 && openStart !== undefined) {
      if (change.at >= openStart) intervals.push({ startedAt: openStart, endedAt: change.at });
      openStart = undefined;
    }
  }
  const stillHeld = wait.after.length > 0 && wait.releasedAt === undefined;
  if (openStart !== undefined) {
    if (stillHeld) intervals.push({ startedAt: openStart });
    else {
      const end = wait.releasedAt ?? wait.changes?.at(-1)?.at;
      if (end !== undefined && end >= openStart) intervals.push({ startedAt: openStart, endedAt: end });
    }
  }
  return {
    ...(intervals.length ? { intervals } : {}),
    ...(stillHeld ? { active: { after: [...wait.after], reason: wait.reason, ...(openStart !== undefined ? { since: openStart } : {}) } } : {}),
  };
}

function extractReadinessWaits(task: Task): ReadinessWait[] {
  const waits: ReadinessWait[] = [];
  const works: RepositoryState[] = task.repositories ? [...task.repositories] : [task.repository ?? displayTask(task)];
  for (const work of works) {
    if (work.builderSession?.readinessWait) waits.push(work.builderSession.readinessWait);
  }
  for (const session of Object.values(task.designSessions ?? {})) {
    if (session?.readinessWait) waits.push(session.readinessWait);
  }
  for (const stage of Object.values(task.reviewSessions ?? {})) {
    for (const seat of Object.values(stage ?? {})) {
      if (seat?.readinessWait) waits.push(seat.readinessWait);
    }
  }
  return waits;
}

function extractDelivery(task: Pick<Task, "state">, work: RepositoryState & Partial<TaskRepository>): ThroughputDeliveryRecord {
  return {
    productId: work.productId,
    delivery: work.delivery,
    ...(work.nothingToPublish ? { nothingToPublish: true } : {}),
    ...(markedDoneUnconfirmed(task, work) ? { markedDone: true } : {}),
    ...(work.landingAccepted ? { landingAccepted: true } : {}),
    ...(work.companion && work.companion.state !== "done" ? { companionPending: true } : {}),
    ...(work.pr ? { pr: { state: work.pr.state, openedAt: work.pr.openedAt } } : {}),
    ...(work.release ? { hasRelease: true } : {}),
    ...(work.landed ? { hasLanded: true } : {}),
    ...(work.confirmedDelivery?.at !== undefined ? { confirmedAt: work.confirmedDelivery.at } : {}),
    ...(work.localUpdate !== undefined ? { localUpdatePushed: work.localUpdate.pushed } : {}),
    ...(work.shipping?.step !== undefined || work.shipping?.carriedOver ? { shippingActive: true } : {}),
  };
}

function extractCheckBatches(step: JourneyStep): ThroughputCheckBatch[] | undefined {
  if (step.kind === "you" || step.work === "check-reuse" || !step.productChecks?.length) return undefined;
  const groups = new Map<string, JourneyProductCheck[]>();
  for (const check of step.productChecks) {
    if (check.reusedAt !== undefined) continue;
    const attemptId = check.run?.source?.attemptId ?? check.attemptId ?? check.id?.match(/^run-\d+(?=:)/)?.[0] ?? "run-0";
    const key = `${check.productId ?? ""}:${attemptId}`;
    const list = groups.get(key) ?? [];
    list.push(check);
    groups.set(key, list);
  }
  if (!groups.size) return undefined;
  const batches: ThroughputCheckBatch[] = [];
  for (const [, rows] of groups) {
    const first = rows[0]!;
    const attemptId = first.run?.source?.attemptId ?? first.attemptId ?? first.id?.match(/^run-\d+(?=:)/)?.[0] ?? "run-0";
    const results = rows.map(checkEntryResult);
    let queuedAt: number | undefined;
    let startedAt: number | undefined;
    let endedAt: number | undefined;
    let inFlightSince: number | undefined;
    let allEnded = true;
    for (const row of rows) {
      if (row.queuedAt !== undefined) queuedAt = queuedAt === undefined ? row.queuedAt : Math.min(queuedAt, row.queuedAt);
      const rowStart = row.startedAt ?? row.run?.startedAt;
      const rowEnd = row.endedAt ?? row.run?.endedAt;
      if (rowStart !== undefined) startedAt = startedAt === undefined ? rowStart : Math.min(startedAt, rowStart);
      if (rowEnd !== undefined) endedAt = endedAt === undefined ? rowEnd : Math.max(endedAt, rowEnd);
      else if (rowStart !== undefined && (row.result === "running" || row.result === "pending")) {
        allEnded = false;
        inFlightSince = inFlightSince === undefined ? rowStart : Math.min(inFlightSince, rowStart);
      } else if (row.result === "running" || row.result === "pending") {
        allEnded = false;
      }
    }
    if (startedAt === undefined && results.some((res) => res !== "pending" && res !== "skipped")) startedAt = step.startedAt;
    if (endedAt === undefined && allEnded && step.endedAt !== undefined) endedAt = step.endedAt;
    const hasFail = results.includes("fail");
    const hasUnfinished = results.some((res) => res === "did-not-finish" || res === "stopped");
    const hasOpen = results.some((res) => res === "running" || res === "pending");
    const outcome: ThroughputCheckBatch["outcome"] = hasFail
      ? "failed"
      : step.endedAt === undefined && hasOpen && !hasUnfinished
        ? "running"
        : hasUnfinished || hasOpen || step.end === "failed" || step.end === "cancelled"
          ? "interrupted"
          : "passed";
    batches.push({
      attemptId,
      ...(first.productId ? { productId: first.productId } : {}),
      ...(queuedAt !== undefined ? { queuedAt } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(endedAt !== undefined && allEnded ? { endedAt } : {}),
      ...(inFlightSince !== undefined ? { inFlightSince } : {}),
      outcome,
    });
  }
  return batches;
}

function extractJourneyStep(taskId: Id, step: JourneyStep): ThroughputJourneyStep {
  const batches = extractCheckBatches(step);
  const setups = step.checkSetups?.map((setup): ThroughputSetupAttempt => ({
    id: setup.id,
    productId: setup.productId,
    queuedAt: setup.queuedAt,
    ...(setup.startedAt !== undefined ? { startedAt: setup.startedAt } : {}),
    ...(setup.endedAt !== undefined ? { endedAt: setup.endedAt } : {}),
    ...(setup.observationFailure || setup.results?.some((entry) => !entry.run.ok) ? { failed: true } : {}),
    ...(setup.lifecycle === "stopped" ? { interrupted: true } : {}),
  }));
  const extras = step.extraValidations?.map((ev): ThroughputExtraValidation => ({
    id: ev.id,
    taskId: ev.taskId || taskId,
    productId: ev.productId,
    state: ev.state,
    ...(ev.result ? { result: ev.result } : {}),
    queuedAt: ev.queuedAt,
    ...(ev.startedAt !== undefined ? { startedAt: ev.startedAt } : {}),
    ...(ev.endedAt !== undefined ? { endedAt: ev.endedAt } : {}),
  }));
  const readiness = (step.agentInputs ?? []).flatMap((input) =>
    input.readiness ? [{
      at: input.readiness.at,
      ...(input.at !== undefined ? { endedAt: input.at } : {}),
      toolId: input.readiness.toolId,
      outcome: input.readiness.outcome
    }] : [],
  );
  const reopened = step.result?.findingChanges?.reopened?.length ?? 0;
  const failedAcc =
    step.acceptanceChecks?.some((entry) => entry.result === "fail" || entry.result === "blocked") ||
    step.proofChecks?.some((entry) => entry.result === "fail" || entry.result === "blocked");
  return {
    id: step.id,
    kind: step.kind,
    ...(step.stageId ? { stageId: step.stageId } : {}),
    round: step.round,
    sub: step.sub,
    ...(step.roleId ? { roleId: step.roleId } : {}),
    ...(step.fixing ? { fixing: true } : {}),
    ...(step.findingIds?.length ? { hasFindings: true } : {}),
    ...(step.update ? { update: true } : {}),
    ...(step.port ? { port: true } : {}),
    ...(step.call ? { call: true } : {}),
    ...(step.work ? { work: step.work } : {}),
    ...(step.waitsFor ? { waitsFor: step.waitsFor } : {}),
    startedAt: step.startedAt,
    ...(step.endedAt !== undefined ? { endedAt: step.endedAt } : {}),
    ...(step.end ? { end: step.end } : {}),
    ...(step.outcome ? { outcome: step.outcome } : {}),
    ...(step.reason ? { reason: step.reason } : {}),
    ...(step.tone ? { tone: step.tone } : {}),
    ...(step.trigger?.after ? { triggerAfter: step.trigger.after } : {}),
    ...(step.trigger?.reason ? { triggerReason: step.trigger.reason } : {}),
    ...(step.builderReturn?.changed !== undefined ? { builderChanged: step.builderReturn.changed } : {}),
    ...(step.builderReturn?.productId ?? step.buildProductId ? { builderProductId: step.builderReturn?.productId ?? step.buildProductId } : {}),
    ...(step.checkRepairs?.length ? { hasCheckRepairs: true } : {}),
    ...(reopened > 0 ? { reopenedFindings: reopened } : {}),
    ...(failedAcc ? { hasFailedAcceptance: true } : {}),
    ...(step.asks?.length ? { asks: step.asks.map((ask) => ({
      id: ask.id,
      kind: ask.kind,
      at: ask.at,
      ...(ask.endedAt !== undefined ? { endedAt: ask.endedAt } : {})
    })) } : {}),
    ...(readiness.length ? { readinessRechecks: readiness } : {}),
    ...(step.reuses?.length
      ? { reuses: step.reuses.map((reuse) => ({
        at: reuse.at,
        ...(reuse.productId ? { productId: reuse.productId } : {}),
        purpose: reuse.purpose,
        basis: reuse.basis,
        passed: reuse.passed
      })) }
      : {}),
    ...(step.checkReasons?.length
      ? { checkReasons: step.checkReasons.map((entry) => ({
        ...(entry.attemptId ? { attemptId: entry.attemptId } : {}),
        ...(entry.productId ? { productId: entry.productId } : {}),
        purpose: entry.purpose,
        changed: [...entry.changed]
      })) }
      : {}),
    ...(batches?.length ? { checkBatches: batches } : {}),
    ...(setups?.length ? { setupAttempts: setups } : {}),
    ...(extras?.length ? { extraValidations: extras } : {}),
  };
}

/** Extract only the timing, check, wait and delivery facts needed for throughput analytics. */
export function throughputTaskRecord(task: Task): ThroughputTaskRecord {
  const productIds = taskProductIds(task);
  const activeRepos = task.repositories?.filter((work) => !work.removed);
  const deliveries = activeRepos?.length
    ? activeRepos.map((work) => extractDelivery(task, work))
    : [extractDelivery(task, task.repository ?? displayTask(task))];
  const runtimeWait = extractRuntimeWait(task.runtimeWait);
  const readinessWaits = extractReadinessWaits(task);
  const journey = (task.journey ?? []).filter((step) => !step.legacy).map((step) => extractJourneyStep(task.id, step));
  return {
    id: task.id,
    title: task.title,
    productId: task.productId,
    productIds,
    sharedScope: Boolean(activeRepos && activeRepos.length > 1) || productIds.length > 1,
    state: task.state,
    column: task.column,
    held: Boolean(task.held),
    holdsSlot: Boolean(task.holdsSlot),
    createdAt: task.createdAt,
    ...(task.startedAt !== undefined ? { startedAt: task.startedAt } : {}),
    ...(task.finishedAt !== undefined ? { finishedAt: task.finishedAt } : {}),
    ...(task.combinedInto ? { combinedInto: task.combinedInto } : {}),
    ...(task.maintenance?.noProductChanges ? { noProductChanges: true } : {}),
    ...(task.sentBack ? { sentBack: task.sentBack } : {}),
    ...(task.after?.length ? { after: [...task.after] } : {}),
    activeAgents: (task.agent ? 1 : 0) + (task.helpers?.length ?? 0),
    statusLine: task.statusLine ?? "",
    ...(task.checkActivity ? { checkActivity: task.checkActivity } : {}),
    ...(runtimeWait.intervals ? { runtimeWaitIntervals: runtimeWait.intervals } : {}),
    ...(runtimeWait.active ? { activeRuntimeWait: runtimeWait.active } : {}),
    ...(readinessWaits.length ? { readinessWaits } : {}),
    ...(task.modelCapacity?.length ? { modelCapacity: task.modelCapacity.map((mc) => ({ toolId: mc.toolId, modelId: mc.modelId, until: mc.until })) } : {}),
    ...(task.capacityPaused?.length ? { capacityPaused: task.capacityPaused.length } : {}),
    ...(task.plan?.stages?.length ? { planStages: task.plan.stages.map((stage) => ({ id: stage.id, kind: stage.kind, roleId: stage.roleId })) } : {}),
    deliveries,
    journey,
  };
}
