// How numbers read in the app: "820 tokens", "48k tokens", "1.9M tokens", "under a minute",
// "12m", "1h 05m", "312h". Limits read in words, always with when they were reported.

import type { LimitStatus } from "./worklog.js";
import type { UsageReport } from "./model.js";
import { currentReport, kindWords } from "./usage.js";

/**
 * A total and whether whole turns are known to be missing from it. A missing value is "not
 * reported" when a tool sent no figure, and "not known" when the work itself wasn't recorded
 * (cut off when Petrina stopped, or from before Petrina kept track). Never a zero.
 */
export interface Figure {
  value?: number;
  atLeast: boolean;
  /** No value because the work wasn't recorded, not because a tool left it out. */
  unknown?: boolean;
}

function compact(value: number, unit: number, suffix: string): string {
  const scaled = value / unit;
  const text = scaled < 10 ? (Math.round(scaled * 10) / 10).toFixed(1).replace(/\.0$/, "") : String(Math.round(scaled));
  return `${text}${suffix}`;
}

/** A token count without the word: "820", "4.5k", "48k", "1.9M". */
export function tokenNumber(value: number): string {
  const n = Math.max(0, Math.round(value));
  if (n < 1000) return String(n);
  if (n < 999_500) return compact(n, 1000, "k");
  if (n < 999_500_000) return compact(n, 1_000_000, "M");
  return compact(n, 1_000_000_000, "B");
}

export function tokensText(value: number): string {
  return `${tokenNumber(value)} ${Math.round(value) === 1 ? "token" : "tokens"}`;
}

/** Agent time: "under a minute", "12m", "1h 05m", "312h". */
export function durationText(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours >= 100) return `${hours}h`;
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** A figure in words. Unknown is never zero, and "at least" never comes before "under a minute". */
export function figureText(figure: Figure, kind: "tokens" | "time", options: { bare?: boolean; missing?: string } = {}): string {
  if (figure.value === undefined || (figure.atLeast && figure.value <= 0)) return figure.unknown || figure.value !== undefined ? "not known" : (options.missing ?? "not reported");
  if (figure.atLeast && kind === "time" && figure.value < 60_000) return "at least a few seconds";
  const text = kind === "tokens" ? (options.bare ? tokenNumber(figure.value) : tokensText(figure.value)) : durationText(figure.value);
  return figure.atLeast ? `at least ${text}` : text;
}

/** "3 turns", "1 turn". */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function listWords(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/**
 * Why a view's numbers read "at least", once, with counts. Empty when nothing is missing. With
 * nothing recorded at all (`recorded` 0) and only earlier work, it says the use isn't known.
 */
export function atLeastLine(reasons: { noTokens: number; lost: number; beforeTracking: boolean; recorded?: number }): string {
  if (reasons.recorded === 0 && reasons.beforeTracking) return "Not known: work from before Petrina started keeping track wasn't recorded.";
  const parts: string[] = [];
  if (reasons.noTokens > 0) parts.push(`${count(reasons.noTokens, "turn")} sent no token report`);
  if (reasons.lost > 0) parts.push(`${count(reasons.lost, "turn")} ${reasons.lost === 1 ? "was" : "were"} cut off when Petrina stopped`);
  if (reasons.beforeTracking) parts.push("work from before Petrina started keeping track isn't counted");
  return parts.length ? `“At least” because ${listWords(parts)}.` : "";
}

// ── Limits ──────────────────────────────────────────────────────────────────

const STATUS_WORDS: Record<LimitStatus, string> = { fine: "fine", close: "close to the limit", reached: "limit reached" };

export function limitStatusText(status: LimitStatus | undefined): string {
  return status ? STATUS_WORDS[status] : "";
}

function clock(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "today 14:00", "tomorrow 09:30", "Tue 14:00", "12 Oct". */
export function whenText(at: number, now: number): string {
  const day = (value: number) => new Date(value).setHours(0, 0, 0, 0);
  const days = Math.round((day(at) - day(now)) / 86_400_000);
  if (days === 0) return `today ${clock(at)}`;
  if (days === 1) return `tomorrow ${clock(at)}`;
  if (days === -1) return `yesterday ${clock(at)}`;
  if (days > 1 && days < 7) return `${DAYS[new Date(at).getDay()]} ${clock(at)}`;
  return new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** "3m ago", "2h ago", "yesterday 18:10". */
export function agoText(at: number, now: number): string {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return whenText(at, now);
}

export interface LimitWords {
  label: string;
  /** "42% used", or "limit reached", or "has reset since it was reported". */
  used: string;
  /** "resets today 14:00". Empty when unknown. */
  resets: string;
  /** "reported 3m ago". */
  reported: string;
  /** The reset time has passed: the percentage is no longer current. */
  stale: boolean;
  percent?: number;
  status?: LimitStatus;
}

/** A limit in words, never showing an old percentage as current. */
export function limitWords(limit: UsageReport, now: number): LimitWords {
  const reset = limit.resetsAt !== undefined && limit.resetsAt <= now;
  const stale = !currentReport(limit, now);
  const percent = limit.utilization === undefined ? undefined : Math.max(0, Math.min(100, Math.round(limit.utilization * 100)));
  const status: LimitStatus = limit.status === "rejected" ? "reached" : limit.status === "allowed_warning" ? "close" : "fine";
  let used: string;
  if (stale) used = reset ? "has reset since it was last reported" : "not reported";
  else if (percent !== undefined) used = `${percent}% used${status !== "fine" ? ` · ${limitStatusText(status)}` : ""}`;
  else used = limit.toolId === "codex" ? "not reported" : limitStatusText(status);
  return {
    label: kindWords(limit.kind, limit.windowMinutes, limit.name),
    used,
    resets: limit.resetsAt === undefined ? "" : stale ? `reset ${whenText(limit.resetsAt, now)}` : `resets ${whenText(limit.resetsAt, now)}`,
    reported: `reported ${agoText(limit.at, now)}`,
    stale,
    ...(percent !== undefined && !stale ? { percent } : {}),
    ...(!stale ? { status } : {}),
  };
}

/** The limit closest to running out, among those still current. */
export function nearestLimit(limits: readonly UsageReport[], toolId: string, now: number): UsageReport | undefined {
  const rank = (limit: UsageReport) => (limit.status === "rejected" ? 1000 : 0) + (limit.utilization !== undefined ? limit.utilization * 100 : limit.status === "allowed_warning" ? 90 : 0);
  return limits
    .filter((limit) => limit.toolId === toolId && currentReport(limit, now))
    .sort((a, b) => rank(b) - rank(a) || (a.resetsAt ?? Infinity) - (b.resetsAt ?? Infinity))[0];
}

/** A tool's nearest current limit in words, or nothing once every limit it reported has reset. */
export function nearestLimitWords(limits: readonly UsageReport[], toolId: string, now: number): LimitWords | undefined {
  const limit = nearestLimit(limits, toolId, now);
  return limit && limitWords(limit, now);
}

/** When the next reported limit resets: the moment its percentage stops being current. */
export function nextReset(limits: readonly UsageReport[], now: number): number | undefined {
  const upcoming = limits.map((limit) => limit.resetsAt ?? Infinity).filter((at) => at > now);
  return upcoming.length ? Math.min(...upcoming) : undefined;
}

// ── Reading what the tools report about limits ──────────────────────────────

const seconds = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value > 0 ? (value < 1e12 ? value * 1000 : value) : undefined);

/** Codex's `account/rateLimits/read` answer: each limit's percentage, length and reset. Nothing else is kept. */
export function codexLimits(response: unknown, reportedAt: number): UsageReport[] {
  if (!response || typeof response !== "object") return [];
  const body = response as { rateLimits?: unknown; rateLimitsByLimitId?: unknown };
  const snapshots: [string, unknown][] = body.rateLimitsByLimitId && typeof body.rateLimitsByLimitId === "object" ? Object.entries(body.rateLimitsByLimitId as Record<string, unknown>) : [];
  if (snapshots.length === 0 && body.rateLimits) snapshots.push(["codex", body.rateLimits]);
  const limits: UsageReport[] = [];
  for (const [limitId, snapshot] of snapshots) {
    if (!snapshot || typeof snapshot !== "object") continue;
    const name = (snapshot as { limitName?: unknown }).limitName;
    for (const slot of ["primary", "secondary"] as const) {
      const window = (snapshot as Record<string, unknown>)[slot] as { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown } | null | undefined;
      if (!window || typeof window !== "object") continue;
      const percent = typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent) ? window.usedPercent : undefined;
      const minutes = typeof window.windowDurationMins === "number" ? window.windowDurationMins : undefined;
      const resetsAt = seconds(window.resetsAt);
      limits.push({
        toolId: "codex",
        kind: `${limitId.slice(0, 40)}:${slot}`,
        at: reportedAt,
        status: percent !== undefined && percent >= 100 ? "rejected" : percent !== undefined && percent >= 90 ? "allowed_warning" : "allowed",
        ...(minutes !== undefined && Number.isFinite(minutes) && minutes > 0 ? { windowMinutes: minutes } : {}),
        ...(typeof name === "string" && name.trim() && limitId !== "codex" ? { name: name.trim().slice(0, 40) } : {}),
        ...(percent !== undefined ? { utilization: percent / 100 } : {}),
        ...(resetsAt ? { resetsAt } : {}),
      });
    }
  }
  return limits;
}
