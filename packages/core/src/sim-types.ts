// Configuration for scripted agents and their simulated clock; never persisted task fields.
import type { Id } from "./model.js";
import type { NewTaskInput } from "./commands.js";
import type { MemoryWorkLog, WorkStageKind } from "./worklog.js";

/** A scripted moment where an agent stops and asks the coordinator something. `screen`: it needs the screen, for `title`. */
export interface Trigger {
  kind: "question" | "permission" | "screen";
  title: string;
  body?: string;
  options?: readonly string[];
  detail?: string;
}

/** Keyed by `taskId|roleId|round|item`: the agent stops when it starts that item of its to-do list. */
export type Triggers = Readonly<Record<string, Trigger>>;

/** How the simulated tools behave for one agent (keyed by `taskId|roleId`), so the demos show every case. */
export interface SimQuirk {
  /** Only for agents on this tool. */
  toolId?: Id;
  /** What the tool actually ran, when it differs from the profile. */
  ran?: { model: string; name: string; effort: string };
  /** The tool changed model or effort during the agent's first turn. */
  changedTo?: { model?: string; effort?: string };
  /** The tool never said what the session ran on. */
  notConfirmed?: boolean;
  /** Codex: helper agents started in the first turn, whose use Codex doesn't report. */
  helpers?: number;
  /** The first turn ends without a token report. */
  noTokens?: boolean;
  /** Claude Code sent only its main figure, without the per-model breakdown. */
  noBreakdown?: boolean;
  /** Claude Code: a second model in the breakdown (a helper agent or compaction). */
  extraModel?: string;
}

/** Turns and stages still open when a simulator stops, so another one can pick them up. */
export interface SimOpenWork {
  turns: readonly [Id, { id: Id; startedAt: number; waitedMs: number; waitingSince?: number; first: boolean }][];
  stages: readonly [Id, { stageId: Id; title: string; kind: WorkStageKind; roleId: Id; round: number; startedAt: number }][];
  runs: readonly [Id, number][];
  /** Scripted GitHub progress belongs to the demo, never a persisted product task. */
  pullRequests: readonly [Id, number][];
}

export interface SimOptions {
  triggers?: Triggers;
  /** Work another simulator left open (the demos fast-forward tasks one by one). */
  open?: SimOpenWork;
  /** The work log the simulator writes. A fresh one by default. */
  log?: MemoryWorkLog;
  quirks?: Readonly<Record<string, SimQuirk>>;
  /** Ticks a pull request stays open before the simulated coordinator merges it on GitHub. */
  prMergeAfter?: number;
  /** Milliseconds of simulated time per tick when no clock value is given. */
  tickMs?: number;
  /** Tasks whose design reviewer keeps objecting every round, so the architects end up disagreeing. */
  disagree?: readonly Id[];
  /** Tasks whose working copy cannot be removed at the first try, so Petrina tries again a tick later. */
  lockedCopies?: readonly Id[];
}

/** A new task for the demo: the window's, plus the area its scripted agents talk about. */
export interface NewTask extends NewTaskInput {
  area?: string;
}

export type MessageMode = "queue" | "interrupt";
