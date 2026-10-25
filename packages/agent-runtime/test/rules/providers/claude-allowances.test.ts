import { expect, it } from "bun:test";
import { claudeReports } from "../../../src/claude-usage-report.js";
import { claudeAccountReports } from "../../../src/claude-account-report.js";
const NOW = Date.parse("2026-10-21T12:00:00Z"), HOUR = 3_600_000;
const account = (used: number, enabled: boolean, paid: unknown) => ({ rate_limits_available: true, rate_limits: {
  five_hour: { utilization: used, resets_at: new Date(NOW + HOUR).toISOString() },
  seven_day: { utilization: 2, resets_at: new Date(NOW + 24 * HOUR).toISOString() },
  extra_usage: { is_enabled: enabled, utilization: paid },
} });
it("does not turn unavailable paid usage into an included-quota report", () => {
  // Native rate_limit_event payloads are forwarded verbatim by claude-agent-acp 0.89.1.
  const reports = claudeReports("claude-code", { "_claude/rateLimit": {
    status: "allowed", rateLimitType: "five_hour", utilization: 0.05,
    isUsingOverage: false, overageDisabledReason: "org_level_disabled", overageStatus: "rejected",
  } });
  expect(reports.filter(report => !("claudeOverage" in report))).toEqual([
    { toolId: "claude-code", kind: "five_hour", status: "allowed", utilization: 0.05 },
  ]);
});


it("does not infer paid continuation from entitlement or unknown fields", () => {
  for (const fields of [{ overageStatus: "allowed" }, { overageEnabled: true }, { overageInUse: false }, { overageDisabledReason: "unknown" }, { overageDisabledReason: "fetch_error" }]) {
    expect(claudeReports("claude-code", { "_claude/rateLimit": { status: "rejected", rateLimitType: "seven_day", ...fields } })[0]?.overage).not.toBe(true);
  }
  expect(claudeReports("claude-code", { "_claude/rateLimit": { status: "rejected", rateLimitType: "seven_day", overageInUse: true } })[0]?.overage).toBe(true);
  expect(claudeReports("claude-code", { "_claude/rateLimit": { status: "rejected", rateLimitType: "seven_day", isUsingOverage: true, overageStatus: "rejected" } })[0]?.overage).toBe(false);
  for (const invalid of [undefined, null, -1, 101, NaN, Infinity]) {
    expect(claudeAccountReports(account(100, true, invalid))[0]?.overage).not.toBe(true);
  }
});
