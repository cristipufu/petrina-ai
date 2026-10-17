// Usage limits as the tools report them: Claude Code says how close it is on every turn, Codex only says
// it is out. Both end up as the same two things: a report for the pool, and a UsageLimited error.

import { kindWords, UNKNOWN_LIMIT_MS, type AgentProfile, type UsageReport } from "@petrina/core";
import { ADAPTERS } from "./tools.js";

/** One report from a tool, before the engine stamps it with the time. */
export type UsageInfo = Omit<UsageReport, "at">;

/** A turn ended because its tool (or one model family of it) is out of usage until `until`. */
export class UsageLimited extends Error {
  constructor(
    readonly toolId: string,
    /** Milliseconds. */
    readonly until: number,
    /** Plain words: "Claude Code's weekly Opus limit". */
    readonly reason: string,
    /** Set when only this model family is out ("opus"). */
    readonly model?: string,
  ) {
    super(`${reason} is used up`);
  }

  /** What the agent had said in the turn before it stopped, when its tool lets that through. */
  said?: string;
}

/** Nobody can work the step until a limit ends: the task waits, and the driver lets go of it quietly. */
export class WaitingForUsage extends Error {
  /** What the task's status line says. */
  constructor(readonly words: string) {
    super(words);
  }
}

const FAMILY_OF_KIND: Readonly<Record<string, string>> = { seven_day_opus: "opus", seven_day_sonnet: "sonnet" };

const USAGE_STATUS = new Set(["allowed", "allowed_warning", "rejected"]);

/** One Claude rate-limit object (`SDKRateLimitInfo`) as the reports it contains. The session window is `status`; the spend cap is `overageStatus`. Both are the same enum. */
export function claudeReports(toolId: string, meta: unknown): UsageInfo[] {
  if (!meta || typeof meta !== "object") return [];
  const info = (meta as Record<string, unknown>)["_claude/rateLimit"];
  if (!info || typeof info !== "object") return [];
  const { status, resetsAt, rateLimitType, utilization, overageStatus, overageResetsAt } = info as {
    status?: unknown;
    resetsAt?: unknown;
    rateLimitType?: unknown;
    utilization?: unknown;
    overageStatus?: unknown;
    overageResetsAt?: unknown;
  };
  const reports: UsageInfo[] = [];
  if (typeof status === "string" && USAGE_STATUS.has(status)) {
    const kind = typeof rateLimitType === "string" ? rateLimitType : "limit";
    const family = FAMILY_OF_KIND[kind];
    reports.push({
      toolId,
      kind,
      status: status as UsageInfo["status"],
      ...(family ? { model: family } : {}),
      ...(typeof utilization === "number" ? { utilization } : {}),
      // Seconds on the wire, milliseconds everywhere else.
      ...(typeof resetsAt === "number" ? { resetsAt: resetsAt * 1000 } : {}),
    });
  }
  // The monthly spend cap is this field, not a sentence. It can be rejected while the session window is still open.
  if (overageStatus === "allowed_warning" || overageStatus === "rejected") {
    reports.push({
      toolId,
      kind: "overage",
      status: overageStatus,
      ...(typeof overageResetsAt === "number" ? { resetsAt: overageResetsAt * 1000 } : {}),
    });
  }
  return reports;
}

/** Claude Code's rate limit report (its `_claude/rateLimit` note on a usage update), or undefined when it is not one. */
export function claudeReport(toolId: string, meta: unknown): UsageInfo | undefined {
  return claudeReports(toolId, meta)[0];
}

/** The error for a turn that ended while the tool's latest report said it was out. */
export function limitFromReport(profile: AgentProfile, info: UsageInfo, now: number): UsageLimited {
  const tool = ADAPTERS[profile.toolId]?.name ?? profile.toolId;
  return new UsageLimited(profile.toolId, info.resetsAt && info.resetsAt > now ? info.resetsAt : now + UNKNOWN_LIMIT_MS, `${tool}'s ${kindWords(info.kind)} limit`, info.model);
}

/** "try again at 5:42 PM", or Claude's "resets 8:10pm": the next time the clock shows that. */
export function clockTime(text: string, now: number): number | undefined {
  const found = /(?:try again (?:at|after)|resets(?: at)?) (\d{1,2})(?::(\d{2}))?\s*([AP]M)?/i.exec(text);
  if (!found) return undefined;
  let hours = Number(found[1]);
  const minutes = Number(found[2] ?? 0);
  const half = found[3]?.toUpperCase();
  if (half === "PM" && hours < 12) hours += 12;
  if (half === "AM" && hours === 12) hours = 0;
  if (hours > 23 || minutes > 59) return undefined;
  const at = new Date(now);
  at.setHours(hours, minutes, 0, 0);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return at.getTime();
}

/** Codex `codexErrorInfo` values that mean the account or the session cannot continue. From codex-acp `STRING_CODEX_ERROR_CATEGORIES`. */
const CODEX_OUT = new Set(["usageLimitExceeded", "rateLimitExceeded", "sessionBudgetExceeded"]);
/** Claude `errorKind` values the adapter maps to a limit (`providerFailureCategory`). `billing_error` is the spend cap. */
const CLAUDE_OUT = new Set(["billing_error", "account_on_hold", "rate_limit"]);
/** Session-failure kinds both adapters use for a limit. */
const LIMIT_KIND = new Set(["quota_exhausted", "rate_limited", "budget_exhausted"]);

/**
 * Claude's own list, `USAGE_LIMIT_ERROR_PREFIXES` in `@anthropic-ai/claude-agent-sdk`.
 * The adapter sends `errorKind` when it has one. When it does not (a synthetic usage-limit
 * message), the JSON-RPC error is `Internal error: <that sentence>` and `data` is empty.
 * This list is only for that case.
 */
const CLAUDE_USAGE_PREFIXES = [
  "You've hit your",
  "You've reached your",
  "You're out of usage credits",
  "Your org is out of usage · add funds to continue",
  "Your org is out of usage · contact your admin",
  "Your seat type doesn't include usage credits",
  "Your seat type doesn't include usage",
  "Your usage allocation has been disabled by your admin",
  "Your group's usage limit is set to $0",
  "Fable 5 requires usage credits",
  "You're out of extra usage",
  "Your seat type doesn't include extra usage",
] as const;

const payload = (error: unknown): Record<string, unknown> => {
  if (!error || typeof error !== "object") return {};
  const record = error as Record<string, unknown>;
  const data = record.data && typeof record.data === "object" ? (record.data as Record<string, unknown>) : {};
  return { ...record, ...data };
};

const textOf = (error: unknown, said: string): string => {
  const message = (error as { message?: unknown } | undefined)?.message;
  return `${typeof message === "string" ? message : ""}\n${said}`;
};

/**
 * A failed turn that carried no rate-limit report. The decision is the tool's code:
 * Codex `codexErrorInfo`, Claude `errorKind`, or a session-failure kind. The sentence
 * is read only when those fields are absent, and only against Claude's prefix list.
 * A clock time in the sentence ("resets 8:10pm") is when it ends; the code does not say.
 */
export function limitFromFailure(profile: AgentProfile, error: unknown, said: string, now: number): UsageLimited | undefined {
  const data = payload(error);
  const code = typeof data.codexErrorInfo === "string" ? data.codexErrorInfo : undefined;
  const errorKind = typeof data.errorKind === "string" ? data.errorKind : undefined;
  const category = typeof data.category === "string" ? data.category : undefined;
  const kind = typeof data.kind === "string" ? data.kind : undefined;
  const coded = (code !== undefined && CODEX_OUT.has(code)) || (errorKind !== undefined && CLAUDE_OUT.has(errorKind)) || (category !== undefined && LIMIT_KIND.has(category)) || (kind !== undefined && LIMIT_KIND.has(kind));
  const message = typeof (error as { message?: unknown } | undefined)?.message === "string" ? (error as { message: string }).message : "";
  // The prefix list is for the error text only. An agent's own words ("You've hit your stride") are not a limit.
  if (!coded && !CLAUDE_USAGE_PREFIXES.some((prefix) => message.includes(prefix))) return undefined;
  const text = textOf(error, said);
  const tool = ADAPTERS[profile.toolId]?.name ?? profile.toolId;
  const reason =
    errorKind === "billing_error" ? `${tool}'s spend limit` : errorKind === "rate_limit" || code === "rateLimitExceeded" ? `${tool}'s rate limit` : `${tool}'s usage limit`;
  return new UsageLimited(profile.toolId, clockTime(text, now) ?? now + UNKNOWN_LIMIT_MS, reason);
}
