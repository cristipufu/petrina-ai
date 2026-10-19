// The work log: one entry per agent turn, per-model token lines under each turn, and one
// entry per notable moment. Only numbers, names and ids: never prompts, replies, commands
// or file paths. The engine keeps it in SQLite; the simulator keeps it in memory.

import type { Id, StageKind, UsageReport } from "./model.js";
import { readingsIn, recordReading, type UsageHistoryFilter } from "./usage-history.js";

/** Why a turn happened. */
export type TurnReason = "first" | "message" | "answer" | "redo" | "continue";

/**
 * How a turn ended.
 * - `finished`: the agent ended the turn.
 * - `interrupted`: the coordinator interrupted it.
 * - `stopped`: a pause or a cancel stopped it.
 * - `agent-stopped`: the agent itself stopped (its process ended or failed).
 * - `lost`: still unfinished when Petrina stopped.
 */
export type TurnEnd = "finished" | "interrupted" | "stopped" | "agent-stopped" | "lost";

/** Token figures as a tool reports them. A missing figure is "not reported", never zero. */
export interface TokenCounts {
  /** New input: neither read from nor written to the cache. */
  input?: number;
  /** Input reused from the cache. */
  cacheRead?: number;
  /** Input written to the cache. */
  cacheWrite?: number;
  output?: number;
  /** Reasoning, already part of output. */
  reasoning?: number;
  total?: number;
}

/** One model's tokens in one turn, exactly as the tool named and counted them. Never an effort. */
export interface TokenLine extends TokenCounts {
  turnId: Id;
  model: string;
  /** Codex rerouted to another model during the turn, so its single figure can't be split between models. */
  changed?: boolean;
}

export type WorkStageKind = StageKind | "plan";

export interface WorkTurn {
  id: Id;
  taskId: Id;
  productId: Id;
  stageId: Id;
  /** The stage's name at that time. */
  stageTitle: string;
  stageKind: WorkStageKind;
  round: number;
  /** The builder was fixing review findings. */
  fixing: boolean;
  roleId: Id;
  toolId: Id;
  profileId: Id;
  /** What Petrina asked the tool for. */
  modelAsked?: string;
  modelAskedName?: string;
  effortAsked?: string;
  /** What the tool confirmed the session ran on. Missing means "not confirmed", never a guess. */
  modelRan?: string;
  modelRanName?: string;
  effortRan?: string;
  /** The tool changed the model or effort during the turn, to these. */
  modelChangedTo?: string;
  effortChangedTo?: string;
  /** The agent session the turn belongs to. */
  sessionId: Id;
  reason: TurnReason;
  startedAt: number;
  endedAt?: number;
  /** Missing while the turn is running. */
  end?: TurnEnd;
  /** The figures count the main agent only. */
  mainOnly: boolean;
  /** Helper agents the agent started whose use the tool doesn't report (Codex). */
  helpers: number;
  /** Working time, without waits for the coordinator. Missing when unknown. */
  workMs?: number;
  /** Missing when the tool sent no token report. */
  tokens?: TokenCounts;
}

export type MomentKind =
  | "stage-start"
  | "stage-end"
  | "design-round"
  | "design-end"
  | "verdict"
  | "review-end"
  | "ask"
  | "failure"
  | "retry"
  | "redo"
  | "task-end"
  | "untracked";

export type MomentOutcome =
  // stage-end
  | "done"
  | "settled"
  | "to-you"
  | "passed"
  | "sent-back"
  | "rounds-used"
  | "delivered"
  | "cancelled"
  // task-end
  | "merged"
  | "closed"
  // failure reasons
  | "limit"
  | "agent-stopped"
  | "unusable"
  | "other";

export type AskKind = "question" | "permission" | "checkpoint";
export type AskAnswer = "answered" | "decided" | "allowed" | "allowed-always" | "denied" | "approved" | "changes";

/** The same request entry is completed even after it leaves the inbox. */
export const askMomentId = (taskId: Id, itemId: Id): Id => `ask:${taskId}:${itemId}`;

export interface WorkMoment {
  id: Id;
  at: number;
  kind: MomentKind;
  taskId: Id;
  productId: Id;
  stageId?: Id;
  stageTitle?: string;
  stageKind?: WorkStageKind;
  roleId?: Id;
  toolId?: Id;
  profileId?: Id;
  round?: number;
  /** A design round: the design reviewer. `roleId`/`profileId` are the architect's. */
  peerRoleId?: Id;
  peerProfileId?: Id;
  outcome?: MomentOutcome;
  ask?: AskKind;
  answer?: AskAnswer;
  /** stage-end: start to finish. ask: how long the answer took. */
  durationMs?: number;
  /** stage-end: the agents' working time. */
  workMs?: number;
  /** design-round: objections. verdict: findings. */
  count?: number;
  blocking?: number;
  /** A reviewer's own verdict, kept separately from the review round's outcome. */
  verdict?: "pass" | "fail";
  /** design-end: rounds the design took. */
  rounds?: number;
}

/** Every product Petrina has ever had. Removed ones keep their entry, so their id is never reused. */
export interface ProductRecord {
  id: Id;
  /** Missing for products removed before Petrina kept names. */
  name?: string;
  repo?: string;
  addedAt?: number;
  removedAt?: number;
}

export type LimitStatus = "fine" | "close" | "reached";

/** What the state carries about the work log: never the log itself. */
export interface WorkInfo {
  /** Changes whenever an entry is written, so views know to refresh. */
  version: number;
  /** When Petrina started keeping track. */
  since: number;
}

// ── Reading the log ───────────────────────────────────────────────────────

export interface TurnFilter {
  taskId?: Id;
  productId?: Id;
  stageId?: Id;
  round?: number;
  /** Turns that count at or after this time (when they ended, or started if lost). */
  from?: number;
  to?: number;
}

export interface MomentFilter extends TurnFilter {
  kinds?: readonly MomentKind[];
}

/** Sums for a set of turns: enough to tell totals and whether they read "at least". */
export interface Tally {
  turns: number;
  /** Turns with a token report. */
  reported: number;
  /** Ended turns that sent no token report. */
  noTokens: number;
  /** Turns lost when Petrina stopped. */
  lost: number;
  tokens: number;
  /** Turns with a known working time. */
  timed: number;
  workMs: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** How many reported turns gave each figure. */
  hasInput: number;
  hasCacheRead: number;
  hasCacheWrite: number;
  hasOutput: number;
}

/** What the views need from the log. The engine answers it from SQLite, the simulator from memory. */
export interface WorkLogReader {
  since(): number;
  turns(filter: TurnFilter): WorkTurn[];
  lines(filter: TurnFilter): TokenLine[];
  moments(filter: MomentFilter): WorkMoment[];
  /** All-time sums per product. */
  productTallies(): Map<Id, Tally>;
  /** Tasks that had started before Petrina started keeping track. */
  untracked(): Map<Id, Id>;
  products(): ProductRecord[];
  /** Readings of the tools' usage limits in a period, oldest first: the last thirty days are kept. */
  usageHistory(filter: UsageHistoryFilter): UsageReport[];
}

export function emptyTally(): Tally {
  return { turns: 0, reported: 0, noTokens: 0, lost: 0, tokens: 0, timed: 0, workMs: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, hasInput: 0, hasCacheRead: 0, hasCacheWrite: 0, hasOutput: 0 };
}

/** Add one turn to a tally. A running turn counts nowhere until it ends. */
export function addTurn(tally: Tally, turn: WorkTurn): Tally {
  if (!turn.end) return tally;
  tally.turns += 1;
  if (turn.end === "lost") tally.lost += 1;
  if (turn.workMs !== undefined) {
    tally.timed += 1;
    tally.workMs += turn.workMs;
  }
  const tokens = turn.tokens;
  if (tokens && tokens.total !== undefined) {
    tally.reported += 1;
    tally.tokens += tokens.total;
    if (tokens.input !== undefined) (tally.input += tokens.input), (tally.hasInput += 1);
    if (tokens.cacheRead !== undefined) (tally.cacheRead += tokens.cacheRead), (tally.hasCacheRead += 1);
    if (tokens.cacheWrite !== undefined) (tally.cacheWrite += tokens.cacheWrite), (tally.hasCacheWrite += 1);
    if (tokens.output !== undefined) (tally.output += tokens.output), (tally.hasOutput += 1);
  } else if (turn.end !== "lost") {
    tally.noTokens += 1;
  }
  return tally;
}

export function tallyOf(turns: readonly WorkTurn[]): Tally {
  const tally = emptyTally();
  for (const turn of turns) addTurn(tally, turn);
  return tally;
}

// ── Counting tokens the same way for every tool ───────────────────────────

/**
 * A turn's total, worked out by Petrina: new input + reused input + written input + output,
 * so nothing is counted twice. When a tool gives only a total, that total is used.
 */
export function totalOf(counts: TokenCounts): number | undefined {
  if (counts.input !== undefined && counts.output !== undefined) return counts.input + (counts.cacheRead ?? 0) + (counts.cacheWrite ?? 0) + counts.output;
  return counts.total;
}

function withTotal(counts: TokenCounts): TokenCounts {
  const total = totalOf(counts);
  return total === undefined ? { ...counts } : { ...counts, total };
}

function sumCounts(all: readonly TokenCounts[]): TokenCounts {
  const sum = (key: keyof TokenCounts) => (all.some((entry) => entry[key] !== undefined) ? all.reduce((acc, entry) => acc + (entry[key] ?? 0), 0) : undefined);
  const result: TokenCounts = {};
  for (const key of ["input", "cacheRead", "cacheWrite", "output", "reasoning", "total"] as const) {
    const value = sum(key);
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/** What a tool sent at the end of a turn, already read into Petrina's names. */
export interface TurnReport {
  /** The primary model confirmed by a whole-prompt report, including a resolved alias. */
  model?: string;
  /** The main figure (ACP's `usage`). For Claude Code it counts the main agent loop only. */
  main?: TokenCounts;
  /** Claude Code's or Grok's per-model breakdown, or Codex's single row under the model it names. */
  models?: readonly { model: string; counts: TokenCounts }[];
}

/**
 * Turn a report into the turn's figures and its per-model lines.
 * - Claude Code: the per-model breakdown already includes helper agents, side conversations
 *   and compaction. It is counted once and never added to the main figure. Without it, the
 *   main figure goes on one line under the confirmed model and the turn counts the main agent only.
 * - Grok: whole-prompt per-model totals include folded subagents, counted once like Claude Code.
 * - Codex: its single figure is one line under the
 *   model it names. A reroute marks the line; a Codex helper agent started during the turn marks the
 *   turn "main agent only".
 */
export function turnTokens(input: { toolId: Id; report?: TurnReport; model?: string; rerouted?: boolean; helpers?: number }): { tokens?: TokenCounts; lines: Omit<TokenLine, "turnId">[]; mainOnly: boolean } {
  const { toolId, report, model, rerouted = false, helpers = 0 } = input;
  const claude = toolId === "claude-code";
  // Claude bills thinking inside output and never breaks it out, so it reports no reasoning figure.
  const clean = (counts: TokenCounts): TokenCounts => {
    const kept: TokenCounts = {};
    for (const key of ["input", "cacheRead", "cacheWrite", "output", "reasoning", "total"] as const) {
      const value = counts[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0 && !(claude && key === "reasoning")) kept[key] = Math.round(value);
    }
    return withTotal(kept);
  };
  const rows = (report?.models ?? []).map((row) => ({ model: row.model, counts: clean(row.counts) })).filter((row) => row.counts.total !== undefined && row.counts.total > 0);
  const mainOnlyForTool = !claude && helpers > 0;
  if (rows.length > 0) {
    const lines = rows.map((row) => ({ model: row.model, ...row.counts, ...(rerouted && !claude ? { changed: true } : {}) }));
    return { tokens: sumCounts(rows.map((row) => row.counts)), lines, mainOnly: mainOnlyForTool };
  }
  const main = report?.main ? clean(report.main) : undefined;
  if (!main || main.total === undefined) return { lines: [], mainOnly: mainOnlyForTool };
  if (main.total === 0) return { tokens: main, lines: [], mainOnly: mainOnlyForTool };
  const line = { model: model ?? "", ...main, ...(rerouted && !claude ? { changed: true } : {}) };
  return { tokens: main, lines: [line], mainOnly: claude || mainOnlyForTool };
}

// ── Model names ───────────────────────────────────────────────────────────

/** Claude model ids Petrina recognises: family, version, and an optional date. Nothing else. */
const CLAUDE_ID = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/;
const PLAIN_NAME = /^(Opus|Sonnet|Haiku|Fable) \d+(?:\.\d+)?$/;

/** The installed Grok resolves this session alias to this exact response model. */
const GROK_47 = new Set(["grok-4.7", "grok-4.7-build"]);

/** Resolve only a verified alias; unknown names and variants stay distinct. */
export function sameModel(toolId: Id, asked: string | undefined, ran: string | undefined): boolean {
  return asked === ran || (toolId === "grok" && asked !== undefined && ran !== undefined && GROK_47.has(asked) && GROK_47.has(ran));
}

/**
 * A model name as people read it. Names Petrina recognises are shown plainly ("claude-opus-5-5"
 * reads "Opus 5.5"), and Grok’s verified alias and build id as "Grok 4.7". Any other name is shown
 * exactly as reported, so two different names never land on one line.
 */
export function modelLabel(raw: string | undefined): string {
  const name = raw ?? "";
  if (!name.trim()) return "";
  if (GROK_47.has(name)) return "Grok 4.7";
  if (name === "gemini-4-argon") return "Gemini 4 Argon";
  if (name === "gemini-3.8-flash") return "Gemini 3.8 Flash";
  if (PLAIN_NAME.test(name)) return name;
  const claude = CLAUDE_ID.exec(name);
  if (claude) {
    const family = claude[1]!.charAt(0).toUpperCase() + claude[1]!.slice(1);
    return `${family} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}`;
  }
  return name;
}

/** The model an agent's session ran on, named so it lands on the same line as its tokens. */
export function sessionModelLabel(turn: Pick<WorkTurn, "modelRan" | "modelRanName">): string {
  if (turn.modelRanName && PLAIN_NAME.test(turn.modelRanName)) return turn.modelRanName;
  return modelLabel(turn.modelRan);
}

export const NOT_CONFIRMED_LABEL = "Model not confirmed";
export const CHANGED_LABEL = "Changed model during a turn";

/** The line a model's tokens land on: the model as reported, or "changed during a turn" when the tool rerouted. */
export function lineModelLabel(line: Pick<TokenLine, "model" | "changed">): string {
  return line.changed ? CHANGED_LABEL : modelLabel(line.model) || "Model not reported";
}

/** The line a turn's agent time lands on: the model the session ran on, not confirmed, or changed partway. */
export function turnModelLabel(turn: Pick<WorkTurn, "modelRan" | "modelRanName" | "modelChangedTo">): string {
  if (turn.modelRan === undefined) return NOT_CONFIRMED_LABEL;
  if (turn.modelChangedTo !== undefined) return CHANGED_LABEL;
  return sessionModelLabel(turn) || NOT_CONFIRMED_LABEL;
}

// ── The simulator's log ───────────────────────────────────────────────────

const matches = (at: number, taskId: Id, productId: Id, filter: TurnFilter) =>
  (filter.taskId === undefined || filter.taskId === taskId) && (filter.productId === undefined || filter.productId === productId) && (filter.from === undefined || at >= filter.from) && (filter.to === undefined || at < filter.to);

const turnAt = (turn: WorkTurn) => turn.endedAt ?? turn.startedAt;

/** The work log in memory, for the simulator and the demos. */
export class MemoryWorkLog implements WorkLogReader {
  private readonly turnList: WorkTurn[] = [];
  private readonly lineList: TokenLine[] = [];
  private readonly momentList: WorkMoment[] = [];
  private readonly productList = new Map<Id, ProductRecord>();
  private readonly untrackedTasks = new Map<Id, Id>();
  private readonly readings: UsageReport[] = [];

  constructor(private readonly start: number) {}

  /** A tool said how much of a limit is used: kept in the thirty-day history unless it repeats the last reading. True when kept. */
  recordUsage(report: UsageReport): boolean {
    return recordReading(this.readings, report);
  }

  usageHistory(filter: UsageHistoryFilter): UsageReport[] {
    return readingsIn(this.readings, filter);
  }

  since(): number {
    return this.start;
  }

  addTurn(turn: WorkTurn, lines: readonly Omit<TokenLine, "turnId">[] = []): void {
    this.turnList.push(turn);
    for (const line of lines) this.lineList.push({ ...line, turnId: turn.id });
  }

  /** Finish a running turn. */
  endTurn(turnId: Id, update: Partial<WorkTurn>, lines: readonly Omit<TokenLine, "turnId">[] = []): void {
    const index = this.turnList.findIndex((turn) => turn.id === turnId);
    if (index < 0) return;
    this.turnList[index] = { ...this.turnList[index]!, ...update };
    for (const line of lines) this.lineList.push({ ...line, turnId });
  }

  addMoment(moment: WorkMoment): void {
    const index = moment.kind === "ask" ? this.momentList.findIndex((entry) => entry.id === moment.id) : -1;
    if (index < 0) this.momentList.push(moment);
    else this.momentList[index] = { ...moment, at: this.momentList[index]!.at };
  }

  recordProduct(record: ProductRecord): void {
    this.productList.set(record.id, { ...this.productList.get(record.id), ...record });
  }

  markUntracked(taskId: Id, productId: Id): void {
    this.untrackedTasks.set(taskId, productId);
  }

  /** How many entries the log holds. */
  size(): number {
    return this.turnList.length + this.momentList.length;
  }

  turn(turnId: Id): WorkTurn | undefined {
    return this.turnList.find((turn) => turn.id === turnId);
  }

  /** Shift a slice of entries in time, keeping request ids in step with the demo's inbox. */
  shift(taskId: Id, delta: number, momentIds: ReadonlyMap<Id, Id> = new Map()): void {
    for (let index = 0; index < this.turnList.length; index += 1) {
      const turn = this.turnList[index]!;
      if (turn.taskId !== taskId) continue;
      this.turnList[index] = { ...turn, startedAt: turn.startedAt + delta, ...(turn.endedAt !== undefined ? { endedAt: turn.endedAt + delta } : {}) };
    }
    for (let index = 0; index < this.momentList.length; index += 1) {
      const moment = this.momentList[index]!;
      if (moment.taskId === taskId) this.momentList[index] = { ...moment, id: momentIds.get(moment.id) ?? moment.id, at: moment.at + delta };
    }
  }

  /** Drop a task's entries entirely (for demo tasks whose earlier work was "not recorded"). */
  forget(taskId: Id, before: number): void {
    const dropped = new Set(this.turnList.filter((turn) => turn.taskId === taskId && turnAt(turn) < before).map((turn) => turn.id));
    for (let index = this.turnList.length - 1; index >= 0; index -= 1) if (dropped.has(this.turnList[index]!.id)) this.turnList.splice(index, 1);
    for (let index = this.lineList.length - 1; index >= 0; index -= 1) if (dropped.has(this.lineList[index]!.turnId)) this.lineList.splice(index, 1);
    for (let index = this.momentList.length - 1; index >= 0; index -= 1) {
      const moment = this.momentList[index]!;
      if (moment.taskId === taskId && moment.at < before) this.momentList.splice(index, 1);
    }
  }

  /** An independent copy: what one simulator writes into it never shows in the other. */
  copy(): MemoryWorkLog {
    const copy = new MemoryWorkLog(this.start);
    // Entries are plain data: a JSON round trip copies them fully, the same everywhere.
    copy.turnList.push(...(JSON.parse(JSON.stringify(this.turnList)) as WorkTurn[]));
    copy.lineList.push(...(JSON.parse(JSON.stringify(this.lineList)) as TokenLine[]));
    copy.momentList.push(...(JSON.parse(JSON.stringify(this.momentList)) as WorkMoment[]));
    copy.readings.push(...(JSON.parse(JSON.stringify(this.readings)) as UsageReport[]));
    for (const record of this.productList.values()) copy.recordProduct(record);
    for (const [taskId, productId] of this.untrackedTasks) copy.markUntracked(taskId, productId);
    return copy;
  }

  /** Copy every entry of another log into this one. */
  absorb(other: MemoryWorkLog): void {
    this.turnList.push(...other.turnList);
    this.lineList.push(...other.lineList);
    this.momentList.push(...other.momentList);
  }

  turns(filter: TurnFilter): WorkTurn[] {
    return this.turnList.filter((turn) => matches(turnAt(turn), turn.taskId, turn.productId, filter) && (filter.stageId === undefined || turn.stageId === filter.stageId) && (filter.round === undefined || turn.round === filter.round));
  }

  lines(filter: TurnFilter): TokenLine[] {
    const ids = new Set(this.turns(filter).map((turn) => turn.id));
    return this.lineList.filter((line) => ids.has(line.turnId));
  }

  moments(filter: MomentFilter): WorkMoment[] {
    return this.momentList.filter((moment) => matches(moment.at, moment.taskId, moment.productId, filter) && (filter.stageId === undefined || moment.stageId === filter.stageId) && (filter.round === undefined || moment.round === filter.round) && (!filter.kinds || filter.kinds.includes(moment.kind)));
  }

  productTallies(): Map<Id, Tally> {
    const tallies = new Map<Id, Tally>();
    for (const turn of this.turnList) addTurn(tallies.get(turn.productId) ?? tallies.set(turn.productId, emptyTally()).get(turn.productId)!, turn);
    return tallies;
  }

  untracked(): Map<Id, Id> {
    return new Map(this.untrackedTasks);
  }

  products(): ProductRecord[] {
    return [...this.productList.values()];
  }
}
