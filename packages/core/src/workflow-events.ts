// Compact workflow facts and the events their changes produce. The engine compares a task's facts on
// every recorded change, before a batched save or retirement can hide a transition. The facts are small
// projections of the journey, inbox and delivery records that already exist, never another account of
// workflow state: routine tool actions, streamed text, progress wording and clocks are left out, so an
// unchanged save produces nothing.

import type { AgentProfile, CheckAttemptEvidence, Finding, Id, InboxItem, InboxKind, InputManifestEntry, JourneyAgentInput, JourneyStep, Role, RunState, Task, TaskRepository, TaskState, UsageLimit } from "./model.js";
import { JOURNEY_WORDS, landingOf, stepName, type Landing } from "./journey.js";
import { checkCounts } from "./check-evidence.js";
import { copyNoLongerNeeded, markedDoneUnconfirmed } from "./cleanup.js";
import { historyItem, historyStatus, type HistoryStatus } from "./history.js";
import { assignedProducts, displayTask, landingState, taskProductIds } from "./repositories.js";
import { roleForTask } from "./roles.js";
import { findingReportCounts, outstandingReportsFirst } from "./finding-reports.js";
import { runtimeWaitView, type RuntimeWaitTask } from "./runtime-wait.js";

export const WORKFLOW_EVENT_KINDS = [
  "task.created", "task.state", "task.waiting", "task.finished",
  "node.started", "node.finished", "seat.started", "seat.finished",
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

export type PublishingResult =
  | { kind: "released"; landed: true; tag: string; url: string }
  | { kind: "committed"; landed: true; branch: string; sha: string; pushed?: true }
  | { kind: "merged"; landed: true; number: number; url: string }
  | { kind: "pull-request-open"; landed: false; number: number; url: string; updated?: boolean }
  | { kind: "pull-request-closed"; landed: false; number: number; url: string; decision: "needed" | "accepted" | "none" }
  | { kind: "local-unpushed"; landed: false; branch: string; sha: string }
  | { kind: "publishing"; landed: false; step: string }
  | { kind: "interrupted"; landed: false; decision: "needed" }
  | { kind: "unknown"; landed: false }
  | { kind: "no-changes"; landed: null }
  | { kind: "unconfirmed"; landed: false; pullRequestCheck: "unconfirmed" | "none" | "pending" | "found"; lookup?: { number: number; url: string; state: string }; foreignPullRequest?: { number: number; url: string } }
  | { kind: "pending"; landed: false };

export interface PublishingFacts {
  productId: Id;
  productName: string;
  delivery: TaskRepository["delivery"];
  result: PublishingResult;
}

type Work = TaskRepository | NonNullable<TaskState["repository"]>;

/** One product's recorded delivery result through the existing delivery and landing rules. Nothing is inferred from a general delivered marker. */
export function publishingResult(task: Pick<TaskState, "state" | "repositories"> & { maintenance?: Pick<NonNullable<TaskState["maintenance"]>, "noProductChanges"> }, work: Work, interrupted: boolean): PublishingResult {
  const shared = work as Partial<TaskRepository>;
  if (work.shipping?.carriedOver) return { kind: "unknown", landed: false };
  if (shared.nothingToPublish || task.maintenance?.noProductChanges) return { kind: "no-changes", landed: null };
  if (markedDoneUnconfirmed(task, work)) return { kind: "unconfirmed", landed: false, pullRequestCheck: work.pr ? "found" : work.cleanup?.pullRequest ?? "pending", ...(work.pr ? { lookup: { number: work.pr.number, url: work.pr.url, state: work.pr.state } } : {}), ...(work.cleanup?.foreignPullRequest ? { foreignPullRequest: work.cleanup.foreignPullRequest } : {}) };
  if (work.release) return { kind: "released", landed: true, tag: work.release.tag, url: work.release.url };
  if (work.pr?.state === "merged") return { kind: "merged", landed: true, number: work.pr.number, url: work.pr.url };
  if (work.pr?.state === "closed") return { kind: "pull-request-closed", landed: false, number: work.pr.number, url: work.pr.url, decision: task.repositories ? (shared.landingAccepted ? "accepted" : "needed") : "none" };
  if (work.landed && work.localUpdate?.pushed === false) return { kind: "local-unpushed", landed: false, branch: work.localUpdate.branch, sha: work.localUpdate.sha };
  if (work.landed) return { kind: "committed", landed: true, branch: work.landed.branch, sha: work.landed.sha, ...(work.localUpdate?.pushed === true ? { pushed: true } : {}) };
  if (work.pr?.state === "open") return { kind: "pull-request-open", landed: false, number: work.pr.number, url: work.pr.url, ...(work.source?.start.kind === "pull-request" ? { updated: true } : {}) };
  if (work.localUpdate && !work.localUpdate.pushed) return { kind: "local-unpushed", landed: false, branch: work.localUpdate.branch, sha: work.localUpdate.sha };
  if (interrupted) return { kind: "interrupted", landed: false, decision: "needed" };
  if (work.shipping?.step) return { kind: "publishing", landed: false, step: work.shipping.step };
  if (task.state === "done") return { kind: "unconfirmed", landed: false, pullRequestCheck: work.cleanup?.pullRequest ?? "pending", ...(work.cleanup?.foreignPullRequest ? { foreignPullRequest: work.cleanup.foreignPullRequest } : {}) };
  return { kind: "pending", landed: false };
}

/** Plain words for a product's result. */
export function publishingWords(result: PublishingResult): string {
  switch (result.kind) {
    case "released": return `published release ${result.tag} (landed)`;
    case "committed": return `committed to ${result.branch} at ${result.sha}${result.pushed ? " and pushed" : "; no push confirmation recorded"} (landed)`;
    case "merged": return `pull request #${result.number} merged (landed)`;
    case "pull-request-open": return `pull request #${result.number} ${result.updated ? "updated and " : ""}open, awaiting merge (not landed)`;
    case "pull-request-closed": return `pull request #${result.number} closed without merging (not landed${result.decision === "needed" ? "; your decision is needed" : result.decision === "accepted" ? "; you resolved it" : ""})`;
    case "local-unpushed": return `${result.branch} advanced locally at ${result.sha}; its push has not finished (not landed)`;
    case "publishing": return `publishing in progress (${result.step}; not landed yet)`;
    case "interrupted": return "shipping was interrupted; your decision is needed (not landed)";
    case "unknown": return "delivery saved by an older Petrina: what went out is unknown until you check GitHub";
    case "no-changes": return "no product changes";
    case "unconfirmed": return `marked done without a confirmed delivery${result.lookup ? `; later lookup found pull request #${result.lookup.number} (${result.lookup.state})` : result.pullRequestCheck === "none" ? "; no pull request was found on its branch" : result.pullRequestCheck === "pending" ? "; the pull request lookup has not finished" : "; the pull request lookup could not be confirmed"}`;
    case "pending": return "not published yet";
  }
}

// ── Facts ──────────────────────────────────────────────────────────────

interface SeatInputFacts {
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
interface SeatResultFacts {
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
interface CheckFacts {
  index: number;
  id?: string;
  attemptId?: string;
  name: string;
  result: string;
  startedAt?: number;
  endedAt?: number;
  queuedAt?: number;
  productId?: Id;
  ok?: boolean;
  ms?: number;
  logComplete?: boolean;
  logRecorded?: boolean;
  detail?: string;
}
interface AskFacts { id: Id; kind: string; title: string; at: number; endedAt?: number; how?: string; answer?: string }
interface NodeFacts {
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
  checked: readonly (Omit<CheckAttemptEvidence, "id" | "commands"> & { attemptId: string })[];
  reuses: NonNullable<JourneyStep["reuses"]>;
  findingIds?: readonly Id[];
  resultFindings: readonly { id: Id; status: string; severity: string }[];
  findingsSettled?: true;
  findingChanges?: NonNullable<JourneyStep["result"]>["findingChanges"];
  reviewSteps?: readonly Id[];
}
interface InboxFacts { id: Id; kind: InboxKind; title: string; at: number; blocking: boolean; reviewKey?: string; roleId?: Id; profileId?: Id; productId?: Id }
interface WorkFacts {
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
interface FindingFacts { text: string; tracking?: Finding["tracking"]; id: Id; status: Finding["status"]; severity: Finding["severity"]; raisedBy: Id; roleId?: Id; reopenedAt?: number; answerFixed?: boolean; answerAt?: number; confirmed: number; verdict?: string; productIds?: readonly Id[]; evidence: boolean }

/** A lone participant's handoff closes its node; parallel participants keep theirs. Follow only the
 * recorded handoff at the same workflow position, never a prior round, product or unrelated step. */
function previousParticipant(node: NodeFacts, input: SeatInputFacts, nodes: readonly NodeFacts[]): { nodeId: Id; input: SeatInputFacts } | undefined {
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

const clip = (text: string | undefined, limit = SUMMARY_CHARACTERS): string | undefined => (text === undefined ? undefined : text.length > limit ? `${text.slice(0, limit - 1)}…` : text);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

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
    name: check.name, result: check.result,
    ...(check.startedAt !== undefined ? { startedAt: check.startedAt } : {}), ...(check.endedAt !== undefined ? { endedAt: check.endedAt } : {}), ...(check.queuedAt !== undefined ? { queuedAt: check.queuedAt } : {}),
    ...(check.productId ? { productId: check.productId } : {}),
    ...(check.run ? { ok: check.run.ok, ms: check.run.ms, logRecorded: !!check.run.logPath, ...(check.run.logComplete !== undefined ? { logComplete: check.run.logComplete } : {}) } : {}),
    ...(check.detail ? { detail: clip(check.detail, 300) } : {}),
  }]);
  const asks: AskFacts[] = (step.asks ?? []).map((ask) => ({ id: ask.id, kind: ask.kind, title: clip(ask.title, 200)!, at: ask.at, ...(ask.endedAt !== undefined ? { endedAt: ask.endedAt } : {}), ...(ask.how ? { how: ask.how } : {}), ...(ask.answer ? { answer: clip(ask.answer, 300) } : {}) }));
  const acceptance = step.acceptanceChecks ? { pass: step.acceptanceChecks.filter((check) => check.result === "pass").length, fail: step.acceptanceChecks.filter((check) => check.result === "fail").length, blocked: step.acceptanceChecks.filter((check) => check.result === "blocked").length } : undefined;
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
  const view = displayTask(task as unknown as Task);
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
    ...(wait ? { runtimeWait: { held: wait.held, decisionNeeded: wait.decisionNeeded, reason: wait.reason, prerequisites: wait.prerequisites, phase: wait.phase } } : {}),
    statusLine: task.statusLine,
    agents: [task.agent, ...(task.helpers ?? [])].flatMap((agent) => (agent ? [{ roleId: agent.roleId, profileId: agent.profileId, ...(agent.reviewKey ? { reviewKey: agent.reviewKey } : {}), since: agent.since }] : [])),
    nodes: journey.map((step, index) => nodeFacts(step, index, journey, task, ctx)),
    inbox: ctx.inbox.filter((item) => item.taskId === task.id).map((item) => ({ id: item.id, kind: item.kind, title: clip(item.title, 200)!, at: item.at, blocking: item.blocking, ...(item.reviewKey ? { reviewKey: item.reviewKey } : {}), ...(item.roleId ? { roleId: item.roleId } : {}), ...(item.profileId ? { profileId: item.profileId } : {}), ...(item.productId ? { productId: item.productId } : {}) })),
    works: works.map((work, index) => ({
      productId: work.productId, productName: productName(work.productId), delivery: work.delivery,
      result: results[index]!,
      ...(work.checks ? { checks: { at: work.checks.at, ...(work.checks.sha ? { sha: work.checks.sha } : {}), ...(work.checks.tree ? { tree: work.checks.tree } : {}), ...(work.checks.definition ? { definition: work.checks.definition } : {}), ...(work.checks.current !== undefined ? { current: work.checks.current } : {}), passed: work.checks.results.every((run) => run.ok), count: work.checks.results.length, ...(work.checks.provenance ? { node: work.checks.provenance.nodeId, attemptId: work.checks.provenance.attemptId } : {}) } } : {}),
      checkReturns: work.checkReturns ?? 0, acceptanceReturns: work.acceptanceReturns ?? 0, stepAttempts: work.stepAttempts ?? 0,
      ...(work.baseSha ? { baseSha: work.baseSha } : {}), ...(work.reviewedSha ? { reviewedSha: work.reviewedSha } : {}), ...(work.reviewedTree ? { reviewedTree: work.reviewedTree } : {}),
      ...(work.approvedFor ? { approvedFor: work.approvedFor } : {}), ...(work.cleanup ? { cleanup: work.cleanup } : {}),
    })),
    findings: task.findings.map((finding) => ({ id: finding.id, text: clip(finding.text, 160)!, ...(finding.tracking ? { tracking: finding.tracking } : {}), status: finding.status, severity: finding.severity, raisedBy: finding.raisedBy, ...(finding.roleId ? { roleId: finding.roleId } : {}), ...(finding.reopenedAt !== undefined ? { reopenedAt: finding.reopenedAt } : {}), ...(finding.answer ? { answerFixed: finding.answer.fixed, answerAt: finding.answer.at } : {}), confirmed: finding.confirmedBy.length, ...(finding.verification ? { verdict: finding.verification.verdict } : {}), productIds: assignedProducts(task as Task, finding.productIds), evidence: !!finding.evidence })),
    capacityRetries: (task.capacityRetries ?? []).map((entry) => ({ key: `${entry.roleId}|${entry.profileId}|${entry.member ?? ""}`, tried: entry.tried })),
    landing,
    ...(shared ? { shared } : {}),
    ...(finished ? { history: historyStatus(historyItem(view)) } : {}),
    ...(task.repair ? { repair: task.repair } : {}),
  };
}

// ── Events from changed facts ──────────────────────────────────────────

/** The events one task's changed facts produce, in causal order. `prev` undefined: the task is new. */
export interface FindingBaseline { findings: FindingFacts[]; since: "node-start" | "engine-start"; /** The Builder's claims this node examines. */ claims: Id[] }

/**
 * Why the work went back to the Builder. An explicit shared repair names its own kind; otherwise the step that ended
 * last sent it back. A checks run, or the handoff of an unchanged tree's saved failure, is a check repair. A handoff
 * with no recorded failure sends nothing back, and with no step at all the kind is unknown: neither is guessed.
 */
function repairKind(repair: WorkflowFacts["repair"], cause: NodeFacts | undefined, roles: WorkflowContext["roles"]): string | undefined {
  if (repair) return repair.kind;
  if (!cause) return undefined;
  if (cause.kind === "petrina" && cause.work === "check-reuse") return cause.reusedFailed ? "checks" : undefined;
  if (cause.kind === "petrina" && cause.work === "checks") return "checks";
  if (cause.kind === "agent" && roles.find((role) => role.id === cause.roleId)?.result === "checks") return "acceptance";
  return cause.kind === "you" ? "changes" : "review";
}

/**
 * A request can leave the inbox one change before its answer or decision is recorded on the journey. Such a
 * removal is carried to the next observation of the task, where the recorded decision names it; a removal
 * that nothing records by then is reported as handled.
 */
export type DeferredRemovals = Map<Id, InboxFacts>;

export function workflowEvents(prev: WorkflowFacts | undefined, next: WorkflowFacts, ctx: WorkflowContext, baselines: Map<Id, FindingBaseline>, deferred: DeferredRemovals = new Map()): WorkflowEventDraft[] {
  const drafts: WorkflowEventDraft[] = [];
  const carried = [...deferred.values()];
  deferred.clear();
  const settledItems = new Set<Id>();
  const base = { taskId: next.id, productIds: next.productIds };
  const push = (draft: Omit<WorkflowEventDraft, "taskId" | "productIds">) => drafts.push({ ...base, ...draft } as WorkflowEventDraft);
  const roleName = (id: Id | undefined) => (id ? ctx.roles.find((role) => role.id === id)?.name ?? id : "Agent");
  const before: WorkflowFacts = prev ?? { ...next, state: next.state, nodes: [], inbox: [], works: [], findings: [], capacityRetries: [], agents: [], waitKind: undefined };
  if (!prev) push({ at: ctx.now, kind: "task.created", summary: `Task created: “${next.title}” (${next.state})`, state: next.state, title: next.title, ...(next.combinedFrom ? { combinedFrom: next.combinedFrom } : {}) });

  // Task state and waits.
  if (prev && prev.state !== next.state) {
    const terminal = next.state === "done" || next.state === "cancelled";
    push({ at: ctx.now, kind: "task.state", summary: `${prev.state} → ${next.state}: ${next.statusLine}`, from: prev.state, to: next.state, column: next.column, reason: next.statusLine, ...(next.waitKind ? { wait: next.waitKind } : {}), ...(next.error ? { error: next.error } : {}), ...(terminal ? { terminal: true } : {}) });
  } else if (prev && next.state === "waiting" && prev.waitKind !== next.waitKind && next.waitKind) {
    push({ at: ctx.now, kind: "task.waiting", summary: `Waiting (${next.waitKind}): ${next.statusLine}`, wait: next.waitKind, reason: next.statusLine });
  }
  if (next.state === "waiting" && next.runtimeWait?.held && (prev?.state !== "waiting" || !same(prev.runtimeWait, next.runtimeWait))) {
    // The kind comes from the saved prerequisite facts, never a classifier over the coordinator's words.
    const alreadyReported = drafts.some((event) => event.kind === "task.waiting");
    const detail = { wait: next.waitKind, reason: next.runtimeWait.reason, prerequisites: next.runtimeWait.prerequisites, phase: next.runtimeWait.phase, decisionNeeded: next.runtimeWait.decisionNeeded };
    if (alreadyReported) Object.assign(drafts.find((event) => event.kind === "task.waiting")!, detail);
    else push({ at: ctx.now, kind: "task.waiting", summary: next.statusLine, ...detail });
  }
  for (const retry of next.capacityRetries) {
    const earlier = before.capacityRetries.find((entry) => entry.key === retry.key)?.tried ?? 0;
    if (retry.tried > earlier) push({ at: ctx.now, kind: "retry", summary: `Same-conversation retry ${retry.tried} after the selected model was at capacity (${retry.key.split("|")[1]})`, retryKind: "capacity", profileId: retry.key.split("|")[1], tried: retry.tried });
  }
  if (prev && (!prev.fixing && next.fixing || (next.repair && !same(prev.repair, next.repair) && next.repair.index === 0))) {
    const cause = [...next.nodes].reverse().find((node) => node.endedAt !== undefined);
    const work = next.works.find((entry) => entry.productId === (next.repair?.products[0] ?? next.productIds[0]));
    const kind = repairKind(next.repair, cause, ctx.roles);
    push({ at: ctx.now, kind: "repair.returned", summary: `Back to the builder${kind ? ` (${kind})` : ""}: ${cause?.reason ?? cause?.outcome ?? next.statusLine}`, ...(kind ? { repairKind: kind } : {}), ...(cause ? { cause: { nodeId: cause.id, reason: cause.reason ?? cause.outcome, kind: cause.kind === "petrina" ? cause.work : cause.roleId ?? cause.waitsFor } } : {}), allowance: { checkReturns: work?.checkReturns ?? 0, acceptanceReturns: work?.acceptanceReturns ?? 0, limit: 2 }, ...(next.repair ? { products: next.repair.products } : {}) });
  }

  // Journey nodes: starts, seats, checks, asks and ends.
  for (const node of next.nodes) {
    const old = before.nodes[node.index];
    const fresh = !old || old.id !== node.id;
    const isNew = fresh && !node.legacy;
    const role = node.roleId ? ctx.roles.find((entry) => entry.id === node.roleId) : undefined;
    const at = { nodeId: node.id, ...(node.stageId ? { stageId: node.stageId } : {}) };
    if (isNew) {
      if (!baselines.has(node.id)) baselines.set(node.id, baselines.get(node.reviewSteps?.[0] ?? node.id) ?? { findings: next.findings.map((finding) => ({ ...finding })), since: "node-start", claims: claimsUnderTest(next, node, ctx.roles) });
      const checkBasis = node.kind === "agent" && (role?.result === "checks" || role?.result === "findings" || role?.result === "votes") ? checkBasisFor(next, node) : undefined;
      push({ at: node.startedAt, kind: "node.started", summary: `${node.name} started${node.trigger?.reason ? `: ${node.trigger.reason}` : ""}`, ...at, nodeKind: node.kind, ...(node.roleId ? { roleId: node.roleId } : {}), ...(node.profileId ? { profileId: node.profileId } : {}), ...(node.team ? { team: node.team } : {}), ...(node.seats ? { seats: node.seats } : {}), round: node.round, ...(node.fixing ? { fixing: true, ...(node.findingIds ? { findingIds: node.findingIds, findingCount: node.findingIds.length } : {}) } : {}), ...(node.update ? { update: true } : {}), ...(node.port ? { port: true } : {}), ...(node.call ? { call: true } : {}), ...(node.work ? { work: node.work } : {}), ...(node.waitsFor ? { waitsFor: node.waitsFor } : {}), ...(node.waitsOn ? { waitsOn: node.waitsOn } : {}), ...(node.trigger ? { cause: { ...(node.trigger.after ? { nodeId: node.trigger.after } : {}), reason: node.trigger.reason } } : {}), ...(checkBasis ? { checks: checkBasis } : {}), refs: { node: { taskId: next.id, nodeId: node.id }, ...(node.reviewInput ? { reviewInput: { taskId: next.id, nodeId: node.id } } : {}) } });
    }
    for (const input of node.inputs) {
      const known = !fresh && old!.inputs[input.index];
      if (known) continue;
      const previous = previousParticipant(node, input, next.nodes);
      const replaced = previous && previous.input.profileId !== input.profileId ? previous.input : undefined;
      const limit = replaced ? ctx.limited?.find((entry) => { const profile = ctx.profiles.find((candidate) => candidate.id === replaced.profileId); return !!profile && entry.toolId === profile.toolId && (!entry.model || profile.model.toLowerCase().includes(entry.model.toLowerCase())); }) : undefined;
      // The read selects the seat and its attempt, oldest first, independent of the node's other seats.
      const seatRef = { taskId: next.id, nodeId: node.id, seat: input.seat, index: input.attempt - 1 };
      push({
        at: input.at ?? node.startedAt, kind: "seat.started", ...at, seat: input.seat, attempt: input.attempt,
        summary: `${roleName(input.roleId)} (${input.seat}) started on ${input.profileId}${input.requestedProfileId && input.requestedProfileId !== input.profileId ? ` instead of ${input.requestedProfileId}` : ""}: ${input.mode === "resumed" ? "resumed its interrupted conversation" : input.mode === "continued" ? "continued its conversation" : input.freshReason ? `fresh conversation (${input.freshReason})` : "fresh conversation"}${input.readiness ? `; readiness recheck ${input.readiness.check}, ${input.readiness.outcome === "no answer" ? "no answer in time" : input.readiness.outcome}` : ""}${node.trigger?.reason ? `; after: ${node.trigger.reason}` : ""}`,
        roleId: input.roleId, profileId: input.profileId, ...(input.requestedProfileId ? { requestedProfileId: input.requestedProfileId } : {}), ...(input.selectionReason ? { selectionReason: input.selectionReason } : {}),
        mode: input.mode, ...(input.freshReason ? { freshReason: input.freshReason } : {}), ...(input.readiness ? { readiness: input.readiness } : {}), ...(input.sessionId ? { conversation: input.sessionId } : {}), ...(input.confirmedSettings ? { confirmedSettings: input.confirmedSettings } : {}),
        ...(node.builderConversation ? { builderConversation: node.builderConversation } : {}),
        ...(input.productId ? { productId: input.productId } : {}),
        ...(input.stepAttempts !== undefined ? { stepAttempts: input.stepAttempts } : {}),
        ...(node.trigger ? { cause: { ...(node.trigger.after ? { nodeId: node.trigger.after } : {}), reason: node.trigger.reason } } : {}),
        ...(input.exact ? { exact: input.exact } : { exact: null }),
        ...(input.manifest ? { manifest: input.manifest, manifestTotal: input.manifestTotal, ...(input.manifestTotal! > input.manifest.length ? { manifestShortened: true } : {}) } : { manifest: null }),
        taskDescriptionIncluded: input.taskDescription,
        versions: input.versions ?? null,
        ...(input.reviewInput ? { reviewInput: input.reviewInput } : {}),
        ...(replaced ? { replaced: { nodeId: previous!.nodeId, seat: input.seat, attempt: replaced.attempt, previousProfileId: replaced.profileId, ...(replaced.sessionId ? { conversation: replaced.sessionId } : {}), ...(limit ? { reason: limit.reason } : input.selectionReason ? { reason: input.selectionReason } : {}) } } : {}),
        refs: { ...(input.reviewInput ? { reviewInput: { taskId: next.id, nodeId: node.id } } : {}), input: seatRef, manifest: { ...seatRef, section: "manifest" }, conversation: { taskId: next.id, nodeId: node.id } },
      });
      if (replaced) push({ at: input.at ?? node.startedAt, kind: "profile.replaced", ...at, seat: input.seat, attempt: input.attempt, summary: `${roleName(input.roleId)} (${input.seat}): ${replaced.profileId} replaced by ${input.profileId}${limit ? ` (${limit.reason})` : input.selectionReason ? ` (${input.selectionReason})` : ""}`, previousNodeId: previous!.nodeId, previousAttempt: replaced.attempt, ...(replaced.sessionId ? { previousConversation: replaced.sessionId } : {}), previousProfileId: replaced.profileId, profileId: input.profileId, ...(limit ? { reason: limit.reason, limitUntil: limit.until } : input.selectionReason ? { reason: input.selectionReason } : {}), refs: { input: seatRef, previousInput: { taskId: next.id, nodeId: previous!.nodeId, seat: replaced.seat, index: replaced.attempt - 1 } } });
    }
    for (const result of node.results) {
      if (!fresh && old!.results[result.index]) continue;
      const seatInput = result.inputIndex !== undefined ? node.inputs[result.inputIndex] : node.inputs.findLast((input) => input.seat === result.seat && (input.at ?? 0) <= result.at);
      push({ at: result.at, kind: "seat.finished", ...at, seat: result.seat, ...(seatInput ? { attempt: seatInput.attempt } : {}), summary: `${roleName(result.roleId)} (${result.seat}) handed back: ${result.summary}${role?.result === "build" ? " (automated checks are a separate step)" : ""}`, roleId: result.roleId, profileId: result.profileId, ...(result.productId ? { productId: result.productId } : {}), ...(result.versions ? { versions: result.versions } : {}), ...(result.findingCopies !== undefined ? { findingCopies: result.findingCopies } : {}), ...(result.images ? { images: result.images } : {}), refs: { result: { taskId: next.id, nodeId: node.id, index: result.index }, ...(result.findingCopies ? { findings: { taskId: next.id, nodeId: node.id, result: result.index } } : {}) } });
    }
    for (const check of node.checks) {
      const earlier = fresh ? undefined : old!.checks.find((entry) => entry.index === check.index);
      const ref = { check: { taskId: next.id, nodeId: node.id, index: check.index } };
      const terminal = !["pending", "running"].includes(check.result);
      if (!earlier) push({ at: check.queuedAt ?? node.startedAt, kind: "check.queued", ...at, summary: `${check.name} queued`, name: check.name, ...(check.attemptId ? { attemptId: check.attemptId } : {}), ...(check.productId ? { productId: check.productId } : {}), refs: ref });
      if ((!earlier || earlier.result === "pending") && (check.result === "running" || (terminal && check.startedAt !== undefined))) push({ at: check.startedAt ?? node.startedAt, kind: "check.started", ...at, summary: `${check.name} started`, name: check.name, ...(check.attemptId ? { attemptId: check.attemptId } : {}), ...(check.productId ? { productId: check.productId } : {}), refs: ref });
      if (terminal && (!earlier || earlier.result !== check.result)) push({ at: check.endedAt ?? ctx.now, kind: "check.finished", ...at, summary: `${check.name}: ${check.result === "pass" ? "passed" : check.result === "fail" ? "failed" : check.result === "did-not-finish" ? "did not finish" : check.result}${check.ms !== undefined ? ` in ${Math.max(1, Math.round(check.ms / 1000))}s` : ""}${check.detail ? `: ${check.detail.split("\n")[0]}` : ""}`, name: check.name, result: check.result, ...(check.ok !== undefined ? { ok: check.ok } : {}), ...(check.attemptId ? { attemptId: check.attemptId } : {}), ...(check.productId ? { productId: check.productId } : {}), ...(check.logRecorded !== undefined ? { log: check.logRecorded ? (check.logComplete === false ? "incomplete" : check.logComplete ? "complete" : "unverified") : "excerpt-only" } : {}), ...(check.detail ? { detail: check.detail } : {}), versions: check.attemptId ? node.checked.find((entry) => entry.attemptId === check.attemptId && entry.productId === check.productId) ?? null : null, refs: ref });
    }
    for (const [position, reuse] of node.reuses.entries()) {
      if (!fresh && old!.reuses[position]) continue;
      push({ at: reuse.at, kind: "check.reused", ...at, summary: `Checks reused for ${reuse.purpose}: the ${reuse.passed ? "passing" : "failing"} run from ${node.name} still covers the same ${reuse.basis === "same-tree" ? "code" : "commit"} and check definitions`, purpose: reuse.purpose, ...(reuse.attemptId ? { attemptId: reuse.attemptId } : {}), basis: reuse.basis, passed: reuse.passed, originalAt: reuse.originalAt, ...(reuse.productId ? { productId: reuse.productId } : {}), ...(reuse.sha ? { sha: reuse.sha } : {}), ...(reuse.tree ? { tree: reuse.tree } : {}), ...(reuse.definition ? { definition: reuse.definition } : {}), refs: { node: { taskId: next.id, nodeId: node.id }, checks: node.checks.filter((check) => check.ok !== undefined && (!reuse.attemptId || check.attemptId === reuse.attemptId)).map((check) => ({ taskId: next.id, nodeId: node.id, index: check.index })) } });
    }
    for (const ask of node.asks) {
      const earlier = fresh ? undefined : old!.asks.find((entry) => entry.id === ask.id);
      if (earlier && earlier.endedAt === undefined && ask.endedAt !== undefined) {
        settledItems.add(ask.id);
        push({ at: ask.endedAt, kind: "coordinator.decision", ...at, summary: `${ask.kind === "question" ? "Question" : "Permission"} ${ask.how ?? "settled"}${ask.answer ? `: ${ask.answer}` : ""}: ${ask.title}`, requestKind: ask.kind, itemId: ask.id, how: ask.how ?? "unknown", ...(ask.answer ? { answer: ask.answer } : {}), title: ask.title, refs: { conversation: { taskId: next.id, nodeId: node.id } } });
      }
    }
    if (node.endedAt !== undefined && (fresh || old!.endedAt === undefined)) {
      // Settlement proves the whole group reported, including work kept through Try again on earlier steps.
      // Without that proof, only a step holding every required hand-back gets a completed review summary.
      const review = node.kind === "agent" && (role?.result === "findings" || role?.result === "votes") ? reviewEnd(node) : undefined;
      const reviewNodes = review?.examined && node.reviewSteps ? next.nodes.filter(entry => node.reviewSteps!.includes(entry.id)) : [node];
      const reconciliation = review?.examined ? reconcile(baselines.get(node.id) ?? { findings: before.findings, since: "engine-start", claims: claimsUnderTest({ nodes: next.nodes, findings: before.findings }, node, ctx.roles) }, next.findings) : undefined;
      // A restart can observe this node after settlement. Keep the saved round's decisions,
      // rather than attributing them to the engine-start population baseline.
      if (reconciliation && node.findingChanges) Object.assign(reconciliation, node.findingChanges);
      // A run resumed on the same step keeps its stopped attempt as history; the step's result is its latest attempt.
      const attempt = node.kind === "petrina" && node.work === "checks" ? checkAttempt(node) : undefined;
      const checkSummary = attempt ? { ...(attempt.attemptId ? { attemptId: attempt.attemptId } : {}), ...(attempt.productId ? { productId: attempt.productId } : {}), attempts: attempt.attempts, ...checkTally(attempt.checks) } : undefined;
      push({ at: node.endedAt, kind: "node.finished", ...at, summary: `${node.name}: ${node.outcome ?? node.end ?? "ended"}${node.reason ? ` (${node.reason})` : ""}${review && !review.examined ? `; no completed review (${review.acceptedResults} of ${review.seats} accepted result${review.seats === 1 ? "" : "s"})` : ""}`, nodeKind: node.kind, ...(node.roleId ? { roleId: node.roleId } : {}), ...(node.profileId ? { profileId: node.profileId } : {}), ...(node.work ? { work: node.work } : {}), ...(node.waitsFor ? { waitsFor: node.waitsFor } : {}), ...(node.outcome ? { outcome: node.outcome } : {}), ...(node.reason ? { reason: node.reason } : {}), end: node.end ?? "done", ...(node.tone ? { tone: node.tone } : {}), elapsedMs: Math.max(0, node.endedAt - node.startedAt), ...(node.acceptance ? { acceptance: node.acceptance } : {}), ...(attempt && checkSummary ? { checks: checkSummary, versions: attemptVersions(node, attempt.attemptId, attempt.productId) } : {}), ...(role?.result === "build" ? { checks: "separate-step" } : {}), ...(review ? { review } : {}), refs: { node: { taskId: next.id, nodeId: node.id }, ...(attempt ? { checks: attempt.checks.filter((check) => check.ok !== undefined).map((check) => ({ taskId: next.id, nodeId: node.id, index: check.index })) } : {}), ...(review && !review.examined && node.results.length ? { results: resultRefs(next.id, node) } : {}) } });
      if (reconciliation) {
        const counts = reconciliation.reportCounts.closing;
        const reports = outstandingReportsFirst(next.findings).map((finding) => {
          const result = node.results.find((result) => result.findingIds?.includes(finding.id));
          const read = { taskId: next.id, nodeId: node.id, findingId: finding.id };
          return { id: finding.id, text: finding.text, severity: finding.severity, status: finding.status, productIds: finding.productIds ?? [],
            ...(finding.tracking ? { tracking: finding.tracking } : {}),
            evidence: node.resultFindings.some((copy) => copy.id === finding.id) ? { read } : result ? { read: { ...read, result: result.index } } : { unavailable: "This review saved no copy of this report. Current status may differ." } };
        });
        push({ at: node.endedAt, kind: "review.finished", ...at,
          summary: `${node.name} finished: ${reconciliation.opening} ${reconciliation.opening === 1 ? "report" : "reports"} before, ${reconciliation.closing} after; ${counts.open.total} open ${counts.open.total === 1 ? "report" : "reports"} (${counts.open.important} Important, ${counts.open.nits} ${counts.open.nits === 1 ? "nit" : "nits"}, ${counts.open.preExisting} pre-existing ${counts.open.preExisting === 1 ? "follow-up" : "follow-ups"}); raised ${reconciliation.raised.length}, fixed ${reconciliation.fixed.length}, reopened ${reconciliation.reopened.length}, dismissed ${reconciliation.dismissed.length}, unverified ${reconciliation.unverified.length}`,
          ...reconciliation, reports, omitted: { reportBodies: "Use each report’s evidence.read for full text, answers and verification, or its unavailable reason." }, ...(role ? { roleId: node.roleId } : {}), ...(node.team ? { team: node.team } : {}),
          refs: { node: { taskId: next.id, nodeId: node.id }, ...(node.reviewInput ? { reviewInput: { taskId: next.id, nodeId: node.id } } : {}), findings: { taskId: next.id, nodeId: node.id }, results: reviewNodes.flatMap(entry => resultRefs(next.id, entry)), inputs: reviewNodes.flatMap(entry => entry.inputs.map((input) => ({ taskId: next.id, nodeId: entry.id, seat: input.seat, index: input.attempt - 1 }))), currentRequests: { taskId: next.id } } });
      }
      if (node.kind === "you") {
        const item = [...carried, ...before.inbox].find((entry) => LEGACY_KINDS[entry.kind] === node.waitsFor && !next.inbox.some((current) => current.id === entry.id));
        if (item) settledItems.add(item.id);
        push({ at: node.endedAt, kind: "coordinator.decision", ...at, summary: `${node.name}: ${node.outcome ?? "decided"}${node.reason ? ` (${node.reason})` : ""}`, requestKind: item?.kind ?? node.waitsFor, ...(item ? { itemId: item.id, title: item.title } : {}), how: node.outcome ?? "decided", ...(node.reason ? { reason: node.reason } : {}) });
      }
    }
  }

  // Coordinator requests, including kinds with no journey step of their own.
  for (const item of next.inbox) {
    if (before.inbox.some((entry) => entry.id === item.id)) continue;
    const node = [...next.nodes].reverse().find((entry) => entry.asks.some((ask) => ask.id === item.id)) ?? [...next.nodes].reverse().find((entry) => entry.endedAt === undefined);
    push({ at: item.at, kind: "coordinator.request", ...(node ? { nodeId: node.id } : {}), summary: `Needs you (${item.kind}): ${item.title}`, requestKind: item.kind, itemId: item.id, title: item.title, blocking: item.blocking, ...(item.roleId ? { roleId: item.roleId } : {}), ...(item.profileId ? { profileId: item.profileId } : {}), ...(item.reviewKey ? { seat: item.reviewKey } : {}), ...(item.productId ? { productId: item.productId } : {}), ...(node?.trigger || node?.reason ? { cause: { nodeId: node.id, reason: node.reason ?? node.trigger?.reason } } : {}), refs: { request: { itemId: item.id } } });
  }
  const handled = (item: InboxFacts) => push({ at: ctx.now, kind: "coordinator.decision", summary: `${item.kind} request handled: ${item.title}`, requestKind: item.kind, itemId: item.id, how: next.state === "cancelled" ? "cancelled" : next.state === "paused" ? "withdrawn" : "handled", title: item.title });
  for (const item of before.inbox) {
    if (next.inbox.some((entry) => entry.id === item.id) || settledItems.has(item.id)) continue;
    // Its answer or decision may be recorded in the very next change: wait for that one observation.
    const askOpen = (item.kind === "question" || item.kind === "permission") && next.nodes.some((node) => node.asks.some((ask) => ask.id === item.id && ask.endedAt === undefined));
    const gateOpen = LEGACY_KINDS[item.kind] !== undefined && next.nodes.some((node) => node.kind === "you" && node.waitsFor === LEGACY_KINDS[item.kind] && node.endedAt === undefined);
    if ((askOpen || gateOpen) && next.state !== "cancelled" && next.state !== "done") deferred.set(item.id, item);
    else handled(item);
  }
  for (const item of carried) if (!settledItems.has(item.id) && !next.inbox.some((entry) => entry.id === item.id)) handled(item);

  // Publishing results, per product, through the existing delivery rules.
  for (const work of next.works) {
    const earlier = before.works.find((entry) => entry.productId === work.productId);
    if (earlier && same(earlier.result, work.result)) continue;
    if (!earlier && work.result.kind === "pending") continue;
    push({ at: ctx.now, kind: "publishing.result", productId: work.productId, summary: `${work.productName}: ${publishingWords(work.result)}`, result: work.result, delivery: work.delivery, landing: next.landing, ...(next.shared ? { shared: next.shared } : {}), ...(next.state === "cancelled" ? { cancelled: true } : {}), products: next.works.map((entry) => ({ productId: entry.productId, result: entry.result })) });
  }

  // Terminal events keep the final delivery list readable after archival.
  const terminalNow = (next.state === "done" || next.state === "cancelled") && (!prev || (prev.state !== "done" && prev.state !== "cancelled"));
  if (terminalNow) {
    const results = next.works.map((work) => ({ productId: work.productId, productName: work.productName, result: work.result }));
    const published = results.filter((entry) => ["released", "merged", "committed", "pull-request-open", "pull-request-closed"].includes(entry.result.kind));
    push({ at: ctx.now, kind: "task.finished", ...(next.finishedAt !== undefined ? { finishedAt: next.finishedAt } : {}), summary: next.state === "cancelled" ? `Cancelled${next.combinedInto ? `: combined into ${next.combinedInto}` : published.length ? `; already out: ${published.map((entry) => `${entry.productName} ${publishingWords(entry.result)}`).join("; ")}` : ""}` : `Finished: ${next.history ?? next.landing}${results.length ? ` (${results.map((entry) => `${entry.productName}: ${publishingWords(entry.result)}`).join("; ")})` : ""}`, state: next.state, landing: next.landing, ...(next.shared ? { shared: next.shared } : {}), ...(next.history ? { history: next.history } : {}), ...(next.combinedInto ? { combinedInto: next.combinedInto } : {}), products: results });
  }
  const order = { "task.created": 0, "node.started": 1, "seat.started": 2, "profile.replaced": 3, "check.queued": 4, "check.started": 5, "check.finished": 6, "check.reused": 6, "seat.finished": 7, "node.finished": 8, "review.finished": 9, "coordinator.decision": 10, "coordinator.request": 11, "repair.returned": 12, "retry": 13, "publishing.result": 14, "task.waiting": 15, "task.state": 15, "task.finished": 16 } as const;
  return drafts.map((draft, index) => ({ draft, index })).sort((a, b) => a.draft.at - b.draft.at || order[a.draft.kind] - order[b.draft.kind] || a.index - b.index).map(({ draft }) => draft);
}

const LEGACY_KINDS: Partial<Record<InboxKind, string>> = { plan: "plan", design: "design", delivery: "delivery", disagreement: "call", stuck: "stuck", shipping: "shipping" };

/**
 * The attempts recorded on a checks step, oldest first, each with its product. An attempt's entries are added
 * when it is queued and its versions when it runs, so one with nothing to run has versions only. Attempt
 * numbers never decrease within a step, which orders attempts whose records interleave.
 */
function stepAttempts(node: NodeFacts): { attemptId?: string; productId?: Id }[] {
  const seen = new Map<string, { attemptId?: string; productId?: Id }>();
  for (const record of [...node.checks, ...node.checked]) {
    const key = `${record.attemptId ?? ""}|${record.productId ?? ""}`;
    if (!seen.has(key)) seen.set(key, { ...(record.attemptId !== undefined ? { attemptId: record.attemptId } : {}), ...(record.productId ? { productId: record.productId } : {}) });
  }
  const number = (id: string | undefined): number => { const match = /(\d+)$/.exec(id ?? ""); return match ? Number(match[1]) : -1; };
  return [...seen.values()].sort((a, b) => number(a.attemptId) - number(b.attemptId));
}

/**
 * One attempt on a checks step: the named one, a product's latest, or the step's latest, with how many attempts
 * that product made on the step. A run interrupted and resumed on the same step keeps the stopped attempt as
 * history. Records without a product (an older single-product step) stand in when the product named has none.
 */
function checkAttempt(node: NodeFacts, select: { attemptId?: string; productId?: Id } = {}): { attemptId?: string; productId?: Id; checks: CheckFacts[]; attempts: number } {
  const all = stepAttempts(node);
  const chosen = select.attemptId !== undefined
    ? all.findLast((attempt) => attempt.attemptId === select.attemptId && (select.productId === undefined || attempt.productId === select.productId))
    : all.findLast((attempt) => select.productId === undefined || attempt.productId === select.productId) ?? all.findLast((attempt) => attempt.productId === undefined);
  if (!chosen) return { checks: [], attempts: 0 };
  return {
    ...(chosen.attemptId !== undefined ? { attemptId: chosen.attemptId } : {}), ...(chosen.productId ? { productId: chosen.productId } : {}),
    checks: node.checks.filter((check) => check.attemptId === chosen.attemptId && check.productId === chosen.productId),
    attempts: all.filter((attempt) => attempt.productId === chosen.productId).length,
  };
}

/** Each entry counts once: completed with a verdict, stopped or still waiting, or skipped. */
function checkTally(checks: readonly CheckFacts[]): { configured: number; ran: number; passed: number; failed: number; unfinished: number; skipped: number } {
  const count = (test: (check: CheckFacts) => boolean) => checks.filter(test).length;
  return { configured: checks.length, ran: count((check) => check.result === "pass" || check.result === "fail"), passed: count((check) => check.result === "pass"), failed: count((check) => check.result === "fail"), unfinished: count((check) => ["stopped", "did-not-finish", "pending", "running"].includes(check.result)), skipped: count((check) => check.result === "skipped") };
}

/** The recorded versions of exactly this attempt; an older record without attempt identities keeps its latest, and nothing borrows another attempt's. */
function attemptVersions(node: NodeFacts, attemptId: string | undefined, productId?: Id): NodeFacts["checked"][number] | null {
  return (attemptId === undefined ? node.checked.at(-1) : node.checked.findLast((entry) => entry.attemptId === attemptId && (productId === undefined || entry.productId === productId))) ?? null;
}

type CheckBasis = Record<string, unknown> & { productId?: Id; basis: string; passed?: boolean | null };

/**
 * On what basis a tester, reviewer or voter could start: for each of the task's products, the latest run or
 * reuse before this node, or none. `none-configured` is recorded evidence that there was nothing to run (an
 * attempt with versions but no entries, or a reuse of one); `passed` is then `null`, because nothing passed.
 * A reconstructed older step says nothing. Review and acceptance check every product in turn, so a single
 * product reads flat, and several are listed in task order and combined.
 */
function checkBasisFor(facts: WorkflowFacts, node: NodeFacts): Record<string, unknown> {
  const products = facts.works.map((work) => work.productId);
  // Older records without a product belong to a single product's task; on a shared task they stay unattributed.
  const key = (productId: Id | undefined): Id | undefined => productId ?? (products.length === 1 ? products[0] : undefined);
  const latest = new Map<Id | undefined, { at: number; value: CheckBasis }>();
  const consider = (productId: Id | undefined, at: number, value: CheckBasis) => {
    const have = latest.get(productId);
    if (!have || at >= have.at) latest.set(productId, { at, value: { ...(productId ? { productId } : {}), ...value } });
  };
  for (const entry of facts.nodes) {
    if (entry.index >= node.index) break;
    const checksStep = entry.kind === "petrina" && entry.work === "checks";
    const refs = { node: { taskId: facts.id, nodeId: entry.id } };
    if (checksStep && entry.endedAt !== undefined) {
      const attempted = [...new Set(stepAttempts(entry).map((attempt) => attempt.productId))];
      for (const productId of attempted.length ? attempted : [undefined]) {
        const attempt = checkAttempt(entry, { productId });
        const tally = checkTally(attempt.checks);
        const none = tally.configured === 0;
        consider(key(productId), entry.endedAt, entry.legacy && none ? { basis: "unavailable", nodeId: entry.id, refs }
          : { basis: none ? "none-configured" : tally.unfinished && !tally.ran ? "unfinished" : "ran", nodeId: entry.id, ...(attempt.attemptId ? { attemptId: attempt.attemptId } : {}), attempts: attempt.attempts, passed: none ? null : tally.ran > 0 && !tally.failed && !tally.unfinished, ran: tally.ran, failed: tally.failed, unfinished: tally.unfinished, configured: tally.configured, versions: attemptVersions(entry, attempt.attemptId, attempt.productId), refs });
      }
    }
    for (const reuse of entry.reuses) {
      if (reuse.at > node.startedAt) continue;
      // A reused attempt that recorded its versions but no entries had nothing to run.
      const none = checksStep && reuse.attemptId !== undefined && entry.checked.some((version) => version.attemptId === reuse.attemptId && (!reuse.productId || version.productId === reuse.productId)) && checkAttempt(entry, { attemptId: reuse.attemptId, ...(reuse.productId ? { productId: reuse.productId } : {}) }).checks.length === 0;
      consider(key(reuse.productId), reuse.at, { basis: none ? "none-configured" : "reused", reused: true, nodeId: entry.id, ...(reuse.attemptId ? { attemptId: reuse.attemptId } : {}), passed: none ? null : reuse.passed, ...(none ? { configured: 0 } : {}), purpose: reuse.purpose, reuseBasis: reuse.basis, originalAt: reuse.originalAt, versions: { ...(reuse.sha ? { sha: reuse.sha } : {}), ...(reuse.tree ? { tree: reuse.tree } : {}), ...(reuse.definition ? { definition: reuse.definition } : {}) }, refs });
    }
  }
  const listed: CheckBasis[] = [
    ...products.map((productId) => latest.get(productId)?.value ?? { productId, basis: "unavailable" }),
    ...[...latest].filter(([productId]) => productId === undefined || !products.includes(productId)).map(([, entry]) => entry.value),
  ];
  if (listed.length <= 1) return listed[0] ?? { basis: "unavailable" };
  const name = (productId: Id | undefined) => facts.works.find((work) => work.productId === productId)?.productName ?? productId ?? "unattributed product";
  const bases = new Set(listed.map((entry) => entry.basis));
  const passes = listed.map((entry) => entry.passed);
  // Combined: any failure or unfinished run fails; a missing record leaves it unknown; nothing configured anywhere is null.
  const passed = passes.includes(false) ? false : passes.includes(undefined) ? undefined : passes.every((value) => value === null) ? null : true;
  return { basis: bases.size === 1 ? [...bases][0] : "mixed", ...(passed !== undefined ? { passed } : {}), summary: listed.map((entry) => `${name(entry.productId)}: ${checkBasisWords(entry)}`).join("; "), products: listed, refs: { nodes: listed.flatMap((entry) => (typeof entry.nodeId === "string" ? [{ taskId: facts.id, nodeId: entry.nodeId }] : [])) } };
}

/** Plain words for one product's basis. */
function checkBasisWords(entry: CheckBasis): string {
  switch (entry.basis) {
    case "ran": return entry.passed ? "checks ran and passed" : entry.failed ? `checks ran, ${entry.failed} failed` : "checks ran and did not all pass";
    case "reused": return `checks reused (${entry.passed ? "passing" : "failing"} run)`;
    case "none-configured": return `${JOURNEY_WORDS.noChecks}${entry.reused ? " (reused)" : ""}`;
    case "unfinished": return "checks did not finish";
    default: return "no check evidence recorded";
  }
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
function reviewEnd(node: ReviewProgress): { examined: boolean; acceptedResults: number; seats: number } {
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

/** Claims not yet examined by an earlier completed review, using the same completion rule as its event. */
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
  return task.findings.filter(finding => finding.answer?.fixed && (finding.answer.at ?? 0) > reviewed).map(finding => finding.id);
}

/** Each accepted result on a step, by seat, with how many finding copies it left. */
const resultRefs = (taskId: Id, node: NodeFacts) => node.results.map((result) => ({ taskId, nodeId: node.id, index: result.index, seat: result.seat, findingCopies: result.findingCopies ?? 0 }));

/**
 * The Builder's fix claims a review examines: claims made since the last completed review, whatever status
 * the claim already gave the finding. Claims an earlier review already examined are not under test again.
 */
function claimsUnderTest(facts: Pick<WorkflowFacts, "nodes" | "findings">, node: Pick<NodeFacts, "index">, roles: WorkflowContext["roles"]): Id[] {
  const reviewed = Math.max(-Infinity, ...facts.nodes.filter((entry) => entry.index < node.index && entry.kind === "agent" && reviewEnd(entry).examined && roles.find((role) => role.id === entry.roleId)?.result === "findings").map((entry) => entry.endedAt!));
  return facts.findings.filter((finding) => finding.answerFixed && (finding.answerAt ?? 0) > reviewed).map((finding) => finding.id);
}

interface Reconciliation {
  opening: number;
  closing: number;
  since: "node-start" | "engine-start";
  raised: Id[];
  fixed: Id[];
  claimedFixed: Id[];
  reopened: { id: Id; evidence: boolean }[];
  dismissed: Id[];
  unverified: Id[];
  /** Compatibility: open Important reports only, never all open reports. */
  stillOpen: Id[];
  stillOpenPopulation: "open-important";
  openImportant: Id[];
  openNits: Id[];
  openPreExisting: Id[];
  reportCounts: { opening: ReturnType<typeof findingReportCounts>; closing: ReturnType<typeof findingReportCounts> };
  shortened?: true;
}

function reconcile(baseline: FindingBaseline, closing: FindingFacts[]): Reconciliation {
  const opening = baseline.findings;
  const was = new Map(opening.map((finding) => [finding.id, finding]));
  const claims = new Set(baseline.claims);
  const raised = closing.filter((finding) => !was.has(finding.id)).map((finding) => finding.id);
  // Fixed: closed as fixed during the review, or a claim under test the review left standing. A reopened claim is open again.
  const fixed = closing.filter((finding) => finding.status === "fixed" && (was.get(finding.id)?.status !== "fixed" || claims.has(finding.id))).map((finding) => finding.id);
  const claimedFixed = closing.filter((finding) => claims.has(finding.id)).map((finding) => finding.id);
  const reopened = closing.filter((finding) => finding.reopenedAt !== undefined && was.get(finding.id)?.reopenedAt !== finding.reopenedAt).map((finding) => ({ id: finding.id, evidence: finding.evidence }));
  const dismissed = closing.filter((finding) => finding.status === "dismissed" && was.get(finding.id)?.status !== "dismissed").map((finding) => finding.id);
  const unverified = closing.filter((finding) => finding.status === "unverified" && was.get(finding.id)?.status !== "unverified").map((finding) => finding.id);
  const stillOpen = closing.filter((finding) => finding.status === "open" && finding.severity === "blocking").map((finding) => finding.id);
  return { opening: opening.length, closing: closing.length, since: baseline.since, raised, fixed, claimedFixed, reopened, dismissed, unverified, stillOpen,
    stillOpenPopulation: "open-important", openImportant: stillOpen,
    openNits: closing.filter((finding) => finding.status === "open" && finding.severity === "suggestion").map((finding) => finding.id),
    openPreExisting: closing.filter((finding) => finding.status === "open" && finding.severity === "pre-existing").map((finding) => finding.id),
    reportCounts: { opening: findingReportCounts(opening), closing: findingReportCounts(closing) } };
}

// ── The observer ───────────────────────────────────────────────────────

/** Keeps each task's last recorded facts and turns changes into events. Finished tasks keep their facts for a while, so later archive edits still compare. */
export class WorkflowObserver {
  private readonly facts = new Map<Id, WorkflowFacts>();
  private readonly baselines = new Map<Id, Map<Id, FindingBaseline>>();
  private readonly deferred = new Map<Id, DeferredRemovals>();
  private readonly finished: Id[] = [];
  constructor(private readonly retainFinished = 200) {}

  /** Record a task's facts without events: the engine's starting state, or an archived task opened for a read. */
  baseline(task: TaskState, ctx: WorkflowContext): void {
    const facts = workflowFacts(task, ctx);
    this.facts.set(task.id, facts);
    // A step already under way keeps the findings it was first observed with, labelled as such.
    this.baselines.set(task.id, new Map(facts.nodes.filter((node) => node.endedAt === undefined).map((node) => [node.id, { findings: facts.findings.map((finding) => ({ ...finding })), since: "engine-start" as const, claims: claimsUnderTest(facts, node, ctx.roles) }])));
    this.retire(task);
  }

  known(taskId: Id): boolean { return this.facts.has(taskId); }

  /** Compare a task with its last recorded facts. A task never seen before is new only while it is unfinished. */
  observe(task: TaskState, ctx: WorkflowContext): WorkflowEventDraft[] {
    const prev = this.facts.get(task.id);
    const finishedTask = task.state === "done" || task.state === "cancelled";
    if (!prev && finishedTask) { this.baseline(task, ctx); return []; }
    const next = workflowFacts(task, ctx);
    const baselines = this.baselines.get(task.id) ?? new Map<Id, FindingBaseline>();
    this.baselines.set(task.id, baselines);
    const deferred = this.deferred.get(task.id) ?? new Map<Id, InboxFacts>();
    this.deferred.set(task.id, deferred);
    const events = workflowEvents(prev, next, ctx, baselines, deferred);
    this.facts.set(task.id, next);
    for (const node of next.nodes) if (node.endedAt !== undefined) {
      if (node.reviewSteps && !reviewEnd(node).examined) continue;
      baselines.delete(node.id);
      for (const id of node.reviewSteps ?? []) baselines.delete(id);
    }
    this.retire(task);
    return events;
  }

  forget(taskId: Id): void {
    this.facts.delete(taskId);
    this.baselines.delete(taskId);
    this.deferred.delete(taskId);
  }

  private retire(task: TaskState): void {
    const queued = this.finished.indexOf(task.id);
    const keep = () => { if (queued >= 0) this.finished.splice(queued, 1); };
    if (task.state !== "done" && task.state !== "cancelled") { keep(); return; }
    // The existing cleanup rule retains work that can still change delivery. Its later merge, close or
    // lookup must compare with the facts already observed, regardless of how many settled tasks finish.
    const view = displayTask(task as unknown as Task);
    if (!copyNoLongerNeeded(view) || (task.repositories ?? (task.repository ? [task.repository] : [])).some((work) => work.shipping?.step || work.shipping?.carriedOver || work.localUpdate?.pushed === false)) { keep(); return; }
    if (!this.finished.includes(task.id)) this.finished.push(task.id);
    while (this.finished.length > this.retainFinished) this.forget(this.finished.shift()!);
  }
}

/** Whether an event belongs to a product scope, including shared tasks that retain the product. */
export function eventInvolvesProduct(event: Pick<WorkflowEvent, "productIds" | "productId">, productId: Id): boolean {
  return event.productIds.includes(productId) || event.productId === productId;
}

export type { FindingFacts as WorkflowFindingFacts, PublishingFacts as WorkflowPublishingFacts };
