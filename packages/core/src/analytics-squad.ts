import { figures, type Detail } from "./analytics-figures.js";
import type { AnalyticsThroughput, ThroughputTaskRecord } from "./analytics-throughput-record.js";
import type { OverTimeView } from "./charts.js";
import type { LimitsOverTime, ReadingsRequest, ReadingsView } from "./limit-history-view.js";
import type { AgentProfile, Id, State, Task, UsageReport } from "./model.js";
import type { NodeUsage } from "./node-usage.js";
import { atLeastLine, count, durationText, listWords, type Figure } from "./numbers.js";
import {
  addTurn, emptyTally, modelLabel, sameModel, sessionModelLabel,
  type Tally, type WorkLogReader, type WorkMoment, type WorkTurn,
} from "./worklog.js";

export type UsagePeriod = "today" | "7d" | "30d";

export const USAGE_PERIODS: readonly UsagePeriod[] = ["today", "7d", "30d"];

export type UsageRequest =
  | ReadingsRequest
  | { view: "task"; taskId: Id }
  | { view: "node"; taskId: Id; nodeId: Id }
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
  /** The live allowance readings Analytics uses instead of the pool's current ones: a paged read keeps its first page's. */
  usage?: readonly UsageReport[];
  /** Configured concurrent automated check slots (defaults to 1). */
  checkSlots?: number;
  /** Compact throughput records for archived tasks in the window, without loading conversations. */
  archivedThroughputTasks?: (filter: {
    from: number;
    productId?: Id;
    taskIds: readonly Id[];
  }) => readonly ThroughputTaskRecord[];
}

export interface WorkUsageLine {
  key: string;
  label: string;
  note?: string;
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
  settings: string;
  differs: boolean;
  notConfirmed: boolean;
  rounds: number;
  turns: number;
  tokens: Figure;
  time: Figure;
  models: { label: string; tokens: number }[];
}

export interface StageUsage {
  stageId: Id;
  title: string;
  removed: boolean;
  rounds: number;
  tokens: Figure;
  time: Figure;
  agents: AgentUsage[];
}

export interface TaskUsageSummary {
  empty?: "untracked" | "nothing";
  tokens: Figure;
  time: Figure;
}

export interface TaskUsage extends TaskUsageSummary {
  view: "task";
  cacheRead?: number;
  atLeast: string;
  stages: StageUsage[];
}

export interface ProductsUsage {
  view: "products";
  products: { productId: Id; tokens: Figure; time: Figure; turns: number }[];
  atLeast: string;
}

export interface TodayUsage {
  view: "today";
  turns: number;
  tokens: Figure;
  time: Figure;
  atLeast: string;
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
  credited: boolean;
  stages: number;
  time: Figure;
  rounds: number;
  blocking: number;
  sentBack: number;
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
    settingsLine: string;
  };
}

export interface AboutCounts {
  turns: number;
  codexHelperTurns: number;
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
  overTime: OverTimeView;
  limits: LimitsOverTime;
  byTool: WorkUsageLine[];
  byModel: WorkUsageLine[];
  byRole: WorkUsageLine[];
  byProduct?: WorkUsageLine[];
  byTask: WorkUsageLine[];
  squad: SquadUsage;
  throughput: AnalyticsThroughput;
  about: AboutCounts;
}

export type UsageView = ReadingsView | NodeUsage | TaskUsage | ProductsUsage | TodayUsage | AnalyticsUsage;

export type UsageViewFor<R extends UsageRequest> = R extends { view: "readings" }
  ? ReadingsView
  : R extends { view: "node" }
    ? NodeUsage
    : R extends { view: "task" }
      ? TaskUsage
      : R extends { view: "products" }
        ? ProductsUsage
        : R extends { view: "today" }
          ? TodayUsage
          : AnalyticsUsage;

const TOOL_NAMES: Record<Id, string> = { "claude-code": "Claude Code", codex: "Codex", grok: "Grok", antigravity: "Antigravity" };
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Today; today and the 6 days before; today and the 29 days before. Counted from local midnight. */
export function periodRange(period: UsagePeriod, now: number): {
  from: number;
  to: number;
  hourly: boolean;
  buckets: {
  start: number;
  end: number;
  label: string
}[]
} {
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

export function detailOf(tally: Tally): Detail {
  return {
    ...(tally.hasInput ? { input: tally.input } : {}),
    ...(tally.hasCacheRead ? { cacheRead: tally.cacheRead } : {}),
    ...(tally.hasCacheWrite ? { cacheWrite: tally.cacheWrite } : {}),
    ...(tally.hasOutput ? { output: tally.output } : {}),
  };
}

export function reasonsOf(tally: Tally, beforeTracking: boolean): string {
  return atLeastLine({ noTokens: tally.noTokens, lost: tally.lost, beforeTracking, recorded: tally.turns });
}

export const ended = (turns: readonly WorkTurn[]) => turns.filter((turn) => turn.end !== undefined);

export function group<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = groups.get(k);
    if (list) list.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}

export const byTokens = (a: WorkUsageLine, b: WorkUsageLine) =>
  (b.tokens.value ?? -1) - (a.tokens.value ?? -1) || (b.time.value ?? -1) - (a.time.value ?? -1) || a.label.localeCompare(b.label);

export function names(state: State, log: WorkLogReader, task?: UsageContext["task"], taskName?: UsageContext["taskName"]) {
  const products = new Map(state.products.map((product) => [product.id, product]));
  const ever = new Map(log.products().map((record) => [record.id, record]));
  const tasks = new Map(state.tasks.map((entry) => [entry.id, entry]));
  const roles = new Map(state.roles.map((role) => [role.id, role]));
  const tools = new Map(state.tools.map((tool) => [tool.id, tool]));
  const profiles = new Map([...(state.retiredProfiles ?? []), ...state.profiles].map((profile) => [profile.id, profile]));
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

export type Names = ReturnType<typeof names>;

const askedName = (turn: WorkTurn) => turn.modelAskedName ?? turn.modelAsked ?? "the default";
const ranName = (turn: WorkTurn) => (turn.toolId === "grok" ? modelLabel(turn.modelRan) : (turn.modelRanName ?? turn.modelRan ?? ""));
const finalEffort = (turn: WorkTurn) => turn.effortChangedTo ?? turn.effortRan;

/** The turn ran on exactly the model and effort that were asked for, start to end. */
export function ranAsAsked(turn: WorkTurn): boolean {
  return (
    turn.modelRan !== undefined
    && turn.effortRan !== undefined
    && sameModel(turn.toolId, turn.modelAsked, turn.modelRan)
    && turn.effortRan === turn.effortAsked
    && turn.modelChangedTo === undefined
    && turn.effortChangedTo === undefined
  );
}

const confirmed = (turn: WorkTurn) => turn.modelRan !== undefined && turn.effortRan !== undefined;

/** An agent's settings in words, from its turns in one stage. */
export function settingsWords(turns: readonly WorkTurn[]): { text: string; differs: boolean; notConfirmed: boolean } {
  const last = turns.at(-1)!;
  if (turns.some((turn) => turn.modelRan === undefined)) return { text: "settings not confirmed", differs: false, notConfirmed: true };
  const ran = (turn: WorkTurn) => `${ranName(turn)}${turn.effortRan ? ` at ${turn.effortRan}` : ", effort not confirmed"}`;
  const distinct = [...new Set(turns.map(ran))];
  const change = turns.filter((turn) => turn.modelChangedTo !== undefined || turn.effortChangedTo !== undefined).at(-1);
  const to = change ? [
    change.modelChangedTo ? modelLabel(change.modelChangedTo) : "",
    change.effortChangedTo ? `${change.effortChangedTo} effort` : ""
  ].filter(Boolean).join(" at ") : "";
  const switched = change ? `, switched to ${to} during a turn` : "";
  const differs = turns.some((turn) => !sameModel(
    turn.toolId,
    turn.modelAsked,
    turn.modelRan
  ) || (turn.effortRan !== undefined && turn.effortRan !== turn.effortAsked));
  const notConfirmed = turns.some((turn) => turn.effortRan === undefined);
  const ranText = distinct.length > 1 ? `ran ${listWords(distinct)}` : `ran ${distinct[0]}`;
  if (differs) return { text: `asked for ${askedName(last)} at ${last.effortAsked ?? "the default effort"}, ${ranText}${switched}`, differs, notConfirmed };
  return { text: `${distinct.length > 1 ? ranText : distinct[0]}${switched}`, differs: change !== undefined, notConfirmed };
}

const STAGE_KIND_LABEL: Record<string, string> = {
  researcher: "Research",
  "ux-designer": "Screens",
  builder: "Build",
  tester: "Testing",
  "release-manager": "Delivery",
};

function stageKindOf(moment: WorkMoment, lookup: Names): { key: string; label: string } {
  if (moment.stageKind === "plan") return { key: "plan", label: "Planning" };
  if (moment.stageKind === "converge") return { key: "design", label: "Design" };
  if (moment.stageKind === "review-chain") return { key: "review", label: "Review" };
  if (moment.roleId && lookup.roleResult(moment.roleId) === "build" && (moment.round ?? 1) > 1) return { key: "fixes", label: "Fixes after review" };
  const role = moment.roleId ?? "other";
  return { key: role, label: STAGE_KIND_LABEL[role] ?? lookup.role(role) };
}

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
};

const mean = (values: readonly number[]): number => (values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0);

const FAILURE_LABEL: Record<string, string> = { limit: "usage limit reached", "agent-stopped": "agent stopped", unusable: "unusable result", other: "other" };

export function squadView(
  turns: readonly WorkTurn[],
  moments: readonly WorkMoment[],
  buckets: readonly { start: number; end: number; label: string }[],
  lookup: Names,
  history: (taskId: Id) => readonly WorkTurn[],
): SquadUsage {
  const of = (kind: WorkMoment["kind"]) => moments.filter((moment) => moment.kind === kind);
  const stageEnds = of("stage-end");
  const taskEnds = of("task-end");
  const delivered = taskEnds.filter((moment) => moment.outcome === "delivered");
  const cancelled = taskEnds.filter((moment) => moment.outcome === "cancelled");
  const inBucket = (
    list: readonly WorkMoment[],
    bucket: {
    start: number;
    end: number
  }
  ) => list.filter((moment) => moment.at >= bucket.start && moment.at < bucket.end).length;

  const kinds = [...group(
    stageEnds.filter((moment) => moment.outcome !== "cancelled" && moment.durationMs !== undefined),
    (moment) => stageKindOf(
    moment,
    lookup
  ).key
  ).entries()].map(([key, list]) => {
    const total = list.reduce((sum, moment) => sum + (moment.durationMs ?? 0), 0);
    const work = list.reduce((sum, moment) => sum + (moment.workMs ?? 0), 0);
    return {
      key,
      label: stageKindOf(
      list[0]!,
      lookup
    ).label,
      runs: list.length,
      typicalMs: median(list.map((moment) => moment.durationMs ?? 0)),
      ...(total > 0 ? { agentShare: Math.min(
      1,
      work / total
    ) } : {})
    };
  });
  const kindOrder = ["plan", "researcher", "design", "ux-designer", "builder", "tester", "review", "fixes", "release-manager"];
  kinds.sort((a, b) => (kindOrder.indexOf(a.key) + 1 || 99) - (kindOrder.indexOf(b.key) + 1 || 99));

  const reviewEnds = of("review-end");
  const sent = reviewEnds.filter((moment) => moment.outcome === "sent-back").length;
  const usedUp = reviewEnds.filter((moment) => moment.outcome === "rounds-used").length;
  const sendBacks = reviewEnds.length
    ? `${sent} of ${count(reviewEnds.length, "review")} sent work back to the builder${usedUp ? `, and ${usedUp} ran out of review rounds` : ""}.`
    : "No reviews finished in this period.";

  const designEnds = of("design-end");
  const toYou = designEnds.filter((moment) => moment.outcome === "to-you").length;
  const avgRounds = designEnds.length ? designEnds.reduce((sum, moment) => sum + (moment.rounds ?? 1), 0) / designEnds.length : 0;
  const designRounds = designEnds.length
    ? `${designEnds.length === 1 ? "The design" : "Designs"} took ${(Math.round(avgRounds * 10) / 10).toString()} ${avgRounds === 1 ? "round" : "rounds"} on average${toYou ? `; ${toYou} of ${designEnds.length} came to you to decide` : ""}.`
    : "No designs settled in this period.";

  const asks = of("ask");
  const agentAsks = asks.filter((moment) => moment.ask !== "checkpoint");
  const checkpoints = asks.filter((moment) => moment.ask === "checkpoint");
  const askParts: string[] = [];
  const answeredAsks = agentAsks.filter((moment) => moment.answer !== undefined && moment.durationMs !== undefined);
  const answeredChecks = checkpoints.filter((moment) => moment.answer !== undefined && moment.durationMs !== undefined);
  if (agentAsks.length) askParts.push(`Agents stopped to ask you ${count(
    agentAsks.length,
    "time"
  )}${answeredAsks.length ? `; you answered in ${durationText(mean(answeredAsks.map((moment) => moment.durationMs!)))} on average` : ""}${agentAsks.length > answeredAsks.length ? `; ${agentAsks.length - answeredAsks.length} unanswered` : ""}`);
  if (checkpoints.length) askParts.push(`${count(
    checkpoints.length,
    "checkpoint"
  )}${answeredChecks.length ? ` waited ${durationText(mean(answeredChecks.map((moment) => moment.durationMs!)))} on average for your OK` : ""}${checkpoints.length > answeredChecks.length ? `; ${checkpoints.length - answeredChecks.length} unanswered` : ""}`);
  const asksLine = askParts.length ? `${askParts.join(". ")}.` : "Nobody needed you in this period.";

  const failureMoments = of("failure");
  const byReason = [...group(
    failureMoments,
    (moment) => moment.outcome ?? "other"
  ).entries()].map(([reason, list]) => ({
    label: FAILURE_LABEL[reason] ?? reason,
    count: list.length
  })).sort((
    a,
    b
  ) => b.count - a.count);
  const retries = of("retry").length;
  const failures = failureMoments.length
    ? `${count(
      failureMoments.length,
      "failure"
    )} (${byReason.map((entry) => `${entry.count} ${entry.label}`).join(", ")}) and ${count(
      retries,
      "retry",
      "retries"
    )}.`
    : retries ? `No failures, ${count(retries, "retry", "retries")}.` : "No failures.";

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
  const labelOf = (taskId: Id, key: string) => {
    const known = labels.get(key);
    if (known) return known;
    const list = roundsOf(taskId, key);
    const first = list[0];
    let who: { label: string; credited: boolean; off: boolean; unconfirmed: boolean } | undefined;
    if (!first) who = undefined;
    else if (list.some((turn) => !confirmed(turn))) who = { label: "Settings not confirmed", credited: false, off: false, unconfirmed: true };
    else if (list.every(ranAsAsked)) {
      const profile = lookup.profile(first.profileId);
      who = {
        label: profile ? `${lookup.tool(profile.toolId)} · ${profile.model} · ${profile.effort}` : first.profileId,
        credited: true,
        off: false,
        unconfirmed: false
      };
    } else {
      const off = list.find((turn) => !ranAsAsked(turn))!;
      const model = off.modelChangedTo ? modelLabel(off.modelChangedTo) : sessionModelLabel(off) || ranName(off);
      who = {
        label: `${lookup.tool(first.toolId)} · ${model} · ${finalEffort(off) ?? "effort not confirmed"} (ran instead)`,
        credited: false,
        off: true,
        unconfirmed: false
      };
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
    const result = lookup.roleResult(roleId);
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
  const whoFor = (moment: WorkMoment, roleId: Id | undefined, profileId: Id | undefined) =>
    roleId && profileId ? labelOf(moment.taskId, stageKey(moment.taskId, moment.stageId, roleId, profileId)) : undefined;
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

  const settingsParts = [
    `${count(offSettings, "agent stage")} ran on settings other than those asked for`,
    `${unconfirmed} ${unconfirmed === 1 ? "wasn't" : "weren't"} confirmed`,
  ];

  return {
    stagesRun: stageEnds.length,
    turnsRun: turns.length,
    delivered: delivered.length,
    cancelled: cancelled.length,
    chart: buckets.map((bucket) => ({
      start: bucket.start,
      label: bucket.label,
      delivered: inBucket(
      delivered,
      bucket
    ),
      cancelled: inBucket(
      cancelled,
      bucket
    )
    })),
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
