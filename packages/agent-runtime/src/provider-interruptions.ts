// How each tool's own connector says a turn was interrupted. Each adapter reads only what its
// connector sends, in the reporting mode Petrina already uses with it. The shared recovery and status
// code works from these answers and never reads provider wording itself.
//
// Two different things, kept apart:
// - A terminal capacity stop: the turn has ended because the selected model is full. Petrina retries it.
// - A native retry: the tool is still working the turn and is trying again by itself. Petrina only shows it.
// A native retry warning never establishes why a later turn ended.
import type { RetryCause } from "@petrina/orchestrator";

/** A turn ended because the selected model is full. `retryAfterMs` is an explicit provider delay. */
export interface CapacityStop { retryAfterMs?: number }

/** A session update, or an extension notification on the tool's own route, received during a turn. */
export type SessionNotice =
  | { kind: "update"; sessionId: string; update: unknown }
  | { kind: "extension"; method: string; params: unknown };

/** The tool is retrying the turn by itself, or its own retries just stopped (the turn ends through its usual result or error). */
export type RetryNotice = { retrying: RetryCause; retryAfterMs?: number } | { stopped: true };

export interface ToolInterruptions {
  /** A terminal failure carried by the prompt response; warnings and cancellation are not failures. */
  failure?: (response: unknown) => Error | undefined;
  /** A thrown failure, a prompt response or the turn's text (`source` is a string) that ended the turn on a full model. */
  capacity?: (source: unknown, text: string) => CapacityStop | undefined;
  /** A native retry notice. Anything else, including account, rate and sign-in reports, is undefined. */
  notice?: (notice: SessionNotice) => RetryNotice | undefined;
}

const recordOf = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined);

// ── Codex ────────────────────────────────────────────────────────────────

/** Codex's own sentence when the selected model is full. This is not an account usage, rate or session limit. */
export const CODEX_MODEL_CAPACITY = "Selected model is at capacity. Please try a different model.";

const CODEX_CAPACITY_CODES = new Set(["serverOverloaded", "server_overloaded"]);

/**
 * `codexErrorInfo` kinds codex-acp files as a lost transport (`STRUCTURED_CODEX_ERROR_CATEGORIES`).
 * They arrive as objects keyed by the kind, such as `{ responseStreamDisconnected: { httpStatusCode: null } }`.
 */
const CODEX_TRANSPORT = new Set(["httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected", "responseTooManyFailedAttempts"]);

/** Account, session-budget and sign-in kinds. Their retries are not shown as an interruption. */
const CODEX_ACCOUNT = new Set(["usageLimitExceeded", "rateLimitExceeded", "sessionBudgetExceeded", "unauthorized", "contextWindowExceeded"]);

/** The whole turn ended on Codex's capacity sentence, with no finished result after it. */
export function codexModelAtCapacity(text: string): boolean {
  return text.trimEnd().endsWith(CODEX_MODEL_CAPACITY);
}

/** Codex's session-failure meta, when this object carries one. A warning means Codex is still working the turn. */
function sessionFailureOf(record: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const meta = recordOf(record?._meta);
  const air = recordOf(recordOf(meta?.jetbrains)?.air);
  return recordOf(air?.sessionFailure);
}

/** An explicit retry delay. `retryAfter` alone is ambiguous, so it is not a delay. */
function retryDelayMs(record: Record<string, unknown> | undefined): number | undefined {
  if (!record) return undefined;
  const ms = record.retryAfterMs ?? record.retry_after_ms;
  if (typeof ms === "number" && Number.isFinite(ms) && ms >= 0) return ms;
  const seconds = record.retryAfterSeconds ?? record.retry_after_seconds;
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  return undefined;
}

/**
 * Codex stopped because the selected model is full: its capacity sentence, or `serverOverloaded` /
 * `server_overloaded`. A warning-severity session failure is Codex retrying the turn itself, so it is not a stop.
 * Returns the provider delay when one was named. This is not an account limit.
 */
export function codexCapacityFailure(error: unknown): CapacityStop | undefined {
  if (typeof error === "string") return codexModelAtCapacity(error) ? {} : undefined;
  const record = recordOf(error);
  if (!record) return undefined;
  const nested = recordOf(record.data) ?? {};
  const failure = sessionFailureOf(record) ?? sessionFailureOf(nested);
  const warning = failure?.severity === "warning";
  const messages = [record.message, nested.message, !warning && typeof failure?.title === "string" ? failure.title : undefined].filter((value): value is string => typeof value === "string" && value.length > 0);
  const code = [record.codexErrorInfo, record.codex_error_info, nested.codexErrorInfo, nested.codex_error_info].some((value) => typeof value === "string" && CODEX_CAPACITY_CODES.has(value));
  const sentence = messages.some((value) => codexModelAtCapacity(value)) || codexModelAtCapacity(messages.join("\n"));
  if (!code && !sentence) return undefined;
  const retryAfterMs = retryDelayMs(record) ?? retryDelayMs(nested) ?? (!warning ? retryDelayMs(failure) : undefined);
  return retryAfterMs !== undefined ? { retryAfterMs } : {};
}

/** The failure, the response or the turn's own text ends on the capacity stop. A response can be a warning while the text still ends on the sentence. */
function codexCapacity(source: unknown, text: string): CapacityStop | undefined {
  return codexCapacityFailure(source) ?? (codexModelAtCapacity(text) ? {} : undefined);
}

/** The HTTP status Codex attached to a structured error kind, if any. */
function codexHttpStatus(info: Record<string, unknown>): number | undefined {
  const details = recordOf(Object.values(info)[0]);
  return typeof details?.httpStatusCode === "number" ? details.httpStatusCode : undefined;
}

/**
 * codex-acp 2.2.2 reports typed session failures when requested. Warning connection/service records
 * describe native retries. Only the completed prompt's own metadata decides terminal failure;
 * a late session-wide error cannot end a different turn. Native Codex retry updates are also recognized.
 */
function codexNotice(notice: SessionNotice): RetryNotice | undefined {
  if (notice.kind !== "update") return undefined;
  const update = recordOf(notice.update);
  if (update?.sessionUpdate !== "session_info_update") return undefined;
  const typed = sessionFailureOf(update);
  if (typed?.severity === "warning") {
    if (typed.category === "connection") return { retrying: "network" };
    if (typed.category === "service") return { retrying: "transient" };
    return undefined;
  }
  if (typed) return undefined;
  const error = recordOf(recordOf(recordOf(update._meta)?.codex)?.error);
  if (!error || error.willRetry !== true) return undefined;
  const info = error.codexErrorInfo;
  if (typeof info === "string") return CODEX_ACCOUNT.has(info) ? undefined : { retrying: "transient" };
  const structured = recordOf(info);
  if (structured) {
    const status = codexHttpStatus(structured);
    if (status === 401 || status === 402 || status === 429) return undefined;
    const kind = Object.keys(structured)[0];
    if (kind && CODEX_TRANSPORT.has(kind)) return { retrying: "network" };
  }
  return { retrying: "transient" };
}

/** codex-acp attributes this response metadata to the completed prompt, unlike session-wide notices. */
function createCodexFailure(authRequired: () => Error) {
  return function codexFailure(response: unknown): Error | undefined {
    const record = recordOf(response);
    if (record?.stopReason === "cancelled") return undefined;
    const failure = sessionFailureOf(record);
    if (failure?.severity !== "error" || typeof failure.title !== "string") return undefined;
    const title = failure.title.trim() || "Codex reported a failed turn.";
    const actions = Array.isArray(failure.actions) ? failure.actions : [];
    if (failure.category === "access" && actions.includes("login")) return authRequired();
    // Typed limit policy distinguishes account quota/rate limits from context or session budgets.
    // A new-session action alone does not prove the account has run out.
    const codexErrorInfo = failure.category === "limit" && !actions.includes("new_session")
      ? actions.includes("retry") ? "rateLimitExceeded" : "usageLimitExceeded" : undefined;
    return Object.assign(new Error(failure.category === "connection" ? `Codex's connection failed: ${title}` : title), { data: codexErrorInfo ? { codexErrorInfo } : {} });
  };
}

// ── Claude Code ──────────────────────────────────────────────────────────

/**
 * claude-agent-acp 0.89.1, without the optional AIR failure records, rejects the prompt with ACP's internal
 * error and `data.errorKind` from Claude's assistant error (`SDKAssistantMessageError`). Only "overloaded"
 * is a full model: rate limits, billing, sign-in and server errors keep their own paths. In this mode the
 * connector sends no native retry notices, so Claude has no reconnecting status.
 */
function claudeCapacity(source: unknown): CapacityStop | undefined {
  if (typeof source === "string") return undefined;
  return recordOf(recordOf(source)?.data)?.errorKind === "overloaded" ? {} : undefined;
}


// ── Grok ─────────────────────────────────────────────────────────────────

/**
 * Grok's own sentence for a capacity failure (`OVERLOADED_USER_MESSAGE`): an overloaded stream error or HTTP 529,
 * after its own retries. It is the whole ACP error message, with no data. Grok files other busy or 503 errors
 * under its rate-limit category, and its 429 can say "at capacity" too; neither is this sentence.
 */
export const GROK_OVERLOADED = "Model is temporarily overloaded. Try again in a moment.";

/** The route Grok's own session updates ride, including `retry_state`. The SDK hands it over with or without the leading underscore. */
const GROK_UPDATE_METHODS = new Set(["_x.ai/session/update", "x.ai/session/update"]);

/**
 * Reasons Grok gives when its connection to the service failed. Its `error_type` is too broad ("http" also
 * covers a response that could not be decoded), so the reason decides. From Grok 1.0.62's recorded retries.
 */
const GROK_CONNECTION = /dns error|failed to lookup address|client error \(Connect\)|connection (?:error|reset|refused|closed|aborted|problem)|connection to grok (?:timed out|was interrupted)|keep-alive timed out|network is unreachable|broken pipe/i;

/** Grok's sign-in, billing and rate-limit retries are not an interruption to show. */
const GROK_ACCOUNT_TYPES = new Set(["auth", "auth_transient", "legacy_auth", "rate_limit", "billing"]);
const GROK_ACCOUNT_REASON = /\((?:status )?(?:401|402|429)\b|\bstatus (?:401|402|429)\b|rate limit|usage balance|unauthorized/i;

function grokCapacity(source: unknown): CapacityStop | undefined {
  if (typeof source === "string") return undefined;
  const message = recordOf(source)?.message;
  return typeof message === "string" && message.trim() === GROK_OVERLOADED ? {} : undefined;
}

/**
 * Grok sends `retry_state` on its own `_x.ai/session/update` route: "retrying" while it tries again by itself,
 * then "exhausted" or "failed" when its own retries end. It names no retry delay there.
 */
function grokNotice(notice: SessionNotice): RetryNotice | undefined {
  if (notice.kind !== "extension" || !GROK_UPDATE_METHODS.has(notice.method)) return undefined;
  const update = recordOf(recordOf(notice.params)?.update);
  if (update?.sessionUpdate !== "retry_state") return undefined;
  if (update.type === "exhausted" || update.type === "failed") return { stopped: true };
  if (update.type !== "retrying") return undefined;
  const reason = typeof update.reason === "string" ? update.reason : "";
  const type = typeof update.error_type === "string" ? update.error_type : typeof update.errorType === "string" ? update.errorType : undefined;
  if ((type && GROK_ACCOUNT_TYPES.has(type)) || GROK_ACCOUNT_REASON.test(reason)) return undefined;
  return { retrying: GROK_CONNECTION.test(reason) ? "network" : "transient" };
}


// Antigravity: the pinned 1.4.1 server records its retries and service-unavailable errors only in its own
// log, never as an ACP event, and a 503 does not establish a full model. It has no interruptions here.

/** Pure observations use the host's authentication error representation. */
export function createProviderInterruptions(authRequired: () => Error): { codex: ToolInterruptions; claude: ToolInterruptions; grok: ToolInterruptions } {
  return {
    codex: { capacity: codexCapacity, notice: codexNotice, failure: createCodexFailure(authRequired) },
    claude: { capacity: claudeCapacity },
    grok: { capacity: grokCapacity, notice: grokNotice },
  };
}
