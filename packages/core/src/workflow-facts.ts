// Compact workflow facts projected from journey, inbox and delivery records.
// Routine tool actions, streamed text, progress wording and clocks stay out, so an unchanged save produces nothing.

import { checkSetupOutcome } from "./check-environment.js";
import type {
  AgentProfile,
  CheckAttemptEvidence,
  Finding,
  Id,
  InboxItem,
  InboxKind,
  InputManifestEntry,
  JourneyAgentInput,
  JourneyStep,
  Role,
  RunState,
  Task,
  TaskRepository,
  TaskState,
  UsageLimit
} from "./model.js";
import { JOURNEY_WORDS, landingOf, stepName, type Landing } from "./journey-words.js";
import { publishingResult, type PublishingResult } from "./publishing-result.js";
import { checkCounts, checkEntryResult } from "./check-evidence.js";
import { checkOutcome, type CheckOutcome } from "./check-outcome.js";
import { historyItem, historyStatus, type HistoryStatus } from "./history.js";
import { assignedProducts, displayTask, landingState, taskProductIds } from "./repositories.js";
import { roleForTask } from "./roles.js";
import { exhaustedAcceptanceFailure } from "./acceptance.js";
import { runtimeWaitView, type RuntimeWaitTask } from "./runtime-wait.js";

export const WORKFLOW_EVENT_KINDS = [
  "task.created", "task.state", "task.waiting", "task.finished",
  "node.started", "node.finished", "seat.started", "seat.finished",
  "extra.queued", "extra.started", "extra.stopping", "extra.held", "extra.finished",
  "check.queued", "check.started", "check.finished", "check.reused",
  "coordinator.request", "coordinator.decision",
  "repair.returned", "retry", "profile.replaced", "review.finished", "publishing.result",
] as const;
export type WorkflowEventKind = (typeof WORKFLOW_EVENT_KINDS)[number];

/** An event before the log assigns its identity and order. */
export interface WorkflowEventDraft {
  at: number;
  kind: WorkflowEventKind;
  taskId: Id;
  productIds: readonly Id[];
  productId?: Id;
  nodeId?: Id;
  seat?: string;
  attempt?: number;
  /** One plain-language line: what happened and why. */
  summary: string;
  /** The recorded step, check or decision that led here. */
  cause?: { nodeId?: Id; reason?: string; kind?: string };
  /** Focused evidence reads that select exactly this event's input, result, check or finding copy. */
  refs?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface WorkflowEvent extends WorkflowEventDraft {
  id: string;
  seq: number;
  /** The engine run that recorded it; a different run means lost continuity. */
  run: string;
}

export interface WorkflowContext {
  roles: readonly Pick<Role, "id" | "name" | "result">[];
  profiles: readonly Pick<AgentProfile, "id" | "toolId" | "model">[];
  inbox: readonly InboxItem[];
  products: readonly { id: Id; name: string }[];
  limited?: readonly UsageLimit[];
  now: number;
  /** Focused lookup also reads prerequisite landing records retained in History. */
  findTask?: (id: Id) => RuntimeWaitTask | undefined;
}

/** How many manifest entries and finding ids an event shows before pointing at the complete page. */
export const EVENT_MANIFEST_ENTRIES = 12;
export const EVENT_FINDING_IDS = 20;
const SUMMARY_CHARACTERS = 400;

export type WaitKind = "capacity" | "usage" | "slot" | "pool" | "dependencies" | "needs-your-decision" | "preparation" | "checks" | "readiness" | "other";

type Work = TaskRepository | NonNullable<TaskState["repository"]>;

export interface SeatInputFacts {
  productId?: Id;
  stepAttempts?: number;
  versions?: JourneyAgentInput["versions"];
  reviewInput?: JourneyAgentInput["reviewInput"];
  index: number;
  seat: string;
  attempt: number;
  at?: number;
  roleId: Id;
  profileId: Id;
  reviewerKey?: string;
  requestedProfileId?: Id;
  selectionReason?: string;
  mode: JourneyAgentInput["mode"] | "resumed";
  confirmedSettings?: JourneyAgentInput["confirmedSettings"];
  exact?: JourneyAgentInput["exact"];
  manifest?: readonly InputManifestEntry[];
  manifestTotal?: number;
  freshReason?: string;
  readiness?: JourneyAgentInput["readiness"];
  sessionId?: string;
  taskDescription: boolean;
  updates: number;
}
export interface SeatResultFacts {
  index: number;
  seat?: string;
  inputIndex?: number;
  roleId: Id;
  profileId: Id;
  at: number;
  productId?: Id;
  versions?: Readonly<Record<Id, string>>;
  findingCopies?: number;
  findingIds?: readonly Id[];
  summary: string;
  images?: number;
}
export interface CheckFacts {
  index: number;
  id?: string;
  attemptId?: string;
  name: string;
  result: string;
  startedAt?: number;
  endedAt?: number;
  queuedAt?: number;
  productId?: Id;
  /** Original reported flag; commandOutcome carries the recorded execution meaning. */
  ok?: boolean;
  commandOutcome?: CheckOutcome;
  previousRunOutcome?: CheckOutcome;
  reportedResult?: string;
  ms?: number;
  logComplete?: boolean;
  logRecorded?: boolean;
  detail?: string;
}
export interface AskFacts { id: Id; kind: string; title: string; at: number; endedAt?: number; how?: string; answer?: string }
export interface NodeFacts {
  reviewInput?: JourneyStep["reviewInput"];
  index: number;
  id: Id;
  name: string;
  kind: JourneyStep["kind"];
  roleId?: Id;
  profileId?: Id;
  team?: readonly Id[];
  seats?: readonly string[];
  stageId?: Id;
  round: number;
  sub: number;
  fixing?: boolean;
  update?: boolean;
  port?: boolean;
  call?: boolean;
  work?: string;
  waitsFor?: string;
  waitsOn?: readonly { id: Id; title: string }[];
  startedAt: number;
  endedAt?: number;
  end?: string;
  outcome?: string;
  reason?: string;
  tone?: string;
  trigger?: JourneyStep["trigger"];
  builderConversation?: string;
  legacy?: boolean;
  inputs: SeatInputFacts[];
  results: SeatResultFacts[];
  checks: CheckFacts[];
  /** A check-reuse handoff: how many of the copied checks it handed on as failed. */
  reusedFailed?: number;
  asks: AskFacts[];
  acceptance?: { pass: number; fail: number; blocked: number };
  localSetup?: { count: number; omittedEarlier: number; attempts: readonly { id: Id; productId: Id; position: string; state: string; endedAt?: number }[] };
  checked: readonly (Omit<CheckAttemptEvidence, "id" | "commands"> & { attemptId: string })[];
  reuses: NonNullable<JourneyStep["reuses"]>;
  findingIds?: readonly Id[];
  resultFindings: readonly { id: Id; status: string; severity: string }[];
  findingsSettled?: true;
  findingChanges?: NonNullable<JourneyStep["result"]>["findingChanges"];
  reviewSteps?: readonly Id[];
}
export interface InboxFacts { id: Id; kind: InboxKind; title: string; at: number; blocking: boolean; reviewKey?: string; roleId?: Id; profileId?: Id; productId?: Id }
export interface WorkFacts {
  productId: Id;
  productName: string;
  delivery: Work["delivery"];
  result: PublishingResult;
  checks?: { at: number; sha?: string; tree?: string; definition?: string; current?: boolean; passed: boolean; count: number; node?: Id; attemptId?: string };
  checkReturns: number;
  acceptanceReturns: number;
  stepAttempts: number;
  baseSha?: string;
  reviewedSha?: string;
  reviewedTree?: string;
  approvedFor?: Work["approvedFor"];
  cleanup?: Work["cleanup"];
}
/** `held`: a shared acceptance failure whose automatic repairs are used up, still open and Important, held for the delivery decision. */
export interface FindingFacts { text: string; tracking?: Finding["tracking"]; id: Id; status: Finding["status"]; severity: Finding["severity"]; raisedBy: Id; roleId?: Id; reopenedAt?: number; answerFixed?: boolean; answerAt?: number; confirmed: number; verdict?: string; productIds?: readonly Id[]; evidence: boolean; held?: true }

/** A lone participant's handoff closes its node; parallel participants keep theirs. Follow only the
 * recorded handoff at the same workflow position, never a prior round, product or unrelated step. */
export function previousParticipant(node: NodeFacts, input: SeatInputFacts, nodes: readonly NodeFacts[]): { nodeId: Id; input: SeatInputFacts } | undefined {
  const sameNode = node.inputs.slice(0, input.index).findLast(entry => entry.seat === input.seat);
  if (sameNode) return { nodeId: node.id, input: sameNode };
  const prior = nodes.find(entry => entry.id === node.trigger?.after);
  if (!prior || prior.kind !== "agent" || prior.team || prior.reason !== JOURNEY_WORDS.agentChanged || prior.endedAt === undefined) return;
  if (prior.roleId !== node.roleId || prior.stageId !== node.stageId || prior.round !== node.round || prior.sub !== node.sub || !!prior.fixing !== !!node.fixing || !!prior.update !== !!node.update || !!prior.port !== !!node.port || !!prior.call !== !!node.call) return;
  const previous = prior.inputs.findLast(entry => entry.seat === input.seat);
  if (previous && previous.productId === input.productId) return { nodeId: prior.id, input: previous };
}

export interface WorkflowFacts {
  id: Id;
  title: string;
  productIds: readonly Id[];
  state: RunState;
  column: string;
  held: boolean;
  stageIndex: number;
  sub: number;
  fixing: boolean;
  startedAt?: number;
  finishedAt?: number;
  combinedInto?: Id;
  combinedFrom?: readonly { id: Id; title: string }[];
  error?: string;
  waitKind?: WaitKind;
  runtimeWait?: Pick<NonNullable<ReturnType<typeof runtimeWaitView>>, "held" | "decisionNeeded" | "reason" | "prerequisites" | "phase">;
  statusLine: string;
  agents: readonly { roleId: Id; profileId: Id; reviewKey?: string; since: number }[];
  nodes: NodeFacts[];
  inbox: InboxFacts[];
  works: WorkFacts[];
  findings: FindingFacts[];
  capacityRetries: readonly { key: string; tried: number }[];
  landing: Landing;
  shared?: ReturnType<typeof landingState>;
  history?: HistoryStatus;
  repair?: TaskState["repair"];
}

export const clip = (
  text: string | undefined,
  limit = SUMMARY_CHARACTERS
): string | undefined => (text === undefined ? undefined : text.length > limit ? `${text.slice(
  0,
  limit - 1
)}…` : text);
export const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function waitKindOf(task: TaskState, ctx: WorkflowContext): WaitKind | undefined {
  if (task.state !== "waiting" && !(task.state === "queued" && task.statusLine.startsWith("Waiting for “"))) return undefined;
  const wait = runtimeWaitView(task, ctx.findTask ?? (() => undefined));
  if (wait?.held) return wait.decisionNeeded ? "needs-your-decision" : "dependencies";
  const now = ctx.now;
  if (task.capacityPaused?.length || task.modelCapacity?.some((entry) => entry.until > now)) return "capacity";
  const line = task.statusLine;
  if (line.startsWith("Waiting for usage") || (ctx.limited?.length && /usage|limit/i.test(line))) return "usage";
  if (line.startsWith("Waiting for “")) return "dependencies";
  if (line.startsWith("Waiting for the pool to resume") || line.startsWith("Waiting: Petrina is")) return "pool";
  if (line.startsWith("Waiting for room to prepare")) return "preparation";
  if (line.startsWith("Waiting to run the checks")) return "checks";
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
    ...(step.trigger ? { trigger: step.trigger } : {}), ...(step.builderConversation ? { builderConversation: step.builderConversation } : {}), ...(step.legacy ? { legacy: true } : {}),
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
    statusLine: task.statusLine,
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
const testedByAcceptance = (finding: { text: string }, at: number, tested: number) => finding.text.startsWith("Failed acceptance check:") && at <= tested;

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
