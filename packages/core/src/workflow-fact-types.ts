import type { CheckOutcome } from "./check-outcome.js";
import type { HistoryStatus } from "./history.js";
import { JOURNEY_WORDS, type Landing } from "./journey-words.js";
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
  TaskRepository,
  TaskState,
  UsageLimit,
} from "./model.js";
import type { PublishingResult } from "./publishing-result.js";
import type { landingState } from "./repositories.js";
import type { runtimeWaitView, RuntimeWaitTask } from "./runtime-wait.js";

export const WORKFLOW_EVENT_KINDS = [
  "task.created",
  "task.state",
  "task.waiting",
  "task.finished",
  "node.started",
  "node.finished",
  "seat.started",
  "seat.finished",
  "extra.queued",
  "extra.started",
  "extra.stopping",
  "extra.held",
  "extra.finished",
  "check.queued",
  "check.started",
  "check.finished",
  "check.reused",
  "coordinator.request",
  "coordinator.decision",
  "repair.returned",
  "retry",
  "profile.replaced",
  "review.finished",
  "publishing.result",
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

export type WaitKind =
  | "capacity"
  | "usage"
  | "slot"
  | "pool"
  | "dependencies"
  | "needs-your-decision"
  | "preparation"
  | "checks"
  | "readiness"
  | "other";

export type WorkflowWorkRecord = TaskRepository | NonNullable<TaskState["repository"]>;

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
export interface AskFacts {
  id: Id;
  kind: string;
  title: string;
  at: number;
  endedAt?: number;
  how?: string;
  answer?: string;
}
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
  localSetup?: {
    count: number;
    omittedEarlier: number;
    attempts: readonly { id: Id; productId: Id; position: string; state: string; endedAt?: number }[];
  };
  checked: readonly (Omit<CheckAttemptEvidence, "id" | "commands"> & { attemptId: string })[];
  reuses: NonNullable<JourneyStep["reuses"]>;
  findingIds?: readonly Id[];
  resultFindings: readonly { id: Id; status: string; severity: string }[];
  findingsSettled?: true;
  findingChanges?: NonNullable<JourneyStep["result"]>["findingChanges"];
  reviewSteps?: readonly Id[];
}
export interface InboxFacts {
  id: Id;
  kind: InboxKind;
  title: string;
  at: number;
  blocking: boolean;
  reviewKey?: string;
  roleId?: Id;
  profileId?: Id;
  productId?: Id;
}
export interface WorkFacts {
  productId: Id;
  productName: string;
  delivery: WorkflowWorkRecord["delivery"];
  result: PublishingResult;
  checks?: {
    at: number;
    sha?: string;
    tree?: string;
    definition?: string;
    current?: boolean;
    passed: boolean;
    count: number;
    node?: Id;
    attemptId?: string;
  };
  checkReturns: number;
  acceptanceReturns: number;
  stepAttempts: number;
  baseSha?: string;
  reviewedSha?: string;
  reviewedTree?: string;
  approvedFor?: WorkflowWorkRecord["approvedFor"];
  cleanup?: WorkflowWorkRecord["cleanup"];
}
/** `held`: a shared acceptance failure whose automatic repairs are used up, still open and Important, held for the delivery decision. */
export interface FindingFacts {
  text: string;
  tracking?: Finding["tracking"];
  id: Id;
  status: Finding["status"];
  severity: Finding["severity"];
  raisedBy: Id;
  roleId?: Id;
  reopenedAt?: number;
  answerFixed?: boolean;
  answerAt?: number;
  confirmed: number;
  verdict?: string;
  productIds?: readonly Id[];
  evidence: boolean;
  held?: true;
}

/** A lone participant's handoff closes its node; parallel participants keep theirs. Follow only the
 * recorded handoff at the same workflow position, never a prior round, product or unrelated step. */
export function previousParticipant(
  node: NodeFacts,
  input: SeatInputFacts,
  nodes: readonly NodeFacts[],
): { nodeId: Id; input: SeatInputFacts } | undefined {
  const sameNode = node.inputs.slice(0, input.index).findLast((entry) => entry.seat === input.seat);
  if (sameNode) return { nodeId: node.id, input: sameNode };
  const prior = nodes.find((entry) => entry.id === node.trigger?.after);
  if (
    !prior
    || prior.kind !== "agent"
    || prior.team
    || prior.reason !== JOURNEY_WORDS.agentChanged
    || prior.endedAt === undefined
  ) {
    return undefined;
  }
  if (
    prior.roleId !== node.roleId
    || prior.stageId !== node.stageId
    || prior.round !== node.round
    || prior.sub !== node.sub
    || !!prior.fixing !== !!node.fixing
    || !!prior.update !== !!node.update
    || !!prior.port !== !!node.port
    || !!prior.call !== !!node.call
  ) {
    return undefined;
  }
  const previous = prior.inputs.findLast((entry) => entry.seat === input.seat);
  if (previous && previous.productId === input.productId) return { nodeId: prior.id, input: previous };
  return undefined;
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
  runtimeWait?: Pick<
    NonNullable<ReturnType<typeof runtimeWaitView>>,
    "held" | "decisionNeeded" | "reason" | "prerequisites" | "phase"
  >;
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

export const clip = (text: string | undefined, limit = SUMMARY_CHARACTERS): string | undefined =>
  text === undefined ? undefined : text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
export const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
