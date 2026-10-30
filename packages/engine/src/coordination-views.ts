import type {
  CoordinationResult as Result,
  HistoryQuery,
  InboxItem,
  InboxKind,
  Landing,
  ScreenMode,
  Task,
  WorkChoice,
  WorkflowEventKind,
} from "@petrina/core";
import {
  deliveryDecisionProblem,
  displayTask,
  mainLine,
  nextSteps,
  originalCheck,
  reviewDecisionPending,
  roleForTask,
  runtimeWaitView,
  seatRemaining,
  taskLanding,
  taskProductIds,
  timeLeft,
  workedSoFar,
} from "@petrina/core";
import { fingerprint } from "@petrina/storage/receipt-identity";
import { checkLogRevision } from "./check-log-read.js";
import type { Engine } from "./engine.js";
import { cursor } from "./evidence-read.js";

/** Validated operation payload fields across the schema catalogue in `operations.ts`. */
export interface CoordinationArgs {
  [key: string]: unknown;
  requestId?: string;
  taskId?: string;
  taskIds?: string[];
  targetTaskId?: string;
  productId?: string;
  itemId?: string;
  revision?: string;
  ifRevision?: string;
  nodeId?: string;
  stageId?: string;
  profileId?: string;
  findingId?: string;
  messageId?: string;
  eventId?: string;
  setupAttemptId?: string;
  anchorId?: string;
  toolId?: string;
  seat?: string;
  marker?: string;
  cursor?: string;
  search?: string;
  title?: string;
  description?: string;
  answer?: string;
  note?: string;
  reason?: string;
  text?: string;
  section?: string;
  target?: "engine" | "pool" | "task" | "inbox";
  condition?: "change" | "drained" | "decision" | "delivered" | "landed" | "state";
  decision?: "check" | "ship-again" | "mark-done";
  side?: "before" | "after";
  mode?: string;
  list?: "profileIds" | "reviewerProfileIds";
  from?: "now" | "oldest";
  period?: "today" | "7d" | "30d";
  limit?: number;
  cap?: number;
  index?: number;
  position?: number;
  result?: number;
  update?: number;
  timeoutMs?: number;
  wait?: boolean;
  held?: boolean;
  blocking?: boolean;
  allowed?: boolean;
  includeActivity?: boolean;
  after?: string[];
  positions?: number[];
  states?: Task["state"][];
  kinds?: (InboxKind | WorkflowEventKind)[];
  choice?: WorkChoice;
  checks?: Parameters<Engine["setProductChecks"]>[1];
  requirements?: Parameters<Engine["setProductCheckSetup"]>[1];
}

export interface LifecycleControl {
  status(): Result | Promise<Result>;
  request(name: string, args: Record<string, unknown>): Result | Promise<Result>;
  receipt?(id: string): Result | undefined;
}

/** Awaiting merge confirms a delivery; only landing proves it landed. */
export const deliveryConfirmed = (landing: Landing): boolean =>
  landing === "landed" || landing === "awaiting-merge";

/** Retain each wait decision once, including after its ordinary timeline entry is evicted. */
export function taskTimeline(task: Task) {
  const changes = task.runtimeWait?.changes ?? [];
  const audit = (change: (typeof changes)[number]) => ({
    kind: "prerequisite-wait-change",
    before: change.before,
    after: change.after,
    reason: change.reason,
    requestId: change.requestId ?? null,
  });
  return [
    ...task.timeline.map((entry) => {
      const change = changes.find((candidate) => candidate.timelineId === entry.id);
      return change ? { ...entry, ...audit(change) } : entry;
    }),
    ...changes.flatMap((change, index) =>
      task.timeline.some((entry) => entry.id === change.timelineId)
        ? []
        : [
            {
              id: change.timelineId ?? `${task.id}:prerequisite-wait:${index}`,
              at: change.at,
              tone: "you",
              text: change.after.length
                ? `You set the prerequisite wait. ${change.reason}`
                : `You cleared the prerequisite wait. ${change.reason}`,
              ...audit(change),
            },
          ],
    ),
  ].sort((left, right) => left.at - right.at);
}

export function taskSummary(engine: Engine, task: Task) {
  // Delivery describes the whole task, whichever product is displayed.
  const landing = taskLanding(task);
  task = displayTask(task);
  const state = engine.activeState();
  const wait = runtimeWaitView(task, (id) => engine.task(id) ?? engine.taskDetails(id));
  const { changes: _changes, ...waitSummary } = wait ?? {};
  return {
    id: task.id,
    productId: task.productId,
    title: task.title,
    state: task.state,
    held: task.held,
    priority: task.priority,
    after: task.after ?? [],
    ...(wait
      ? {
          runtimeWait: waitSummary,
          waitKind: wait.held ? (wait.decisionNeeded ? "needs-your-decision" : "dependencies") : null,
        }
      : {}),
    summary: mainLine(task),
    activity: task.toolActivity ?? null,
    workers: [task.agent, ...(task.helpers ?? [])]
      .filter(Boolean)
      .map((worker) => ({
        ...worker,
        activity: worker?.reviewKey
          ? (task.hunt?.work?.[worker.reviewKey]?.toolActivity ?? null)
          : (task.toolActivity ?? null),
      })),
    next: nextSteps(state, task) ?? null,
    waitingReason: ["backlog", "waiting", "needs-you", "paused", "queued", "failed"].includes(task.state)
      ? task.statusLine
      : null,
    inbox: state.inbox.filter((item) => item.taskId === task.id).map(({ id, kind }) => ({ id, kind })),
    landing,
    delivery: task.delivery,
    deliveryConfirmed: deliveryConfirmed(landing),
    error: task.error?.slice(0, 1000) ?? null,
    errorShortened: (task.error?.length ?? 0) > 1000,
  };
}

/**
 * A ballot's required places and who still owes answers. A bounded panel names each place with its tool, assigned
 * finding ids, answers still owed and why it was chosen, plus the tools usable when it was saved and any third-answer decisions.
 */
function voterPlaces(engine: Engine, task: Task) {
  const hunt = task.hunt!;
  const panel = hunt.panel;
  if (!panel) {
    return {
      requiredVoters: hunt.voterProfiles ?? [],
      waitingVoters: (hunt.voterProfiles ?? []).filter(
        (id) =>
          !Object.keys(hunt.voted ?? {}).some((used) => engine.profile(used)?.toolId === engine.profile(id)?.toolId),
      ),
    };
  }
  const places = panel.seats.map((seat) => ({
    key: seat.key,
    profileId: seat.profileId,
    toolId: seat.toolId,
    findingIds: seat.findingIds,
    owed: seatRemaining(panel, seat, task.findings, hunt),
    third: seat.third === true,
    reason: seat.replaced?.reason ?? seat.reason,
  }));
  return {
    requiredVoters: [...new Set(panel.seats.map((seat) => seat.profileId))],
    waitingVoters: [...new Set(places.filter((place) => place.owed.length).map((place) => place.profileId))],
    verifierPanel: {
      rule: panel.rule,
      usableAtSelection: panel.usable,
      places,
      escalations: panel.escalations ?? {},
    },
  };
}

export function drainStatus(engine: Engine) {
  const state = engine.activeState();
  const observed = engine.drainObservation();
  const cleanupBlockers = observed.cleanup.blockers.map((blocker) => ({
    taskId: blocker.taskId,
    state: blocker.state,
    reason:
      blocker.state === "failed"
        ? "Agent cleanup was not confirmed. Its working files were kept."
        : "Waiting for the agent's programs to stop.",
  }));
  const active = state.tasks.filter(
    (task) =>
      !engine.isPausedCheck(task.id)
      && (engine.settling.has(task.id) || engine.drivers.has(task.id) || task.holdsSlot),
  );
  const blockers = state.inbox
    .filter((item) => active.some((task) => task.id === item.taskId) && (item.blocking || item.kind === "screen"))
    .map(({ id, taskId, kind, title }) => ({ id, taskId, kind, title }));
  // A yielded screen conversation has released its admission. It is saved work waiting to
  // start again, distinct from a screen request still keeping an admitted group open.
  return {
    drained: engine.inFlight() === 0 && blockers.length === 0,
    pendingWork: observed.pending,
    cleanupBlockers: cleanupBlockers.slice(0, 100),
    cleanupBlockerCount: cleanupBlockers.length,
    cleanupFailureCount: observed.cleanup.blockers.filter((blocker) => blocker.state === "failed").length,
    active: active.slice(0, 100).map((task) => taskSummary(engine, task)),
    activeCount: active.length,
    blockers: blockers.slice(0, 100),
    blockerCount: blockers.length,
    checkBlockers: engine.extraValidations.blockers,
    checkBlockerCount: engine.extraValidations.blockers.length,
    extraValidations: (state.extraValidations ?? []).map((run) => ({
      requestId: run.requestId,
      taskId: run.taskId,
      name: run.name,
      state: run.state,
      queuedAt: run.queuedAt,
      startedAt: run.startedAt,
    })),
    screenWaiting: state.tasks
      .filter((task) => task.screen && !active.some((entry) => entry.id === task.id))
      .slice(0, 100)
      .map((task) => ({ taskId: task.id, reason: task.screen!.reason })),
    queued: state.tasks.filter((task) => task.state === "queued").length,
    waiting: state.tasks.filter((task) => task.state === "waiting").length,
    checkpoints: state.inbox.filter(
      (item) => !item.blocking && ["plan", "design", "delivery", "disagreement"].includes(item.kind),
    ).length,
    pendingParticipants: state.tasks
      .flatMap((task) => {
        const stage = task.plan?.stages[task.stageIndex];
        return stage?.kind === "review-chain" && task.hunt
          ? [
              {
                taskId: task.id,
                stageId: stage.id,
                finishedReviewers: Object.keys(task.hunt.reported),
                waitingReviewers: stage.profileIds.flatMap((profileId, index) =>
                  task.hunt!.reported[String(index)] ? [] : [{ index, profileId }],
                ),
                finishedVoters: Object.keys(task.hunt.voted ?? {}),
                ...voterPlaces(engine, task),
              },
            ]
          : [];
      })
      .slice(0, 100),
  };
}

export function requestRevision(engine: Engine, item: InboxItem): string {
  const task = engine.taskDetails(item.taskId);
  // Include exactly what a checkpoint confirms, excluding clocks, unrelated activity and conversations.
  return fingerprint({
    item,
    ...(item.kind === "screen" ? { screen: task?.screen } : {}),
    ...(item.kind === "shipping" ? { shipping: task?.shipping, source: task?.source, delivery: task?.delivery } : {}),
    ...(task && ["plan", "design", "delivery", "disagreement"].includes(item.kind)
      ? {
          productId: task.productId,
          title: task.title,
          description: task.description,
          selectedProducts: task.selectedProducts,
          workRows: task.workRows,
          workValidating: task.workValidating,
          approvalExplanation: task.approvalExplanation,
          leadProductId: task.leadProductId,
          acceptance: {
            passed: task.acceptancePassed,
            blocked: task.acceptanceBlocked,
            unverified: task.acceptanceUnverified,
            testedPatch: task.testedPatch,
            testedVersions: task.testedVersions,
            proofRequests: task.proofRequests,
            proofRefreshes: task.proofRefreshes,
          },
          diagnostics: checkLogRevision(
            engine.dataDir,
            task.id,
            (task.repositories ?? [task]).flatMap(
              (work) =>
                work.checks?.results.flatMap((run) => [run.logPath, originalCheck(task, run)?.check.run?.logPath]) ?? [],
            ),
          ),
          evidence: task.journey?.map(
            ({
              id,
              kind,
              roleId,
              stageId,
              round,
              endedAt,
              productChecks,
              checkAttempts,
              checkSetups,
              reuses,
              reviewInput,
              agentInputs,
              agentResults,
              result,
              seats,
              acceptanceChecks,
              acceptancePatch,
              buildVersions,
              buildProductId,
            }) => ({
              id,
              kind,
              roleId,
              stageId,
              round,
              endedAt,
              productChecks,
              checkAttempts,
              checkSetups,
              reuses,
              reviewInput,
              agentInputs,
              agentResults,
              result,
              seats,
              acceptanceChecks,
              acceptancePatch,
              buildVersions,
              buildProductId,
            }),
          ),
          evidenceRoles: [
            ...new Set([
              ...(task.journey ?? []).map((step) => step.roleId),
              ...(task.plan?.stages ?? []).map((stage) => stage.roleId),
            ]),
          ].map((id) => {
            const role = id ? roleForTask(engine.s.roles, id, task) : undefined;
            return role && { id: role.id, name: role.name, result: role.result, canEdit: role.canEdit };
          }),
          plan: task.plan,
          source: task.source,
          proposedSource: task.proposedSource,
          workChoice: task.workChoice,
          workProposal: task.workProposal,
          workProduct: task.workProduct,
          workError: task.workError,
          confirmWork: task.confirmWork,
          delivery: task.delivery,
          approveDelivery: task.approveDelivery,
          brief: task.brief,
          objections: task.objections,
          call: task.call,
          findings: task.findings,
          reviewDecision: task.reviewDecision,
          repositories: task.repositories?.map((work) => ({
            productId: work.productId,
            source: work.source,
            workChoice: work.workChoice,
            delivery: work.delivery,
            checkedSha: work.checkedSha,
            checkedPatch: work.checkedPatch,
            checks: work.checks,
            checkSetup: work.checkSetup,
            checkSetupInvalidated: work.checkSetupInvalidated,
          })),
          checkedSha: task.checkedSha,
          checkedPatch: task.checkedPatch,
          checks: task.checks,
          checkSetup: task.checkSetup,
          checkSetupInvalidated: task.checkSetupInvalidated,
          stageIndex: task.stageIndex,
        }
      : {}),
  });
}

export const decisionsForRequest = (
  kind: string,
  task?: Pick<
    Task,
    | "productId"
    | "repositories"
    | "checks"
    | "checkSetup"
    | "checkSetupInvalidated"
    | "reviewDecision"
    | "checkedSha"
    | "checkedPatch"
    | "journey"
  >,
): string[] =>
  kind === "question"
    ? ["inbox.answer"]
    : kind === "permission"
      ? ["inbox.allow", "inbox.deny"]
      : kind === "stuck"
        ? ["inbox.retry"]
        : kind === "shipping"
          ? ["inbox.recovery"]
          : kind === "screen"
            ? ["screen.allow"]
            : kind === "learnings"
              ? ["learning.accept", "learning.decline"]
              : kind === "guide"
                ? ["review-guide.accept", "review-guide.decline"]
                : kind === "delivery" && task && !reviewDecisionPending(task) && deliveryDecisionProblem(task)
                  ? ["inbox.rerun-checks", "inbox.changes"]
                  : ["plan", "design", "delivery", "disagreement"].includes(kind)
                    ? ["inbox.approve", "inbox.changes"]
                    : [];

/** A bounded health read: recorded facts about the current step, with no verdict and no action. */
export function taskHealthView(engine: Engine, task: Task): Result {
  const state = engine.activeState();
  const now = Date.now();
  const node = [...(task.journey ?? [])].reverse().find((step) => step.endedAt === undefined) ?? task.journey?.at(-1);
  const lines = task.session.filter(
    (line) => line.step === node?.id && (line.from === "agent" || line.from === "activity"),
  );
  const status = task.timeline.filter((entry) => entry.step === node?.id && entry.tone === "status");
  const seatOfKey = (key: string) =>
    [task.agent, ...(task.helpers ?? [])].find((agent) => agent?.reviewKey === key);
  const seats = Object.entries(task.hunt?.work ?? {}).map(([key, work]) => ({
    seat: key,
    roleId: seatOfKey(key)?.roleId ?? null,
    profileId: seatOfKey(key)?.profileId ?? null,
    workedMs: work.clock ? workedSoFar(work.clock, now) : null,
    working: work.clock?.since !== undefined,
    todo: work.todo ?? null,
    lastActivity: work.toolActivity?.lastActivity ?? null,
    runningTool: work.toolActivity?.runningTool
      ? {
          description: work.toolActivity.runningTool.description,
          startedAt: work.toolActivity.runningTool.startedAt,
        }
      : null,
    actionCount: work.toolActivity?.actionCount ?? null,
    waiting: work.waiting ?? null,
    attempts: work.attempts,
  }));
  const estimate = timeLeft({ tasks: state.tasks, now, history: state.history }, task);
  const lastObserved = Math.max(
    0,
    ...lines.map((line) => line.at),
    ...status.map((entry) => entry.at),
    task.toolActivity?.runningTool?.startedAt ?? 0,
    ...Object.values(node?.toolActivity ?? {}).map((activity) => activity.runningTool?.startedAt ?? 0),
  );
  return {
    outcome: "completed",
    observedAt: now,
    state: task.state,
    ...(node
      ? {
          node: {
            id: node.id,
            kind: node.kind,
            roleId: node.roleId ?? null,
            profileId: node.profileId ?? null,
            startedAt: node.startedAt,
            elapsedMs: now - node.startedAt,
            ended: node.endedAt !== undefined,
          },
        }
      : { node: null }),
    workedMs: task.stepClock ? workedSoFar(task.stepClock, now) : null,
    working: task.stepClock?.since !== undefined,
    attempts: task.stepAttempts ?? null,
    lastObservedAt: lastObserved || null,
    todo: task.todo ?? null,
    lastActivity: task.toolActivity?.lastActivity ?? null,
    runningTool: task.toolActivity?.runningTool
      ? {
          description: task.toolActivity.runningTool.description,
          startedAt: task.toolActivity.runningTool.startedAt,
        }
      : null,
    actionCount: task.toolActivity?.actionCount ?? null,
    waitingReason: ["waiting", "needs-you", "paused", "queued", "failed", "backlog"].includes(task.state)
      ? task.statusLine
      : null,
    seats,
    estimate: estimate
      ? {
          text: estimate,
          basis:
            "The median of the last ten finished steps with the same role and first-or-repeat pass, with at least three samples. An estimate, never a threshold.",
        }
      : null,
    note: "Recorded facts only. A quiet step is not a stuck step, and this read never retries, cancels or replaces work.",
  };
}

export function filteredInbox(engine: Engine, args: CoordinationArgs): InboxItem[] {
  const state = engine.activeState();
  return state.inbox
    .filter((item) => {
      if (args.productId) {
        const task = state.tasks.find((candidate) => candidate.id === item.taskId);
        const archived = task ? undefined : engine.store.history.item(item.taskId);
        const products = task ? taskProductIds(task) : (archived?.productIds ?? (archived ? [archived.productId] : []));
        if (!products.includes(args.productId)) return false;
      }
      return (
        (!args.taskId || item.taskId === args.taskId)
        && (!args.kinds || (args.kinds as string[]).includes(item.kind))
        && (args.blocking === undefined || item.blocking === args.blocking)
        && (!args.search || item.title.toLowerCase().includes(args.search.toLowerCase()))
      );
    })
    .sort((left, right) => left.at - right.at || left.id.localeCompare(right.id));
}

export function readHistoryPage(engine: Engine, args: CoordinationArgs): Result {
  const states = args.states?.filter((state): state is "done" | "cancelled" => state === "done" || state === "cancelled");
  const request: HistoryQuery = {
    productId: args.productId,
    taskId: args.taskId,
    states,
    held: args.held,
    query: args.search,
    limit: args.limit,
  };
  // The engine flushes newly finished work before this indexed, lightweight read.
  let page = engine.historyPage(request);
  const key = fingerprint([
    "task.history",
    request.productId,
    request.taskId,
    request.states,
    request.held,
    request.query,
    engine.store.history.info().revision,
  ]);
  if (args.cursor) {
    try {
      const saved = JSON.parse(Buffer.from(args.cursor, "base64url").toString()) as { key?: unknown; after?: unknown };
      if (saved.key !== key || typeof saved.after !== "string") throw new Error();
      page = engine.historyPage({ ...request, cursor: saved.after });
    } catch {
      return {
        outcome: "changed",
        message: "This history page changed or expired. Read finished history again from the beginning.",
      };
    }
  }
  return {
    outcome: "completed",
    items: page.items.map((item) => {
      const landing = taskLanding(item);
      return { ...item, summary: item.statusLine, landing, deliveryConfirmed: deliveryConfirmed(landing) };
    }),
    total: page.total,
    ...(page.nextCursor ? { next: cursor({ key, after: page.nextCursor }) } : {}),
  };
}

export type { ScreenMode };
