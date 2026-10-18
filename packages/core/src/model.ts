// The domain model shared by the engine, the simulator and the UI.
// Everything here is plain data so it can be stored, diffed and rendered.

import type { WorkInfo } from "./worklog.js";
import type { CheckId, Setup } from "./setup.js";

export type Id = string;

export type Effort = "low" | "medium" | "high" | "xhigh";

export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh"];

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

export type Column = "queue" | "planning" | "designing" | "building" | "reviewing" | "ready" | "done";

export const COLUMNS: readonly Column[] = ["queue", "planning", "designing", "building", "reviewing", "ready", "done"];

export type StageKind = "do" | "converge" | "review-chain" | "gate";

export type GateKind = "plan" | "design" | "delivery";

export interface Stage {
  id: Id;
  kind: StageKind;
  title: string;
  /** The doer, the author of a converge stage, or the reviewer role of a review chain. */
  roleId: Id;
  /** `do`: one profile. `converge`: the author. `review-chain`: the reviewers, in order. */
  profileIds: readonly Id[];
  /** `review-chain`: the role of each reviewer in `profileIds`, in order. Missing: `roleId`. */
  roleIds?: readonly Id[];
  /** `converge` only. */
  reviewerRoleId?: Id;
  reviewerProfileIds?: readonly Id[];
  maxRounds?: number;
  gate?: GateKind;
}

export interface Plan {
  stages: readonly Stage[];
  rationale: string;
  plannerProfileId: Id;
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
export type RunState = "queued" | "waiting" | "running" | "needs-you" | "paused" | "failed" | "pr-open" | "done" | "cancelled";

export interface ActiveAgent {
  roleId: Id;
  profileId: Id;
  since: number;
  /** How far the agent is through its current step list. */
  step: number;
}

export interface TimelineEntry {
  id: Id;
  at: number;
  roleId?: Id;
  profileId?: Id;
  text: string;
  tone: "status" | "milestone" | "you" | "warn" | "done";
  /** The journey step it belongs to. */
  step?: Id;
}

export interface SessionLine {
  id: Id;
  at: number;
  from: "agent" | "you" | "system" | "activity";
  roleId?: Id;
  profileId?: Id;
  text: string;
  /** The journey step it belongs to. */
  step?: Id;
}

/** How an arrow out of a step reads: the work moved on, went back (a send-back, changes asked), or got stuck. */
export type JourneyTone = "on" | "back" | "stuck";

/** What a step of the coordinator's waits for: a check, the call on a disagreement, a stuck task, or interrupted shipping. */
export type JourneyWait = GateKind | "call" | "stuck" | "shipping";

/** Petrina's own work, with no agent: running the product's checks, finding main moved on, and publishing the delivery. */
export type JourneyWork = "checks" | "update" | "delivery";

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
  /** Unique within the task. Timeline and session lines carry it. */
  id: Id;
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
  /** Why the work moved on from here: the words on the arrow out. */
  reason?: string;
  tone?: JourneyTone;
  asks?: readonly JourneyAsk[];
  /** Made up from the plan for a task that ran before journeys were recorded: no times or rounds. */
  legacy?: boolean;
}

export interface QueuedMessage {
  id: Id;
  text: string;
  at: number;
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
export interface ConversationNote {
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
  /** The coordinator handed the step back: the note of what changed, until the agent hears it. */
  handback?: string;
}

/**
 * The coordinator took over a step in their own terminal: the agent's own tool, on the same
 * conversation, in the task's working copy. The step is paused and keeps its seat in the pool.
 */
export interface Driving {
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

export interface DesignBrief {
  summary: string;
  forUsers: readonly string[];
  areas: readonly string[];
  acceptance: readonly { text: string; met?: boolean }[];
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
  /** The outcome of checking an Important finding before it could send work back: the majority's verdict. */
  verification?: FindingVerification;
  /** Each voter's verdict, when fresh agents voted on it. */
  votes?: readonly Vote[];
  /** The builder's answer when the finding came back to it. */
  answer?: { fixed: boolean; text: string; at: number };
  status: "open" | "fixed" | "dismissed";
}

export type RiskLevel = "low" | "medium" | "high";

/** A point reviewers missed once, now in the product's review guide. */
/** A line the coordinator accepted for one of the repository's points files (REVIEW.md, LEARNINGS.md). */
export interface GuideLine {
  text: string;
  at: number;
  /** The task it came from. */
  fromTask: Id;
  /** The task whose branch adds it to the file. */
  writtenOn?: Id;
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
  stageId: Id;
  round: number;
  /** Per reviewer position in the stage, what it reported. */
  reported: Readonly<Record<Id, true>>;
  /** The profile reserved or actually used at each position, kept after reporting and across restarts. */
  profiles?: Readonly<Record<Id, Id>>;
  /** Per actual voter profile, whether it finished the round's findings. Older records used planned profiles. */
  voted?: Readonly<Record<Id, true>>;
  /** How many findings the task had when the round began: what the round's reviewers raise comes after. */
  findings?: number;
  /** Each parallel agent's starting role, by reviewer place or voter profile, through interruptions. */
  roles?: Readonly<Record<string, Role>>;
}

/** One voter's verdict on an Important finding. */
export interface Vote {
  by: Id;
  /** The actual independent tool. Absent in older votes whose planned attribution cannot prove who ran. */
  toolId?: Id;
  verdict: FindingVerification["verdict"];
  reason: string;
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
  /** An uncertain delivery marked done still needs its branch checked for an open pull request. */
  pullRequest?: "unconfirmed" | "none";
  /** When the folder and the repository's record of it were both gone. */
  removedAt?: number;
  /** Why the last try failed, in plain words. Petrina tries again. */
  error?: string;
}

export interface Task {
  id: Id;
  productId: Id;
  title: string;
  description: string;
  /** A short noun for the part of the product the task touches, used in plain-language lines. */
  area: string;
  kind: TaskKind;
  /** Position in the queue. Lower starts first. */
  priority: number;
  held: boolean;
  /** Tasks that must land first; until then this one waits quietly (a cancelled one no longer blocks). */
  after?: readonly Id[];
  state: RunState;
  column: Column;
  /** Whether the task currently occupies a pool slot. */
  holdsSlot: boolean;
  approvePlan: boolean;
  /** What happens once the work is ready. Defaults to the product's setting. */
  delivery: DeliveryMode;
  /** Ask the coordinator before Petrina delivers. */
  approveDelivery: boolean;
  plan?: Plan;
  /** -1 while the planner runs, then the index into `plan.stages`. */
  stageIndex: number;
  /** Rounds per stage id. */
  rounds: Readonly<Record<Id, number>>;
  /** Per review stage, how many Important findings were open at the end of each round: whether it still converges. */
  blockingAfter?: Readonly<Record<Id, readonly number[]>>;
  /** `converge`: 0 author, 1 reviewer. `review-chain`: reviewer index. */
  sub: number;
  /** The builder is fixing review findings. */
  fixing: boolean;
  /** Changes were asked at this design check: earlier checks of the same design pass by themselves on the way back to it. */
  returnToCheck?: number;
  /** The last time Petrina ran the product's checks on this task, and on which commit. */
  /** The tree is the code itself: a squash keeps it, so the checks still count. */
  /** The definition covers commands and hook inputs, separately from the code. */
  checks?: { at: number; sha?: string; tree?: string; definition?: string; results: readonly CheckRun[] };
  /** How many times failing checks sent the work back before review or delivery. */
  checkReturns?: number;
  /** The base's commit when the working copy was made: reviews, the tamper check and the review guide go by it, whatever later happens to refs. */
  baseSha?: string;
  /** The commit the last review round looked at: later rounds review only what changed since. */
  reviewedSha?: string;
  /** The exact code that completed code review, including any later reviewed port. Missing on older tasks: they receive ordinary review. */
  reviewedTree?: string;
  /** How much could go wrong, as the planner rated it from what the task touches. Sets review depth and the delivery check. */
  risk?: { level: RiskLevel; why: string };
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
  /** The change (its fingerprint) the tester last tried: fix rounds are reviewed, and the tester tries the final code once more before the delivery check. */
  testedPatch?: string;
  /** Whether that acceptance run passed; a failed run can never satisfy the final acceptance check. */
  acceptancePassed?: boolean;
  /** Final acceptance failures return to the builder twice, then wait for the coordinator. */
  acceptanceReturns?: number;
  /** Acceptance still failed after those returns: wait for a coordinator decision, including after restart. */
  acceptanceBlocked?: boolean;
  /** The tester is trying the final code right before the delivery check; the check follows, or the builder if it fails. */
  retest?: boolean;
  /** The builder's own conversation from its last step: fix rounds and updates go back to it. */
  builderSession?: { stageId: Id; profileId: Id; toolId: Id; model: string; sessionId: string };
  /** The coordinator sent the delivery back with this note: the Guide keeper looks for what reviewers missed. */
  miss?: { note: string; at: number };
  /** How many times the coordinator sent a delivery back after every reviewer had passed it. */
  sentBack?: number;
  agent?: ActiveAgent;
  /** Agents working on the same step at the same time as `agent` (reviewers hunting at once, voters). Each holds a slot of its own. */
  helpers?: readonly ActiveAgent[];
  /** A review round's parallel work so far, so a restart only redoes what had not finished. */
  hunt?: Hunt;
  statusLine: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  timeline: readonly TimelineEntry[];
  session: readonly SessionLine[];
  queued: readonly QueuedMessage[];
  brief?: DesignBrief;
  objections: readonly Objection[];
  /** The coordinator's call on a disagreement. It stays, so no later design check reopens the design it settled. */
  call?: DesignCall;
  findings: readonly Finding[];
  pr?: PullRequest;
  /** Ticks spent with the pull request open (simulator only). */
  prAge: number;
  /** The task's own branch and working copy. */
  branch?: string;
  worktree?: string;
  base?: string;
  /** Notes handed back by earlier steps, for every later agent on the task. */
  handedBack?: readonly HandedBack[];
  /** Set once the task is finished and Petrina has removed (or is trying to remove) its working copy. */
  cleanup?: Cleanup;
  /**
   * What the builder reported, in plain language: its one-line commit title, and a pull request's description,
   * which Petrina publishes as the builder wrote it.
   */
  report?: { summary: string; changes: readonly string[]; tests?: string; title?: string; description?: string };
  /** Why the task failed, when it did. */
  error?: string;
  /** Set when a `release` product published this task. */
  release?: { tag: string; url: string };
  /** Set when a `local` product committed this task onto its default branch. */
  landed?: { branch: string; sha: string };
  /** Everything the coordinator said about this task, kept for every later agent (latest wins). */
  notes?: readonly { at: number; text: string; id?: Id }[];
  /** What the coordinator said during the current step, in order. Cleared when the step finishes. */
  stepNotes?: readonly StepNote[];
  /** How many times the current step has started. */
  stepAttempts?: number;
  /** The conversation the current step's agent has open, so it can pick it up after a restart. */
  conversation?: ConversationNote;
  /** Set while the task is being shipped. */
  shipping?: ShippingRecord;
  /** Set while the coordinator drives the current step in their own terminal. */
  driving?: Driving;
  /** Files changed by hand that no review chain has looked at from its first reviewer yet. Nothing ships while set. */
  handChanges?: boolean;
  /** The review chain that runs again from its first reviewer once the step the coordinator drove finishes. */
  rereview?: Id;
  /** Ids the window gave what it sent lately, so a resend after a lost confirmation counts once. */
  received?: readonly Id[];
  /** The window's id for the request that added it: sending it again after a lost reply finds this task instead of adding another. */
  clientId?: Id;
  /** Every step the task went through, in order, rounds and send-backs included. Never trimmed. */
  journey?: readonly JourneyStep[];
}

/**
 * `shipping`: a delivery was interrupted, and Petrina could not tell whether it went out, or found something
 * else there. `driving`: the coordinator took over a step in their terminal.
 */
export type InboxKind = "question" | "permission" | "plan" | "design" | "disagreement" | "delivery" | "stuck" | "shipping" | "driving" | "guide" | "learnings";

export interface InboxItem {
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
  /** A Stuck item about a tool that is not ready or would not start: the item shows that tool's fix, and Retry checks it again first. */
  toolId?: CheckId;
  /** With `toolId`: what was wrong with the tool when the item was raised. */
  toolProblem?: "not-installed" | "logged-out" | "wont-start";
}

/**
 * What "ready" means for a product.
 * - `pull-request`: push the work's one commit and open a pull request (never merged by Petrina).
 * - `release`: push the work with a version commit to the default branch, with a new version tag, and publish a GitHub release.
 * - `local`: move the local default branch forward to the work. Nothing is pushed.
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
  /** Lessons the coordinator accepted for AGENTS.md's Learnings section, until a delivery adds them. */
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
  /** The end of the command's output, as plain text. */
  output: string;
  /** Private complete output on this machine, independent of the working copy and prompt excerpt. */
  logPath?: string;
  /** The log could not be saved completely; this never changes the command's own result. */
  logError?: string;
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
  /** Milliseconds. */
  until: number;
  /** Plain words, for example "Claude Code's weekly Opus limit". */
  reason: string;
  /** When the tool reported that it was out. Missing in older saved state. */
  at?: number;
}

export interface Pool {
  limit: number;
  paused: boolean;
  toolCaps: Readonly<Record<Id, number>>;
  /** The latest report per tool and kind of limit. */
  usage?: readonly UsageReport[];
  /** Who is out of usage right now. Entries are dropped when their time has passed. */
  limited?: readonly UsageLimit[];
}

/** A terminal Petrina can open a take-over in. */
export interface Terminal {
  id: Id;
  name: string;
}

export interface State {
  now: number;
  seq: number;
  products: readonly Product[];
  /** Every role: the built-in ones as the coordinator left them, then the ones they added. */
  roles: readonly Role[];
  /** What the coordinator changed in the roles. `roles` is built from it. */
  roleChanges?: RoleChanges;
  tools: readonly Tool[];
  profiles: readonly AgentProfile[];
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
}
