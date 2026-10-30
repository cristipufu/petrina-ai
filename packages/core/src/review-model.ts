// Agent activity, conversation, design, review, proof and delivery record types.
import type { Id, Role } from "./catalog-model.js";
import type { TaskSource, WorkChoice } from "./source.js";
import type { ReadinessWait } from "./readiness.js";

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
  /** The participant's start on its step (`agentInputs` index) that wrote it, telling apart places that share a role and profile. Older lines have none. */
  inputIndex?: number;
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
  /** Exact text and original-step fingerprints available to this conversation. */
  noteHashes?: Readonly<Record<Id, string>>;
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
  /** Pre-publication candidate validation on GitHub before direct branch or release delivery. */
  remoteValidation?: { ref: string; sha: string; pushed?: boolean; verifiedAt?: number };
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
  acceptance: readonly {
    text: string;
    productIds?: readonly Id[];
    versions?: Readonly<Record<Id, string>>;
    met?: boolean;
    verification?: "passed" | "failed" | "blocked" | "stale";
    reason?: string
  }[];
  risks: readonly string[];
}

export interface Objection {
  id: Id;
  round: number;
  text: string;
  blocking: boolean;
  raisedBy: Id;
  /**
   * `noted`: a non-blocking point nobody decided on, kept as a follow-up. Never a default "rejected". While the review
   * that raised it is the latest design step, builders receive it as advice only.
   */
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

export type FindingKind =
  | "review"
  | "product-check"
  | "acceptance-failed"
  | "acceptance-unverified"
  | "tamper"
  | "delivery";

/**
 * What a review found. `blocking` is shown as Important (must be fixed before it ships), `suggestion`
 * as Nit, and `pre-existing` is a confirmed older bug unrelated to the approved task: a follow-up,
 * never blocking. An older defect can still be Important when the task requires its repair.
 */
export interface Finding {
  /** Origin of this finding; older saved records omit it and fall back to `findingKind()`. */
  kind?: FindingKind;
  /** Reproduced failure of one explicit proof request; text is not its identity. */
  proofRequestId?: Id;
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
  /** When a reviewer confirmed it, or acceptance testing failed it again, while a decision to continue covered it. */
  reproducedAt?: number;
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

/** One review round's parallel work: each reviewer's findings as they arrive, then each voter's verdicts. */
export interface Hunt {
  /** This review execution, retained across restart even when its allowance round is reused. */
  id?: Id;
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
  screenTurns?: Readonly<Record<string, {
    reason: string;
    at: number;
    copy: string;
    copies?: Readonly<Record<Id, string>>;
    conversation: ConversationNote;
    allowed?: boolean
  }>>;
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
