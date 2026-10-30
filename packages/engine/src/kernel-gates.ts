// Inbox gates, failure transitions, coordinator note attribution and parallel review summaries.

import * as library from "@petrina/core";
import {
  acceptanceGapLines,
  beginYouStep,
  callCheckBody,
  CHECK_NAMES,
  endOpenStep,
  fixFor,
  gateStatus,
  gateTitle,
  JOURNEY_WORDS,
  MAX_STEP_RECORDS,
  openStep,
  OTHERS_CONTINUE,
  recordAcceptanceGap,
  stepRecord,
  wontStartFix,
  workSummary,
  type ActiveAgent,
  type CheckId,
  type CheckStatus,
  type DeepMutable,
  type GateKind,
  type Id,
  type InboxItem,
  type InboxKind,
} from "@petrina/core";
import {
  executionFor,
  executionOf,
  releaseAgentForDecision,
  taskView,
  type RepositoryContext,
} from "@petrina/orchestrator";
import {
  deliveryLines,
  MaintenanceProfileProblem,
  notReady,
  ToolProblem,
  type RuntimeTask,
} from "./engine-options.js";
import type { Kernel } from "./kernel.js";

export interface RaiseExtra {
  body?: string;
  options?: string[];
  detail?: string;
  toolId?: CheckId;
  toolProblem?: InboxItem["toolProblem"];
  reviewKey?: string;
  stageId?: Id | null;
}

const UNRESOLVED_REVIEW_EXPLANATION = [
  "Review left Important findings open. Send the work back with a concrete repair request, or accept the unresolved review and continue to final verification.",
  "Continuing approves no delivery, fixes no finding and grants no automatic review rounds.",
  "Current product checks and required acceptance testing still run before a separate delivery approval.",
].join(" ");

export function raiseGate(
  kernel: Kernel,
  task: RuntimeTask,
  gate: GateKind,
  problem?: string,
  checks?: { title: string; body: string },
  decides?: Id | null,
): void {
  releaseAgentForDecision(task);
  const decision = beginYouStep(task, gate, Date.now());
  if (gate === "delivery" && task.proofRequests?.length) {
    decision.proofDecision = structuredClone(task.checkedProofDecision);
  }
  const reviewCall = gate === "delivery" && library.reviewDecisionPending(task);
  if (reviewCall) decision.work = "review-decision";
  if (gate === "delivery" && !decision.productChecks) {
    decision.productChecks = library.decisionEvidence(taskView(task));
  }
  // The decision keeps what it was asked about required acceptance that could not be verified.
  const gap = gate === "delivery" ? recordAcceptanceGap(taskView(task), decision, kernel.s.roles) : undefined;
  const gapText = gap ? acceptanceGapLines(taskView(task), gap, (productId) => kernel.productLabel(productId)) : "";
  const work = gate === "plan" ? task.proposedSource ?? executionFor(task).work.source : executionFor(task).work.source;
  const workLine = task.workRows || task.repositories
    ? (gate === "plan"
      ? task.workRows?.map((row) => [
        row.source ? workSummary(row.source) : row.choice.productId,
        row.choice.reason,
        row.error,
        row.addition ? `Will be added in ${row.addition.path}` : "",
      ].filter(Boolean).join("\n"))
      : task.repositories?.map((entry) => [
        entry.source ? workSummary(entry.source) : entry.productId,
        entry.report?.summary,
        entry.checks?.results.length
          ? library.checkProblem(entry) === "unverified"
            ? "Product checks unverified"
            : entry.checks.results.every((run) => run.ok)
              ? "Product checks passed"
              : "Product checks failed"
          : "Product checks: Not run",
        entry.releasePreview
          ? `Release ${entry.releasePreview.tag}: ${entry.releasePreview.notes}\nThis includes everything waiting on the default branch since the previous release.`
          : "",
      ].filter(Boolean).join("\n")))?.join("\n\n") ?? ""
    : work ? workSummary(work) : "";
  const body = gate === "design"
    ? callCheckBody(task)
    : gate === "delivery"
      ? [
        workLine,
        task.repositories
          ? [library.companionPreview(task.repositories), gapText].filter(Boolean).join("\n")
          : deliveryLines(taskView(task), gapText) ?? "",
      ].filter(Boolean).join("\n")
      : gate === "plan"
        ? [workLine, task.workError ?? ""].filter(Boolean).join("\n")
        : undefined;
  const explanation = [
    problem,
    checks?.body,
    reviewCall ? UNRESOLVED_REVIEW_EXPLANATION : undefined,
    body,
  ].filter(Boolean).join("\n\n");
  const proofBody = gate === "delivery" && task.proofRequests?.length
    ? [library.proofGap(taskView(task)), library.proofContext(task.proofRequests)].filter(Boolean).join("\n\n")
    : "";
  // A review decision is asked after the flow moved past its review: the check still decides that review.
  const stageId = decides !== undefined
    ? decides
    : reviewCall
      ? task.reviewDecision!.stageId
      : task.stageIndex >= 0
        ? task.plan?.stages[task.stageIndex]?.id
        : undefined;
  const combinedBody = [explanation, proofBody].filter(Boolean).join("\n\n");
  kernel.raise(task, gate, checks?.title ?? gateTitle(taskView(task), gate), false, {
    ...(combinedBody ? { body: combinedBody } : {}),
    ...(stageId !== undefined ? { stageId } : {}),
  });
  task.statusLine = problem ? "Delivery preparation needs you" : gateStatus(taskView(task), gate);
  task.column = gate === "plan" ? "planning" : gate === "design" ? "designing" : "ready";
  // On disk before the window shows it: an answer to this check must find it after any restart.
  kernel.commitNow();
}

export function raiseInboxItem(
  kernel: Kernel,
  target: RuntimeTask | RepositoryContext,
  kind: InboxKind,
  title: string,
  blocking: boolean,
  extra: RaiseExtra = {},
  by?: { roleId: Id; profileId: Id },
): Id {
  const scope = executionOf(target);
  const { task, work: repository } = scope;
  by ??= task.agent;
  const id = kernel.id("inbox");
  task.state = "needs-you";
  kernel.s.inbox.push({
    ...(task.repositories && ["guide", "learnings", "shipping", "stuck"].includes(kind)
      ? { productId: repository.productId }
      : {}),
    id,
    taskId: task.id,
    kind,
    title,
    at: Date.now(),
    blocking,
    ...(by ? { roleId: by.roleId, profileId: by.profileId } : {}),
    ...(extra.body ? { body: extra.body } : {}),
    ...(extra.options ? { options: extra.options } : {}),
    ...(extra.detail ? { detail: extra.detail } : {}),
    ...(extra.toolId ? { toolId: extra.toolId } : {}),
    ...(extra.toolProblem ? { toolProblem: extra.toolProblem } : {}),
    ...(extra.reviewKey ? { reviewKey: extra.reviewKey } : {}),
    ...(extra.stageId !== undefined ? { stageId: extra.stageId } : {}),
  });
  kernel.tracking.asked(scope, kernel.s.inbox.at(-1)!);
  // Offers let the caller carry on; only a decision that stops work yields its resources.
  if (kind !== "learnings" && kind !== "guide") kernel.onCoordinatorWait?.(task);
  return id;
}

export function failTask(kernel: Kernel, taskId: Id, error: unknown): void {
  const task = kernel.task(taskId);
  const scope = task ? executionFor(task) : undefined;
  if (!task) return;
  kernel.stepOwnership.failed(scope!);
  kernel.stopHelpers(taskId);
  delete task.helpers;
  const message = error instanceof Error ? error.message : String(error);
  kernel.tracking.failed(task, error);
  delete task.agent;
  delete task.capacityResume;
  delete task.capacityRetries;
  delete task.capacityPaused;
  delete scope!.work.conversation;
  kernel.discardScreenTurns(task);
  kernel.releaseScreen(task);
  kernel.stopStep(task);
  task.holdsSlot = false;
  const published = task.repositories?.filter((work) => library.repositoryPublished(work)).length ?? 0;
  task.state = published || error instanceof MaintenanceProfileProblem ? "needs-you" : "failed";
  task.error = message;
  task.statusLine = published
    ? `Delivery needs you · ${published} of ${task.repositories!.length} delivered`
    : error instanceof MaintenanceProfileProblem
      ? "Waiting for confirmed maintenance settings. Check the tool, then try again."
      : "Stuck. Needs you";
  kernel.dropBlockingItems(taskId);
  // What went wrong belongs to the step that got stuck (an agent's, or Petrina's own); then the task waits for the coordinator.
  if (openStep(task)?.kind !== "you") {
    endOpenStep(task, { outcome: JOURNEY_WORDS.stuck, reason: message, tone: "stuck", end: "failed" }, Date.now());
  }
  if (error instanceof ToolProblem) {
    // Named, with its fix in one sentence; what the tool said stays behind Details.
    const name = CHECK_NAMES[error.toolId];
    const kind = notReady(error.status as CheckStatus)
      ? (error.status as "not-installed" | "logged-out")
      : "wont-start";
    const problem = kind === "not-installed"
      ? `${name} isn't installed`
      : kind === "logged-out"
        ? `${name} isn't logged in`
        : `${name} wouldn't start`;
    const platform = kernel.s.setup?.platform ?? "linux";
    const fix = kind === "wont-start"
      ? wontStartFix(error.toolId, platform)
      : fixFor(error.toolId, kind, platform);
    task.statusLine = `Stuck: ${problem}`;
    kernel.log(task, "warn", `Stuck: ${problem}`);
    beginYouStep(task, "stuck", Date.now());
    kernel.raise(task, "stuck", `${problem}, so “${task.title}” is stuck`, false, {
      ...(fix ? { body: fix.sentence } : {}),
      ...(kind === "wont-start" ? { detail: message.slice(0, 600) } : {}),
      toolId: error.toolId,
      toolProblem: kind,
    });
  } else {
    kernel.log(task, "warn", `Stuck: ${message.slice(0, 300)}`);
    beginYouStep(task, "stuck", Date.now());
    kernel.raise(task, "stuck", `“${task.title}” is stuck`, false, { body: message.slice(0, 600) });
  }
  task.state = published || error instanceof MaintenanceProfileProblem ? "needs-you" : "failed";
  kernel.commit();
}

export function checkStageOf(task: RuntimeTask, item: InboxItem): Id | null | undefined {
  if (item.stageId !== undefined) return item.stageId;
  if (item.kind !== "delivery") return undefined;
  if (library.reviewDecisionPending(task)) return task.reviewDecision!.stageId;
  const stage = task.plan?.stages[task.stageIndex];
  return stage?.kind === "gate" && stage.gate === "delivery" ? undefined : null;
}

export function rememberCoordinatorNote(
  kernel: Kernel,
  task: RuntimeTask,
  text: string,
  id?: Id,
  kind?: InboxKind,
  stageId?: Id | null,
): void {
  // While a check waits, anything the coordinator says belongs to the stage it decides, not a later one, which has not run.
  if (stageId === undefined) {
    const waiting = kernel.s.inbox.find((item) => item.taskId === task.id && (item.stageId !== undefined || item.kind === "delivery"));
    stageId = waiting ? kernel.checkStage(task, waiting) : library.reviewDecisionPending(task) ? task.reviewDecision!.stageId : undefined;
  }
  const stage = stageId === undefined
    ? task.plan?.stages[task.stageIndex]
    : task.plan?.stages.find((entry) => entry.id === stageId);
  // An unknown decided stage, or one no longer in the plan, stays unrecorded rather than named after the current one.
  if (stageId !== undefined && !stage) {
    task.notes = [...(task.notes ?? []), { at: Date.now(), text, ...(id ? { id } : {}) }];
    return;
  }
  const roleId = stageId === undefined
    ? task.agent?.roleId ?? (stage?.kind === "converge" && task.sub > 0 ? stage.reviewerRoleId : stage?.roleId)
    : stage?.roleId;
  const roleName = roleId ? kernel.role(roleId, task)?.name : undefined;
  const origin = {
    stageTitle: stage?.title ?? (task.startedAt === undefined ? "Before work started" : "Planning"),
    ...(stage ? { stageId: stage.id } : {}),
    ...(roleName ? { roleName } : {}),
    ...(kind ? { kind } : {}),
  };
  task.notes = [...(task.notes ?? []), { at: Date.now(), text, origin, ...(id ? { id } : {}) }];
}

export function showParallelReviewWork(task: RuntimeTask): void {
  const agents = [task.agent, ...(task.helpers ?? [])].filter(
    (agent): agent is DeepMutable<ActiveAgent> => agent?.reviewKey !== undefined,
  );
  if (!agents.length) return;
  const working = (agent: (typeof agents)[number]) => task.hunt?.work?.[agent.reviewKey!];
  const agent = agents.find((entry) => working(entry)?.waiting)
    ?? agents.find((entry) => working(entry)?.retrying)
    ?? agents.find((entry) => working(entry))
    ?? agents[0]!;
  task.agent = agent;
  const helpers = agents.filter((entry) => entry !== agent);
  if (helpers.length) task.helpers = helpers;
  else delete task.helpers;
  const work = working(agent);
  const before = task.retrying;
  // Working now: its clock runs, and it neither waits for the coordinator nor retries. A capacity wait pauses the clock.
  const continuing = helpers.some((entry) => {
    const other = working(entry);
    return !!other && !other.waiting && !other.retrying && other.clock?.since !== undefined;
  });
  if (work?.retrying && !work.waiting) {
    task.retrying = continuing ? `${work.retrying} ${OTHERS_CONTINUE}` : work.retrying;
  } else {
    delete task.retrying;
  }
  if (work?.toolActivity) task.toolActivity = work.toolActivity;
  else delete task.toolActivity;
  if (work?.todo) task.todo = work.todo;
  else delete task.todo;
  if (work?.clock) task.stepClock = work.clock;
  else delete task.stepClock;
  if (task.state === "running" && (task.retrying ?? work?.activity)) {
    task.statusLine = task.retrying ?? work!.activity!;
  } else if (task.state === "running" && before !== undefined && task.statusLine === before) {
    // The retry ended before this member's first tool call: its words do not stay on as the latest action.
    task.statusLine = "Continuing work";
  } else if (task.state === "needs-you" && work?.waiting) {
    task.statusLine = work.waiting;
  }
}

export function finishParallelReviewWork(kernel: Kernel, task: RuntimeTask, key: string): void {
  const work = task.hunt?.work?.[key];
  if (work?.clock && work.attempts === 1) {
    task.steps = [...(task.steps ?? []), stepRecord(work.clock, Date.now())].slice(-MAX_STEP_RECORDS);
  }
  if (task.hunt?.work) delete task.hunt.work[key];
  kernel.showReviewWork(task);
}
