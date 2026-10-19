// Usage limits as the tools report them: Claude Code says how close it is on every turn, Codex only says
// it is out, and Grok says so with a rate-limit code when a turn fails. All end up as the same two things:
// a report for the pool, and a UsageLimited error.

import { kindWords, UNKNOWN_LIMIT_MS, type AgentProfile, type UsageReport } from "@petrina/core";
import { ADAPTERS } from "./tools.js";

/** One report from a tool, before the engine stamps it with the time. */
export type UsageInfo = Omit<UsageReport, "at">;

/** A turn ended on a usage refusal. `until` is a reset, or a cooldown before retrying. */
export class UsageLimited extends Error {
  constructor(
    readonly toolId: string,
    /** Milliseconds. */
    readonly until: number,
    /** Plain words: "Claude Code's weekly Opus limit". */
    readonly reason: string,
    /** Set when only this model family is out ("opus"). */
    readonly model?: string,
    /** The provider refused a request without reporting a reset; `until` is our retry time. */
    readonly retry?: boolean,
  ) {
    super(retry ? reason : `${reason} is used up`);
  }

  /** What the agent had said in the turn before it stopped, when its tool lets that through. */
  said?: string;
  /** The public text is already saved in the task's live conversation. */
  streamed?: boolean;
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
  const { status, resetsAt, rateLimitType, utilization, overageStatus, overageResetsAt, isUsingOverage } = info as {
    status?: unknown;
    resetsAt?: unknown;
    rateLimitType?: unknown;
    utilization?: unknown;
    overageStatus?: unknown;
    overageResetsAt?: unknown;
    isUsingOverage?: unknown;
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
      // A window reported as rejected while the account goes on with extra usage is spent, not out: turns keep working.
      ...(isUsingOverage === true ? { overage: true } : {}),
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
/** Grok's StopFailure class for a rate limit, and the sentence `format_rate_limited_user_message` shows when that class has no field. */
const GROK_RATE = "rate_limit";
const GROK_RATE_MESSAGE = "You've hit the rate limit for your plan.";
const GROK_BALANCE_MESSAGE = "Grok Build usage balance exhausted";
/** A request refusal does not establish that the whole account is out, or when it resets. */
const GROK_REFUSAL_COOLDOWN_MS = 5 * 60_000;
/**
 * Grok classifies a capacity error (503, 529) as `rate_limit` too. Those show one of these sentences,
 * and they are a busy service, not the plan's rate limit. Matched on the error text only.
 */
const GROK_BUSY = ["The service is busy.", "Service unavailable", "Something went wrong on our side.", "Server error"] as const;
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

/**
 * A failed turn that carried no rate-limit report. The decision is the tool's code:
 * Codex `codexErrorInfo`, Claude `errorKind`, Grok's `rate_limit`, or a session-failure kind.
 * Claude's sentence is read only when those fields are absent, and only against its prefix list.
 * Grok's one sentence counts on the error text. A busy-service or server sentence does not, even
 * when Grok filed it under `rate_limit`. A clock time in the sentence ("resets 8:10pm") is when it ends.
 */
export function limitFromFailure(profile: AgentProfile, error: unknown, said: string, now: number): UsageLimited | undefined {
  const data = payload(error);
  const code = typeof data.codexErrorInfo === "string" ? data.codexErrorInfo : undefined;
  const errorKind = typeof data.errorKind === "string" ? data.errorKind : undefined;
  const category = typeof data.category === "string" ? data.category : undefined;
  const kind = typeof data.kind === "string" ? data.kind : undefined;
  const outerMessage = (error as { message?: unknown } | undefined)?.message;
  const message = [outerMessage, data.message].filter((value): value is string => typeof value === "string").join("\n");
  // The prefix list and Grok's sentence are for the error text only. An agent's own words are not a limit.
  const grok = profile.toolId === "grok";
  // Native Grok puts the HTTP failure in ACP error.data, underneath "Internal error".
  // Keep it separate from the account allowance: a later small request can still succeed.
  if (grok && data.http_status === 402 && message.includes(GROK_BALANCE_MESSAGE)) {
    return new UsageLimited(profile.toolId, now + GROK_REFUSAL_COOLDOWN_MS, `Grok refused the request: ${GROK_BALANCE_MESSAGE}`, undefined, true);
  }
  const grokBusy = grok && (data.http_status === 503 || data.http_status === 529 || GROK_BUSY.some((line) => message.includes(line)));
  if (grokBusy) return undefined;
  const grokError = grok && data.error === GROK_RATE && !grokBusy;
  const grokSentence = grok && !grokBusy && message.includes(GROK_RATE_MESSAGE);
  const coded = (code !== undefined && CODEX_OUT.has(code)) || (errorKind !== undefined && CLAUDE_OUT.has(errorKind)) || (category !== undefined && LIMIT_KIND.has(category)) || (kind !== undefined && LIMIT_KIND.has(kind)) || grokError;
  if (!coded && !grokSentence && !CLAUDE_USAGE_PREFIXES.some((prefix) => message.includes(prefix))) return undefined;
  const text = `${message}\n${said}`;
  const tool = ADAPTERS[profile.toolId]?.name ?? profile.toolId;
  const rate = errorKind === "rate_limit" || code === "rateLimitExceeded" || grokError || grokSentence;
  const reason = errorKind === "billing_error" ? `${tool}'s spend limit` : rate ? `${tool}'s rate limit` : `${tool}'s usage limit`;
  return new UsageLimited(profile.toolId, clockTime(text, now) ?? now + UNKNOWN_LIMIT_MS, reason);
}
