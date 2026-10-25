import { expect, it } from "bun:test";
import { claudeAccountReports } from "../../../src/claude-account-report.js";
import { account } from "../../fixtures/claude-account.js";

it("reads real zeroes and named model quotas without blocking included work on disabled extra usage", () => {
  const reports = claudeAccountReports(account);
  expect(reports).toHaveLength(3);
  expect(reports[0]).toEqual({ toolId: "claude-code", kind: "five_hour", status: "allowed", utilization: 0, claudeAccountComplete: true });
  expect(reports[1]?.resetsAt).toBe(Date.parse("2026-10-28T12:00:00Z"));
  expect(reports[2]).toMatchObject({ kind: "seven_day_overage_included", model: "fable", status: "rejected", utilization: 1 });
  expect(reports.some(report => report.kind === "overage")).toBe(false);
});

it("does not invent readings from unavailable, missing, or invalid account data", () => {
  expect(claudeAccountReports({ ...account, rate_limits_available: false })).toEqual([]);
  expect(claudeAccountReports({ rate_limits_available: true, rate_limits: { five_hour: { utilization: null }, seven_day: { utilization: 101 } } })).toEqual([]);
  expect(claudeAccountReports(null)).toEqual([]);
});

it("retains family scope and paid allowance only when Claude reports it available", () => {
  const reports = claudeAccountReports({ rate_limits_available: true, rate_limits: {
    seven_day: { utilization: 100 }, seven_day_opus: { utilization: 95 },
    extra_usage: { is_enabled: true, utilization: 25 },
  } });
  expect(reports[0]).toMatchObject({ status: "rejected", overage: true });
  expect(reports[1]).toMatchObject({ model: "opus", status: "allowed_warning" });
});

it("combines legacy family rows with named rows and gives a model only one current identity", () => {
  const reports = claudeAccountReports({ rate_limits_available: true, rate_limits: {
    five_hour: { utilization: 5 }, seven_day: { utilization: 2 },
    seven_day_opus: { utilization: 100 }, seven_day_sonnet: { utilization: 60 },
    model_scoped: [{ display_name: "Opus", utilization: 10 }, { display_name: "Fable", utilization: 30 }],
  } });
  expect(reports.find(report => report.model === "opus")).toMatchObject({ kind: "seven_day_opus", utilization: 0.1, status: "allowed" });
  expect(reports.filter(report => report.model === "opus")).toHaveLength(1);
  expect(reports.find(report => report.model === "sonnet")?.utilization).toBe(0.6);
  expect(reports.find(report => report.model === "fable")?.kind).toBe("seven_day_overage_included");
  expect(reports[0]?.claudeAccountComplete).toBe(true);
  const partial = claudeAccountReports({ ...account, rate_limits: { ...account.rate_limits, seven_day_opus: { utilization: null } } });
  expect(partial[0]?.claudeAccountComplete).toBeUndefined();
});
