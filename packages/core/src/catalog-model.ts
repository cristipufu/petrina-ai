// Shared catalog, role, plan, inbox and pool domain types for the engine, simulator and UI.
import type { RoleResult } from "./result-contracts.js";
import type { GateKind, StageKind } from "./stage-kinds.js";
import type { CheckId } from "./setup.js";

export type { GateKind, RoleResult, StageKind };

export type Id = string;

export const EFFORTS = ["low", "medium", "high", "xhigh", "ultra"] as const;

export type Effort = (typeof EFFORTS)[number];

export const EFFORT_LABEL: Readonly<Record<Effort, string>> = {
  ultra: "ultra effort",
  low: "low effort",
  medium: "medium effort",
  high: "high effort",
  xhigh: "extra high effort",
};

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
export const ROLE_ICON_CHOICES: readonly RoleIcon[] = [
  "lightbulb",
  "shield",
  "pen",
  "megaphone",
  "chart",
  "globe",
  "users",
  "bug",
  "book",
  "compass",
  "scale",
  "palette",
  "hammer",
  "flask",
  "search",
  "map",
  "rocket"
];

export const TONES = ["indigo", "orange", "violet", "purple", "pink", "blue", "green", "teal", "slate", "amber"] as const;

export type Tone = (typeof TONES)[number];

export const TONE_CHOICES: readonly Tone[] = ["blue", "teal", "green", "orange", "amber", "pink", "purple", "violet", "indigo", "slate"];

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
  /** Prefer a coding tool other than the builder's when another ready tool can run this role. */
  awayFromBuilder?: boolean;
  /** Review the complete change from the base on every round instead of only what changed since the last review. */
  fullReview?: boolean;
  /** Optional opening scope sentence for full-diff specialist reviews when using Petrina's default wording. */
  fullReviewSummary?: string;
  /** Optional short label for a card's pipeline strip (defaults to `ROLE_RESULT_CATALOG[result].stepLabel`). */
  stepLabel?: string;
  /** Optional plain-language phrase for "Next: …" summaries (defaults to `ROLE_RESULT_CATALOG[result].upcomingVerb`). */
  upcomingVerb?: string;
  /** Optional stage-kind label and sort order in Analytics (defaults to `ROLE_RESULT_CATALOG[result].analytics`). */
  analyticsLabel?: string;
  analyticsOrder?: number;
  /** Optional offline-demo script variant and example result placeholders so strategies never branch on role id. */
  simVariant?: "research" | "screens";
  exampleNotes?: { readonly summary: string; readonly note: string };
  exampleFinding?: { readonly text: string; readonly evidence: string };
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
export const RUN_STATES = ["backlog", "queued", "waiting", "running", "needs-you", "paused", "failed", "pr-open", "done", "cancelled"] as const;

export type RunState = (typeof RUN_STATES)[number];

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

/** An accepted lesson the once-a-minute tidy-up found on the default branch as it left the waiting list. */
export interface LearningReceipt {
  text: string;
  /** The task it came from. */
  fromTask: Id;
  /** The task whose branch wrote it, when one did. */
  writtenOn?: Id;
  /** The default-branch commit where it was found. */
  foundOn: string;
}

/** Something an agent learned about working in the repository, waiting for the coordinator at the delivery check. */
export interface Lesson {
  text: string;
  roleId: Id;
  profileId: Id;
  at: number;
}

import type { InboxKind } from "./inbox-catalog.js";
export type { InboxKind };

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
  /**
   * The stage a check decides, which notes given while it waits and its answer belong to. A review decision's review,
   * kept when that check is raised again at a later stage. Null: raised again from an older check that recorded none.
   */
  stageId?: Id | null;
}

export { DELIVERY_MODES, type DeliveryDestinationKind, type DeliveryMode } from "./delivery-modes.js";

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
