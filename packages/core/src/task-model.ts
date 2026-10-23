// Task state is grouped by owner and lifetime. These interfaces keep one persisted shape;
// composing them does not introduce projection copies or a second schema.
import type { AcceptanceGap, ActiveAgent, BuilderContext, CheckRun, Cleanup, Column, ConversationNote, DesignBrief, DesignCall, DeliveryMode, Driving, Finding, HandedBack, Hunt, Id, InboxKind, JourneyStep, Lesson, Objection, Plan, PullRequest, QueuedMessage, RiskLevel, RunState, ScreenRequest, SessionLine, ShippingRecord, SourcePointer, StepClock, StepNote, StepRecord, TaskKind, TimelineEntry, WorkRow } from "./model.js";
import type { PullRequestBackground, TaskSource, WorkChoice } from "./source.js";
import type { ReadinessWait } from "./readiness.js";

/** Execution state owned by exactly one product repository. */
export interface RepositoryState {
  workChoice?: WorkChoice;
  workProduct?: TaskSource["product"];
  source?: TaskSource;
  prBackground?: PullRequestBackground;
  tamper?: { at: number; sha: string; problems: readonly string[] };
  productId: Id;
  /** What happens once the work is ready. Defaults to the product's setting. */
  delivery: DeliveryMode;
  /** The last time Petrina ran the product's checks on this task, and on which commit. */
  /** The tree is the code itself: a squash keeps it, so the checks still count. */
  /** The definition covers commands and hook inputs, separately from the code. */
  checks?: { current?: boolean; at: number; sha?: string; tree?: string; definition?: string; results: readonly CheckRun[]; provenance?: { nodeId: Id; attemptId: string } };
  /**
   * Automatic Builder returns in the current check failure episode, twice at most. Only a passing run of every
   * check and hook on the current code and check definitions ends the episode and clears it.
   */
  checkReturns?: number;
  /** The base's commit when the working copy was made: reviews, the tamper check and the review guide go by it, whatever later happens to refs. */
  baseSha?: string;
  /** The commit the last review round looked at: later rounds review only what changed since. */
  reviewedSha?: string;
  /** The exact code that completed code review, including any later reviewed port. Missing on older tasks: they receive ordinary review. */
  reviewedTree?: string;
  /** The commit the delivery check showed the coordinator, and the one they approved. */
  checkedSha?: string;
  approvedSha?: string;
  /**
   * The change itself as the delivery check showed it, and as approved (git's patch-id): main moving on
   * underneath keeps it, so only a change to the work itself asks the coordinator again.
   */
  checkedPatch?: string;
  approvedPatch?: string;
  /**
   * Who allowed the delivery (the coordinator at the delivery check, or the task's own setting to ship
   * without asking) and for what: this delivery mode and destination only. Nothing an agent says counts.
   */
  approvedFor?: { by: "coordinator" | "task"; mode: DeliveryMode; destination: string };
  /**
   * Main moved on and the task's change no longer applies cleanly: the working copy is on main with the
   * change applied and these files conflicting, until the builder brings it up to date.
   * `head` permits a port review only when `reviewedTree` records a completed review of that exact code.
   */
  updating?: { from: string; onto: string; head?: string; files: readonly string[]; notes?: readonly string[] };
  /**
   * The builder ported the change onto a main that moved: the change itself was reviewed already (its version
   * `head` on `from`), so the next review round looks only at the port, in `files`, with one reviewer.
   */
  portReview?: { from: string; head: string; onto: string; files: readonly string[] };
  /** What agents learned about working in the repository during this task, offered to the coordinator at the delivery check. */
  lessons?: readonly Lesson[];
  /** Petrina is running the repository's pre-commit hook, with the working copy's HEAD detached at the base: a restart puts it back. */
  hooking?: boolean;
  /** Final acceptance failures return to the builder twice, then wait for the coordinator. */
  acceptanceReturns?: number;
  /** The builder's own conversation from its last step: fix rounds and updates go back to it. */
  builderSession?: { stageId: Id; profileId: Id; plannedProfileId?: Id; toolId: Id; model: string; sessionId: string; context?: BuilderContext; rethought?: boolean; readinessWait?: ReadinessWait };
  pr?: PullRequest;
  /** The task's own branch and working copy. */
  branch?: string;
  worktree?: string;
  base?: string;
  /** Set once the task is finished and Petrina has removed (or is trying to remove) its working copy. */
  cleanup?: Cleanup;
  /**
   * What the builder reported, in plain language: its one-line commit title, and a pull request's description,
   * which Petrina publishes as the builder wrote it.
   */
  report?: { summary: string; changes: readonly string[]; tests?: string; title?: string; description?: string };
  /** Set when a `release` product published this task. */
  release?: { tag: string; url: string };
  /** Set when commit delivery advanced the approved branch and confirmed its push, if it has GitHub. */
  landed?: { branch: string; sha: string };
  /** Full confirmed delivery identity for evidence inclusion, separate from display labels. */
  confirmedDelivery?: { sha: string; tree: string; repo: string; branch: string; at: number };
  /** The destination was advanced locally; its push is a separate, possibly unfinished step. */
  localUpdate?: { branch: string; sha: string; pushed: boolean };
  /** How many times the current step has started. */
  stepAttempts?: number;
  /** Admitted editable work owns this copy until its step completes, including a failed partial attempt. */
  editAttempt?: { step: string; failed?: boolean };
  /** The conversation the current step's agent has open, so it can pick it up after a restart. */
  conversation?: ConversationNote;
  /** Main-step bookkeeping retained durably while an internal errand owns the current conversation. */
  sideStep?: { roleId: Id; conversation?: ConversationNote; stepAttempts?: number; todo?: string; stepClock?: StepClock };
  /** Set while the task is being shipped. */
  shipping?: ShippingRecord;
  releasePreview?: { start: string; base?: string; version: string; tag: string; after: string; notes: string; summary: string };
  /** Exact version-only commit verified by Petrina, retained through shared release completion. */
  proofRelease?: { start: string; tested: string };
}

/** These fields belong to one repository, never to a whole shared task. */
export const REPOSITORY_FIELDS = [
  "productId", "workChoice", "workProduct", "source", "prBackground", "delivery",
  "worktree", "branch", "base", "baseSha", "checks", "checkReturns", "reviewedSha", "reviewedTree",
  "checkedSha", "checkedPatch", "approvedSha", "approvedPatch", "approvedFor", "updating", "portReview",
  "lessons", "hooking", "tamper", "builderSession", "report", "pr", "release", "landed", "localUpdate", "shipping",
  "cleanup", "conversation", "sideStep", "stepAttempts", "editAttempt", "acceptanceReturns", "releasePreview", "confirmedDelivery", "proofRelease"
] as const;
export type RepositoryField = typeof REPOSITORY_FIELDS[number];
export type TaskRepository = RepositoryState & {
  completedStages: readonly Id[];
  preparation?: "waiting" | "ready";
  preparingCopy?: { path: string; branch: string; base: string };
  nothingToPublish?: boolean;
  landingAccepted?: { at: number };
  companion?: { text: string; state: "pending" | "checking" | "done" };
  removed?: boolean;
};

/** The request and coordinator choices. They survive every step and restart. */
export interface TaskRequest {
  maintenance?: import("./routines.js").MaintenanceRun;
  id: Id;
  /** The requested product; execution may currently belong to another approved product. */
  productId: Id;
  /** Requested default; each repository retains its approved delivery. */
  delivery: DeliveryMode;
  workChoice?: WorkChoice;
  title: string;
  description: string;
  /** A short noun for the part of the product the task touches, used in plain-language lines. */
  area: string;
  kind: TaskKind;
  createdAt: number;
  /** The window's id for the request that added it: sending it again after a lost reply finds this task instead of adding another. */
  clientId?: Id;
  approvePlan: boolean;
  /** Ask the coordinator before Petrina delivers. */
  approveDelivery: boolean;
}

/** Proposed and approved product scope. Repository execution records are independent owners. */
export interface TaskScopeState {
  /** Canonical execution record for a single-product task; top-level repository fields are a display view. */
  repository?: RepositoryState;
  /** Retained coordinator choices and the complete validated scope, before any fetching. */
  selectedProducts?: readonly WorkChoice[];
  workRows?: readonly WorkRow[];
  repositories?: readonly TaskRepository[];
  excludedRepositories?: readonly TaskRepository[];
  leadProductId?: Id;
  /** Product assigned to the current step. Operations retain their own repository context across waits. */
  activeProductId?: Id;
  repair?: {
    products: readonly Id[];
    index: number;
    returnStage: number;
    kind: "checks" | "acceptance" | "review";
    /** Owners added only to port conflicts, without an owed findings repair. Other owners retain their original repair. */
    portProducts?: readonly Id[];
  };
  /** Explicit New task choices stay authoritative until the coordinator approves a change. */
  explicitStart?: boolean;
  proposedSource?: TaskSource;
  workProposal?: readonly WorkChoice[];
  workError?: string;
  confirmWork?: boolean;
  workValidating?: boolean;
  approvalExplanation?: string;
  sharedLessons?: readonly Lesson[];
}

/** Queue membership and progress through the plan. A waiting task owns no new work. */
export interface TaskProgress {
  /** Window summaries omit histories; full details are fetched only for the open task. */
  detailsOmitted?: boolean;
  detailsRevision?: string;
  /** Position in the queue. Lower starts first. */
  priority: number;
  held: boolean;
  /** Tasks that must land first; until then this one waits quietly (a cancelled one no longer blocks). */
  after?: readonly Id[];
  /** A coordinator's explicit hold on new work after this task has started. */
  runtimeWait?: RuntimeWait;
  state: RunState;
  column: Column;
  /** Whether the task currently occupies a pool slot. */
  holdsSlot: boolean;
  plan?: Plan;
  /** Optional locations actually inspected during planning, verified again before handoff. */
  sourcePointers?: readonly SourcePointer[];
  /** -1 while the planner runs, then the index into `plan.stages`. */
  stageIndex: number;
  /** Rounds per stage id. */
  rounds: Readonly<Record<Id, number>>;
  /** `converge`: 0 author, 1 reviewer. `review-chain`: reviewer index. */
  sub: number;
  /** The builder is fixing review findings. */
  fixing: boolean;
  /** How much could go wrong, as the planner rated it from what the task touches. Sets review depth and the delivery check. */
  risk?: { level: RiskLevel; why: string };
  startedAt?: number;
  finishedAt?: number;
  deliveryRecorded?: boolean;
}

/** Every coordinator decision is retained; release never rewrites the task's attempt history. */
export interface RuntimeWaitChange {
  at: number;
  before: readonly Id[];
  after: readonly Id[];
  reason: string;
  requestId?: Id;
  /** Links the bounded ordinary timeline entry to this permanent audit record. */
  timelineId?: Id;
}

export interface RuntimeWait {
  after: readonly Id[];
  reason: string;
  /** Retained names keep unavailable prerequisites and earlier decisions understandable. */
  titles?: Readonly<Record<Id, string>>;
  changes: readonly RuntimeWaitChange[];
  releasedAt?: number;
  releaseReason?: string;
  /** Before admitting a new step, bring every repository onto its current starting source. */
  refreshPending?: boolean;
  /** Owners still owed a source check; a pending conflict port retains its obligation until it finishes. */
  refreshProducts?: readonly Id[];
  /** An already-started step finishes on its own version before the refresh. */
  refreshAfterStep?: string;
}

/** The shared design and independent participant conversations. A coordinator call remains final. */
export interface TaskDesignState {
  brief?: DesignBrief;
  objections: readonly Objection[];
  /** The coordinator's call on a disagreement. It stays, so no later design check reopens the design it settled. */
  call?: DesignCall;
  /** Separate completed design conversations per stage, participant and product. Never shared between author and reviewer. */
  designSessions?: Readonly<Record<string, { scope: string; plannedProfileId: Id; profileId: Id; toolId: Id; model: string; sessionId: string; context?: BuilderContext; briefDigest?: string; freshReason?: string; readinessWait?: ReadinessWait }>>;
  /** Changes were asked at this design check: earlier checks of the same design pass by themselves on the way back to it. */
  returnToCheck?: number;
  designRevision?: number;
}

/** Review evidence and convergence across the complete reviewer group. */
export interface TaskReviewState {
  findings: readonly Finding[];
  /** Accepting unresolved review permits final verification, never publishing or another automatic review round. */
  reviewDecision?: { stageId: Id; round: number; accepted: boolean };
  /** Completed conversations belong to one stage and reviewer seat, never to voters or peers. */
  reviewSessions?: Readonly<Record<Id, Readonly<Record<Id, {
    scope: string;
    round: number;
    plannedProfileId: Id;
    profileId: Id;
    toolId: Id;
    model: string;
    sessionId: string;
    context?: BuilderContext;
    /** Immutable bases this seat last reviewed; older saved seats start fresh once. */
    bases?: Readonly<Record<Id, string>>;
    freshReason?: string;
    /** This seat's first wait for its tool's uncertain readiness; the next completed review replaces it. */
    readinessWait?: ReadinessWait;
  }>>>>;
  /** Per stage and seat, why its saved conversation was dropped (a conflict port), kept through pauses and restarts until that seat next starts. */
  reviewFreshReasons?: Readonly<Record<Id, Readonly<Record<Id, string>>>>;
  /** A review round's parallel work so far, so a restart only redoes what had not finished. */
  hunt?: Hunt;
  /** Per review stage, how many Important findings were open at the end of each round: whether it still converges. */
  blockingAfter?: Readonly<Record<Id, readonly number[]>>;
  /** The blocking findings still open after each review round, to tell fixes from newly discovered issues. */
  blockingFindingsAfter?: Readonly<Record<Id, readonly (readonly Id[])[]>>;
  /** The coordinator sent the delivery back with this note: the Guide keeper looks for what reviewers missed. */
  miss?: { note: string; at: number };
  /** How many times the coordinator sent a delivery back after every reviewer had passed it. */
  sentBack?: number;
  /** Cards listed to each reviewer, so a missing choice stays a missing choice after a restart. */
  shownFollowUps?: Readonly<Record<string, readonly Id[]>>;
  /** Files changed by hand that no review chain has looked at from its first reviewer yet. Nothing ships while set. */
  handChanges?: boolean;
  /** The review chain that runs again from its first reviewer once the step the coordinator drove finishes. */
  rereview?: Id;
}

/** Acceptance of the tested versions. Unavailable probes remain distinct from reproduced failures. */
export interface TaskAcceptanceState {
  /** Explicit reviewer requests, owned by final acceptance, separate from defect findings. */
  proofRequests?: readonly ProofRequest[];
  /** Each product's own patch at the latest completed acceptance run. */
  testedChanges?: Readonly<Record<Id, string>>;
  /** Main-only final acceptance refreshes in this delivery attempt. */
  proofRefreshes?: number;
  proofRefreshBlocked?: boolean;
  proofRetestReason?: "requested" | "main-moved" | "code-changed";
  /** Added only when requested proof, or required acceptance that could not be verified, needs the delivery check in a plan that omitted it. */
  proofDeliveryGate?: Id;
  /** One in-flight Tester run, retained across pause, restart and profile handoff. */
  acceptanceRun?: NonNullable<JourneyStep["proofRun"]>;
  /**
   * Set from an acceptance agent's start until its cleanup is over, to that cleanup's own identity: a later start
   * trusts the run only with the record that cleanup left, never one an earlier cleanup of the same run left.
   */
  acceptanceCleanupPending?: string;
  checkedProofDecision?: ProofDecision;
  approvedProofDecision?: ProofDecision;
  /** The required acceptance gap the coordinator explicitly approved delivery with; automatic authorization never sets it. */
  approvedAcceptanceGap?: AcceptanceGap;
  /** The change (its fingerprint) the tester last tried: fix rounds are reviewed, and the tester tries the final code once more before the delivery check. */
  testedPatch?: string;
  testedVersions?: Readonly<Record<Id, string>>;
  /**
   * Whether that acceptance run passed every required item (the saved checklist and requested proof) with nothing
   * failing; a failed run can never satisfy the final acceptance check. An extra probe left unverified does not count.
   */
  acceptancePassed?: boolean;
  /** Acceptance still failed after those returns: wait for a coordinator decision, including after restart. */
  acceptanceBlocked?: boolean;
  /** At least one acceptance item could not be checked; never send the same unavailable probe back unchanged. */
  acceptanceUnverified?: boolean;
  /** The tester is trying the final code right before the delivery check; the check follows, or the builder if it fails. */
  retest?: boolean;
}

export interface ProofDecision {
  versions: Readonly<Record<Id, string>>;
  statuses: Readonly<Record<Id, ProofRequest["status"]>>;
  refreshBlocked?: boolean;
}

export interface ProofRequest {
  id: Id;
  text: string;
  reason: string;
  productIds: readonly Id[];
  checklistText?: string;
  requestedBy: { stageId: Id; round: number; seat: string; roleId: Id; profileId: Id; reviewId?: Id };
  reviewedVersions: Readonly<Record<Id, string>>;
  ownerStageId: Id;
  status: "pending" | "already-current" | "proved" | "failed" | "unverified" | "stale";
  /** Position in one accepted reviewer result: replay never creates another request. */
  source: string;
  proof?: { stepId: Id; versions: Readonly<Record<Id, string>>; result: "pass" | "fail" | "blocked"; evidence?: string; reason?: string; checklist?: boolean };
}

/** The current step, its agent seats, public activity and coordinator interaction. */
export interface TaskActivity {
  agent?: ActiveAgent;
  /** Agents working on the same step at the same time as `agent` (reviewers hunting at once, voters). Each holds a slot of its own. */
  helpers?: readonly ActiveAgent[];
  statusLine: string;
  toolActivity?: import("./model.js").AgentToolActivity;
  /** Agent-owned current to-do, kept separate from changing tool activity. */
  todo?: string;
  /**
   * The agent's own tool reported it is retrying the turn by itself (a lost connection, or another passing
   * problem): what the task says instead of its latest action and to-do item, until useful work resumes.
   * For agents working at once, the one shown, naming its tool. Never inferred from silence.
   */
  retrying?: string;
  stepClock?: StepClock;
  queued: readonly QueuedMessage[];
  /** What the coordinator said during the current step, in order. Cleared when the step finishes. */
  stepNotes?: readonly StepNote[];
  /** Set while the coordinator drives the current step in their own terminal. */
  driving?: Driving;
  /** The current step's agent asked for the screen. */
  screen?: ScreenRequest;
  /** "Allow the screen for this task": its screen requests go ahead even while the switch is off. */
  screenAllowed?: boolean;
  /** Ids the window gave what it sent lately, so a resend after a lost confirmation counts once. */
  received?: readonly Id[];
  /** Why the task failed, when it did. */
  error?: string;
  /**
   * Models that are full for this task, as their tool reported, until the short retry. Not an account limit: usage meters ignore it.
   * Every effort of `modelId` is full. Cleared when the time passes.
   */
  modelCapacity?: readonly { toolId: Id; modelId: string; profileId: Id; until: number }[];
  /**
   * Conversations to reopen after a model-capacity wait, one per reviewer or voter who does not own the task conversation.
   * Cleared once that short continue is sent, or when the step ends.
   */
  capacityResume?: readonly { sessionId: string; profileId: Id; roleId: Id; toolId: Id; model: string; member?: string }[];
  /**
   * How many same-conversation continues this step has already sent for a full model.
   * Kept when the short wait ends, so the next stop uses the next delay. Cleared when the step ends.
   */
  capacityRetries?: readonly { toolId: Id; modelId: string; profileId: Id; roleId: Id; member?: string; tried: number }[];
  /**
   * A short same-conversation retry is still waiting. `plannedId` is the profile the step was planned for,
   * so a replacement keeps that step until its own short wait passes. Cleared when that time passes, or when the step ends.
   */
  capacityPaused?: readonly { toolId: Id; modelId: string; profileId: Id; roleId: Id; plannedId?: Id; member?: string }[];
}

/** Append-only evidence and provenance retained when the active task is archived. */
export interface TaskHistoryState {
  steps?: readonly StepRecord[];
  timeline: readonly TimelineEntry[];
  session: readonly SessionLine[];
  /** Notes handed back by earlier steps, for every later agent on the task. */
  handedBack?: readonly HandedBack[];
  /** Everything the coordinator said about this task, kept for every later agent (latest wins). */
  notes?: readonly { at: number; text: string; id?: Id; origin?: { stageId?: Id; stageTitle: string; roleName?: string; kind?: InboxKind } }[];
  /** Every step the task went through, in order, rounds and send-backs included. Never trimmed. */
  journey?: readonly JourneyStep[];
  /**
   * Set when this task is the Backlog card for a confirmed older bug.
   * The reports are the evidence; the description is the request the coordinator can edit.
   */
  followUp?: {
    /** A coordinator-created bug request gained report links; keep its request and product scope intact. */
    preserveRequest?: boolean;
    reports: readonly {
      taskId: Id;
      findingId: Id;
      /** The task the report came from, so the link has a name after that task leaves the board. */
      sourceTitle: string;
      text: string;
      steps: string;
      evidence: string;
      raisedBy: Id;
      roleId?: Id;
      productIds: readonly Id[];
      /** Why the checkers called it older, when a vote settled it. */
      reasons?: readonly string[];
      at: number;
    }[];
    /** Products named only after work had started. They are not part of this card. */
    alsoReported?: readonly Id[];
  };
  /** Original requests combined into this task, or the replacement for a combined source. */
  combinedFrom?: readonly { id: Id; title: string }[];
  combinedInto?: Id;
}

/** Canonical task-wide state used by the engine. Execution fields live in its repository records. */
export interface TaskState extends TaskRequest, TaskScopeState, TaskProgress, TaskDesignState, TaskReviewState, TaskAcceptanceState, TaskActivity, TaskHistoryState {}

/** Public task view: task-wide state with one repository's execution fields for display. */
export interface Task extends TaskState, RepositoryState {}
