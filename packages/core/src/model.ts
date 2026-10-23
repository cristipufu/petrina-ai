import type { Task } from "./task-model.js";
// The domain model shared by the engine, the simulator and the UI.
// Everything here is plain data so it can be stored, diffed and rendered.
import type { TaskSource, WorkChoice } from "./source.js";

import type { TurnReason, WorkInfo } from "./worklog.js";
import type { CheckId, Setup } from "./setup.js";
import type { ReadinessRecheck, ReadinessWait } from "./readiness.js";

export type Id = string;

export type Effort = "low" | "medium" | "high" | "xhigh" | "ultra";

export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "ultra"];

/** Something that can run an agent. Usually an ACP command line. */
export interface Tool {
  id: Id;
  name: string;
  /** How Petrina starts the tool's ACP adapter. */
  command: readonly string[];
  status: "ready" | "not-installed" | "logged-out";
  models: readonly string[];
}

/** A tool, a model and an effort. Any role can run on any profile. */
export interface AgentProfile {
  id: Id;
  toolId: Id;
  /** What people read, e.g. "Opus 5.5". */
  model: string;
  /** The value the tool's ACP adapter takes, e.g. "opus" or "gpt-6.1-sol". */
  modelId?: string;
  effort: Effort;
  /** Only a stand-in for when the planned model is out of usage: the planner is never offered it. */
  standby?: boolean;
}

export type RoleIcon =
  | "map"
  | "book"
  | "compass"
  | "scale"
  | "palette"
  | "hammer"
  | "flask"
  | "search"
  | "rocket"
  | "shield"
  | "pen"
  | "lightbulb"
  | "megaphone"
  | "chart"
  | "globe"
  | "users"
  | "bug";

/** The icons and colours a role the coordinator adds can pick from. */
export const ROLE_ICON_CHOICES: readonly RoleIcon[] = ["lightbulb", "shield", "pen", "megaphone", "chart", "globe", "users", "bug", "book", "compass", "scale", "palette", "hammer", "flask", "search", "map", "rocket"];

export type Tone = "indigo" | "orange" | "violet" | "purple" | "pink" | "blue" | "green" | "teal" | "slate" | "amber";

export const TONE_CHOICES: readonly Tone[] = ["blue", "teal", "green", "orange", "amber", "pink", "purple", "violet", "indigo", "slate"];

/**
 * The kind of result a role hands back. It decides which kind of step the role works in, and it never
 * changes: built-in roles have theirs, and a role the coordinator adds hands back notes or findings.
 */
export type RoleResult = "plan" | "notes" | "brief" | "objections" | "build" | "checks" | "findings" | "delivery" | "check-discovery" | "guide" | "votes";

/** A role is data: what the agent is for, how it works, what it may do, what it sees and what it hands back. */
export interface Role {
  /** Permanent category; workflow is the default for existing roles. */
  category?: "workflow" | "maintenance";
  id: Id;
  name: string;
  icon: RoleIcon;
  tone: Tone;
  /** What the role is for. The planner reads it to decide when to bring the role in. */
  purpose: string;
  /** How it works: what the agent is told. Petrina adds the task, the notes and its own rules around it. */
  instructions: string;
  canEdit: boolean;
  sees: string;
  handsBack: string;
  result: RoleResult;
  /** The board column a task sits in while this role works on it. */
  column: Column;
  /** Petrina runs this role itself: the planner is never told it exists, and a plan cannot use it. */
  internal?: boolean;
  /** The coordinator added it. */
  added?: boolean;
  /** A built-in role the coordinator changed. */
  edited?: boolean;
  /** An added role the coordinator removed: gone from the Library and the planner, still known to tasks planned with it. */
  removed?: boolean;
}

/** What the coordinator changed in a built-in role. Fields never changed keep following Petrina's defaults. */
export interface RoleEdit {
  purpose?: string;
  instructions?: string;
  canEdit?: boolean;
  handsBack?: string;
}

/** Everything the coordinator changed in the roles, saved by the engine. */
export interface RoleChanges {
  /** Built-in roles, by id: only the fields that differ from Petrina's defaults. */
  edits: Readonly<Record<Id, RoleEdit>>;
  /** Roles the coordinator added, in the order they were added. */
  added: readonly Role[];
}

export type Column = "backlog" | "queue" | "planning" | "designing" | "building" | "reviewing" | "ready" | "done";

export const COLUMNS: readonly Column[] = ["backlog", "queue", "planning", "designing", "building", "reviewing", "ready", "done"];

export type StageKind = "do" | "converge" | "review-chain" | "gate";

export type GateKind = "plan" | "design" | "delivery";

export interface ProfileAssignment {
  /** The profile requested by the person or agent making this assignment. */
  profileId: Id;
  by: "planner" | "coordinator" | "engine";
  reason?: string;
  changeReason?: string;
}

export interface Stage {
  id: Id;
  kind: StageKind;
  title: string;
  /** The doer, the author of a converge stage, or the reviewer role of a review chain. */
  roleId: Id;
  /** `do`: one profile. `converge`: the author. `review-chain`: the reviewers, in order. */
  profileIds: readonly Id[];
  assignments?: readonly ProfileAssignment[];
  /** `review-chain`: the role of each reviewer in `profileIds`, in order. Missing: `roleId`. */
  roleIds?: readonly Id[];
  /** `converge` only. */
  reviewerRoleId?: Id;
  reviewerProfileIds?: readonly Id[];
  reviewerAssignments?: readonly ProfileAssignment[];
  maxRounds?: number;
  gate?: GateKind;
}

export interface Plan {
  stages: readonly Stage[];
  rationale: string;
  plannerProfileId: Id;
  products?: readonly { productId: Id; builderProfileId: Id; reviewerProfileIds: readonly Id[] }[];
  leadProductId?: Id;
}

export type TaskKind = "new" | "feature" | "bug" | "chore";

/**
 * Where the task is in its run, separate from its board column.
 * - `queued`: in the queue, not started.
 * - `waiting`: started before, waiting for a free slot to continue.
 * - `running`: an agent is working.
 * - `needs-you`: blocked on the coordinator (question, permission, gate).
 * - `pr-open`: delivered; the pull request is open for the coordinator to merge on GitHub.
 */
export type RunState = "backlog" | "queued" | "waiting" | "running" | "needs-you" | "paused" | "failed" | "pr-open" | "done" | "cancelled";

export interface ActiveAgent {
  roleId: Id;
  profileId: Id;
  since: number;
  /** How far the agent is through its current step list. */
  step: number;
  /** Whether its commands run in its tool's own sandbox, and why not when they don't. Unset until its conversation opens. */
  sandbox?: { on: true } | { on: false; reason: string };
  /** Stable place in a grouped review, independent of a usage stand-in profile. */
  reviewKey?: string;
}

/** Only states actually reported by the harness. Missing means unreported. */
export type ToolInvocationStatus = "pending" | "in_progress" | "completed" | "failed";

/** Bounded diagnostic evidence, never rendered as app activity. */
export interface ToolInvocation {
  id: Id;
  turnId: Id;
  toolCallId: string;
  description: string;
  title?: string;
  kind: string;
  startedAt: number;
  updatedAt: number;
  status?: ToolInvocationStatus;
  /** Set only when the harness reports completion or failure. */
  endedAt?: number;
  /** Observation ended without a reported outcome; this does not mean completion. */
  turnEndedAt?: number;
  command?: string;
  paths?: readonly string[];
  metadataShortened?: boolean;
}

/** Small, plain-language state safe for live window updates. */
export interface AgentToolActivity {
  actionCount: number;
  roleId?: Id;
  profileId?: Id;
  productId?: Id;
  lastActivity?: string;
  runningTool?: Pick<ToolInvocation, "id" | "description" | "startedAt" | "status">;
}

export interface TimelineEntry {
  id: Id;
  at: number;
  roleId?: Id;
  profileId?: Id;
  productId?: Id;
  text: string;
  tone: "status" | "milestone" | "you" | "warn" | "done";
  /** The journey step it belongs to. */
  step?: Id;
}

export interface ReportImage {
  /** Opaque reference to a separate file in task history. */
  id: string;
  caption: string;
  /** The original report this picture was kept from, so a retry does not keep a second copy. */
  from?: { taskId: Id; imageId: string };
}

export interface SessionLine {
  id: Id;
  at: number;
  from: "agent" | "you" | "system" | "activity";
  roleId?: Id;
  profileId?: Id;
  productId?: Id;
  text: string;
  /** Links coordinator delivery status without copying the conversation into board activity. */
  coordinatorMessageId?: Id;
  /** The journey step it belongs to. */
  step?: Id;
  images?: readonly ReportImage[];
  /** Distinct invocation identity; streamed metadata updates this line in place. */
  toolInvocationId?: Id;
}

/** How an arrow out of a step reads: the work moved on, went back (a send-back, changes asked), or got stuck. */
export type JourneyTone = "on" | "back" | "stuck";

/** What a step of the coordinator's waits for: a check, the call on a disagreement, a stuck task, or interrupted shipping. */
export type JourneyWait = GateKind | "call" | "stuck" | "shipping";

/** Petrina's own work, with no agent: running the product's checks, finding main moved on, and publishing the delivery. */
export type JourneyWork = "checks" | "check-reuse" | "update" | "delivery" | "review-decision";

/** A question or permission request asked during a step, with how the coordinator answered. */
export interface JourneyAsk {
  /** The inbox item. */
  id: Id;
  kind: "question" | "permission";
  title: string;
  at: number;
  endedAt?: number;
  /** Answered, allowed, said no, decided for you, or withdrawn (a pause, a restart or cancelling dropped it). */
  how?: "answered" | "allowed" | "denied" | "decided" | "withdrawn";
  /** The answer, or the note with a "No". */
  answer?: string;
}

/**
 * One step of a task's journey, recorded by the engine (and the simulator) the moment it starts.
 * A new round, send-back or retry is a new step; picking up after a restart or a pause is the same one.
 */
export interface JourneyStep {
  /** The immutable blind-review input shared by this round, retained after temporary review state ends. */
  reviewInput?: NonNullable<Hunt["input"]>;
  /** Unique within the task. Timeline and session lines carry it. */
  id: Id;
  /** Why this step began, captured then rather than reconstructed from later task state. */
  trigger?: { after?: Id; reason: string };
  /**
   * `agent`: a role at work. `you`: waiting for the coordinator. `wait`: waiting for other tasks to land.
   * `petrina`: Petrina's own work, with no agent.
   */
  kind: "agent" | "you" | "wait" | "petrina";
  /** The plan stage it belongs to; none while planning. */
  stageId?: Id;
  /** The design or review round. */
  round: number;
  /** The design position: 0 the architect of a design round and 1 its reviewer. A review round's reviewers share one step. */
  sub: number;
  /** The builder fixing review findings or changes asked for at the delivery check. */
  fixing?: boolean;
  /** Findings assigned to this builder fix round. */
  findingIds?: readonly Id[];
  /** This step's saved evidence, independent of later rounds. Unmarked older findings are hand-back copies. */
  result?: {
    objections?: readonly Objection[];
    findings?: readonly Finding[];
    findingsSettled?: true;
    /** Recorded transitions; a settled reviewers' step covers the whole examination across retries. */
    findingChanges?: { raised: readonly Id[]; fixed: readonly Id[]; dismissed: readonly Id[]; reopened?: readonly { id: Id; evidence: boolean }[]; claimedFixed?: readonly Id[] };
  };
  /** Whether the builder continued its saved conversation or began a fresh one for this step. */
  builderConversation?: "resumed" | "new";
  /** Observed contents for this return, independent of the Builder's claims. */
  builderReturn?: { productId: Id; changed?: boolean; claimedFixes: number; outcome: string };
  /** Created with exact per-turn usage attribution enabled. Older steps may need time-based evidence. */
  usageTracked?: boolean;
  /** The builder bringing the work up to date with main. */
  update?: boolean;
  /** A review round that looks only at the builder's port of an already reviewed change onto a main that moved. */
  port?: boolean;
  /** The architect following the coordinator's call. */
  call?: boolean;
  roleId?: Id;
  /** The tool, model and effort. */
  profileId?: Id;
  /** Every agent on the step when several work at once (a review round's reviewers, its voters), `profileId` first. */
  team?: readonly Id[];
  /**
   * The positions the step expects a result from, recorded by the engine as it admits participants: a review
   * round's reviewer places (`reviewer:0`, `reviewer:1`) or a vote's places (`verifier:<place>`, see `JourneyAgentInput.place`).
   * Profiles that start or stand in fill these positions; a planned seat nobody started is still expected.
   */
  seats?: readonly string[];
  /** The role-specific context given to each agent in this step. Older saved steps have no snapshot. */
  agentInputs?: readonly JourneyAgentInput[];
  /** The original accepted response, plus any pictures saved with that response. `findings`: the finding records exactly as this seat's result left them; later peers and rounds never rewrite them. */
  agentResults?: readonly { roleId: Id; profileId: Id; at: number; value: unknown; inputIndex?: number; images?: readonly ReportImage[]; productId?: Id; versions?: Readonly<Record<Id, string>>; findings?: readonly Finding[] }[];
  /** Later steps that reused this step's run instead of running the checks again, with the basis for each reuse. */
  reuses?: readonly JourneyCheckReuse[];
  /** The product checks Petrina ran during this checks step. */
  productChecks?: readonly JourneyProductCheck[];
  /** Immutable run versions; unlike the repository's latest checks these survive subsequent runs. */
  checkAttempts?: readonly CheckAttemptEvidence[];
  /** Check-specific answers from a completed build result, bound before that repair started. */
  checkRepairs?: readonly CheckRepairEvidence[];
  buildVersions?: Readonly<Record<Id, string>>;
  buildProductId?: Id;
  /** Passed applicable review rounds, without any reviewer conclusions. */
  checkReviews?: readonly { productId: Id; tree: string; at: number; stageId: Id; round: number }[];
  /** Per seat, including finished members and usage replacements. */
  toolActivity?: Readonly<Record<string, AgentToolActivity>>;
  /** Recent calls across all seats, capped independently of lifetime action counts. */
  toolInvocations?: readonly (ToolInvocation & { seat: string; roleId: Id; profileId: Id; productId: Id })[];
  /** `petrina`: what Petrina did. */
  work?: JourneyWork;
  /** `you`: what it waits for. */
  waitsFor?: JourneyWait;
  /** `wait`: the tasks it waits for, named as they were then. */
  waitsOn?: readonly { id: Id; title: string }[];
  startedAt: number;
  endedAt?: number;
  /** How it ended: done, stuck, or stopped by cancelling. */
  end?: "done" | "failed" | "cancelled";
  /** What happened, in a few words: "Wrote the brief", "3 objections, 2 blocking", "Approved". */
  outcome?: string;
  /** Acceptance criteria and their result from this Tester run. */
  acceptanceChecks?: readonly JourneyAcceptanceCheck[];
  /** Why the work moved on from here: the words on the arrow out. */
  reason?: string;
  tone?: JourneyTone;
  asks?: readonly JourneyAsk[];
  /** Made up from the plan for a task that ran before journeys were recorded: no times or rounds. */
  legacy?: boolean;
}

export interface JourneyAcceptanceCheck {
  text: string;
  result: "pass" | "fail" | "blocked";
  reason?: string;
  /** The scenario and observed result, recorded by this acceptance run. */
  evidence?: string;
}

export interface JourneyProductCheck {
  id?: string;
  /** Shared by the commands prepared together, including a rerun on the same journey step. */
  attemptId?: string;
  queuedAt?: number;
  productId?: Id;
  findingId?: Id;
  namedFailures?: readonly { name: string; file?: string }[];
  /** Original run, including its complete diagnostic link. Never points to a later run. */
  run?: CheckRun;
  /** When saved evidence was selected; never an execution start. */
  reusedAt?: number;
  /** Original recorded attempt, including entries skipped without execution. */
  source?: CheckRun["source"];
  name: string;
  result: "pending" | "running" | "pass" | "fail" | "did-not-finish" | "stopped" | "skipped";
  startedAt?: number;
  endedAt?: number;
  /** A short diagnostic from the failed run, saved with the step for later review. */
  detail?: string;
}

export interface CheckAttemptEvidence {
  id: string;
  productId: Id;
  sha?: string;
  tree?: string;
  /** Product commands only; hook inputs deliberately do not define a peer match. */
  commands: readonly string[];
  definition: string;
  /** Every required command and hook passed on this exact version and definition. */
  passed?: boolean;
}

export interface CheckRepairEvidence {
  productId: Id;
  failureNode: Id;
  checkId: string;
  attemptId: string;
  findingId: Id;
  sha: string;
  tree: string;
  definition: string;
  commands: readonly string[];
  answer: { fixed: boolean; text: string };
}

/** A later step consumed this step's saved run because the code and check definitions were unchanged. */
export interface JourneyCheckReuse {
  at: number;
  /** The original attempt on its saved journey node, when recorded. */
  attemptId?: string;
  /** What the reused evidence was for. */
  purpose: "acceptance" | "review" | "delivery-check" | "publishing";
  productId?: Id;
  /** How the unchanged code was recognized. */
  basis: "same-tree" | "same-commit";
  originalAt: number;
  sha?: string;
  tree?: string;
  definition?: string;
  passed: boolean;
}

/** The exact text handed to an agent, saved once as an immutable file beside the complete-context files. */
export interface ExactMessage {
  file: string;
  digest: string;
  size: number;
}

/** One section of an exact message: its name, size and content identity, never its body. */
export interface InputManifestEntry {
  name: string;
  /** Distinguishes sections that share a name within one message. */
  occurrence?: number;
  size: number;
  digest: string;
  /** `reference`: an unchanged complete-context packet referenced instead of repeated. `omitted`: unchanged background left out of a continued conversation, recognized from recorded comparisons. */
  kind: "text" | "instructions" | "reference" | "omitted";
  file?: string;
  reference?: string;
}

/** The job and task context actually handed to one agent, captured before sending. */
export interface JourneyAgentInput {
  /** The bound repository and its recorded versions at this handoff; absent on older records. */
  productId?: Id;
  stepAttempts?: number;
  versions?: { base?: string; reviewed?: string; reviewedTree?: string; checks?: { at: number; sha?: string; tree?: string; definition?: string; passed: boolean; count: number; node?: Id } };
  reviewInput?: NonNullable<Hunt["input"]>;
  at?: number;
  roleId: Id;
  profileId: Id;
  /** Distinguishes reviewer seats even when their role and profile are identical. */
  reviewerKey?: Id;
  /** A vote's place, kept through usage replacements: its original planned profile, or `third:<profile>` for a third answer. */
  place?: string;
  requestedProfileId?: Id;
  selectionReason?: string;
  /** Settings confirmed by the native tool when this turn opened. */
  confirmedSettings?: { model?: string; modelName?: string; effort?: string };
  assignment?: ProfileAssignment;
  taskTitle: string;
  /** Present when this start included the task request; continued prompts only add updated context. */
  taskDescription?: string;
  stageTitle?: string;
  /** The role's job for this particular start, including runtime changes such as conflict repair. */
  instructions?: string;
  sections: readonly { title: string; body: string }[];
  /** Further instructions sent in this step: answers, repairs, messages and interruption resumes. */
  updates?: readonly { at: number; reason: TurnReason; text: string; messageId?: Id; delivery?: MessageDelivery["state"]; exact?: ExactMessage }[];
  mode: "fresh" | "continued";
  /** This continuation resumes an interrupted step, rather than starting a later step in the conversation. */
  resumed?: boolean;
  /** The complete opening text as sent, after context reduction and automatic additions. Absent on older records. */
  exact?: ExactMessage;
  /** The sections the opening text actually supplied, by name, size and identity. */
  manifest?: readonly InputManifestEntry[];
  /** Why a fresh conversation was needed instead of the saved one, when Petrina recorded it. */
  freshReason?: string;
  /** A saved conversation's bounded readiness recheck before this start: what was known, started or joined, and found. */
  readiness?: ReadinessRecheck;
  /** The native conversation this input went to. */
  sessionId?: string;
}

export interface QueuedMessage {
  id: Id;
  text: string;
  at: number;
  mode?: "now" | "queue" | "interrupt";
  /** Transcript recording survives pruning of the compact conversation. */
  recorded?: boolean;
  /** A grouped step keeps the message until every intended member has heard it. */
  recipients?: Readonly<Record<string, boolean>>;
  /** Durable receipts belong to the participant, across process and tool replacements. */
  deliveries?: Readonly<Record<string, MessageDelivery>>;
}

export interface MessageDelivery {
  state: "waiting" | "sending" | "accepted" | "applied" | "unconfirmed" | "skipped";
  via?: "prompt" | "live";
  toolId?: Id;
  sessionId?: string;
  reason?: "unsupported" | "rejected" | "separate-turn" | "unknown";
  /** An engine-owned recovery question, separate from the agent's own question. */
  decisionId?: Id;
}

/**
 * Something the coordinator said during a step. Saved the moment Petrina receives it and kept
 * until the step finishes, so an agent that starts the step again gets all of it.
 */
export interface StepNote {
  /** The queued message's id, when it also waits in `queued`. */
  id: Id;
  at: number;
  /** `changes`: the change request that sent the task into this step. */
  kind: "message" | "interrupt" | "answer" | "denied" | "changes";
  text: string;
  /** The question an answer answers, or what a "No" refused. */
  about?: string;
}

/**
 * The conversation an agent has open for a step. Saved the moment it opens, so after a restart the
 * agent picks up its own conversation. Removed when the step finishes or fails, or the coordinator
 * pauses, cancels or asks for changes; Petrina stopping keeps it. The Release Manager never has one.
 */
export interface BuilderContext {
  scope: string;
  file: string;
  digest: string;
  hashes: Readonly<Record<string, string>>;
  /** Exact records already supplied to this native reviewer conversation. */
  findingHashes?: Readonly<Record<Id, string>>;
}

export interface ConversationNote {
  /** Context supplied to this participant, available if its harness compacts history. */
  context?: BuilderContext;
  repositoryCopies?: Readonly<Record<Id, string>>;
  /** The step: its stage (or the plan), the design round and the reviewer position. */
  step: string;
  roleId: Id;
  profileId: Id;
  /** Builder's planned profile when this conversation opened, before any usage handoff. Older notes omit it. */
  plannedProfileId?: Id;
  toolId: Id;
  /** The model, as the tool takes it. */
  model: string;
  /** The tool's id for the conversation. */
  sessionId: string;
  /** The working copy's commit when the step first started. */
  head?: string;
  /** Actual committable contents before this Builder turn, retained across continuation and restart. */
  builderTree?: string;
  /**
   * What the step's agent may change, as it stood when the step first started. A restart keeps it,
   * so a role made read-only meanwhile never undoes work its agent already did.
   */
  access?: { canEdit: boolean; afterReview?: boolean };
  /**
   * The role as it stood when the step first started. Its agent keeps this version, wording and
   * name included, until the step finishes, restarts included: a change to the role reaches the next agent.
   */
  role?: Role;
  /** When the step first started. */
  startedAt: number;
  /** The question the agent is waiting on in this conversation, with the coordinator's answer once there is one. */
  asked?: { itemId: Id; question: string; answer?: string };
  /** The agent has shown it received its opening instructions. Only then can a restart reopen the conversation. */
  briefed?: boolean;
  /** The selected model was full. The next reopen of this conversation is a short continue, not the opening instructions. */
  capacityContinue?: boolean;
  /** The coordinator handed the step back: the note of what changed, until the agent hears it. */
  handback?: string;
  /** Engine boot that paused this conversation; restart remains a fresh attempt. */
  handbackBoot?: string;
  /**
   * The first wait for this conversation's uncertain tool readiness. A reopened conversation keeps it, restarts included,
   * until a completed turn saves the next continuation; a returning Builder's selection reads it.
   */
  readinessWait?: ReadinessWait;
}

/**
 * An agent asked for the coordinator's screen, for a check that needs the running app on it. Kept
 * until its step ends. The engine gives the screen to one agent at a time, first asked, first served.
 */
export interface ScreenRequest {
  /** Why, in the agent's words, kept short. Untrusted: shown as plain text only. */
  reason: string;
  /** When it asked. */
  at: number;
  roleId: Id;
  profileId: Id;
  /** The reviewer or voter within a parallel review round, when one asked. */
  member?: string;
  /** The coordinator's Allow now, for this request. */
  allowed?: boolean;
  /** The agent has the screen, from the moment it is given until its step ends. */
  granted?: boolean;
  /** The agent has been told it may use the screen. */
  heard?: boolean;
  /** Simulator only: how far through its step the agent was when it asked. */
  step?: number;
}

/**
 * The coordinator took over a step in their own terminal: the agent's own tool, on the same
 * conversation, in the task's working copy. The step is paused and keeps its seat in the pool.
 */
export interface Driving {
  repositoryCopies?: Readonly<Record<Id, { path: string; head: string }>>;
  since: number;
  roleId: Id;
  profileId: Id;
  toolId: Id;
  /** The working copy's commit when the coordinator took over. */
  head: string;
  /** The agent's unfinished work Petrina saved for it before the take-over, as one commit. */
  saved?: { sha: string; files: readonly string[] };
  /** The terminal Petrina opened, by name. Unset when the coordinator copied the command. */
  terminal?: string;
  /** Why the terminal did not open, in plain words. */
  problem?: string;
}

/** What Petrina publishes for a delivery, step by step. */
export type ShippingStep = "push" | "open" | "release" | "update";

/**
 * Petrina's own record of a delivery, saved before every step, so a restart, pause or cancel never
 * publishes twice. The work is already one commit on top of the latest default branch. A pull request's text is
 * the builder's; a release's version commit is Petrina's, and its notes the Release Manager's. Petrina publishes
 * the exact commit it checked.
 */
export interface ShippingRecord {
  /** A completed local branch update is distinct from its push to GitHub. */
  localUpdated?: string;
  /** The task's one commit this preparation started from, on top of `base`. */
  start?: string;
  /** The default branch's commit the work sits on: where Petrina expects it when it publishes. */
  base?: string;
  /** Releases: the version and tag worked out for this preparation, and the latest release then ("" for none). Petrina sets the version itself. */
  version?: string;
  tag?: string;
  after?: string;
  /** What Petrina checked and publishes. */
  prepared?: {
    /** The exact commit Petrina publishes: the work itself, or for a release the version commit on top of it. */
    tested: string;
    summary: string;
    title?: string;
    body?: string;
    notes?: string;
  };
  /** The step Petrina is on. Saved before the step starts; recovery looks the result up. */
  step?: ShippingStep;
  /** Which run of the engine saved the step, to tell a restart from a pause. */
  boot?: string;
  /** Releases: the push of the default branch and the tag went out, so its version and commit stay. */
  pushed?: boolean;
  /** Preparations started again because the default branch moved. */
  moves: number;
  /** Preparations that failed (the checks failing on the version commit). */
  failures: number;
  /**
   * A delivery a Petrina from before Petrina published deliveries saved while its delivery agent published it
   * with a GitHub login. Petrina cannot tell what went out, so it never acts on it by itself: nothing happens until
   * the coordinator chooses "It went out (mark as done)" or "Ship it again".
   */
  carriedOver?: true;
}

/** Navigation references only; no earlier agent's recommendations or inferred requirements. */
export interface SourcePointer {
  productId: Id;
  revision: string;
  path: string;
}

export interface DesignBrief {
  sourcePointers?: readonly SourcePointer[];
  summary: string;
  forUsers: readonly string[];
  areas: readonly string[];
  acceptance: readonly { text: string; productIds?: readonly Id[]; versions?: Readonly<Record<Id, string>>; met?: boolean; verification?: "passed" | "failed" | "blocked" | "stale"; reason?: string }[];
  risks: readonly string[];
}

export interface Objection {
  id: Id;
  round: number;
  text: string;
  blocking: boolean;
  raisedBy: Id;
  /** `noted`: a non-blocking point nobody decided on, kept as a follow-up. Never a default "rejected". */
  status: "open" | "accepted" | "rejected" | "noted";
  answer?: string;
  /** Settled by the coordinator's own decision (siding with the architect), not by an answer. */
  decidedBy?: "coordinator";
  /** The coordinator's words, when their call settled this objection. `answer` is then the architect's note on how the brief follows it. */
  call?: string;
}

/** Current-step working time, excluding time waiting on the coordinator. */
export interface StepClock { roleId: Id; repeat: boolean; worked: number; since?: number }

/** Finished step timing used for rough duration estimates. */
export interface StepRecord { roleId: Id; repeat: boolean; worked: number; at: number }

/** The coordinator's call on a design disagreement. It is final: the architect follows it and nobody reviews the design again. */
export interface DesignCall {
  /** The coordinator's own words. */
  text: string;
  /** The design stage that raised the disagreement. */
  stageId: Id;
  /** The objections that were open when the call was written. */
  open: readonly Id[];
  at: number;
}

/**
 * What a review found. `blocking` is shown as Important (must be fixed before it ships), `suggestion`
 * as Nit, and `pre-existing` is an old problem the change did not cause: a follow-up, never blocking.
 */
export interface Finding {
  id: Id;
  text: string;
  productIds?: readonly Id[];
  answers?: Readonly<Record<Id, { fixed: boolean; text: string; at: number }>>;
  where?: string;
  /** How the reviewer knows. */
  evidence?: string;
  severity: "blocking" | "suggestion" | "pre-existing";
  raisedBy: Id;
  /** The role of the reviewer who raised it, when it is not the code reviewer. */
  roleId?: Id;
  confirmedBy: readonly Id[];
  /** Later reviewers who think it is wrong, and why. */
  disputes?: readonly FindingDispute[];
  /** The outcome of checking an Important finding before it could send work back (see `VerifierPanel`). */
  verification?: FindingVerification;
  /** Each voter's verdict, when fresh agents voted on it. */
  votes?: readonly Vote[];
  /**
   * A completed ballot that still needed a third answer when no independent tool was ready to give one.
   * It stays Important without a verification, and its completed ballot is not repeated on unchanged evidence.
   * The reviewed commits, and their trees where recorded, tell whether a later reproduction is on changed code.
   */
  unresolved?: { at: number; reason: string; heads?: Readonly<Record<Id, string>>; trees?: Readonly<Record<Id, string>> };
  /** When a review reopened a fix or dismissal. Earlier support does not judge the new reproduction. */
  reopenedAt?: number;
  /** Evidence from before a finding was reopened, retained as history rather than current support. */
  earlierReviews?: readonly {
    at: number;
    /** The reproduction attached to the code before this reopening. */
    evidence?: string;
    confirmedBy: readonly Id[];
    disputes?: readonly FindingDispute[];
    verification?: FindingVerification;
    votes?: readonly Vote[];
    unresolved?: Finding["unresolved"];
    answer?: { fixed: boolean; text: string; at: number };
    resolution?: Finding["resolution"];
  }[];
  /** The builder's answer when the finding came back to it. */
  answer?: { fixed: boolean; text: string; at: number };
  status: "open" | "fixed" | "dismissed" | "unverified";
  /** Current-code proof that a reviewer verified an incidental repair of an older bug. */
  resolution?: { by: Id; evidence: string; at: number; versions: Readonly<Record<Id, string>> };
  /** How to see this again, in plain language. */
  steps?: string;
  /** An open follow-up card this matches, or "none" when it is none of the cards the reviewer was shown. */
  sameBug?: Id | "none";
  /** Follow-up cards Petrina listed when this report was saved. Absent when none were shown. */
  cardsShown?: readonly Id[];
  /** Each reviewer's tag, kept as they reported it. Matching never changes these. */
  judgments?: readonly { by: Id; severity: Finding["severity"]; at: number }[];
  /**
   * Where a confirmed older bug went once its task was done.
   * A task id names the bug task tracking it. A reason means it stayed on this task.
   */
  tracking?: { taskId: Id } | { reason: "missing-steps" | "missing-evidence" | "no-choice" | "unmatched" | "unavailable" | "pictures"; retry?: boolean };
}

export type RiskLevel = "low" | "medium" | "high";

/** A line the coordinator accepted for the repository's review guide or AGENTS.md. */
export interface GuideLine {
  text: string;
  at: number;
  /** The task it came from. */
  fromTask: Id;
  /** The task whose branch adds it to the file. */
  writtenOn?: Id;
  /** The default-branch commit that already contains a review rule; older task bases still need it as context. */
  incorporatedOn?: string;
}

/** Something an agent learned about working in the repository, waiting for the coordinator at the delivery check. */
export interface Lesson {
  text: string;
  roleId: Id;
  profileId: Id;
  at: number;
}

/** One review round's parallel work: each reviewer's findings as they arrive, then each voter's verdicts. */
export interface Hunt {
  /** Current-round explicit resolution/confirmation reports; settled only after all reviewer seats finish. */
  findingChecks?: Readonly<Record<Id, Readonly<Record<Id, { by: Id; resolved: boolean; evidence?: string }>>>>;
  stageId: Id;
  round: number;
  /** Immutable round inputs and prepared repository evidence. Bodies stay outside live window state. */
  input?: { file: string; digest: string; heads: Readonly<Record<Id, string>>; trees?: Readonly<Record<Id, string>> };
  /** Per reviewer position in the stage, what it reported. */
  reported: Readonly<Record<Id, true>>;
  /** Each reviewer position’s verdict on repaired shared findings, settled only after everyone reports. */
  fixReviews?: Readonly<Record<Id, Readonly<Record<Id, boolean>>>>;
  /** The profile reserved or actually used at each position, kept after reporting and across restarts. */
  profiles?: Readonly<Record<Id, Id>>;
  /** Parallel agents that asked for the screen: their copies and conversations survive the wait. */
  screenTurns?: Readonly<Record<string, { reason: string; at: number; copy: string; copies?: Readonly<Record<Id, string>>; conversation: ConversationNote; allowed?: boolean }>>;
  /** Per actual voter profile, whether it finished the round's findings. Older records used planned profiles. */
  voted?: Readonly<Record<Id, true>>;
  /** Older rounds' required ballot seats, one per tool, kept with their majority rule until they finish. */
  voterProfiles?: readonly Id[];
  /** An older round's voter seat replaced on a different independent tool; accepted partial votes stay. */
  voterReplacements?: Readonly<Record<Id, { from: Id; reason: string }>>;
  /** The verifier panel saved when voting began, with every place it still requires. */
  panel?: VerifierPanel;
  /** How many findings the task had when the round began: what the round's reviewers raise comes after. */
  findings?: number;
  /** Each parallel agent's starting role, by reviewer place or voter profile, through interruptions. */
  roles?: Readonly<Record<string, Role>>;
  /** Unfinished reviewers and voters, each with its own summary and working time. */
  work?: Readonly<Record<string, ReviewWork>>;
}

export interface ReviewWork {
  todo?: string;
  activity?: string;
  /** This agent's tool is retrying its turn by itself. Only this agent's own fresh work or turn end clears it. */
  retrying?: string;
  toolActivity?: AgentToolActivity;
  clock?: StepClock;
  attempts: number;
  waiting?: string;
}

/** One voter's verdict on an Important finding. */
export interface Vote {
  by: Id;
  /** The actual independent tool. Absent in older votes whose planned attribution cannot prove who ran. */
  toolId?: Id;
  plannedProfileId?: Id;
  verdict: FindingVerification["verdict"];
  reason: string;
  /** The ballot it answered: review stage, round, reviewed versions and panel place. Older votes have none. */
  ballot?: { stageId: Id; round: number; seat: string; versions?: Readonly<Record<Id, string>> };
}

/**
 * Who verifies a round's Important findings. `bounded`: two fresh verifiers on different actual tools (one when only one
 * is usable), chosen from the tools usable when the panel was saved; any real answer keeps a finding Important, and a
 * finding both call not blocking gets a third independent answer when that saved set had a third tool. `majority`: an
 * older round's panel of one voter per tool, settled by its original rule until it finishes.
 */
export interface VerifierPanel {
  rule: "bounded" | "majority";
  /** Actual tools usable when the panel was chosen, in stable order. Later recovery or registration never enlarges it. */
  usable: readonly Id[];
  /** Each finding's author tool the selection avoided where it could; unknown attribution is absent. */
  authors?: Readonly<Record<Id, Id>>;
  /** Every place the panel requires, in admission order. */
  seats: readonly VerifierSeat[];
  /** When the initial places finished and targeted third answers were decided. */
  escalatedAt?: number;
  /** Why a finding needed a third answer, or why none could be had, by finding id. */
  escalations?: Readonly<Record<Id, { reason: string; unresolved?: true }>>;
}

/** One required verifier place: its own identity, assigned finding ids and the tool currently planned for it. */
export interface VerifierSeat {
  /** Never reused within the panel. Votes name it, so a tool answering twice is never mistaken for one place. */
  key: string;
  /** The planned profile; a usage replacement on another tool takes the place over. */
  profileId: Id;
  toolId: Id;
  findingIds: readonly Id[];
  /** A targeted third answer, admitted as its own step once the initial places finished. */
  third?: true;
  /** Why this place was chosen, in plain words. */
  reason: string;
  /** The place's replacement on another independent tool; accepted answers remain attributed to who gave them. */
  replaced?: { from: Id; reason: string };
}

export interface FindingVerification {
  /** The verifier's profile. */
  by: Id;
  verdict: "real" | "not-a-bug" | "nit" | "pre-existing";
  reason: string;
  at: number;
}

export interface FindingDispute {
  /** The profile of the reviewer who disputed it. */
  by: Id;
  reason: string;
  at: number;
}

/** What a role that hands back notes handed back. Every later agent on the task reads it. */
export interface HandedBack {
  /** The product an editing role worked on; absent for shared, read-only notes. */
  productId?: Id;
  stageId: Id;
  roleId: Id;
  profileId?: Id;
  at: number;
  roleName?: string;
  title?: string;
  summary: string;
  notes: readonly string[];
}

export interface PullRequest {
  number: number;
  url: string;
  /** `closed`: closed on GitHub without merging. */
  state: "open" | "merged" | "closed";
  openedAt: number;
}

/** Removing a finished task's working copy. The branch, the history and the delivery details stay. */
export interface Cleanup {
  /** The coordinator ended an unconfirmed delivery; later lookups do not erase that decision. */
  markedDone?: boolean;
  /** An uncertain delivery marked done still needs its branch checked for an open pull request. */
  pullRequest?: "unconfirmed" | "none";
  /** The exact work and destination checked before an interrupted delivery was marked done. */
  checkedDelivery?: { tested: string; base: string };
  /** An unrelated open pull request still using the branch needs its copy, without claiming delivery. */
  foreignPullRequest?: { number: number; url: string };
  /** When the folder and the repository's record of it were both gone. */
  removedAt?: number;
  /** Parallel reviewers' folders and Git records were checked too, including crash leftovers. */
  reviewCopiesRemovedAt?: number;
  /** Why the last try failed, in plain words. Petrina tries again. */
  error?: string;
}

export interface WorkRow {
  choice: WorkChoice;
  previous?: WorkChoice;
  change?: "added" | "changed" | "omitted";
  source?: TaskSource;
  error?: string;
  addition?: { name: string; path: string; productId: Id; created?: boolean; ready?: boolean };
}

export { REPOSITORY_FIELDS } from "./task-model.js";
export type { RepositoryState, RepositoryField, TaskRepository, TaskRequest, TaskScopeState, TaskProgress, TaskDesignState, TaskReviewState, TaskAcceptanceState, TaskActivity, TaskHistoryState, TaskState, Task } from "./task-model.js";


/**
 * `shipping`: a delivery was interrupted, and Petrina could not tell whether it went out, or found something
 * else there. `driving`: the coordinator took over a step in their terminal.
 * `screen`: an agent waits for the coordinator's OK to use the screen. Quiet: listed last, never a notification.
 */
export type InboxKind = "maintenance-settings" | "question" | "permission" | "plan" | "design" | "disagreement" | "delivery" | "stuck" | "shipping" | "driving" | "guide" | "learnings" | "screen";

export interface InboxItem {
  productId?: Id;
  id: Id;
  taskId: Id;
  kind: InboxKind;
  title: string;
  body?: string;
  options?: readonly string[];
  /** Raw detail for the curious, e.g. the exact command behind a permission. */
  detail?: string;
  roleId?: Id;
  profileId?: Id;
  at: number;
  /** The asking agent keeps its slot while it waits. */
  blocking: boolean;
  /** Member asking in grouped review. */
  reviewKey?: string;
  /** A Stuck item about a tool that is not ready or would not start: the item shows that tool's fix, and Retry checks it again first. */
  toolId?: CheckId;
  /** With `toolId`: what was wrong with the tool when the item was raised. */
  toolProblem?: "not-installed" | "logged-out" | "wont-start";
}

/**
 * What "ready" means for a product.
 * - `pull-request`: push the work's one commit and open a pull request (never merged by Petrina).
 * - `release`: push the work with a version commit to the default branch, with a new version tag, and publish a GitHub release.
 * - `local`: advance the approved branch in the local copy and push the tested work to its saved GitHub address. Commit to main does the same for the default branch.
 * Petrina publishes, and sets a release's version itself; the only agent at delivery is the Release Manager, writing a release's notes.
 */
export type DeliveryMode = "pull-request" | "release" | "local";

export interface Product {
  id: Id;
  name: string;
  /** owner/name on GitHub. */
  repo: string;
  /**
   * The address Petrina fetches from and publishes to, exactly as configured when the product was added
   * (no address rewrites). Products added before Petrina kept it ask the coordinator once.
   */
  remote?: string;
  /** An address the coordinator said is wrong: no fetching or publishing with it. */
  remoteRefused?: string;
  tone: Tone;
  /** The local clone Petrina makes worktrees from. */
  path?: string;
  defaultBranch?: string;
  delivery?: DeliveryMode;
  /** Ask the coordinator before delivering. Defaults to true. */
  approveDelivery?: boolean;
  /** Which part of the version a release bumps. Defaults to patch. */
  releaseBump?: "patch" | "minor" | "major";
  /** With "ask before shipping" on: low-risk work ships without asking. Off unless the coordinator opts in. */
  shipLowRisk?: boolean;
  /** Lines the coordinator accepted for the review guide (REVIEW.md). Reviewers see them at once; Petrina adds them to the file. */
  reviewGuide?: readonly GuideLine[];
  /** Lessons accepted for AGENTS.md, until their incorporation in the default branch is confirmed. */
  learnings?: readonly GuideLine[];
  /** Lessons the coordinator said no to (declined or left unticked): never offered again. */
  learningsDeclined?: readonly string[];
  /** The commands that prove this product works. Petrina runs them itself; unset until found. */
  checks?: readonly ProductCheck[];
  /** Who set the checks: the Check finder agent, or the coordinator by hand (never replaced on its own). */
  checksBy?: "finder" | "coordinator";
  /** A fingerprint of the CI and build files the finder read: when they change, it looks again. */
  checksFingerprint?: string;
  /** What the Check finder found for each recent set of CI and build files: tasks on different bases each reuse theirs. */
  checksSeen?: readonly { fingerprint: string; checks: readonly ProductCheck[] }[];
  /** The repository's own commit hooks (pre-commit, commit-msg) as git would run them: Petrina runs them on every task's change. */
  hooks?: readonly string[];
}

/** One command that proves a product works, run as an argument array (never through a shell). */
export interface ProductCheck {
  name: string;
  argv: readonly string[];
  /** Why this command, in plain words (for example: "CI runs it on every pull request"). */
  why?: string;
}

/** What really happened when Petrina ran a check. */
export interface CheckRun {
  name: string;
  command: string;
  ok: boolean;
  ms: number;
  startedAt?: number;
  endedAt?: number;
  source?: { stepId: Id; attemptId: string; checkId: string };
  /** Confirmed machine event overlapping this execution, not an inferred failure cause. */
  interruption?: { source: "macOS power log"; at: number; event: string };
  /** The end of the command's output, as plain text. */
  output: string;
  /** Private complete output on this machine, independent of the working copy and prompt excerpt. */
  logPath?: string;
  /** Identity captured from the file Petrina opened for this check; absent on older saved runs. */
  logFileIdentity?: { device: string; inode: string };
  /** Settled length in bytes, read through that same opened file; absent on older saved runs. */
  logFileLength?: number;
  /** SHA-256 of that file's first 4,096 bytes (or all of a shorter file): bounded recognition, not proof of later bytes. */
  logFileBeginning?: string;
  /** The log could not be saved completely; this never changes the command's own result. */
  logError?: string;
  /** Whether both output pipes reached their end before the command settled. Absent on older runs. */
  logComplete?: boolean;
  interrupted?: boolean;
  timedOut?: boolean;
  /** Petrina could not obtain a process-tree snapshot while stopping this command. */
  cleanupIncomplete?: boolean;
}

/** What a tool last said about its usage limit: "allowed_warning" means it is close, "rejected" means it is out. */
export type UsageStatus = "allowed" | "allowed_warning" | "rejected";

/** The latest report from a tool for one kind of limit (five hours, a week, one model's week). */
export interface UsageReport {
  toolId: Id;
  /** Set when the report is about one model family only (for example "opus"). */
  model?: string;
  /** Which limit: "five_hour", "seven_day", "seven_day_opus", and so on. */
  kind: string;
  status: UsageStatus;
  /** How much of the limit is used, from 0 to 1, when the tool says. */
  utilization?: number;
  /** Codex reports each window’s length and, sometimes, its name. */
  windowMinutes?: number;
  name?: string;
  /** When the limit resets (milliseconds), when the tool says. */
  resetsAt?: number;
  /** The window is used up and the tool goes on, on usage paid beyond the plan (Claude Code's extra usage): spent, not out. */
  overage?: boolean;
  at: number;
}

/** A tool, or one model family of it, that is out of usage until a time. */
export interface UsageLimit {
  toolId: Id;
  model?: string;
  /** Keep an actual request refusal separate from a restriction inferred from account readings. */
  source?: "report" | "refusal";
  /** Milliseconds. */
  until: number;
  /** Plain words, for example "Claude Code's weekly Opus limit". */
  reason: string;
  /** A request was refused without a reset time. `until` is Petrina's retry time, not a reported reset. */
  retry?: boolean;
  /** When the tool reported that it was out. Missing in older saved state. */
  at?: number;
}

export interface Pool {
  limit: number;
  paused: boolean;
  toolCaps: Readonly<Record<Id, number>>;
  /** The latest report per tool and kind of limit. */
  usage?: readonly UsageReport[];
  /** Account refresh attempts, separate from the age of the last successful usage report. */
  usageReads?: Readonly<Record<Id, { at: number; state: "reading" | "reported" | "unavailable" }>>;
  /** Who is out of usage right now. Entries are dropped when their time has passed. */
  limited?: readonly UsageLimit[];
  /** "Agents may use the screen". Unset is Off. */
  screen?: ScreenUse;
}

/** Off (the default), For an hour, or On. */
export type ScreenMode = "off" | "hour" | "on";

export interface ScreenUse {
  mode: ScreenMode;
  /** When For an hour turns off. */
  until?: number;
}

/** A terminal Petrina can open a take-over in. */
export interface Terminal {
  id: Id;
  name: string;
}

export interface State {
  routines?: readonly import("./routines.js").Routine[];
  /** Short engine-owned conversations, counted in the same pool as task agents. Cleared on restart. */
  backgroundAgents?: readonly { id: Id; roleId: Id; profileId: Id; label: string; since: number }[];
  /** Compact totals and recent durations for finished work, fetched separately from the board. */
  history?: import("./history.js").HistoryMetadata;
  now: number;
  seq: number;
  products: readonly Product[];
  /** Every role: the built-in ones as the coordinator left them, then the ones they added. */
  roles: readonly Role[];
  /** What the coordinator changed in the roles. `roles` is built from it. */
  roleChanges?: RoleChanges;
  tools: readonly Tool[];
  profiles: readonly AgentProfile[];
  /** Removed profile definitions remain readable for historical records, never offered for new work. */
  retiredProfiles?: readonly AgentProfile[];
  /** Defaults initialize once; saved edits and deletions survive restarts. */
  profileCatalogSaved?: boolean;
  tasks: readonly Task[];
  inbox: readonly InboxItem[];
  pool: Pool;
  /** First run and the tools check. Absent in the demo and from older engines: no first run. */
  setup?: Setup;
  /** The terminals found on this machine, the usual one first. Unset in the demo. */
  terminals?: readonly Terminal[];
  /** The terminal the coordinator chose for take-overs. Unset: the usual one. */
  terminal?: Id;
  /** The work log's counter and when tracking began. Never the log itself. */
  work?: WorkInfo;
  /** The profile the planner runs on, so a task's journey can name it before it starts. */
  planner?: Id;
  /**
   * Follow-up links that are decided but not finished, or waiting because matching could not run.
   * Kept here so a restart can finish them without reading every finished task.
   */
  followUpPending?: readonly { keys: readonly string[]; cardId?: Id; retry?: boolean }[];
}
