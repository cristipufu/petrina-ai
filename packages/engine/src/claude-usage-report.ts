import type { UsageInfo } from "./usage.js";

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

