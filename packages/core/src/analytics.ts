// What each view shows about the work log, worked out from the log itself. The app never
// gets the log: it asks for one of these views and gets just its numbers.

import { limitsOverTime, tokensOverTime, type LimitsOverTime, type OverTimeView } from "./charts.js";
import type { AgentProfile, Id, State, Task } from "./model.js";
import { atLeastLine, count, durationText, type Figure, listWords } from "./numbers.js";
import { CHANGED_LABEL, NOT_CONFIRMED_LABEL, emptyTally, addTurn, lineModelLabel, modelLabel, sameModel, sessionModelLabel, turnModelLabel, type Tally, type TokenLine, type WorkLogReader, type WorkMoment, type WorkTurn } from "./worklog.js";

export type UsagePeriod = "today" | "7d" | "30d";

export const USAGE_PERIODS: readonly UsagePeriod[] = ["today", "7d", "30d"];

export type UsageRequest =
  | { view: "task"; taskId: Id }
  | { view: "products" }
  | { view: "today" }
  | { view: "analytics"; period: UsagePeriod; productId?: Id };

export interface UsageContext {
  now: number;
  /** For names and the current plans. */
  state: State;
  /** Finished tasks are read individually when a usage view needs their name or plan. */
  task?: (taskId: Id) => Task | undefined;
  /** Analytics lists read only the name, rather than loading every past conversation. */
  taskName?: (taskId: Id) => string | undefined;
}

/** New input, reused, written and output. Missing: not reported. */
export interface Detail {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
}

export interface WorkUsageLine {
  key: string;
  label: string;
  /** For example "removed". */
  note?: string;
  /** A task's product, so tasks with the same title can be told apart. */
  context?: string;
  toolId?: Id;
  roleId?: Id;
  productId?: Id;
  taskId?: Id;
  tokens: Figure;
  time: Figure;
  detail: Detail;
}

export interface AgentUsage {
  key: string;
  roleId: Id;
  toolId: Id;
  profileId: Id;
  /** What actually ran, in words: "Opus 5.5 at high", or "asked for sol at xhigh, ran gpt-6.1 at medium". */
  settings: string;
  /** The tool ran something other than what was asked. */
  differs: boolean;
  notConfirmed: boolean;
  rounds: number;
  turns: number;
  tokens: Figure;
  time: Figure;
  /** Each model with its tokens as reported, when the agent's tokens span more than one. */
  models: { label: string; tokens: number }[];
}

export interface StageUsage {
  stageId: Id;
  title: string;
  /** No longer in the plan (a re-plan removed it). */
  removed: boolean;
  rounds: number;
  tokens: Figure;
  time: Figure;
  agents: AgentUsage[];
}

export interface TaskUsage {
  view: "task";
  /** No entries: the task ran before Petrina kept track, or nothing has run yet. */
  empty?: "untracked" | "nothing";
  tokens: Figure;
  time: Figure;
  /** Input the tools reused from their cache, as they report it. Missing: not reported. */
  cacheRead?: number;
  atLeast: string;
  stages: StageUsage[];
}

export interface ProductsUsage {
  view: "products";
  products: { productId: Id; tokens: Figure; time: Figure; turns: number }[];
  /** Why any product's numbers read "at least", once for the page. Empty when nothing is missing. */
  atLeast: string;
}

export interface TodayUsage {
  view: "today";
  turns: number;
  tokens: Figure;
  time: Figure;
  atLeast: string;
  /** Each tool's limits are read from the state by the app, against its own clock, so a reset shows the moment it passes. */
  byTool: { toolId: Id; label: string; tokens: Figure; time: Figure; turns: number }[];
}

export interface ChartBucket {
  start: number;
  label: string;
  tokens: Record<Id, number>;
  timeMs: Record<Id, number>;
}

export interface SquadRow {
  label: string;
  /** The stage ran on the profile's own model and effort. */
  credited: boolean;
  stages: number;
  time: Figure;
  /** Reviewers: verdicts given. Architects and design reviewers: design rounds. */
  rounds: number;
  /** Reviewers: blocking findings. Design reviewers: blocking objections. */
  blocking: number;
  /** Reviewers: reviews where they asked for fixes. Architects: designs that came to you. */
  sentBack: number;
  /** Architects: designs finished. */
  designs: number;
}

export interface SquadUsage {
  stagesRun: number;
  turnsRun: number;
  delivered: number;
  cancelled: number;
  chart: { start: number; label: string; delivered: number; cancelled: number }[];
  stageKinds: { key: string; label: string; runs: number; typicalMs: number; agentShare?: number }[];
  sendBacks: string;
  designRounds: string;
  asks: string;
  failures: string;
  details: {
    reviewers: SquadRow[];
    architects: SquadRow[];
    designReviewers: SquadRow[];
    failuresByReason: { label: string; count: number }[];
    retries: number;
    redone: number;
    interrupted: number;
    /** How many agent stages ran on other settings than asked, and how many weren't confirmed. */
    settingsLine: string;
  };
}

export interface AboutCounts {
  turns: number;
  /** Codex turns that started helper agents whose use Codex doesn't report. */
  codexHelperTurns: number;
  /** Claude Code turns that counted the main agent only, because no per-model breakdown came. */
  claudeMainOnly: number;
  tools: Id[];
}

export interface AnalyticsUsage {
  view: "analytics";
  period: UsagePeriod;
  productId?: Id;
  from: number;
  to: number;
  headline: { tokens: Figure; time: Figure; turns: number; tasks: number };
  atLeast: string;
  chart: { hourly: boolean; tools: { toolId: Id; label: string }[]; buckets: ChartBucket[] };
  /** Tokens and agent time per day (per hour for Today), split by tool, by model and by provider. */
  overTime: OverTimeView;
  /** Each usage limit's readings over the period, with its reset moments. */
  limits: LimitsOverTime;
  byTool: WorkUsageLine[];
  byModel: WorkUsageLine[];
  byRole: WorkUsageLine[];
  /** Only when all products are shown. */
  byProduct?: WorkUsageLine[];
  byTask: WorkUsageLine[];
  squad: SquadUsage;
  about: AboutCounts;
}

export type UsageView = TaskUsage | ProductsUsage | TodayUsage | AnalyticsUsage;

export type UsageViewFor<R extends UsageRequest> = R extends { view: "task" } ? TaskUsage : R extends { view: "products" } ? ProductsUsage : R extends { view: "today" } ? TodayUsage : AnalyticsUsage;

const TOOL_NAMES: Record<Id, string> = { "claude-code": "Claude Code", codex: "Codex", grok: "Grok", antigravity: "Antigravity" };

// ── Periods ────────────────────────────────────────────────────────────────

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Today; today and the 6 days before; today and the 29 days before. Counted from local midnight. */
export function periodRange(period: UsagePeriod, now: number): { from: number; to: number; hourly: boolean; buckets: { start: number; end: number; label: string }[] } {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const at = (days: number, hours = 0) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + days, hours).getTime();
  if (period === "today") {
    const buckets = Array.from({ length: 24 }, (_, hour) => ({ start: at(0, hour), end: at(0, hour + 1), label: String(hour).padStart(2, "0") }));
    return { from: at(0), to: at(1), hourly: true, buckets };
  }
  const days = period === "7d" ? 7 : 30;
  const buckets = Array.from({ length: days }, (_, index) => {
    const offset = index - (days - 1);
    const start = at(offset);
    const date = new Date(start);
    return { start, end: at(offset + 1), label: days === 7 ? DAY_NAMES[date.getDay()]! : String(date.getDate()) };
  });
  return { from: at(-(days - 1)), to: at(1), hourly: false, buckets };
}

/** One column per day, Today included: deliveries are always charted per day. */
export function dayBuckets(period: UsagePeriod, now: number): { start: number; end: number; label: string }[] {
  const range = periodRange(period, now);
  return range.hourly ? [{ start: range.from, end: range.to, label: "Today" }] : range.buckets;
}

// ── Figures ────────────────────────────────────────────────────────────────

/**
 * Tokens and time for a tally. "At least" only when whole turns are known to be missing. When
 * nothing known adds up to more than zero and work is missing, there is no number at all: it
 * reads "not reported" when a tool sent no figure, and "not known" when the work wasn't
 * recorded (cut off, or from before Petrina kept track). Unknown is never zero.
 */
export function figures(tally: Tally, beforeTracking = false): { tokens: Figure; time: Figure } {
  const tokens: Figure = { atLeast: tally.noTokens > 0 || tally.lost > 0 || beforeTracking };
  if (!tokens.atLeast) tokens.value = tally.tokens;
  else if (tally.reported > 0 && tally.tokens > 0) tokens.value = tally.tokens;
  else if (tally.noTokens === 0) tokens.unknown = true;
  const time: Figure = { atLeast: tally.lost > 0 || beforeTracking };
  if (!time.atLeast) time.value = tally.workMs;
  else if (tally.timed > 0 && tally.workMs > 0) time.value = tally.workMs;
  else time.unknown = true;
  return { tokens, time };
}

function detailOf(tally: Tally): Detail {
  return {
    ...(tally.hasInput ? { input: tally.input } : {}),
    ...(tally.hasCacheRead ? { cacheRead: tally.cacheRead } : {}),
    ...(tally.hasCacheWrite ? { cacheWrite: tally.cacheWrite } : {}),
    ...(tally.hasOutput ? { output: tally.output } : {}),
  };
}

function reasonsOf(tally: Tally, beforeTracking: boolean): string {
  return atLeastLine({ noTokens: tally.noTokens, lost: tally.lost, beforeTracking, recorded: tally.turns });
}

const ended = (turns: readonly WorkTurn[]) => turns.filter((turn) => turn.end !== undefined);

function group<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = groups.get(k);
    if (list) list.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}

const byTokens = (a: WorkUsageLine, b: WorkUsageLine) => (b.tokens.value ?? -1) - (a.tokens.value ?? -1) || (b.time.value ?? -1) - (a.time.value ?? -1) || a.label.localeCompare(b.label);

function names(state: State, log: WorkLogReader, task?: UsageContext["task"], taskName?: UsageContext["taskName"]) {
  const products = new Map(state.products.map((product) => [product.id, product]));
  const ever = new Map(log.products().map((record) => [record.id, record]));
  const tasks = new Map(state.tasks.map((task) => [task.id, task]));
  const roles = new Map(state.roles.map((role) => [role.id, role]));
  const tools = new Map(state.tools.map((tool) => [tool.id, tool]));
  const profiles = new Map(state.profiles.map((profile) => [profile.id, profile]));
  return {
    tool: (id: Id) => tools.get(id)?.name ?? TOOL_NAMES[id] ?? id,
    role: (id: Id) => roles.get(id)?.name ?? id,
    roleResult: (id: Id) => roles.get(id)?.result,
    product: (id: Id): { label: string; removed: boolean } => {
      const current = products.get(id);
      if (current) return { label: current.name, removed: false };
      return { label: ever.get(id)?.name ?? "A removed product", removed: true };
    },
    taskName: (id: Id) => tasks.get(id)?.title ?? (taskName ? taskName(id) : task?.(id)?.title),
    record: (id: Id) => ever.get(id),
    profile: (id: Id): AgentProfile | undefined => profiles.get(id),
  };
}

type Names = ReturnType<typeof names>;

// ── Settings: what was asked and what ran ──────────────────────────────────

const askedName = (turn: WorkTurn) => turn.modelAskedName ?? turn.modelAsked ?? "the default";
const ranName = (turn: WorkTurn) => turn.toolId === "grok" ? modelLabel(turn.modelRan) : turn.modelRanName ?? turn.modelRan ?? "";
const finalEffort = (turn: WorkTurn) => turn.effortChangedTo ?? turn.effortRan;

/** The turn ran on exactly the model and effort that were asked for, start to end. */
export function ranAsAsked(turn: WorkTurn): boolean {
  return turn.modelRan !== undefined && turn.effortRan !== undefined && sameModel(turn.toolId, turn.modelAsked, turn.modelRan) && turn.effortRan === turn.effortAsked && turn.modelChangedTo === undefined && turn.effortChangedTo === undefined;
}

const confirmed = (turn: WorkTurn) => turn.modelRan !== undefined && turn.effortRan !== undefined;

/** An agent's settings in words, from its turns in one stage. */
function settingsWords(turns: readonly WorkTurn[]): { text: string; differs: boolean; notConfirmed: boolean } {
  const last = turns.at(-1)!;
  if (turns.some((turn) => turn.modelRan === undefined)) return { text: "settings not confirmed", differs: false, notConfirmed: true };
  const ran = (turn: WorkTurn) => `${ranName(turn)}${turn.effortRan ? ` at ${turn.effortRan}` : ", effort not confirmed"}`;
  const distinct = [...new Set(turns.map(ran))];
  const change = turns.filter((turn) => turn.modelChangedTo !== undefined || turn.effortChangedTo !== undefined).at(-1);
  const to = change ? [change.modelChangedTo ? modelLabel(change.modelChangedTo) : "", change.effortChangedTo ? `${change.effortChangedTo} effort` : ""].filter(Boolean).join(" at ") : "";
  const switched = change ? `, switched to ${to} during a turn` : "";
  const differs = turns.some((turn) => !sameModel(turn.toolId, turn.modelAsked, turn.modelRan) || (turn.effortRan !== undefined && turn.effortRan !== turn.effortAsked));
  const notConfirmed = turns.some((turn) => turn.effortRan === undefined);
  const ranText = distinct.length > 1 ? `ran ${listWords(distinct)}` : `ran ${distinct[0]}`;
  if (differs) return { text: `asked for ${askedName(last)} at ${last.effortAsked ?? "the default effort"}, ${ranText}${switched}`, differs, notConfirmed };
  return { text: `${distinct.length > 1 ? ranText : distinct[0]}${switched}`, differs: change !== undefined, notConfirmed };
}

// ── The task sheet ─────────────────────────────────────────────────────────

function taskView(log: WorkLogReader, taskId: Id, ctx: UsageContext): TaskUsage {
  const turns = ended(log.turns({ taskId }));
  const lines = log.lines({ taskId });
  const untracked = log.untracked().has(taskId);
  const tally = turns.reduce(addTurn, emptyTally());
  const { tokens, time } = figures(tally, untracked);
  if (turns.length === 0) return { view: "task", empty: untracked ? "untracked" : "nothing", tokens, time, atLeast: "", stages: [] };

  const task = ctx.state.tasks.find((entry) => entry.id === taskId) ?? ctx.task?.(taskId);
  const order = new Map<Id, number>([[`${taskId}:plan`, -1]]);
  task?.plan?.stages.forEach((stage, index) => order.set(stage.id, index));
  const currentTitle = new Map(task?.plan?.stages.map((stage) => [stage.id, stage.title]) ?? []);
  const linesByTurn = group(lines, (line) => line.turnId);

  const stages: StageUsage[] = [...group(turns, (turn) => turn.stageId).entries()]
    .map(([stageId, stageTurns]) => {
      const agents = [...group(stageTurns, (turn) => `${turn.roleId}|${turn.profileId}`).entries()].map(([key, agentTurns]): AgentUsage => {
        const agentTally = agentTurns.reduce(addTurn, emptyTally());
        const models = new Map<string, number>();
        for (const turn of agentTurns) for (const line of linesByTurn.get(turn.id) ?? []) models.set(modelLabel(line.model) || "Model not reported", (models.get(modelLabel(line.model) || "Model not reported") ?? 0) + (line.total ?? 0));
        const words = settingsWords(agentTurns);
        const first = agentTurns[0]!;
        return {
          key,
          roleId: first.roleId,
          toolId: first.toolId,
          profileId: first.profileId,
          settings: words.text,
          differs: words.differs,
          notConfirmed: words.notConfirmed,
          rounds: new Set(agentTurns.map((turn) => turn.round)).size,
          turns: agentTurns.length,
          ...figures(agentTally),
          models: models.size > 1 ? [...models.entries()].map(([label, value]) => ({ label, tokens: value })).sort((a, b) => b.tokens - a.tokens) : [],
        };
      });
      const stageTally = stageTurns.reduce(addTurn, emptyTally());
      const first = stageTurns[0]!;
      return {
        stageId,
        title: currentTitle.get(stageId) ?? (stageId === `${taskId}:plan` ? "Planning" : first.stageTitle),
        removed: stageId !== `${taskId}:plan` && !currentTitle.has(stageId),
        rounds: new Set(stageTurns.map((turn) => turn.round)).size,
        ...figures(stageTally),
        agents,
        firstAt: first.startedAt,
      };
    })
    .sort((a, b) => (order.get(a.stageId) ?? 1e6) - (order.get(b.stageId) ?? 1e6) || a.firstAt - b.firstAt)
    .map(({ firstAt: _firstAt, ...stage }) => stage);

  return {
    view: "task",
    tokens,
    time,
    ...(tally.hasCacheRead ? { cacheRead: tally.cacheRead } : {}),
    atLeast: reasonsOf(tally, untracked),
    stages,
  };
}

// ── The Products page ──────────────────────────────────────────────────────

function productsView(log: WorkLogReader, ctx: UsageContext): ProductsUsage {
  const tallies = log.productTallies();
  const untrackedProducts = new Set(log.untracked().values());
  const shown = ctx.state.products.map((product) => ({ product, tally: tallies.get(product.id) ?? emptyTally() }));
  const all = shown.reduce((sum, { tally }) => ({ ...sum, turns: sum.turns + tally.turns, noTokens: sum.noTokens + tally.noTokens, lost: sum.lost + tally.lost }), emptyTally());
  return {
    view: "products",
    products: shown.map(({ product, tally }) => ({ productId: product.id, turns: tally.turns, ...figures(tally, untrackedProducts.has(product.id)) })),
    atLeast: reasonsOf(all, shown.some(({ product }) => untrackedProducts.has(product.id))),
  };
}

// ── The pool popover ───────────────────────────────────────────────────────

function todayView(log: WorkLogReader, ctx: UsageContext): TodayUsage {
  const { from, to } = periodRange("today", ctx.now);
  const turns = ended(log.turns({ from, to }));
  const n = names(ctx.state, log, ctx.task, ctx.taskName);
  const before = from < log.since();
  const tally = turns.reduce(addTurn, emptyTally());
  const toolIds = [...new Set([...ctx.state.tools.filter((tool) => tool.status === "ready" || turns.some((turn) => turn.toolId === tool.id)).map((tool) => tool.id), ...turns.map((turn) => turn.toolId)])];
  const byTool = toolIds.map((toolId) => {
    const toolTally = turns.filter((turn) => turn.toolId === toolId).reduce(addTurn, emptyTally());
    return { toolId, label: n.tool(toolId), turns: toolTally.turns, ...figures(toolTally, before && toolTally.turns > 0) };
  });
  return { view: "today", turns: tally.turns, ...figures(tally, before), atLeast: reasonsOf(tally, before), byTool };
}

// ── Analytics ──────────────────────────────────────────────────────────────

function lineOf(key: string, label: string, turns: readonly WorkTurn[], extra: Partial<WorkUsageLine> = {}, beforeTracking = false): WorkUsageLine {
  const tally = turns.reduce(addTurn, emptyTally());
  return { key, label, ...figures(tally, beforeTracking), detail: detailOf(tally), ...extra };
}

/**
 * Tokens per model exactly as reported; agent time only with the model the agent's session ran on.
 * `beforeTracking`: the period starts before Petrina kept track, so any model's line may miss work.
 */
export function modelSplit(turns: readonly WorkTurn[], lines: readonly TokenLine[], beforeTracking = false): WorkUsageLine[] {
  const turnById = new Map(turns.map((turn) => [turn.id, turn]));
  const rows = new Map<string, { tokens: number; hasTokens: boolean; workMs: number; hasTime: boolean; lost: number; noTokens: number; tools: Set<Id>; detail: Required<Detail>; has: Record<keyof Detail, boolean> }>();
  const row = (label: string, toolId: Id) => {
    let entry = rows.get(label);
    if (!entry) {
      entry = { tokens: 0, hasTokens: false, workMs: 0, hasTime: false, lost: 0, noTokens: 0, tools: new Set(), detail: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, has: { input: false, cacheRead: false, cacheWrite: false, output: false } };
      rows.set(label, entry);
    }
    entry.tools.add(toolId);
    return entry;
  };
  for (const line of lines) {
    const owner = turnById.get(line.turnId);
    if (!owner) continue;
    const entry = row(lineModelLabel(line), owner.toolId);
    entry.tokens += line.total ?? 0;
    entry.hasTokens = true;
    for (const key of ["input", "cacheRead", "cacheWrite", "output"] as const) {
      if (line[key] === undefined) continue;
      entry.detail[key] += line[key]!;
      entry.has[key] = true;
    }
  }
  for (const turn of turns) {
    if (!turn.end) continue;
    const entry = row(turnModelLabel(turn), turn.toolId);
    if (turn.workMs !== undefined) {
      entry.workMs += turn.workMs;
      entry.hasTime = true;
    }
    if (turn.end === "lost") entry.lost += 1;
    else if (!turn.tokens || turn.tokens.total === undefined) entry.noTokens += 1;
  }
  return [...rows.entries()]
    .map(([label, entry]) => {
      const tokens: Figure = { atLeast: entry.hasTokens && (entry.lost > 0 || entry.noTokens > 0 || beforeTracking) };
      if (entry.hasTokens) tokens.value = entry.tokens;
      else if (entry.lost > 0 || beforeTracking) tokens.unknown = true;
      const time: Figure = { atLeast: entry.hasTime && (entry.lost > 0 || beforeTracking) };
      if (entry.hasTime) time.value = entry.workMs;
      else if (entry.lost > 0 || beforeTracking) time.unknown = true;
      const detail: Detail = {};
      for (const key of ["input", "cacheRead", "cacheWrite", "output"] as const) if (entry.has[key]) detail[key] = entry.detail[key];
      const toolId = entry.tools.size === 1 && label !== CHANGED_LABEL && label !== NOT_CONFIRMED_LABEL ? [...entry.tools][0] : undefined;
      return { key: `model:${label}`, label, tokens, time, detail, ...(toolId ? { toolId } : {}) };
    })
    .sort(byTokens);
}

const STAGE_KIND_LABEL: Record<string, string> = {
  researcher: "Research",
  "ux-designer": "Screens",
  builder: "Build",
  tester: "Testing",
  "release-manager": "Delivery",
};

function stageKindOf(moment: WorkMoment, n: Names): { key: string; label: string } {
  if (moment.stageKind === "plan") return { key: "plan", label: "Planning" };
  if (moment.stageKind === "converge") return { key: "design", label: "Design" };
  if (moment.stageKind === "review-chain") return { key: "review", label: "Review" };
  if (moment.roleId && n.roleResult(moment.roleId) === "build" && (moment.round ?? 1) > 1) return { key: "fixes", label: "Fixes after review" };
  const role = moment.roleId ?? "other";
  return { key: role, label: STAGE_KIND_LABEL[role] ?? n.role(role) };
}

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
};

const mean = (values: readonly number[]): number => (values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0);

const FAILURE_LABEL: Record<string, string> = { limit: "usage limit reached", "agent-stopped": "agent stopped", unusable: "unusable result", other: "other" };

/**
 * How the squad works in a period. `history` gives every turn of a task, in the period or not:
 * a profile is credited with an agent's stage only when every round of it ran on its settings.
 */
function squadView(turns: readonly WorkTurn[], moments: readonly WorkMoment[], buckets: readonly { start: number; end: number; label: string }[], n: Names, history: (taskId: Id) => readonly WorkTurn[]): SquadUsage {
  const of = (kind: WorkMoment["kind"]) => moments.filter((moment) => moment.kind === kind);
  const stageEnds = of("stage-end");
  const taskEnds = of("task-end");
  const delivered = taskEnds.filter((moment) => moment.outcome === "delivered");
  const cancelled = taskEnds.filter((moment) => moment.outcome === "cancelled");
  const inBucket = (list: readonly WorkMoment[], bucket: { start: number; end: number }) => list.filter((moment) => moment.at >= bucket.start && moment.at < bucket.end).length;

  const kinds = [...group(stageEnds.filter((moment) => moment.outcome !== "cancelled" && moment.durationMs !== undefined), (moment) => stageKindOf(moment, n).key).entries()].map(([key, list]) => {
    const total = list.reduce((sum, moment) => sum + (moment.durationMs ?? 0), 0);
    const work = list.reduce((sum, moment) => sum + (moment.workMs ?? 0), 0);
    return { key, label: stageKindOf(list[0]!, n).label, runs: list.length, typicalMs: median(list.map((moment) => moment.durationMs ?? 0)), ...(total > 0 ? { agentShare: Math.min(1, work / total) } : {}) };
  });
  const kindOrder = ["plan", "researcher", "design", "ux-designer", "builder", "tester", "review", "fixes", "release-manager"];
  kinds.sort((a, b) => (kindOrder.indexOf(a.key) + 1 || 99) - (kindOrder.indexOf(b.key) + 1 || 99));

  // Reviews.
  const reviewEnds = of("review-end");
  const sent = reviewEnds.filter((moment) => moment.outcome === "sent-back").length;
  const usedUp = reviewEnds.filter((moment) => moment.outcome === "rounds-used").length;
  const sendBacks = reviewEnds.length
    ? `${sent} of ${count(reviewEnds.length, "review")} sent work back to the builder${usedUp ? `, and ${usedUp} ran out of review rounds` : ""}.`
    : "No reviews finished in this period.";

  // Designs.
  const designEnds = of("design-end");
  const toYou = designEnds.filter((moment) => moment.outcome === "to-you").length;
  const avgRounds = designEnds.length ? designEnds.reduce((sum, moment) => sum + (moment.rounds ?? 1), 0) / designEnds.length : 0;
  const designRounds = designEnds.length
    ? `${designEnds.length === 1 ? "The design" : "Designs"} took ${(Math.round(avgRounds * 10) / 10).toString()} ${avgRounds === 1 ? "round" : "rounds"} on average${toYou ? `; ${toYou} of ${designEnds.length} came to you to decide` : ""}.`
    : "No designs settled in this period.";

  // Questions to the coordinator.
  const asks = of("ask");
  const agentAsks = asks.filter((moment) => moment.ask !== "checkpoint");
  const checkpoints = asks.filter((moment) => moment.ask === "checkpoint");
  const askParts: string[] = [];
  const answeredAsks = agentAsks.filter((moment) => moment.answer !== undefined && moment.durationMs !== undefined);
  const answeredChecks = checkpoints.filter((moment) => moment.answer !== undefined && moment.durationMs !== undefined);
  if (agentAsks.length) askParts.push(`Agents stopped to ask you ${count(agentAsks.length, "time")}${answeredAsks.length ? `; you answered in ${durationText(mean(answeredAsks.map((moment) => moment.durationMs!)))} on average` : ""}${agentAsks.length > answeredAsks.length ? `; ${agentAsks.length - answeredAsks.length} unanswered` : ""}`);
  if (checkpoints.length) askParts.push(`${count(checkpoints.length, "checkpoint")}${answeredChecks.length ? ` waited ${durationText(mean(answeredChecks.map((moment) => moment.durationMs!)))} on average for your OK` : ""}${checkpoints.length > answeredChecks.length ? `; ${checkpoints.length - answeredChecks.length} unanswered` : ""}`);
  const asksLine = askParts.length ? `${askParts.join(". ")}.` : "Nobody needed you in this period.";

  // Failures.
  const failureMoments = of("failure");
  const byReason = [...group(failureMoments, (moment) => moment.outcome ?? "other").entries()].map(([reason, list]) => ({ label: FAILURE_LABEL[reason] ?? reason, count: list.length })).sort((a, b) => b.count - a.count);
  const retries = of("retry").length;
  const failures = failureMoments.length
    ? `${count(failureMoments.length, "failure")} (${byReason.map((entry) => `${entry.count} ${entry.label}`).join(", ")}) and ${count(retries, "retry", "retries")}.`
    : retries
      ? `No failures, ${count(retries, "retry", "retries")}.`
      : "No failures.";

  // Comparisons per profile: only work that ran on the profile's own model and effort counts for it.
  // An agent's stage covers all its rounds, also those before the period: one round on other
  // settings takes the whole stage's credit away.
  const stageKey = (taskId: Id, stageId: Id | undefined, roleId: Id, profileId: Id) => `${taskId}|${stageId}|${roleId}|${profileId}`;
  const agentStages = group(turns, (turn) => stageKey(turn.taskId, turn.stageId, turn.roleId, turn.profileId));
  const everyRound = new Map<Id, Map<string, WorkTurn[]>>();
  const roundsOf = (taskId: Id, key: string): readonly WorkTurn[] => {
    let stages = everyRound.get(taskId);
    if (!stages) {
      stages = group(history(taskId), (turn) => stageKey(turn.taskId, turn.stageId, turn.roleId, turn.profileId));
      everyRound.set(taskId, stages);
    }
    return stages.get(key) ?? [];
  };
  const labels = new Map<string, { label: string; credited: boolean; off: boolean; unconfirmed: boolean }>();
  /** Who an agent's stage counts for, judged on all its rounds. */
  const labelOf = (taskId: Id, key: string) => {
    const known = labels.get(key);
    if (known) return known;
    const list = roundsOf(taskId, key);
    const first = list[0];
    let who: { label: string; credited: boolean; off: boolean; unconfirmed: boolean } | undefined;
    if (!first) who = undefined;
    else if (list.some((turn) => !confirmed(turn))) who = { label: "Settings not confirmed", credited: false, off: false, unconfirmed: true };
    else if (list.every(ranAsAsked)) {
      const profile = n.profile(first.profileId);
      who = { label: profile ? `${n.tool(profile.toolId)} · ${profile.model} · ${profile.effort}` : first.profileId, credited: true, off: false, unconfirmed: false };
    } else {
      const off = list.find((turn) => !ranAsAsked(turn))!;
      const model = off.modelChangedTo ? modelLabel(off.modelChangedTo) : sessionModelLabel(off) || ranName(off);
      who = { label: `${n.tool(first.toolId)} · ${model} · ${finalEffort(off) ?? "effort not confirmed"} (ran instead)`, credited: false, off: true, unconfirmed: false };
    }
    if (who) labels.set(key, who);
    return who;
  };
  let offSettings = 0;
  let unconfirmed = 0;
  for (const [key, list] of agentStages) {
    const who = labelOf(list[0]!.taskId, key);
    if (who?.off) offSettings += 1;
    if (who?.unconfirmed) unconfirmed += 1;
  }
  const rows = new Map<string, SquadRow>();
  const rowTimes = new Map<SquadRow, Tally>();
  const rowFor = (bucket: string, who: { label: string; credited: boolean }) => {
    const id = `${bucket}|${who.label}`;
    let entry = rows.get(id);
    if (!entry) {
      entry = { label: who.label, credited: who.credited, stages: 0, time: { atLeast: false }, rounds: 0, blocking: 0, sentBack: 0, designs: 0 };
      rows.set(id, entry);
      rowTimes.set(entry, emptyTally());
    }
    return entry;
  };
  const bucketOfRole = (roleId: Id) => {
    const result = n.roleResult(roleId);
    return result === "findings" ? "reviewer" : result === "brief" ? "architect" : result === "objections" ? "design-reviewer" : undefined;
  };
  for (const [key, list] of agentStages) {
    const bucket = bucketOfRole(list[0]!.roleId);
    const who = labelOf(list[0]!.taskId, key);
    if (!bucket || !who) continue;
    const entry = rowFor(bucket, who);
    entry.stages += 1;
    for (const turn of list) addTurn(rowTimes.get(entry)!, turn);
  }
  const whoFor = (moment: WorkMoment, roleId: Id | undefined, profileId: Id | undefined) => (roleId && profileId ? labelOf(moment.taskId, stageKey(moment.taskId, moment.stageId, roleId, profileId)) : undefined);
  for (const moment of of("verdict")) {
    const who = whoFor(moment, moment.roleId, moment.profileId);
    if (!who) continue;
    const entry = rowFor("reviewer", who);
    entry.rounds += 1;
    entry.blocking += moment.blocking ?? 0;
    if (moment.verdict === "fail" || (moment.blocking ?? 0) > 0) entry.sentBack += 1;
  }
  for (const moment of of("design-round")) {
    const author = whoFor(moment, moment.roleId, moment.profileId);
    if (author) rowFor("architect", author).rounds += 1;
    const reviewer = whoFor(moment, moment.peerRoleId, moment.peerProfileId);
    if (reviewer) {
      const entry = rowFor("design-reviewer", reviewer);
      entry.rounds += 1;
      entry.blocking += moment.blocking ?? 0;
    }
  }
  for (const moment of designEnds) {
    const author = whoFor(moment, moment.roleId, moment.profileId);
    if (!author) continue;
    const entry = rowFor("architect", author);
    entry.designs += 1;
    if (moment.outcome === "to-you") entry.sentBack += 1;
  }
  const rowsOf = (bucket: string) =>
    [...rows.entries()]
      .filter(([id]) => id.startsWith(`${bucket}|`))
      .map(([, entry]) => {
        const tally = rowTimes.get(entry)!;
        entry.time = tally.turns > 0 ? figures(tally).time : { atLeast: false };
        return entry;
      })
      .sort((a, b) => Number(b.credited) - Number(a.credited) || b.stages - a.stages || a.label.localeCompare(b.label));

  const settingsParts: string[] = [];
  settingsParts.push(`${count(offSettings, "agent stage")} ran on settings other than those asked for`);
  settingsParts.push(`${unconfirmed} ${unconfirmed === 1 ? "wasn't" : "weren't"} confirmed`);

  return {
    stagesRun: stageEnds.length,
    turnsRun: turns.length,
    delivered: delivered.length,
    cancelled: cancelled.length,
    chart: buckets.map((bucket) => ({ start: bucket.start, label: bucket.label, delivered: inBucket(delivered, bucket), cancelled: inBucket(cancelled, bucket) })),
    stageKinds: kinds,
    sendBacks,
    designRounds,
    asks: asksLine,
    failures,
    details: {
      reviewers: rowsOf("reviewer"),
      architects: rowsOf("architect"),
      designReviewers: rowsOf("design-reviewer"),
      failuresByReason: byReason,
      retries,
      redone: of("redo").length,
      interrupted: turns.filter((turn) => turn.end === "interrupted").length,
      settingsLine: `${settingsParts.join(", and ")}. Comparisons per profile only count stages that ran on the profile's own model and effort.`,
    },
  };
}

function analyticsView(log: WorkLogReader, request: { period: UsagePeriod; productId?: Id }, ctx: UsageContext): AnalyticsUsage {
  const range = periodRange(request.period, ctx.now);
  const filter = { from: range.from, to: range.to, ...(request.productId ? { productId: request.productId } : {}) };
  const turns = ended(log.turns(filter));
  const lines = log.lines(filter);
  const moments = log.moments(filter);
  const n = names(ctx.state, log, ctx.task, ctx.taskName);
  // When the period starts before Petrina kept track, any tool, role or model may miss earlier work,
  // and so may every product that was already there. A product added later cannot.
  const since = log.since();
  const addedLater = (productId: Id) => (n.record(productId)?.addedAt ?? -Infinity) > since;
  const before = range.from < since && !(request.productId && addedLater(request.productId));
  const untracked = log.untracked();
  const tally = turns.reduce(addTurn, emptyTally());

  const toolIds = [...new Set(turns.map((turn) => turn.toolId))];
  for (const tool of ctx.state.tools) if (tool.status === "ready" && !toolIds.includes(tool.id)) toolIds.push(tool.id);

  const buckets: ChartBucket[] = range.buckets.map((bucket) => {
    const inside = turns.filter((turn) => (turn.endedAt ?? turn.startedAt) >= bucket.start && (turn.endedAt ?? turn.startedAt) < bucket.end);
    const tokens: Record<Id, number> = {};
    const timeMs: Record<Id, number> = {};
    for (const turn of inside) {
      tokens[turn.toolId] = (tokens[turn.toolId] ?? 0) + (turn.tokens?.total ?? 0);
      timeMs[turn.toolId] = (timeMs[turn.toolId] ?? 0) + (turn.workMs ?? 0);
    }
    return { start: bucket.start, label: bucket.label, tokens, timeMs };
  });

  const byTool = [...group(turns, (turn) => turn.toolId).entries()].map(([toolId, list]) => lineOf(`tool:${toolId}`, n.tool(toolId), list, { toolId }, before)).sort(byTokens);
  const byRole = [...group(turns, (turn) => turn.roleId).entries()].map(([roleId, list]) => lineOf(`role:${roleId}`, n.role(roleId), list, { roleId }, before)).sort(byTokens);
  const byProduct = request.productId
    ? undefined
    : [...group(turns, (turn) => turn.productId).entries()]
        .map(([productId, list]) => {
          const product = n.product(productId);
          return lineOf(`product:${productId}`, product.label, list, { productId, ...(product.removed ? { note: "removed" } : {}) }, before && !addedLater(productId));
        })
        .sort(byTokens);
  const byTask = [...group(turns, (turn) => turn.taskId).entries()]
    .map(([taskId, list]) => {
      const product = n.product(list[0]!.productId);
      // Earlier work is missing from a task's line only in a period that starts before tracking began, as on every other line.
      return lineOf(`task:${taskId}`, n.taskName(taskId) ?? "A task no longer on the board", list, { taskId, productId: list[0]!.productId, context: product.label, ...(product.removed ? { note: "removed" } : {}) }, before && untracked.has(taskId));
    })
    .sort(byTokens);

  const claudeMainOnly = turns.filter((turn) => turn.toolId === "claude-code" && turn.mainOnly).length;
  const codexHelperTurns = turns.filter((turn) => turn.toolId === "codex" && turn.helpers > 0).length;

  return {
    view: "analytics",
    period: request.period,
    ...(request.productId ? { productId: request.productId } : {}),
    from: range.from,
    to: range.to,
    headline: { ...figures(tally, before), turns: tally.turns, tasks: new Set(turns.map((turn) => turn.taskId)).size },
    atLeast: reasonsOf(tally, before),
    chart: { hourly: range.hourly, tools: toolIds.map((toolId) => ({ toolId, label: n.tool(toolId) })), buckets },
    overTime: tokensOverTime(turns, lines, range.buckets, range.hourly, n.tool),
    limits: limitsOverTime(log.usageHistory({ from: range.from, to: range.to }), ctx.state.pool.usage ?? [], range, ctx.now, n.tool, ctx.state.tools.map((tool) => tool.id)),
    byTool,
    byModel: modelSplit(turns, lines, before),
    byRole,
    ...(byProduct ? { byProduct } : {}),
    byTask,
    squad: squadView(turns, moments, dayBuckets(request.period, ctx.now), n, (taskId) => log.turns({ taskId })),
    about: { turns: tally.turns, codexHelperTurns, claudeMainOnly, tools: toolIds },
  };
}

/** Work out one view from the log. */
export function usageView<R extends UsageRequest>(log: WorkLogReader, request: R, ctx: UsageContext): UsageViewFor<R> {
  switch (request.view) {
    case "task":
      return taskView(log, request.taskId, ctx) as UsageViewFor<R>;
    case "products":
      return productsView(log, ctx) as UsageViewFor<R>;
    case "today":
      return todayView(log, ctx) as UsageViewFor<R>;
    case "analytics":
      return analyticsView(log, request, ctx) as UsageViewFor<R>;
  }
  throw new Error("Unknown view");
}
