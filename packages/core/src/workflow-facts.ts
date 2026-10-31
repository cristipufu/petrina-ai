// Compact workflow facts projected from journey, inbox and delivery records.
// Routine tool actions, streamed text, progress wording and clocks stay out, so an unchanged save produces nothing.

import { exhaustedAcceptanceFailure } from "./acceptance.js";
import { CHECK_WORDS, checkActivityLine, checkReasonWords, inCheckLine, type CheckActivity } from "./check-activity.js";
import { findingKind } from "./findings.js";
import { checkSetupOutcome } from "./check-environment.js";
import { checkCounts, checkEntryResult } from "./check-evidence.js";
import { checkOutcome } from "./check-outcome.js";
import { historyItem, historyStatus } from "./history.js";
import { landingOf, stepName, type Landing } from "./journey-words.js";
import type { Finding, Id, JourneyAgentInput, JourneyStep, Role, Task, TaskState } from "./model.js";
import { publishingResult } from "./publishing-result.js";
import { assignedProducts, displayTask, landingState, taskProductIds } from "./repositories.js";
import { roleForTask } from "./roles.js";
import { runtimeWaitView, runtimeWaitWords } from "./runtime-wait.js";
import {
  clip,
  EVENT_MANIFEST_ENTRIES,
  type AskFacts,
  type CheckFacts,
  type NodeFacts,
  type SeatInputFacts,
  type SeatResultFacts,
  type WaitKind,
  type WorkflowContext,
  type WorkflowEvent,
  type WorkflowFacts,
  type WorkflowWorkRecord as Work,
} from "./workflow-fact-types.js";

export * from "./workflow-fact-types.js";

function waitKindOf(task: TaskState, ctx: WorkflowContext): WaitKind | undefined {
  const waiting = task.state === "waiting" || (task.state === "queued" && task.statusLine.startsWith("Waiting for “"));
  const wait = waiting ? runtimeWaitView(task, ctx.findTask ?? (() => undefined)) : undefined;
  if (wait?.held) return wait.decisionNeeded ? "needs-your-decision" : "dependencies";
  // A run in the check line keeps its task running: its structured fact, never its words, names the wait.
  if (inCheckLine(task.checkActivity) && (task.state === "running" || task.state === "waiting")) return "checks";
  if (!waiting) return undefined;
  const now = ctx.now;
  if (task.capacityPaused?.length || task.modelCapacity?.some((entry) => entry.until > now)) return "capacity";
  const line = task.statusLine;
  if (line.startsWith("Waiting for usage") || (ctx.limited?.length && /usage|limit/i.test(line))) return "usage";
  if (line.startsWith("Waiting for “")) return "dependencies";
  if (line.startsWith("Waiting for the pool to resume") || line.startsWith("Waiting: Petrina is")) return "pool";
  if (line.startsWith(CHECK_WORDS.recovery)) return "checks";
  if (line.startsWith("Waiting for room to prepare")) return "preparation";
  if (line.startsWith("Waiting for a free")) return "slot";
  if (/^Checking .+ before (returning to its saved conversation|the Builder returns)$/.test(line)) return "readiness";
  return "other";
}

/** The seat an input or result belongs to, independent of a usage stand-in: the reviewer position, the vote place (older records: the voter's planned profile), or the role. */
export function seatOf(entry: Pick<JourneyAgentInput, "roleId" | "profileId" | "reviewerKey" | "requestedProfileId" | "place">, roles: WorkflowContext["roles"], task?: Pick<TaskState, "maintenance">): string {
  if (entry.reviewerKey !== undefined) return `reviewer:${entry.reviewerKey}`;
  const role = roleForTask(roles, entry.roleId, task);
  if (role?.result === "votes") return `verifier:${entry.place ?? entry.requestedProfileId ?? entry.profileId}`;
  return entry.roleId;
}

/** A result's recorded input identifies its seat even when peers share a role and profile. Ambiguous older records stay unavailable. */
export function resultSeatOf(step: JourneyStep, result: NonNullable<JourneyStep["agentResults"]>[number], roles: WorkflowContext["roles"], task?: Pick<TaskState, "maintenance">): string | undefined {
  if (result.inputIndex !== undefined) {
    const input = step.agentInputs?.[result.inputIndex];
    return input && input.roleId === result.roleId && input.profileId === result.profileId ? seatOf(input, roles, task) : undefined;
  }
  const inputs = (step.agentInputs ?? []).filter((input) => input.roleId === result.roleId && input.profileId === result.profileId && (input.at ?? 0) <= result.at);
  const seats = new Set(inputs.map((input) => seatOf(input, roles, task)));
  return seats.size > 1 ? undefined : seats.values().next().value ?? seatOf(result, roles, task);
}

/** A short plain description of what a result handed back, by the role's result kind. */
function resultSummary(value: unknown, result: Role["result"] | undefined): string {
  const v = (value ?? {}) as Record<string, unknown>;
  const text = (key: string) => (typeof v[key] === "string" ? (v[key] as string) : undefined);
  const count = (key: string) => (Array.isArray(v[key]) ? (v[key] as unknown[]).length : 0);
  switch (result) {
    case "findings": return `${count("findings")} finding${count("findings") === 1 ? "" : "s"} raised, ${count("confirms")} confirmed, ${count("disputes")} disputed; verdict ${text("verdict") ?? "unreported"}`;
    case "votes": return `${count("verdicts")} verdict${count("verdicts") === 1 ? "" : "s"}`;
    case "checks": {
      const checks = Array.isArray(v.checks) ? (v.checks as { result?: string }[]) : [];
      const tally = (kind: string) => checks.filter((check) => check.result === kind).length;
      return `${tally("pass")} pass, ${tally("fail")} fail, ${tally("blocked")} could not be verified${text("summary") ? `: ${text("summary")}` : ""}`;
    }
    case "objections": return `${count("objections")} objection${count("objections") === 1 ? "" : "s"}`;
    case "brief": return text("summary") ?? "brief";
    case "plan": return `plan with ${Array.isArray(v.stages) ? (v.stages as unknown[]).length : 0} stages`;
    default: return text("summary") ?? text("notes") ?? "result handed back";
  }
}

function nodeFacts(step: JourneyStep, index: number, journey: readonly JourneyStep[], task: TaskState, ctx: WorkflowContext): NodeFacts {
  const role = step.roleId ? roleForTask(ctx.roles, step.roleId, task) : undefined;
  const seats = new Map<string, number>();
  const inputs: SeatInputFacts[] = (step.agentInputs ?? []).map((input, position) => {
    const seat = seatOf(input, ctx.roles, task);
    const attempt = (seats.get(seat) ?? 0) + 1;
    seats.set(seat, attempt);
    return {
      index: position, seat, attempt, at: input.at, roleId: input.roleId, profileId: input.profileId,
      ...(input.productId ? { productId: input.productId } : {}), ...(input.stepAttempts !== undefined ? { stepAttempts: input.stepAttempts } : {}), ...(input.versions ? { versions: input.versions } : {}), ...(input.reviewInput ? { reviewInput: input.reviewInput } : {}),
      ...(input.reviewerKey !== undefined ? { reviewerKey: input.reviewerKey } : {}),
      ...(input.requestedProfileId ? { requestedProfileId: input.requestedProfileId } : {}),
      ...(input.selectionReason ? { selectionReason: input.selectionReason } : {}),
      mode: input.resumed ? "resumed" : input.mode,
      ...(input.confirmedSettings ? { confirmedSettings: input.confirmedSettings } : {}),
      ...(input.exact ? { exact: input.exact } : {}),
      ...(input.manifest ? { manifest: input.manifest.slice(0, EVENT_MANIFEST_ENTRIES), manifestTotal: input.manifest.length } : {}),
      ...(input.freshReason ? { freshReason: input.freshReason } : {}),
      ...(input.readiness ? { readiness: input.readiness } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      taskDescription: input.taskDescription !== undefined,
      updates: input.updates?.length ?? 0,
    };
  });
  const results: SeatResultFacts[] = (step.agentResults ?? []).map((entry, position) => ({
    index: position, seat: resultSeatOf(step, entry, ctx.roles, task), ...(entry.inputIndex !== undefined ? { inputIndex: entry.inputIndex } : {}),
    roleId: entry.roleId, profileId: entry.profileId, at: entry.at,
    ...(entry.productId ? { productId: entry.productId } : {}),
    ...(entry.versions ? { versions: entry.versions } : {}),
    ...(entry.findings ? { findingCopies: entry.findings.length, findingIds: entry.findings.map((finding) => finding.id) } : {}),
    summary: clip(resultSummary(entry.value, role?.result))!,
    ...(entry.images?.length ? { images: entry.images.length } : {}),
  }));
  // Only executions are check facts. Evidence copies (a reuse handoff's entries, a decision's supporting snapshot)
  // keep their original positions out of the event stream: the reuse is already recorded on the step that ran them.
  const copies = step.kind === "you" || step.work === "check-reuse";
  const checks: CheckFacts[] = (step.productChecks ?? []).flatMap((check, position) => copies || check.reusedAt !== undefined ? [] : [{
    index: position,
    ...(check.id ? { id: check.id } : {}), ...(check.attemptId ? { attemptId: check.attemptId } : {}),
    name: check.name, result: checkEntryResult(check),
    ...(checkEntryResult(check) !== check.result ? { reportedResult: check.result } : {}),
    ...(check.startedAt !== undefined ? { startedAt: check.startedAt } : {}), ...(check.endedAt !== undefined ? { endedAt: check.endedAt } : {}), ...(check.queuedAt !== undefined ? { queuedAt: check.queuedAt } : {}),
    ...(check.productId ? { productId: check.productId } : {}),
    ...(check.run ? {
      ok: check.run.ok,
      ...([
      "pending",
      "running",
      "skipped",
      "stopped"
    ].includes(check.result) ? { previousRunOutcome: checkOutcome(check.run) } : { commandOutcome: checkOutcome(check.run) }),
      ms: check.run.ms,
      logRecorded: !!check.run.logPath,
      ...(check.run.logComplete !== undefined ? { logComplete: check.run.logComplete } : {})
    } : {}),
    ...(check.detail ? { detail: clip(check.detail, 300) } : {}),
  }]);
  const asks: AskFacts[] = (step.asks ?? []).map((ask) => ({
    id: ask.id,
    kind: ask.kind,
    title: clip(
    ask.title,
    200
  )!,
    at: ask.at,
    ...(ask.endedAt !== undefined ? { endedAt: ask.endedAt } : {}),
    ...(ask.how ? { how: ask.how } : {}),
    ...(ask.answer ? { answer: clip(
    ask.answer,
    300
  ) } : {})
  }));
  const acceptance = step.acceptanceChecks ? {
    pass: step.acceptanceChecks.filter((check) => check.result === "pass").length,
    fail: step.acceptanceChecks.filter((check) => check.result === "fail").length,
    blocked: step.acceptanceChecks.filter((check) => check.result === "blocked").length
  } : undefined;
  return {
    index, id: step.id, name: stepName(step, journey.slice(0, index), ctx.roles), kind: step.kind,
    ...(step.reviewInput ? { reviewInput: step.reviewInput } : {}),
    ...(step.roleId ? { roleId: step.roleId } : {}), ...(step.profileId ? { profileId: step.profileId } : {}), ...(step.team ? { team: step.team } : {}), ...(step.seats?.length ? { seats: step.seats } : {}),
    ...(step.stageId ? { stageId: step.stageId } : {}), round: step.round, sub: step.sub,
    ...(step.fixing ? { fixing: true } : {}), ...(step.update ? { update: true } : {}), ...(step.port ? { port: true } : {}), ...(step.call ? { call: true } : {}),
    ...(step.work ? { work: step.work } : {}), ...(step.waitsFor ? { waitsFor: step.waitsFor } : {}), ...(step.waitsOn ? { waitsOn: step.waitsOn } : {}),
    startedAt: step.startedAt, ...(step.endedAt !== undefined ? { endedAt: step.endedAt } : {}), ...(step.end ? { end: step.end } : {}),
    ...(step.outcome ? { outcome: step.outcome } : {}), ...(step.reason ? { reason: step.reason } : {}), ...(step.tone ? { tone: step.tone } : {}),
    ...(step.trigger ? { trigger: step.trigger } : {}),
    ...(step.checkReasons?.length ? { checkReasons: step.checkReasons.map((reason) => ({ ...reason, words: checkReasonWords(reason) })) } : {}),
    ...(step.builderConversation ? { builderConversation: step.builderConversation } : {}), ...(step.legacy ? { legacy: true } : {}),
    inputs, results, checks, ...(step.work === "check-reuse" && step.productChecks ? { reusedFailed: checkCounts(step.productChecks).failed } : {}), asks, ...(acceptance ? { acceptance } : {}),
    ...(step.checkSetups?.length ? { localSetup: { count: step.checkSetups.length, omittedEarlier: Math.max(
      0,
      step.checkSetups.length - EVENT_MANIFEST_ENTRIES
    ),
      attempts: step.checkSetups.slice(-EVENT_MANIFEST_ENTRIES).map(attempt => ({ id: attempt.id, productId: attempt.productId, position: attempt.position,
        state: checkSetupOutcome(attempt).kind, ...(attempt.endedAt !== undefined ? { endedAt: attempt.endedAt } : {}) })) } } : {}),
    checked: (step.checkAttempts ?? []).map(({ id, commands: _commands, ...version }) => ({ attemptId: id, ...version })), reuses: step.reuses ?? [],
    ...(step.findingIds ? { findingIds: step.findingIds } : {}),
    resultFindings: (step.result?.findings ?? []).map((finding) => ({ id: finding.id, status: finding.status, severity: finding.severity })),
    ...(role?.result === "findings" ? { reviewSteps: reviewRoundSteps(task, step.id, ctx.roles).map(entry => entry.id) } : {}),
    ...(step.result?.findingsSettled ? { findingsSettled: true } : {}),
    ...(step.result?.findingsSettled && step.result.findingChanges ? { findingChanges: step.result.findingChanges } : {}),
  };
}

function checkWaitFacts(activity: CheckActivity): NonNullable<WorkflowFacts["checkWait"]> {
  const { since: _since, running: _running, ...rest } = activity;
  return { ...rest, line: checkActivityLine(activity) };
}

/** The compact facts the event log watches for one task. Everything volatile stays out. */
export function workflowFacts(task: TaskState, ctx: WorkflowContext): WorkflowFacts {
  const view = displayTask(task);
  const works: readonly Work[] = task.repositories ?? (task.repository ? [task.repository] : []);
  // A shipping question interrupts the product it names; one without a product (a single product, or an older record) applies to all.
  const interrupted = (work: Work) => ctx.inbox.some((item) => item.taskId === task.id && item.kind === "shipping" && (item.productId === undefined || item.productId === work.productId));
  const productName = (id: Id) => ctx.products.find((product) => product.id === id)?.name ?? (task.repositories?.find((work) => work.productId === id)?.source?.product.name) ?? id;
  const journey = task.journey ?? [];
  const finished = task.state === "done" || task.state === "cancelled";
  const shared = task.repositories ? landingState(task.repositories) : undefined;
  const results = works.map((work) => publishingResult(task, work, interrupted(work)));
  const landing: Landing = task.state === "cancelled" ? "cancelled" : results.some((result) => result.kind === "unconfirmed") ? "marked-done"
    : shared ? shared === "landed" ? "landed" : shared === "waiting" ? "awaiting-merge" : "open"
    : results.some((result) => result.kind === "local-unpushed") ? "open" : landingOf(view);
  const wait = runtimeWaitView(task, ctx.findTask ?? (() => undefined));
  return {
    id: task.id, title: task.title, productIds: taskProductIds(task), state: task.state, column: task.column, held: task.held,
    stageIndex: task.stageIndex, sub: task.sub, fixing: task.fixing,
    ...(task.startedAt !== undefined ? { startedAt: task.startedAt } : {}), ...(task.finishedAt !== undefined ? { finishedAt: task.finishedAt } : {}),
    ...(task.combinedInto ? { combinedInto: task.combinedInto } : {}), ...(task.combinedFrom ? { combinedFrom: task.combinedFrom } : {}),
    ...(task.error ? { error: clip(task.error) } : {}),
    ...((kind) => (kind ? { waitKind: kind } : {}))(waitKindOf(task, ctx)),
    ...(wait ? { runtimeWait: {
      held: wait.held,
      decisionNeeded: wait.decisionNeeded,
      reason: wait.reason,
      prerequisites: wait.prerequisites,
      phase: wait.phase
    } } : {}),
    // A held prerequisite wait is described by its own record, never by a status line left from an earlier wait.
    statusLine: wait?.held && task.state === "waiting" ? runtimeWaitWords(wait) : task.statusLine,
    ...(task.checkActivity && inCheckLine(task.checkActivity) ? { checkWait: checkWaitFacts(task.checkActivity) } : {}),
    agents: [
      task.agent,
      ...(task.helpers ?? [])
    ].flatMap((agent) => (agent ? [{
      roleId: agent.roleId,
      profileId: agent.profileId,
      ...(agent.reviewKey ? { reviewKey: agent.reviewKey } : {}),
      since: agent.since
    }] : [])),
    nodes: journey.map((step, index) => nodeFacts(step, index, journey, task, ctx)),
    inbox: ctx.inbox.filter((item) => item.taskId === task.id).map((item) => ({
      id: item.id,
      kind: item.kind,
      title: clip(
      item.title,
      200
    )!,
      at: item.at,
      blocking: item.blocking,
      ...(item.reviewKey ? { reviewKey: item.reviewKey } : {}),
      ...(item.roleId ? { roleId: item.roleId } : {}),
      ...(item.profileId ? { profileId: item.profileId } : {}),
      ...(item.productId ? { productId: item.productId } : {})
    })),
    works: works.map((work, index) => ({
      productId: work.productId, productName: productName(work.productId), delivery: work.delivery,
      result: results[index]!,
      ...(work.checks ? { checks: {
        at: work.checks.at,
        ...(work.checks.sha ? { sha: work.checks.sha } : {}),
        ...(work.checks.tree ? { tree: work.checks.tree } : {}),
        ...(work.checks.definition ? { definition: work.checks.definition } : {}),
        ...(work.checks.current !== undefined ? { current: work.checks.current } : {}),
        passed: work.checks.results.every((run) => checkOutcome(run).kind === "passed"),
        count: work.checks.results.length,
        ...(work.checks.provenance ? {
        node: work.checks.provenance.nodeId,
        attemptId: work.checks.provenance.attemptId
      } : {})
      } } : {}),
      checkReturns: work.checkReturns ?? 0, acceptanceReturns: work.acceptanceReturns ?? 0, stepAttempts: work.stepAttempts ?? 0,
      ...(work.baseSha ? { baseSha: work.baseSha } : {}), ...(work.reviewedSha ? { reviewedSha: work.reviewedSha } : {}), ...(work.reviewedTree ? { reviewedTree: work.reviewedTree } : {}),
      ...(work.approvedFor ? { approvedFor: work.approvedFor } : {}), ...(work.cleanup ? { cleanup: work.cleanup } : {}),
    })),
    findings: task.findings.map((finding) => ({
      id: finding.id,
      text: clip(
      finding.text,
      160
    )!,
      ...(finding.tracking ? { tracking: finding.tracking } : {}),
      status: finding.status,
      severity: finding.severity,
      raisedBy: finding.raisedBy,
      ...(finding.roleId ? { roleId: finding.roleId } : {}),
      ...(finding.reopenedAt !== undefined ? { reopenedAt: finding.reopenedAt } : {}),
      ...(finding.answer ? {
      answerFixed: finding.answer.fixed,
      answerAt: finding.answer.at
    } : {}),
      confirmed: finding.confirmedBy.length,
      ...(finding.verification ? { verdict: finding.verification.verdict } : {}),
      productIds: assignedProducts(
      task as Task,
      finding.productIds
    ),
      evidence: !!finding.evidence,
      ...(exhaustedAcceptanceFailure(
      task as Task,
      finding
    ) ? { held: true as const } : {})
    })),
    capacityRetries: (task.capacityRetries ?? []).map((entry) => ({ key: `${entry.roleId}|${entry.profileId}|${entry.member ?? ""}`, tried: entry.tried })),
    landing,
    ...(shared ? { shared } : {}),
    ...(finished ? { history: historyStatus(historyItem(view)) } : {}),
    ...(task.repair ? { repair: task.repair } : {}),
  };
}

/**
 * A review step's seats are positions, not participants. The engine records the positions a step expects a result
 * from as it admits participants (`seats`: a round's reviewer places, a vote's electorate), so a planned seat whose
 * tool never started is still a seat without a result, and a replacement is another attempt on the seat it replaced.
 * An older record without them is read from what it holds: every seat that recorded an input, plus each team
 * member no input names as its participant or as the planned profile it stood in for. A record without inputs
 * holds one seat.
 */
type ReviewProgress = Pick<JourneyStep, "endedAt" | "team" | "seats"> & {
  findingsSettled?: true;
  inputs: readonly Pick<SeatInputFacts, "seat" | "profileId" | "requestedProfileId">[];
  results: readonly { seat?: string }[];
};

function reviewSeats(node: Pick<ReviewProgress, "inputs" | "team" | "seats">): { expected?: readonly string[]; count: number } {
  if (node.seats?.length) return { expected: node.seats, count: node.seats.length };
  const recorded = new Set(node.inputs.map((input) => input.seat));
  const named = new Set(node.inputs.flatMap((input) => [input.profileId, ...(input.requestedProfileId ? [input.requestedProfileId] : [])]));
  const unstarted = (node.team ?? []).filter((profileId) => !named.has(profileId)).length;
  return { count: Math.max(recorded.size + unstarted, 1) };
}

/**
 * A completed examination ends after every expected seat reported. A settled copy records the engine's proof
 * that the whole group reported, even across retry-split steps. Otherwise only the hand-backs on this step
 * prove completion. Ending words never prove it, and an open step is not a finished examination. This same
 * rule governs summaries and prior claims; acceptedResults counts the hand-backs saved on this step alone.
 */
export function reviewEnd(node: ReviewProgress): { examined: boolean; acceptedResults: number; seats: number } {
  const { expected, count } = reviewSeats(node);
  // A result whose seat an older record cannot name still covers one position.
  const covered = new Set(node.results.flatMap((result) => (result.seat !== undefined ? [result.seat] : [])));
  const unplaced = node.results.filter((result) => result.seat === undefined).length;
  const complete = expected ? expected.filter((seat) => !covered.has(seat)).length <= unplaced : covered.size + unplaced >= count;
  return { examined: node.endedAt !== undefined && (node.findingsSettled === true || complete), acceptedResults: node.results.length, seats: count };
}

/** Reviewer steps in one examination, including accepted work kept through Try again, never an earlier completed round. */
export function reviewRoundSteps(task: Pick<Task, "journey" | "maintenance">, nodeId: Id, roles: WorkflowContext["roles"]): readonly JourneyStep[] {
  const steps = task.journey ?? [];
  const index = steps.findIndex(step => step.id === nodeId);
  const current = steps[index];
  if (!current || current.kind !== "agent" || roles.find(role => role.id === current.roleId)?.result !== "findings") return current ? [current] : [];
  const group = [current];
  for (let i = index - 1; i >= 0; i--) {
    const step = steps[i]!;
    if (step.kind !== "agent") {
      if (step.kind === "petrina" && step.work === "checks") break;
      continue; // Stuck and Try again checkpoints retain the round's accepted work.
    }
    if (roles.find(role => role.id === step.roleId)?.result !== "findings" || step.stageId !== current.stageId || step.round !== current.round || step.reviewInput?.digest !== current.reviewInput?.digest) break;
    if (reviewEnd({
      ...step, findingsSettled: step.result?.findingsSettled,
      inputs: (step.agentInputs ?? []).map(input => ({ ...input, seat: seatOf(input, roles, task) })),
      results: (step.agentResults ?? []).map(result => ({ seat: resultSeatOf(step, result, roles, task) })),
    }).examined) break;
    group.unshift(step);
  }
  return group;
}

/** A Builder's claim about an acceptance failure is tested by the next acceptance run, never by a review after it. */
const testedByAcceptance = (finding: Pick<Finding, "text"> & { kind?: Finding["kind"]; raisedBy?: string }, at: number, tested: number) =>
  findingKind(finding) === "acceptance-failed" && at <= tested;

/**
 * Claims not yet examined by an earlier completed review, using the same completion rule as its event. A claim about an
 * acceptance failure that a completed acceptance run already tested is that run's, not the review's.
 */
export function reviewClaimIds(task: Pick<Task, "journey" | "findings" | "maintenance">, nodeId: Id, roles: WorkflowContext["roles"]): Id[] {
  const steps = task.journey ?? [];
  const index = steps.findIndex(step => step.id === nodeId);
  const prior = steps.slice(0, index < 0 ? steps.length : index);
  const reviewed = Math.max(-Infinity, ...prior.filter(step => step.kind === "agent" && roles.find(role => role.id === step.roleId)?.result === "findings" && reviewEnd({
    ...step,
    findingsSettled: step.result?.findingsSettled,
    inputs: (step.agentInputs ?? []).map(input => ({ ...input, seat: seatOf(input, roles, task) })),
    results: (step.agentResults ?? []).map(result => ({ seat: resultSeatOf(step, result, roles, task) })),
  }).examined).map(step => step.endedAt!));
  const tested = Math.max(
    -Infinity,
    ...prior.filter(step => step.kind === "agent" && step.endedAt !== undefined && step.acceptanceChecks !== undefined).map(step => step.endedAt!)
  );
  return task.findings.filter(finding => finding.answer?.fixed && (finding.answer.at ?? 0) > reviewed && !testedByAcceptance(
    finding,
    finding.answer.at ?? 0,
    tested
  )).map(finding => finding.id);
}

/**
 * The Builder's fix claims a review examines: claims made since the last completed review, whatever status
 * the claim already gave the finding. Claims an earlier review, or for an acceptance failure an earlier completed
 * acceptance run, already examined are not under test again.
 */
export function claimsUnderTest(facts: Pick<WorkflowFacts, "nodes" | "findings">, node: Pick<NodeFacts, "index">, roles: WorkflowContext["roles"]): Id[] {
  const reviewed = Math.max(
    -Infinity,
    ...facts.nodes.filter((entry) => entry.index < node.index && entry.kind === "agent" && reviewEnd(entry).examined && roles.find((role) => role.id === entry.roleId)?.result === "findings").map((entry) => entry.endedAt!)
  );
  const tested = Math.max(
    -Infinity,
    ...facts.nodes.filter((entry) => entry.index < node.index && entry.acceptance !== undefined && entry.endedAt !== undefined).map((entry) => entry.endedAt!)
  );
  return facts.findings.filter((finding) => finding.answerFixed && (finding.answerAt ?? 0) > reviewed && !testedByAcceptance(
    finding,
    finding.answerAt ?? 0,
    tested
  )).map((finding) => finding.id);
}

/** Whether an event belongs to a product scope, including shared tasks that retain the product. */
export function eventInvolvesProduct(event: Pick<WorkflowEvent, "productIds" | "productId">, productId: Id): boolean {
  return event.productIds.includes(productId) || event.productId === productId;
}
