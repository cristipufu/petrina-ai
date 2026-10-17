// Usage limits: who is out of usage, who is close, and which profile works instead. Pure, so the engine,
// the simulator and the window all read the same answers.

import type { AgentProfile, Id, Pool, State, UsageLimit, UsageReport } from "./model.js";

/** From this much of a limit used, new agents prefer a tool that is further from its own. */
export const NEAR_LIMIT = 0.9;

/** A report with no reset time stops counting after this long without a newer one. */
const STALE_REPORT_MS = 30 * 60_000;

/** When a tool does not say when it is back: try again after this long. */
export const UNKNOWN_LIMIT_MS = 30 * 60_000;

const KIND_WORDS: Readonly<Record<string, string>> = {
  five_hour: "5-hour",
  seven_day: "weekly",
  seven_day_opus: "weekly Opus",
  seven_day_sonnet: "weekly Sonnet",
  seven_day_overage_included: "weekly",
  overage: "extra usage",
};

/** A limit's name in plain words: "weekly Opus". */
export const kindWords = (kind: string): string => KIND_WORDS[kind] ?? "usage";

const modelWords = (family: string): string => family.charAt(0).toUpperCase() + family.slice(1);

/** Whether a model family ("opus") is the profile's model. */
export function inFamily(profile: Pick<AgentProfile, "model" | "modelId">, family: string): boolean {
  const wanted = family.toLowerCase();
  return `${profile.modelId ?? ""} ${profile.model}`.toLowerCase().includes(wanted);
}

const covers = (entry: { toolId: Id; model?: string | undefined }, profile: AgentProfile): boolean => entry.toolId === profile.toolId && (!entry.model || inFamily(profile, entry.model));

/** The limits still in force at `now`. */
export function liveLimits(pool: Pool, now: number): readonly UsageLimit[] {
  return (pool.limited ?? []).filter((limit) => limit.until > now);
}

/** The limit that keeps this profile from working, if there is one. */
export function limitOf(pool: Pool, profile: AgentProfile, now: number): UsageLimit | undefined {
  return liveLimits(pool, now).find((limit) => covers(limit, profile));
}

/** The earliest time a limit in force ends, or undefined with none. */
export function nextExpiry(pool: Pool, now: number): number | undefined {
  const times = liveLimits(pool, now).map((limit) => limit.until);
  return times.length ? Math.min(...times) : undefined;
}

/** The limits with this one added, replacing an older one for the same tool and model. */
export function withLimit(limits: readonly UsageLimit[] | undefined, limit: UsageLimit): UsageLimit[] {
  const same = (entry: UsageLimit) => entry.toolId === limit.toolId && (entry.model ?? "") === (limit.model ?? "");
  const kept = (limits ?? []).filter((entry) => !same(entry));
  const older = (limits ?? []).find(same);
  return [...kept, older && older.until > limit.until ? older : limit];
}

/** The reports with this one added, replacing the last one for the same tool and kind of limit. */
export function withReport(reports: readonly UsageReport[] | undefined, report: UsageReport): UsageReport[] {
  return [...(reports ?? []).filter((entry) => !(entry.toolId === report.toolId && entry.kind === report.kind && (entry.model ?? "") === (report.model ?? ""))), report];
}

/** A report that still counts at `now`. */
const current = (report: UsageReport, now: number): boolean => (report.resetsAt !== undefined ? report.resetsAt > now : now - report.at < STALE_REPORT_MS);

/** Whether the profile's tool says it is close to a limit that covers this profile's model. */
export function nearLimit(pool: Pool, profile: AgentProfile, now: number): boolean {
  return (pool.usage ?? []).some((report) => report.status !== "rejected" && covers(report, profile) && current(report, now) && (report.status === "allowed_warning" || (report.utilization ?? 0) >= NEAR_LIMIT));
}

export type Choice = { kind: "planned" | "substitute"; profile: AgentProfile } | { kind: "none"; waiting: string };

/**
 * Which profile actually works a step planned for `planned`. The planned one when it is free to work and
 * not close to a limit. When it is out: another model on the same tool, else a profile on another tool,
 * preferring the same effort and tools not close to their limits, in the order of the profile list. When it
 * is only close to a limit: an equal profile on a tool that is not, if there is one. Never a profile that
 * is not in the list (the coordinator removed it). With nobody left, the words for waiting.
 */
/**
 * Rules a role's choice keeps. `keep`: never swap the planned profile for being near a limit (reviews were
 * planned on their tools for independence). `awayFrom`: the builder's tool and model, which a security
 * review's stand-in stays as far from as it can: another tool first, then another model on that tool, and
 * only as a last resort the same model. It never waits for that.
 */
export interface ChoiceRules {
  keep?: boolean;
  awayFrom?: { toolId: Id; modelId?: string };
  /** Stand-in tools that cannot take a seat right now. The planned profile is never skipped for this. */
  skipTools?: ReadonlySet<Id>;
}

export function chooseProfile(state: Pick<State, "profiles" | "tools" | "pool">, planned: AgentProfile, now: number, rules: ChoiceRules = {}): Choice {
  const { pool } = state;
  const free = (profile: AgentProfile) => !limitOf(pool, profile, now);
  const near = (profile: AgentProfile) => nearLimit(pool, profile, now);
  const ready = state.tools.filter((tool) => tool.status === "ready").map((tool) => tool.id);
  const skipped = rules.skipTools;
  // With no tool found ready (tests stand in for the tools), every tool in the list counts.
  const usable = (profile: AgentProfile) => free(profile) && (!ready.length || ready.includes(profile.toolId)) && !skipped?.has(profile.toolId);
  // How close a stand-in is to the work it must judge: 0 another tool, 1 another model on that tool, 2 the same model.
  const away = rules.awayFrom;
  const sameness = (profile: AgentProfile) => (!away || profile.toolId !== away.toolId ? 0 : profile.modelId !== away.modelId ? 1 : 2);
  // The most independent first, then not near a limit, then the same effort, then the list's order.
  const closest = (profiles: AgentProfile[]) =>
    [...profiles].sort((a, b) => sameness(a) - sameness(b) || Number(near(a)) - Number(near(b)) || Number(b.effort === planned.effort) - Number(a.effort === planned.effort))[0];

  if (free(planned)) {
    if (!near(planned) || rules.keep) return { kind: "planned", profile: planned };
    const equal = closest(state.profiles.filter((profile) => profile.toolId !== planned.toolId && profile.effort === planned.effort && usable(profile) && !near(profile) && !profile.standby));
    return equal ? { kind: "substitute", profile: equal } : { kind: "planned", profile: planned };
  }
  const sameTool = closest(state.profiles.filter((profile) => profile.id !== planned.id && profile.toolId === planned.toolId && usable(profile)));
  const other = closest(state.profiles.filter((profile) => profile.toolId !== planned.toolId && usable(profile)));
  // Another model on the planned tool first, unless that is less independent than what another tool offers.
  const pick = sameTool && (!other || sameness(sameTool) <= sameness(other)) ? sameTool : other;
  if (pick) return { kind: "substitute", profile: pick };
  return { kind: "none", waiting: waitingWords(state, now) };
}

/**
 * `chooseProfile`, then the next stand-in when the one it picked has no seat (`room` is false).
 * A planned profile is kept even when its tool is full: the cap is there so another tool's own
 * task can take the seat. With every stand-in full, the first of them is returned, so the task
 * waits for that tool's seat rather than for a usage limit.
 */
export function chooseWithRoom(state: Pick<State, "profiles" | "tools" | "pool">, planned: AgentProfile, now: number, rules: ChoiceRules = {}, room?: (toolId: Id) => boolean): Choice {
  const skip = new Set<Id>(rules.skipTools ?? []);
  let held: Choice | undefined;
  for (;;) {
    const choice = chooseProfile(state, planned, now, skip.size ? { ...rules, skipTools: skip } : rules);
    if (!room || choice.kind !== "substitute" || room(choice.profile.toolId)) {
      if (choice.kind === "none" && held?.kind === "substitute") return held;
      return choice;
    }
    if (skip.has(choice.profile.toolId)) return choice;
    held ??= choice;
    skip.add(choice.profile.toolId);
  }
}

const toolName = (state: Pick<State, "tools">, toolId: Id): string => state.tools.find((tool) => tool.id === toolId)?.name ?? toolId;

/** "17:00" today, "Fri 17:00" on another day. */
export function untilWords(time: number, now: number): string {
  const at = new Date(time);
  const clock = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  if (at.toDateString() === new Date(now).toDateString()) return clock;
  return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][at.getDay()]} ${clock}`;
}

/** What a task waiting for usage says: who is out, and until when the first of them is back. */
export function waitingWords(state: Pick<State, "tools" | "pool">, now: number): string {
  const limits = liveLimits(state.pool, now);
  if (!limits.length) return "Waiting for usage";
  const order = (toolId: Id) => state.tools.findIndex((tool) => tool.id === toolId);
  const names = [...new Set([...limits].sort((a, b) => order(a.toolId) - order(b.toolId)).map((limit) => `${toolName(state, limit.toolId)}${limit.model ? ` (${modelWords(limit.model)})` : ""}`))];
  const who = names.length === 1 ? `${names[0]} is` : `${names.slice(0, -1).join(", ")} and ${names.at(-1)} are`;
  return `Waiting for usage: ${who} out until ${untilWords(Math.min(...limits.map((limit) => limit.until)), now)}`;
}

/** One line of a tool's usage for the window. */
export interface UsageLine {
  toolId: Id;
  name: string;
  /** "weekly 82% · Opus out until Fri 17:00", or "fine". */
  text: string;
  tone: "fine" | "near" | "out";
}

/** Every tool's usage in plain words: how much of each limit is used, and who is out until when. */
export function usageLines(state: Pick<State, "tools" | "pool">, now: number): UsageLine[] {
  const lines = state.tools.map((tool) => {
    const reports = (state.pool.usage ?? []).filter((report) => report.toolId === tool.id && current(report, now));
    const used = reports
      .filter((report) => report.utilization !== undefined || report.status === "allowed_warning")
      .sort((a, b) => (b.utilization ?? 0) - (a.utilization ?? 0))
      .slice(0, 2)
      .map((report) => (report.utilization !== undefined ? `${kindWords(report.kind)} ${Math.round(report.utilization * 100)}%` : `${kindWords(report.kind)} nearly used`));
    const out = liveLimits(state.pool, now)
      .filter((limit) => limit.toolId === tool.id)
      .map((limit) => `${limit.model ? `${modelWords(limit.model)} ` : ""}out until ${untilWords(limit.until, now)}`);
    const parts = [...used, ...out];
    const near = reports.some((report) => report.status === "allowed_warning" || (report.utilization ?? 0) >= NEAR_LIMIT);
    return { line: { toolId: tool.id, name: tool.name, text: parts.length ? parts.join(" · ") : "fine", tone: (out.length ? "out" : near ? "near" : "fine") as UsageLine["tone"] }, shown: tool.status === "ready" || parts.length > 0 };
  });
  // A tool that is not here and has said nothing is not listed.
  return lines.filter((entry) => entry.shown).map((entry) => entry.line);
}
