import { expect, it } from "bun:test";
import { turnTokens } from "@petrina/core";
import { grokReports, grokTurnReport } from "../../../src/grok-report.js";
import { billing, end } from "../../fixtures/grok-account-report.js";

  it("keeps different models and cache creation, and rejects partial or legacy last-call figures", () => {
    const a = { inputTokens: 100, outputTokens: 20, cachedReadTokens: 40, cacheCreationTokens: 10, reasoningTokens: 5 };
    const b = { inputTokens: 50, outputTokens: 10, cachedReadTokens: 0, cacheCreationTokens: 0 };
    const report = grokTurnReport({ _meta: { usage: { inputTokens: 150, outputTokens: 30, cachedReadTokens: 40, cacheCreationTokens: 10, modelUsage: { "grok-build": a, "helper-model[fast]": b } } } });
    const result = turnTokens({ toolId: "grok", report });
    expect(result.tokens?.total).toBe(180);
    expect(result.tokens?.input).toBe(100);
    expect(result.lines.map(row => row.model)).toEqual(["grok-build", "helper-model[fast]"]);
    expect(grokTurnReport({ _meta: { totalTokens: 500000, inputTokens: 100, outputTokens: 20 } })).toBeUndefined();
    expect(grokTurnReport({ _meta: { usage: { ...a, usageIsIncomplete: true } } })).toBeUndefined();
    expect(grokTurnReport({ _meta: { usage: { ...a, cachedReadTokens: 200 } } })).toBeUndefined();
    expect(grokTurnReport({ _meta: { usage: { ...a, outputTokens: NaN } } })).toBeUndefined();
    const aggregate = grokTurnReport({ _meta: { usage: { ...a, modelUsage: { incomplete: b } } } });
    expect(turnTokens({ toolId: "grok", report: aggregate, model: "grok-4.7" }).lines).toEqual([{ model: "", input: 50, output: 20, cacheRead: 40, cacheWrite: 10, reasoning: 5, total: 120 }]);
  });

  it("uses the actual allowance percentage and period, keeping no financial fields", () => {
    expect(grokReports(billing())).toEqual([{ toolId: "grok", kind: "seven_day", utilization: 0.11, status: "allowed", resetsAt: Date.parse(end) }]);
    expect(grokReports(billing(0))[0]?.utilization).toBe(0);
    expect(grokReports(billing(90))[0]?.status).toBe("allowed_warning");
    expect(grokReports(billing(101))[0]?.status).toBe("rejected");
    expect(grokReports({ config: { creditUsagePercent: 25, currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY", end: "bad" } } })).toEqual([{ toolId: "grok", kind: "monthly", utilization: 0.25, status: "allowed" }]);
    expect(grokReports({ config: { creditUsagePercent: -1 } })).toEqual([]);
    expect(grokReports({ config: { creditUsagePercent: "11" } })).toEqual([]);
    expect(grokReports({ config: null })).toEqual([]);
  });
