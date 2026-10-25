import type { UsageInfo } from "./failures.js";
import { claudeWindow } from "@petrina/core";

const USAGE_STATUS = new Set(["allowed", "allowed_warning", "rejected"]);
const DISABLED_OVERAGE = new Set(["overage_not_provisioned", "org_level_disabled", "org_level_disabled_until", "out_of_credits", "seat_tier_level_disabled", "member_level_disabled", "seat_tier_zero_credit_limit", "group_zero_credit_limit", "member_zero_credit_limit", "org_service_level_disabled", "no_limits_configured"]);

const validShare = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const seconds = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value > 0 ? value * 1000 : undefined;

/** Subscription windows and the separate paid allowance in SDKRateLimitInfo. Paid status alone is never a refusal. */
export function claudeReports(toolId: string, meta: unknown): UsageInfo[] {
  if (!meta || typeof meta !== "object") return [];
  const info = (meta as Record<string, unknown>)["_claude/rateLimit"];
  if (!info || typeof info !== "object") return [];
  const { status, resetsAt, rateLimitType, utilization, overageStatus, overageResetsAt, overageDisabledReason, isUsingOverage, overageInUse } = info as {
    status?: unknown;
    resetsAt?: unknown;
    rateLimitType?: unknown;
    utilization?: unknown;
    overageStatus?: unknown;
    overageResetsAt?: unknown;
    overageDisabledReason?: unknown;
    isUsingOverage?: unknown;
    overageInUse?: unknown;
  };
  const reports: UsageInfo[] = [];
  // The native CLIs distinguish entitlement, allowance status and continuation. "allowed" paid
  // status (or merely enabling it) does not say the account is actually continuing beyond its plan.
  const disabled = typeof overageDisabledReason === "string" && DISABLED_OVERAGE.has(overageDisabledReason);
  const paidStatus = rateLimitType === "overage" ? status : overageStatus;
  const paidReset = seconds(rateLimitType === "overage" ? resetsAt : overageResetsAt);
  const paidCurrent = paidReset === undefined || paidReset > Date.now();
  const unavailable = paidCurrent && (disabled || paidStatus === "rejected");
  const continuing = isUsingOverage === true || overageInUse === true;
  if (rateLimitType !== "overage" && typeof status === "string" && USAGE_STATUS.has(status)) {
    const kind = typeof rateLimitType === "string" ? rateLimitType : "limit";
    reports.push(claudeWindow({
      toolId,
      kind,
      status: status as UsageInfo["status"],
      ...(validShare(utilization) ? { utilization } : {}),
      // Seconds on the wire, milliseconds everywhere else.
      ...(seconds(resetsAt) !== undefined ? { resetsAt: seconds(resetsAt) } : {}),
      // A window reported as rejected while the account goes on with extra usage is spent, not out: turns keep working.
      ...(status === "rejected" && (unavailable || continuing) ? { overage: !unavailable && continuing } : {}),
    }));
  }
  // Even a paid-only notice can retire the obsolete synthetic paid report, or end paid continuation
  // of a known exhausted window. It cannot establish included exhaustion or recover a request refusal.
  if (unavailable || paidCurrent && typeof paidStatus === "string" && USAGE_STATUS.has(paidStatus)) {
    reports.push({
      toolId,
      kind: "overage",
      status: unavailable ? "rejected" : paidStatus as UsageInfo["status"],
      claudeOverage: unavailable ? "unavailable" : "available",
      ...(paidReset !== undefined ? { resetsAt: paidReset } : {}),
    });
  }
  return reports;
}

/** Claude Code's rate limit report (its `_claude/rateLimit` note on a usage update), or undefined when it is not one. */
export function claudeReport(toolId: string, meta: unknown): UsageInfo | undefined {
  return claudeReports(toolId, meta).find(report => !report.claudeOverage);
}
