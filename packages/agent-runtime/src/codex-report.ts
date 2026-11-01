import type { UsageReport } from "@petrina/core";
import type { UsageInfo } from "./failures.js";

const seconds = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value < 1e12
      ? value * 1000
      : value
    : undefined;

/** Codex's `account/rateLimits/read` answer: each limit's percentage, length and reset. Nothing else is kept. */
export function codexLimits(response: unknown, reportedAt: number): UsageReport[] {
  if (!response || typeof response !== "object") return [];
  const body = response as { rateLimits?: unknown; rateLimitsByLimitId?: unknown };
  const snapshots: [string, unknown][] =
    body.rateLimitsByLimitId && typeof body.rateLimitsByLimitId === "object"
      ? Object.entries(body.rateLimitsByLimitId as Record<string, unknown>)
      : [];
  if (snapshots.length === 0 && body.rateLimits) snapshots.push(["codex", body.rateLimits]);
  const limits: UsageReport[] = [];
  for (const [limitId, snapshot] of snapshots) {
    if (!snapshot || typeof snapshot !== "object") continue;
    const name = (snapshot as { limitName?: unknown }).limitName;
    for (const slot of ["primary", "secondary"] as const) {
      const window = (snapshot as Record<string, unknown>)[slot] as
        | {
            usedPercent?: unknown;
            windowDurationMins?: unknown;
            resetsAt?: unknown;
          }
        | null
        | undefined;
      if (!window || typeof window !== "object") continue;
      const percent =
        typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent)
          ? window.usedPercent
          : undefined;
      const minutes = typeof window.windowDurationMins === "number" ? window.windowDurationMins : undefined;
      const resetsAt = seconds(window.resetsAt);
      limits.push({
        toolId: "codex",
        kind: `${limitId.slice(0, 40)}:${slot}`,
        at: reportedAt,
        status:
          percent !== undefined && percent >= 100
            ? "rejected"
            : percent !== undefined && percent >= 90
              ? "allowed_warning"
              : "allowed",
        ...(minutes !== undefined && Number.isFinite(minutes) && minutes > 0 ? { windowMinutes: minutes } : {}),
        ...(typeof name === "string" && name.trim() && limitId !== "codex"
          ? { name: name.trim().slice(0, 40) }
          : {}),
        ...(percent !== undefined ? { utilization: percent / 100 } : {}),
        ...(resetsAt ? { resetsAt } : {}),
      });
    }
  }
  return limits;
}

/** Codex's windows as shared usage reports, including named limits and their lengths. */
export function codexReports(result: unknown): UsageInfo[] {
  return codexLimits(result, Date.now()).map(({ at: _at, ...report }) => report);
}
