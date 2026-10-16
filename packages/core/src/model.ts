// The domain model shared by the engine, the simulator and the UI.
// Everything here is plain data so it can be stored, diffed and rendered.

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
}

export type RoleIcon = "map" | "book" | "compass" | "scale" | "palette" | "hammer" | "flask" | "search" | "rocket";

export type Tone = "indigo" | "orange" | "violet" | "purple" | "pink" | "blue" | "green" | "teal" | "slate" | "amber";

/** A role is data: what the agent is for, what it may do, what it sees and what it hands back. */
export interface Role {
  id: Id;
  name: string;
  icon: RoleIcon;
  tone: Tone;
  purpose: string;
  canEdit: boolean;
  sees: string;
  handsBack: string;
  /** The board column a task sits in while this role works on it. */
  column: Column;
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
}

export interface SessionLine {
  id: Id;
  at: number;
  from: "agent" | "you" | "system" | "activity";
  roleId?: Id;
  profileId?: Id;
  text: string;
}

export interface QueuedMessage {
  id: Id;
  text: string;
  at: number;
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
  status: "open" | "accepted" | "rejected";
  answer?: string;
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

export interface Finding {
  id: Id;
  text: string;
  where?: string;
  severity: "blocking" | "suggestion";
  raisedBy: Id;
  confirmedBy: readonly Id[];
  status: "open" | "fixed" | "dismissed";
}

export interface PullRequest {
  number: number;
  url: string;
  state: "open" | "merged";
  openedAt: number;
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
  state: RunState;
  column: Column;
  /** Whether the task currently occupies a pool slot. */
  holdsSlot: boolean;
  approvePlan: boolean;
  /** What happens once the work is ready. Defaults to the product's setting. */
  delivery: DeliveryMode;
  /** Ask the coordinator before the shipper delivers. */
  approveDelivery: boolean;
  plan?: Plan;
  /** -1 while the planner runs, then the index into `plan.stages`. */
  stageIndex: number;
  /** Rounds per stage id. */
  rounds: Readonly<Record<Id, number>>;
  /** `converge`: 0 author, 1 reviewer. `review-chain`: reviewer index. */
  sub: number;
  /** The builder is fixing review findings. */
  fixing: boolean;
  agent?: ActiveAgent;
  statusLine: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  timeline: readonly TimelineEntry[];
  session: readonly SessionLine[];
  queued: readonly QueuedMessage[];
  brief?: DesignBrief;
  objections: readonly Objection[];
  /** Set from the coordinator's call on a disagreement until they approve the brief that follows it. */
  call?: DesignCall;
  findings: readonly Finding[];
  pr?: PullRequest;
  /** Ticks spent with the pull request open (simulator only). */
  prAge: number;
  /** The task's own branch and working copy. */
  branch?: string;
  worktree?: string;
  base?: string;
  /** What the builder reported, in plain language. Goes into the pull request. */
  report?: { summary: string; changes: readonly string[]; tests?: string };
  /** Why the task failed, when it did. */
  error?: string;
  /** Set when a `release` product published this task. */
  release?: { tag: string; url: string };
  /** Set when a `local` product committed this task onto its default branch. */
  landed?: { branch: string; sha: string };
}

export type InboxKind = "question" | "permission" | "plan" | "design" | "disagreement" | "delivery" | "stuck";

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
}

/**
 * What "ready" means for a product.
 * - `pull-request`: open a pull request (never merged by Petrina).
 * - `release`: merge into the default branch, push, and publish a GitHub release.
 * - `local`: commit onto the local default branch. Nothing is pushed.
 */
export type DeliveryMode = "pull-request" | "release" | "local";

export interface Product {
  id: Id;
  name: string;
  /** owner/name on GitHub. */
  repo: string;
  tone: Tone;
  /** The local clone Petrina makes worktrees from. */
  path?: string;
  defaultBranch?: string;
  /** Command prefixes the coordinator chose to always allow in this product. */
  allowed?: readonly string[];
  delivery?: DeliveryMode;
  /** Ask the coordinator before delivering. Defaults to true. */
  approveDelivery?: boolean;
  /** Which part of the version a release bumps. Defaults to patch. */
  releaseBump?: "patch" | "minor" | "major";
}

export interface Pool {
  limit: number;
  paused: boolean;
  toolCaps: Readonly<Record<Id, number>>;
}

export interface State {
  now: number;
  seq: number;
  products: readonly Product[];
  roles: readonly Role[];
  tools: readonly Tool[];
  profiles: readonly AgentProfile[];
  tasks: readonly Task[];
  inbox: readonly InboxItem[];
  pool: Pool;
}
