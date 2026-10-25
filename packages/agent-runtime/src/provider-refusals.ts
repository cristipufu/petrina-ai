import { kindWords, UNKNOWN_LIMIT_MS, type AgentProfile } from "@petrina/core";
import { UsageLimited, type UsageInfo } from "./failures.js";
import { commonLimit } from "./provider-limits.js";
import type { LimitFailure } from "./provider-limits.js";

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

/** Native composition supplies provider metadata; parsing itself needs no registry, process or account. */
export function createLimitParsing(adapter: (toolId: string) => { name: string; parseLimitError?: (data: Record<string, unknown>, message: string) => LimitFailure | null | undefined } | undefined) {
  /** The error for a turn that ended while the tool's latest report said it was out. */
  function limitFromReport(profile: AgentProfile, info: UsageInfo, now: number, source: "report" | "refusal" = "report"): UsageLimited {
    const tool = adapter(profile.toolId)?.name ?? profile.toolId;
    return new UsageLimited(profile.toolId, info.resetsAt && info.resetsAt > now ? info.resetsAt : now + UNKNOWN_LIMIT_MS, `${tool}'s ${kindWords(info.kind, info.windowMinutes, info.name)} limit`, info.model, undefined, source);
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
  function limitFromFailure(profile: AgentProfile, error: unknown, said: string, now: number): UsageLimited | undefined {
    const data = payload(error);
    const outerMessage = (error as { message?: unknown } | undefined)?.message;
    const message = [outerMessage, data.message].filter((value): value is string => typeof value === "string").join("\n");
    const native = adapter(profile.toolId)?.parseLimitError?.(data, message);
    if (native === null) return undefined;
    const limit = native ?? commonLimit(data);
    if (!limit) return undefined;
    const tool = adapter(profile.toolId)?.name ?? profile.toolId;
    const reason = limit.reason ?? `${tool}'s ${limit.kind} limit`;
    const refusal = new UsageLimited(profile.toolId, limit.retryAfter ? now + limit.retryAfter : clockTime(`${message}\n${said}`, now) ?? now + UNKNOWN_LIMIT_MS, reason, undefined, limit.retryAfter ? true : undefined);
    if (limit.independent) refusal.independent = true;
    return refusal;
  }
  return { limitFromReport, limitFromFailure };
}
