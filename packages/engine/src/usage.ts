// Usage limits as the tools report them: Claude Code says how close it is on every turn, Codex only says
// it is out, and Grok says so with a rate-limit code when a turn fails. All end up as the same two things:
// a report for the pool, and a UsageLimited error.

import { kindWords, UNKNOWN_LIMIT_MS, type AgentProfile, type UsageReport } from "@petrina/core";
import { commonLimit } from "./provider-limits.js";
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
