export interface LimitFailure { kind: "usage" | "rate" | "spend"; retryAfter?: number; reason?: string; independent?: true }

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


export function claudeLimit(data: Record<string, unknown>, message: string): LimitFailure | undefined {
  if (typeof data.errorKind === "string" && CLAUDE_OUT.has(data.errorKind) || CLAUDE_USAGE_PREFIXES.some(prefix => message.includes(prefix))) {
    return { kind: data.errorKind === "billing_error" ? "spend" : data.errorKind === "rate_limit" ? "rate" : "usage",
      ...(data.errorKind === "billing_error" || data.errorKind === "account_on_hold" ? { independent: true } : {}),
    };
  }
  return undefined;
}
export function codexLimit(data: Record<string, unknown>): LimitFailure | undefined {
  if (typeof data.codexErrorInfo === "string" && CODEX_OUT.has(data.codexErrorInfo)) return { kind: data.codexErrorInfo === "rateLimitExceeded" ? "rate" : "usage" };
  return undefined;
}
/** null means a known busy service, which must not fall through to a quota category. */
export function grokLimit(data: Record<string, unknown>, message: string): LimitFailure | null | undefined {
  if (data.http_status === 402 && message.includes(GROK_BALANCE_MESSAGE)) return {
    kind: "usage",
    retryAfter: GROK_REFUSAL_COOLDOWN_MS,
    reason: `Grok refused the request: ${GROK_BALANCE_MESSAGE}`
  };
  if (data.http_status === 503 || data.http_status === 529 || GROK_BUSY.some(line => message.includes(line))) return null;
  if (data.error === GROK_RATE || message.includes(GROK_RATE_MESSAGE)) return { kind: "rate" };
  return undefined;
}
export function commonLimit(data: Record<string, unknown>): LimitFailure | undefined {
  if (typeof data.category === "string" && LIMIT_KIND.has(data.category) || typeof data.kind === "string" && LIMIT_KIND.has(data.kind)) return { kind: "usage" };
  return undefined;
}
