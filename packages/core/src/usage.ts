// Usage limits: who is out of usage, who is close, and which profile works instead. Pure, so the engine,
// the simulator and the window all read the same answers.

import type { AgentProfile, Id, Pool, State, UsageLimit, UsageReport } from "./model.js";

/** From this much of a limit used, new agents prefer a tool that is further from its own. */
export const NEAR_LIMIT = 0.9;

/** From this much of a window used, a tool slows down: it gets fewer new agents, so it does not run into the wall. */
export const SLOW_DOWN = 0.8;

/** How much of its cap a tool that slows down keeps for new agents (rounded up, at least one). */
export const SLOW_DOWN_SHARE = 0.5;

/** What the usage line says about a tool that slows down. */
export const HOLDING_BACK = "starting fewer agents on it";

/** A report with no reset time stops counting after this long without a newer one. */
const STALE_REPORT_MS = 30 * 60_000;

const HOUR = 3_600_000;

/** A window about to reset counts as at least this far from it (hours), so its room does not read as endless. */
const LEAST_HOURS = 0.25;

/** When a tool does not say when it is back: try again after this long. */
export const UNKNOWN_LIMIT_MS = 30 * 60_000;

const KIND_WORDS: Readonly<Record<string, string>> = {
  five_hour: "5-hour",
  seven_day: "weekly",
  seven_day_opus: "weekly Opus",
  seven_day_sonnet: "weekly Sonnet",
  seven_day_overage_included: "weekly",
  overage: "extra usage",
  monthly: "monthly",
};

/** A limit's name in plain words: "weekly Opus". */
export function kindWords(kind: string, minutes?: number, name?: string): string {
  let label = KIND_WORDS[kind] ?? "usage";
  if (minutes !== undefined && Number.isFinite(minutes) && minutes > 0) {
    label = minutes === 10_080 ? "weekly" : minutes === 1440 ? "daily" : minutes < 60 ? `${Math.round(minutes)}-minute` : minutes < 1440 ? `${Math.round(minutes / 60)}-hour` : `${Math.round(minutes / 1440)}-day`;
  }
  return name ? `${label}, ${name}` : label;
}

const CLAUDE_FAMILY_OF_KIND: Readonly<Record<string, string>> = { seven_day_opus: "opus", seven_day_sonnet: "sonnet", seven_day_overage_included: "fable" };
const CLAUDE_KIND_OF_FAMILY = Object.fromEntries(Object.entries(CLAUDE_FAMILY_OF_KIND).map(([kind, family]) => [family, kind]));

/** Account names and native kinds identify the same Claude model windows, including saved aliases. */
export function claudeWindow<T extends Omit<UsageReport, "at">>(report: T): T {
  if (report.toolId !== "claude-code") return report;
  const family = CLAUDE_FAMILY_OF_KIND[report.kind] ?? (report.kind === "seven_day_model" ? report.model?.trim().toLowerCase() : undefined);
  if (!family) return report;
  const normalized = { ...report, kind: CLAUDE_KIND_OF_FAMILY[family] ?? "seven_day_model", model: family };
  if (family === "opus" || family === "sonnet") {
    delete normalized.name;
    delete normalized.windowMinutes;
  } else {
    normalized.name = family;
    normalized.windowMinutes = 10_080;
  }
  return normalized;
}

const modelWords = (family: string): string => family.charAt(0).toUpperCase() + family.slice(1);

/** Whether a model family ("opus") is the profile's model. */
export function inFamily(profile: Pick<AgentProfile, "model" | "modelId">, family: string): boolean {
  const wanted = family.toLowerCase();
  return `${profile.modelId ?? ""} ${profile.model}`.toLowerCase().includes(wanted);
}

/** A tool, or a profile on it: with no model named, every report about the tool counts. */
type OnTool = Pick<AgentProfile, "toolId"> & Partial<Pick<AgentProfile, "model" | "modelId">>;

export const usageCovers = (entry: { toolId: Id; model?: string | undefined }, profile: OnTool): boolean => entry.toolId === profile.toolId && (!entry.model || profile.model === undefined || inFamily(profile as Pick<AgentProfile, "model" | "modelId">, entry.model));

/** The limits still in force at `now`. */
export function liveLimits(pool: Pool, now: number): readonly UsageLimit[] {
  return (pool.limited ?? []).filter((limit) => limit.until > now);
}

/** Show when each scope can work again; separate stored causes still keep their own expiry. */
export function displayLimits(pool: Pool, now: number): UsageLimit[] {
  const shown: UsageLimit[] = [];
  for (const limit of liveLimits(pool, now)) {
    const index = shown.findIndex(entry => entry.toolId === limit.toolId && (entry.model ?? "") === (limit.model ?? ""));
    if (index < 0) shown.push(limit);
    else if (limit.until > shown[index]!.until || limit.until === shown[index]!.until && limit.retry) shown[index] = limit;
  }
  return shown;
}

/** The limit that keeps this profile from working, if there is one. */
export function limitOf(pool: Pool, profile: AgentProfile, now: number): UsageLimit | undefined {
  return liveLimits(pool, now).find((limit) => usageCovers(limit, profile));
}

/** The earliest time a limit in force ends, or undefined with none. */
export function nextExpiry(pool: Pool, now: number): number | undefined {
  const times = liveLimits(pool, now).map((limit) => limit.until);
  return times.length ? Math.min(...times) : undefined;
}

/** The limits with this one added, keeping request refusals separate from account readings. */
export function withLimit(limits: readonly UsageLimit[] | undefined, limit: UsageLimit): UsageLimit[] {
  const same = (entry: UsageLimit) => entry.toolId === limit.toolId && (entry.model ?? "") === (limit.model ?? "") && (entry.source === "refusal") === (limit.source === "refusal");
  const kept = (limits ?? []).filter((entry) => !same(entry));
  const older = (limits ?? []).find(same);
  return [...kept, older && older.until > limit.until ? older : limit];
}

/** The reports with this one added, replacing the last one for the same tool and kind of limit. */
export function withReport(reports: readonly UsageReport[] | undefined, report: UsageReport): UsageReport[] {
  return [...(reports ?? []).filter((entry) => !(entry.toolId === report.toolId && entry.kind === report.kind && (entry.model ?? "") === (report.model ?? ""))), report];
}

/** A report that still counts at `now`. */
export const currentReport = (report: UsageReport, now: number): boolean => (report.resetsAt !== undefined ? report.resetsAt > now : now - report.at < STALE_REPORT_MS);

/**
 * How much of its window a report says is used, or undefined when it gives no usable number. Petrina's marks
 * apply to this alone: a provider's own warning may use another threshold, so it never stands in for a number.
 */
export const measuredUsage = (report: Pick<UsageReport, "utilization">): number | undefined =>
  typeof report.utilization === "number" && Number.isFinite(report.utilization) ? report.utilization : undefined;

/** A window past the slow-down mark: measured from 80%, or reported as used up. */
export const pastSlowDown = (report: UsageReport): boolean => report.status === "rejected" || (measuredUsage(report) ?? 0) >= SLOW_DOWN;

/** Whether a window covering this profile's model is measured at the near-limit mark. */
export function nearLimit(pool: Pool, profile: AgentProfile, now: number): boolean {
  return (pool.usage ?? []).some((report) => report.status !== "rejected" && usageCovers(report, profile) && currentReport(report, now) && (measuredUsage(report) ?? 0) >= NEAR_LIMIT);
}

/** A tool summary, or only the windows covering a named profile, past the slow-down mark. */
export function slowingDown(pool: Pool, toolId: Id, now: number, profile?: Partial<Pick<AgentProfile, "model" | "modelId">>): boolean {
  return (pool.usage ?? []).some((report) => usageCovers(report, { toolId, ...profile }) && currentReport(report, now) && pastSlowDown(report));
}

/**
 * How many agents the tool may have at once right now: its cap as set (the pool's limit when it has none), and
 * half of that, rounded up and at least one, while it slows down. Undefined: no cap, and nothing to slow down for.
 */
export function toolCapNow(pool: Pool, toolId: Id, now: number, profile?: Partial<Pick<AgentProfile, "model" | "modelId">>): number | undefined {
  const cap = pool.toolCaps[toolId];
  if (!slowingDown(pool, toolId, now, profile)) return cap;
  return Math.max(1, Math.ceil((cap ?? pool.limit) * SLOW_DOWN_SHARE));
}

/**
 * How much room a tool (or a profile's model on it) has left, as the unused share of its tightest window per hour
 * until that window resets: 20% left with an hour to go (0.2) beats 50% left with a week to go (0.003). Out: 0.
 * Undefined when the tool has said nothing that counts, which is neither better nor worse than any number.
 */
export function headroom(pool: Pool, on: OnTool, now: number): number | undefined {
  let least: number | undefined;
  for (const report of (pool.usage ?? []).filter((report) => usageCovers(report, on) && currentReport(report, now))) {
    if (report.status === "rejected") return 0;
    // A warning without a number says nothing about how much is left.
    const used = measuredUsage(report);
    if (used === undefined) continue;
    // With no reset time, the window counts as resetting within the hour.
    const hours = report.resetsAt === undefined ? 1 : Math.max(LEAST_HOURS, (report.resetsAt - now) / HOUR);
    const room = Math.max(0, 1 - used) / hours;
    if (least === undefined || room < least) least = room;
  }
  return least;
}

/**
 * Items in order of room left (see `headroom`), the most first; one whose tool has said nothing ties with the
 * one that has the most. Stable: among equals the given order holds.
 */
export function byRoom<T>(items: readonly T[], roomOf: (item: T) => number | undefined): T[] {
  const known = items.map(roomOf).filter((room): room is number => room !== undefined);
  const top = known.length ? Math.max(...known) : 0;
  const key = (item: T) => roomOf(item) ?? top;
  return [...items].sort((a, b) => key(b) - key(a));
}

/** `freshReason`: why a saved design or review conversation was not kept, when the choice starts that participant fresh. */
export type Choice = { kind: "planned" | "substitute"; profile: AgentProfile; reason?: string; freshReason?: string } | { kind: "none"; waiting: string };

/**
 * Which profile actually works a step planned for `planned`. The planned one when it is free to work and
 * not close to a limit. When it is out: another model on the same tool, else a profile on another tool,
 * preferring the same effort and tools not close to their limits, in the order of the profile list. When it
 * is only close to a limit: an equal profile on a tool that is not, if there is one. Never a profile that
 * is not in the list (the coordinator removed it). With nobody left, the words for waiting.
 */
/**
 * Rules a role's choice keeps. `keep`: never swap the planned profile for being near a limit (reviews were
 * planned on their tools for independence). `awayFrom`: the actual author or builder's tool and model,
 * which a reviewer stays as far from as it can: another tool first, then another model on that tool, and
 * only as a last resort the same model. It never waits for that.
 */
export interface ChoiceRules {
  keep?: boolean;
  awayFrom?: { toolId: Id; modelId?: string };
  /** The tools reserved by the other reviewers, including reviews already reported this round. */
  awayFromTools?: readonly Id[];
  /** Stand-in tools that cannot take a seat right now. The planned profile is never skipped for this. */
  skipTools?: ReadonlySet<Id>;
  /** Full quota groups may exclude one model while another on the same tool has room. */
  skipProfiles?: ReadonlySet<Id>;
}

function sameness(profile: AgentProfile, rules: ChoiceRules): number {
  const away = rules.awayFrom;
  return (rules.awayFromTools?.filter((toolId) => toolId === profile.toolId).length ?? 0) * 3
    + (!away || profile.toolId !== away.toolId ? 0 : profile.modelId !== away.modelId ? 1 : 2);
}

export function chooseProfile(state: Pick<State, "profiles" | "tools" | "pool">, planned: AgentProfile, now: number, rules: ChoiceRules = {}): Choice {
  const { pool } = state;
  const free = (profile: AgentProfile) => !limitOf(pool, profile, now);
  const near = (profile: AgentProfile) => nearLimit(pool, profile, now);
  const ready = state.tools.filter((tool) => tool.status === "ready").map((tool) => tool.id);
  const skipped = rules.skipTools;
  const registered = new Set(state.profiles.map(profile => profile.id));
  // With no tool found ready (tests stand in for the tools), every tool in the list counts.
  const available = (profile: AgentProfile) => registered.has(profile.id) && free(profile) && (!ready.length || ready.includes(profile.toolId));
  const usable = (profile: AgentProfile) => available(profile) && !skipped?.has(profile.toolId) && !rules.skipProfiles?.has(profile.id);
  // The most independent first, then not near a limit, then the same effort, then the tool with more of its limit
  // left (one that said nothing ties with the roomiest), then the list's order.
  const closest = (profiles: AgentProfile[]) =>
    byRoom(profiles, (profile) => headroom(pool, profile, now)).sort((a, b) => sameness(a, rules) - sameness(b, rules) || Number(near(a)) - Number(near(b)) || Number(b.effort === planned.effort) - Number(a.effort === planned.effort))[0];

  if (available(planned)) {
    // A builder may have switched tools since the plan was made. Keep this review independent
    // of the tool that actually built the change, even when its planned reviewer is still free.
    const independent = closest(state.profiles.filter((profile) => sameness(profile, rules) < sameness(planned, rules) && usable(profile)));
    if (independent) return { kind: "substitute", profile: independent, reason: "Selected a more independent tool or model for this review." };
    if (!near(planned) || rules.keep) return { kind: "planned", profile: planned, reason: "The planned profile is available for this step." };
    const equal = closest(state.profiles.filter((profile) => profile.toolId !== planned.toolId && profile.effort === planned.effort && usable(profile) && !near(profile) && !profile.standby));
    return equal ? { kind: "substitute", profile: equal, reason: "The planned profile is near a usage limit; selected another tool at the same effort with room available." } : { kind: "planned", profile: planned, reason: "Kept the planned profile; no equivalent alternative has more usable room." };
  }
  const sameTool = closest(state.profiles.filter((profile) => profile.id !== planned.id && profile.toolId === planned.toolId && usable(profile)));
  const other = closest(state.profiles.filter((profile) => profile.toolId !== planned.toolId && usable(profile)));
  // Another model on the planned tool first, unless that is less independent than what another tool offers.
  const pick = sameTool && (!other || sameness(sameTool, rules) <= sameness(other, rules)) ? sameTool : other;
  if (pick) {
    const limit = limitOf(pool, planned, now);
    const why = limit ? `The planned profile is unavailable: ${limit.reason}.` : "The planned profile's tool is not ready or its profile is no longer offered.";
    return { kind: "substitute", profile: pick, reason: `${why} Selected an available profile, preferring review independence, matching effort and usage headroom.` };
  }
  return { kind: "none", waiting: waitingWords(state, now) };
}

/**
 * `chooseProfile`, then the next stand-in when the one it picked has no seat (`room` is false).
 * A planned profile is kept even when its tool is full: the cap is there so another tool's own
 * task can take the seat. With every stand-in full, the first of them is returned, so the task
 * waits for that tool's seat rather than for a usage limit.
 */
export function chooseWithRoom(state: Pick<State, "profiles" | "tools" | "pool">, planned: AgentProfile, now: number, rules: ChoiceRules = {}, room?: (toolId: Id, profile: AgentProfile) => boolean): Choice {
  const skip = new Set<Id>(rules.skipProfiles ?? []);
  let held: Choice | undefined;
  for (;;) {
    const choice = chooseProfile(state, planned, now, skip.size ? { ...rules, skipProfiles: skip } : rules);
    // A full independent tool waits for a seat. Falling back to its partner's tool would defeat the review.
    if (held?.kind === "substitute" && choice.kind !== "none" && sameness(choice.profile, rules) > sameness(held.profile, rules)) return held;
    if (!room || choice.kind !== "substitute" || room(choice.profile.toolId, choice.profile)) {
      if (choice.kind === "none" && held?.kind === "substitute") return held;
      return held?.kind === "substitute" && choice.kind === "substitute" && held.profile.id !== choice.profile.id
        ? { ...choice, reason: `${choice.reason ?? "Selected an available substitute."} Another substitute had no free agent slot.` } : choice;
    }
    if (skip.has(choice.profile.id)) return choice;
    held ??= choice;
    skip.add(choice.profile.id);
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

/** A reported outage or a cooldown, without presenting our retry time as a provider's reset. */
export function usagePauseWords(limit: UsageLimit, now: number): string {
  return `${limit.model ? `${modelWords(limit.model)} ` : ""}${limit.retry ? "request refused; retry after" : "out until"} ${untilWords(limit.until, now)}`;
}

/** What a task waiting for usage says: who is out, and when work can be tried again. */
export function waitingWords(state: Pick<State, "tools" | "pool">, now: number): string {
  const limits = displayLimits(state.pool, now);
  if (!limits.length) return "Waiting for usage";
  const order = (toolId: Id) => state.tools.findIndex((tool) => tool.id === toolId);
  if (limits.some((limit) => limit.retry)) return `Waiting for usage: ${[...limits].sort((a, b) => order(a.toolId) - order(b.toolId)).map((limit) => `${toolName(state, limit.toolId)} ${usagePauseWords(limit, now)}`).join(" · ")}`;
  const names = [...new Set([...limits].sort((a, b) => order(a.toolId) - order(b.toolId)).map((limit) => `${toolName(state, limit.toolId)}${limit.model ? ` (${modelWords(limit.model)})` : ""}`))];
  const who = names.length === 1 ? `${names[0]} is` : `${names.slice(0, -1).join(", ")} and ${names.at(-1)} are`;
  return `Waiting for usage: ${who} out until ${untilWords(Math.min(...limits.map((limit) => limit.until)), now)}`;
}

/** One line of a tool's usage for the window. */
export interface UsageLine {
  toolId: Id;
  name: string;
  /** "weekly 84%, resets Thu 13:00 · starting fewer agents on it", "weekly 26%, provider warning", "Opus out until Fri 17:00", or "fine". */
  text: string;
  tone: "fine" | "near" | "out";
}

/**
 * Every tool's usage in plain words: how much of each window is used and when it resets, who is out until when,
 * and whether Petrina is starting fewer agents on it (see `slowingDown`).
 */
export function usageLines(state: Pick<State, "tools" | "pool">, now: number): UsageLine[] {
  const lines = state.tools.map((tool) => {
    const reports = (state.pool.usage ?? []).filter((report) => report.toolId === tool.id && currentReport(report, now));
    // A window the tool reported as used up counts as full, whether or not it gave a percentage.
    const fullness = (report: UsageReport) => (report.status === "rejected" ? 1 : (measuredUsage(report) ?? 0));
    // Explain actual limits and measured slowdowns before provider warnings; keep warnings above healthy readings.
    const priority = (report: UsageReport) => report.status === "rejected" ? 3 : pastSlowDown(report) ? 2 : report.status === "allowed_warning" ? 1 : 0;
    const words = (report: UsageReport) => {
      const used = measuredUsage(report);
      const share = used !== undefined ? `${Math.round(used * 100)}%` : undefined;
      if (report.status === "rejected") return `${share ?? "used up"}${report.overage ? ", on extra usage" : ""}`;
      // The provider's own warning, below Petrina's near-limit mark or without a number: kept, never read as nearly used.
      if (report.status === "allowed_warning" && (used ?? 0) < NEAR_LIMIT) return share ? `${share}, provider warning` : "provider warning, percentage not reported";
      return share!;
    };
    const used = reports
      .filter((report) => measuredUsage(report) !== undefined || report.status !== "allowed")
      .sort((a, b) => priority(b) - priority(a) || fullness(b) - fullness(a))
      .slice(0, 2)
      .map((report) => `${kindWords(report.kind, report.windowMinutes, report.name)} ${words(report)}${report.resetsAt !== undefined ? `, resets ${untilWords(report.resetsAt, now)}` : ""}`);
    const out = displayLimits(state.pool, now)
      .filter((limit) => limit.toolId === tool.id)
      .map((limit) => usagePauseWords(limit, now));
    const holding = !out.length && slowingDown(state.pool, tool.id, now);
    const parts = [...used, ...out, ...(holding ? [HOLDING_BACK] : [])];
    return { line: { toolId: tool.id, name: tool.name, text: parts.length ? parts.join(" · ") : reports.some((report) => report.toolId !== "codex" || measuredUsage(report) !== undefined) ? "fine" : "not reported", tone: (out.length ? "out" : holding ? "near" : "fine") as UsageLine["tone"] }, shown: tool.status === "ready" || parts.length > 0 };
  });
  // A tool that is not here and has said nothing is not listed.
  return lines.filter((entry) => entry.shown).map((entry) => entry.line);
}
