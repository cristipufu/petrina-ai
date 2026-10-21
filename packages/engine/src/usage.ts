// Usage limits as the tools report them: Claude Code says how close it is on every turn, Codex only says
// it is out, and Grok says so with a rate-limit code when a turn fails. All end up as the same two things:
// a report for the pool, and a UsageLimited error.

import { kindWords, untilWords, UNKNOWN_LIMIT_MS, type AgentProfile, type UsageReport } from "@petrina/core";
import { commonLimit } from "./provider-limits.js";
import { ADAPTERS } from "./tools.js";

/** Codex's own sentence when the selected model is full. This is not an account usage, rate or session limit. */
export const CODEX_MODEL_CAPACITY = "Selected model is at capacity. Please try a different model.";

/** How long the same conversation waits after the short retries, when nothing else can take the step. */
export const MODEL_CAPACITY_WAIT_MS = 5 * 60_000;

/**
 * Same-conversation retries before anyone else takes the step: five seconds, then ten, then thirty.
 * A later stop uses the five-minute wait instead of starting this schedule over.
 */
export const CAPACITY_RETRY_DELAYS_MS = [5_000, 10_000, 30_000] as const;

/** Status lines for this wait start with this, so they are not rewritten as a usage or slot wait. */
export const CAPACITY_WAIT = "The selected model is at capacity";

/** The whole turn ended on Codex's capacity sentence, with no finished result after it. */
export function codexModelAtCapacity(text: string): boolean {
  return text.trimEnd().endsWith(CODEX_MODEL_CAPACITY);
}

/**
 * How long to wait before the next same-conversation continue. `tried` is how many continues were already sent.
 * Undefined once those retries are used up. An explicit provider delay waits at least that long.
 */
export function capacityRetryDelay(tried: number, providerMs?: number): number | undefined {
  const slot = CAPACITY_RETRY_DELAYS_MS[tried];
  if (slot === undefined) return undefined;
  return Math.max(slot, providerMs ?? 0);
}

/** What the task says while it waits to try the same model again. */
export function capacityWaiting(until: number, now: number): string {
  return `${CAPACITY_WAIT}. Trying again after ${untilWords(until, now)}`;
}

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

/**
 * The selected Codex model is full. The account's usage is unchanged. `modelId` covers every effort of that model.
 */
export class ModelAtCapacity extends Error {
  /** What the agent had said in the turn before it stopped. */
  said?: string;
  /** The public text is already saved in the task's live conversation. */
  streamed?: boolean;
  /** Milliseconds the provider named as its own retry delay. Absent when it named none. */
  retryAfterMs?: number;
  constructor(
    readonly toolId: string,
    readonly modelId: string,
    readonly profileId: string,
    readonly sessionId?: string,
  ) {
    super(CODEX_MODEL_CAPACITY);
    this.name = "ModelAtCapacity";
  }
}

/** Whether this profile is one effort of the model that just filled up. */
export function sameCapacityModel(error: ModelAtCapacity, profile: Pick<AgentProfile, "toolId" | "model" | "modelId">): boolean {
  return error.toolId === profile.toolId && error.modelId === (profile.modelId ?? profile.model);
}

/** Nobody can work the step until a limit ends: the task waits, and the driver lets go of it quietly. */
export class WaitingForUsage extends Error {
  /** What the task's status line says. */
  constructor(readonly words: string) {
    super(words);
  }
}

/** The selected model is full and nothing else can take the step. The task waits, then retries that same profile. */
export class WaitingForCapacity extends WaitingForUsage {
  constructor(words: string) {
    super(words);
    this.name = "WaitingForCapacity";
  }
}

/** The wait a choice with nobody to work named: a full model's, or a usage or seat wait, including when the account is out as well. */
export function waitingFor(words: string): WaitingForUsage {
  return words.startsWith(CAPACITY_WAIT) ? new WaitingForCapacity(words) : new WaitingForUsage(words);
}

export { claudeReports, claudeReport } from "./claude-usage-report.js";

/** The error for a turn that ended while the tool's latest report said it was out. */
export function limitFromReport(profile: AgentProfile, info: UsageInfo, now: number): UsageLimited {
  const tool = ADAPTERS[profile.toolId]?.name ?? profile.toolId;
  return new UsageLimited(profile.toolId, info.resetsAt && info.resetsAt > now ? info.resetsAt : now + UNKNOWN_LIMIT_MS, `${tool}'s ${kindWords(info.kind, info.windowMinutes, info.name)} limit`, info.model);
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

const CAPACITY_CODES = new Set(["serverOverloaded", "server_overloaded"]);

const recordOf = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === "object" ? value as Record<string, unknown> : undefined);

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
export function codexCapacityFailure(error: unknown): { retryAfterMs?: number } | undefined {
  if (typeof error === "string") return codexModelAtCapacity(error) ? {} : undefined;
  const record = recordOf(error);
  if (!record) return undefined;
  const nested = recordOf(record.data) ?? {};
  const failure = sessionFailureOf(record) ?? sessionFailureOf(nested);
  const warning = failure?.severity === "warning";
  const messages = [record.message, nested.message, !warning && typeof failure?.title === "string" ? failure.title : undefined].filter((value): value is string => typeof value === "string" && value.length > 0);
  const code = [record.codexErrorInfo, record.codex_error_info, nested.codexErrorInfo, nested.codex_error_info].some((value) => typeof value === "string" && CAPACITY_CODES.has(value));
  const sentence = messages.some((value) => codexModelAtCapacity(value)) || codexModelAtCapacity(messages.join("\n"));
  if (!code && !sentence) return undefined;
  const retryAfterMs = retryDelayMs(record) ?? retryDelayMs(nested) ?? (!warning ? retryDelayMs(failure) : undefined);
  return retryAfterMs !== undefined ? { retryAfterMs } : {};
}

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
  const outerMessage = (error as { message?: unknown } | undefined)?.message;
  const message = [outerMessage, data.message].filter((value): value is string => typeof value === "string").join("\n");
  const native = ADAPTERS[profile.toolId]?.parseLimitError?.(data, message);
  if (native === null) return undefined;
  const limit = native ?? commonLimit(data);
  if (!limit) return undefined;
  const tool = ADAPTERS[profile.toolId]?.name ?? profile.toolId;
  const reason = limit.reason ?? `${tool}'s ${limit.kind} limit`;
  return new UsageLimited(profile.toolId, limit.retryAfter ? now + limit.retryAfter : clockTime(`${message}\n${said}`, now) ?? now + UNKNOWN_LIMIT_MS, reason, undefined, limit.retryAfter ? true : undefined);
}
