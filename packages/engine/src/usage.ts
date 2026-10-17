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

/** Claude Code's rate limit report (its `_claude/rateLimit` note on a usage update), or undefined when it is not one. */
export function claudeReport(toolId: string, meta: unknown): UsageInfo | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const info = (meta as Record<string, unknown>)["_claude/rateLimit"];
  if (!info || typeof info !== "object") return undefined;
  const { status, resetsAt, rateLimitType, utilization } = info as { status?: unknown; resetsAt?: unknown; rateLimitType?: unknown; utilization?: unknown };
  if (status !== "allowed" && status !== "allowed_warning" && status !== "rejected") return undefined;
  const kind = typeof rateLimitType === "string" ? rateLimitType : "limit";
  const family = FAMILY_OF_KIND[kind];
  return {
    toolId,
    kind,
    status,
    ...(family ? { model: family } : {}),
    ...(typeof utilization === "number" ? { utilization } : {}),
    // Seconds on the wire, milliseconds everywhere else.
    ...(typeof resetsAt === "number" ? { resetsAt: resetsAt * 1000 } : {}),
  };
}

/** The error for a turn that ended while the tool's latest report said it was out. */
export function limitFromReport(profile: AgentProfile, info: UsageInfo, now: number): UsageLimited {
  const tool = ADAPTERS[profile.toolId]?.name ?? profile.toolId;
  return new UsageLimited(profile.toolId, info.resetsAt && info.resetsAt > now ? info.resetsAt : now + UNKNOWN_LIMIT_MS, `${tool}'s ${kindWords(info.kind)} limit`, info.model);
}

/** "try again at 5:42 PM": the next time the clock shows that. */
export function clockTime(text: string, now: number): number | undefined {
  const found = /try again (?:at|after) (\d{1,2})(?::(\d{2}))?\s*([AP]M)?/i.exec(text);
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

/**
 * Codex's way of saying it is out: a failed turn whose error says its usage limit was exceeded (or its quota
 * is exhausted), and a readable message among what the agent said, with the time to try again when it knows.
 */
export function limitFromFailure(profile: AgentProfile, error: unknown, said: string, now: number): UsageLimited | undefined {
  const detail = (() => {
    try {
      return JSON.stringify({ message: (error as Error | undefined)?.message, ...(error as object) });
    } catch {
      return String(error);
    }
  })();
  if (!/usage[_ ]?limit[_ ]?exceeded|quota[_ ]exhausted|hit your usage limit/i.test(`${detail}\n${said}`)) return undefined;
  const tool = ADAPTERS[profile.toolId]?.name ?? profile.toolId;
  return new UsageLimited(profile.toolId, clockTime(`${said}\n${detail}`, now) ?? now + UNKNOWN_LIMIT_MS, `${tool}'s usage limit`);
}
