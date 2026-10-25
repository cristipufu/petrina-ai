import { describe, expect, it } from "bun:test";
import type { AgentProfile } from "@petrina/core";
import { claudeReport, claudeReports } from "@petrina/agent-runtime/claude-usage-report";
import { clockTime } from "@petrina/agent-runtime/provider-refusals";
import { UsageLimited } from "@petrina/agent-runtime/failures";
import { limitFromFailure, limitFromReport } from "../../fixtures/limit-parsing.js";

describe("what the tools say about usage", () => {
  const claude: AgentProfile = { id: "opus-high", toolId: "claude-code", model: "Opus 5.5", modelId: "opus", effort: "high" };
  const codex: AgentProfile = { id: "sol-high", toolId: "codex", model: "sol", modelId: "gpt-6.1-sol", effort: "high" };
  const now = new Date(2026, 9, 17, 15, 0, 0).getTime();

  it("reads Claude Code's rate limit report, with the reset time in milliseconds", () => {
    expect(claudeReport("claude-code", { "_claude/rateLimit": { status: "allowed_warning", resetsAt: 1_800_000_000, rateLimitType: "seven_day_opus", utilization: 0.82 } })).toEqual({ toolId: "claude-code", kind: "seven_day_opus", status: "allowed_warning", model: "opus", utilization: 0.82, resetsAt: 1_800_000_000_000 });
    expect(claudeReport("claude-code", { "_claude/rateLimit": { status: "rejected" } })).toEqual({ toolId: "claude-code", kind: "limit", status: "rejected" });
    // A window used up while the account goes on with extra usage: spent, not out.
    expect(claudeReports("claude-code", { "_claude/rateLimit": { status: "rejected", rateLimitType: "seven_day", resetsAt: 1_800_000_000, isUsingOverage: true } })).toEqual([
      { toolId: "claude-code", kind: "seven_day", status: "rejected", resetsAt: 1_800_000_000_000, overage: true },
    ]);
    // Paid status is separate from the included window; it is consumed before shared readings.
    expect(claudeReports("claude-code", { "_claude/rateLimit": { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.95, overageStatus: "rejected", overageResetsAt: 1_800_000_000 } })).toEqual([
      { toolId: "claude-code", kind: "five_hour", status: "allowed_warning", utilization: 0.95 },
      { toolId: "claude-code", kind: "overage", status: "rejected", claudeOverage: "unavailable", resetsAt: 1_800_000_000_000 },
    ]);
    expect(claudeReport("claude-code", {})).toBeUndefined();
    expect(claudeReport("claude-code", { "_claude/rateLimit": { status: "whatever" } })).toBeUndefined();
  });

  it("says when a rejected report has no reset time: half an hour from now", () => {
    const error = limitFromReport(claude, { toolId: "claude-code", kind: "seven_day_opus", status: "rejected", model: "opus" }, now);
    expect(error).toBeInstanceOf(UsageLimited);
    expect(error).toMatchObject({ toolId: "claude-code", model: "opus", until: now + 30 * 60_000, reason: "Claude Code's weekly Opus limit" });
  });

  it("reads Codex's failure and the time it says to try again at", () => {
    const failure = { code: -32603, message: "Internal error", data: { codexErrorInfo: "usageLimitExceeded", category: "quota_exhausted" } };
    const error = limitFromFailure(codex, failure, "You've hit your usage limit. Try again at 5:42 PM.", now);
    expect(error).toMatchObject({ toolId: "codex", reason: "Codex's usage limit", until: new Date(2026, 9, 17, 17, 42).getTime() });
    // No time given: half an hour.
    expect(limitFromFailure(codex, failure, "", now)!.until).toBe(now + 30 * 60_000);
    // Any other failure is not a usage limit.
    expect(limitFromFailure(codex, new Error("The agent stopped (exit 1)"), "Working on it", now)).toBeUndefined();
  });

  it("reads a failed turn by its code, and Claude's sentence only when the code is missing", () => {
    // The spend cap's code. No sentence required.
    expect(limitFromFailure(claude, { code: -32603, message: "Internal error", data: { errorKind: "billing_error" } }, "Working on it", now)).toMatchObject({ toolId: "claude-code", reason: "Claude Code's spend limit", until: now + 30 * 60_000 });
    expect(limitFromFailure(claude, { code: -32603, message: "Internal error", data: { errorKind: "rate_limit" } }, "", now)?.reason).toBe("Claude Code's rate limit");
    // A synthetic usage-limit message has no errorKind. The adapter wraps Claude's sentence, which names the reset.
    const said = "You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage?from=cc_cli_limit_message · your session limit resets 8:10pm (Europe/Bucharest)";
    const error = limitFromFailure(claude, new Error(`Internal error: ${said}`), "", now);
    expect(error).toMatchObject({ toolId: "claude-code", reason: "Claude Code's usage limit", until: new Date(2026, 9, 17, 20, 10).getTime() });
    expect(error?.model).toBeUndefined();
    // Some other internal error is not a usage limit, even if the agent mentioned a limit.
    expect(limitFromFailure(claude, new Error("Internal error: the tool crashed"), "You've hit your stride", now)).toBeUndefined();
    expect(limitFromFailure(claude, { code: -32603, message: "Internal error", data: { errorKind: "server_error" } }, "", now)).toBeUndefined();
    // The same sentence in what the agent said is not a limit. Only the error text is.
    expect(limitFromFailure(claude, new Error("Internal error: the tool crashed"), "You've hit the rate limit for your plan.", now)).toBeUndefined();
  });

  it("reads Grok's rate-limit code, and its one sentence only on the error", () => {
    const grok: AgentProfile = { id: "grok-high", toolId: "grok", model: "Grok 4.7", modelId: "grok-4.7", effort: "high" };
    expect(limitFromFailure(grok, { message: "You've hit the rate limit for your plan." }, "Working on it", now)).toMatchObject({ toolId: "grok", reason: "Grok's rate limit", until: now + 30 * 60_000 });
    expect(limitFromFailure(grok, { message: "Internal error", data: { error: "rate_limit" } }, "", now)?.reason).toBe("Grok's rate limit");
    expect(limitFromFailure(grok, { message: "Rate limited", data: { error: "rate_limit" } }, "", now)?.reason).toBe("Grok's rate limit");
    expect(limitFromFailure(grok, new Error("You've hit the rate limit for your plan. Try again at 4:10 PM."), "", now)?.until).toBe(new Date(2026, 9, 17, 16, 10).getTime());
    // Grok files a capacity error (503, 529) under the same code. The sentence says it is a busy service, not the plan's limit.
    for (const message of ["Server error", "The service is busy. Wait a minute and send again.", "Service unavailable", "Something went wrong on our side. Wait a minute and send again."]) {
      expect(limitFromFailure(grok, { message, data: { error: "rate_limit" } }, "", now)).toBeUndefined();
      expect(limitFromFailure(grok, new Error(message), "", now)).toBeUndefined();
    }
    expect(limitFromFailure(grok, { message: "Internal error", data: { error: "server_error" } }, "", now)).toBeUndefined();
    // The same sentence in what the agent said is not a limit. Only the error text is.
    expect(limitFromFailure(grok, new Error("Internal error"), "You've hit the rate limit for your plan.", now)).toBeUndefined();
  });

  it("reads Grok's nested HTTP 402 as a request refusal, without inventing a weekly reset", () => {
    const grok: AgentProfile = { ...codex, toolId: "grok" };
    const data = { http_status: 402, message: "API error (status 402 Payment Required): Grok Build usage balance exhausted" };
    const failure = { code: -32603, message: "Internal error", data };
    const error = limitFromFailure(grok, failure, "Weekly usage resets Friday. Try again at 5:42 PM.", now)!;
    expect(error).toEqual(expect.objectContaining({ toolId: "grok", retry: true, until: now + 5 * 60_000, reason: "Grok refused the request: Grok Build usage balance exhausted" }));
    expect(error.message).toBe(error.reason);
    expect(error.model).toBeUndefined();
    // A provider's structured refusal is not a sentence found in the agent's conversation.
    expect(limitFromFailure(grok, new Error("Internal error"), data.message, now)).toBeUndefined();
    expect(limitFromFailure(codex, failure, "", now)).toBeUndefined();
    expect(limitFromFailure(grok, { message: "Internal error", data: { http_status: 402, message: "Payment setup required" } }, "", now)).toBeUndefined();
    for (const http_status of [401, 403, 500, 503, 529]) {
      expect(limitFromFailure(grok, { message: "Internal error", data: { ...data, http_status } }, "", now)).toBeUndefined();
    }
    // Native service-busy errors can also carry rate_limit, beneath the generic ACP message.
    expect(limitFromFailure(grok, { message: "Internal error", data: { http_status: 503, error: "rate_limit", message: "Service unavailable" } }, "", now)).toBeUndefined();
    expect(limitFromFailure(grok, { message: "Internal error", data: { error: "rate_limit", message: "You've hit the rate limit for your plan." } }, "", now)?.reason).toBe("Grok's rate limit");
    expect(limitFromFailure(grok, { message: "Internal error", data: { error: "rate_limit", message: "You've hit the rate limit for your plan. Try again at 4:10 PM." } }, "", now)?.until).toBe(new Date(2026, 9, 17, 16, 10).getTime());
    expect(limitFromFailure(grok, { message: "Internal error", data: { http_status: 529, category: "rate_limited" } }, "", now)).toBeUndefined();
  });

  it("reads every limit code both tools send, with the kind of limit in words", () => {
    const failure = (data: Record<string, string>) => ({ code: -32603, message: "Internal error", data });
    // Codex: its usage, its rate and its session budget.
    expect(limitFromFailure(codex, failure({ codexErrorInfo: "usageLimitExceeded" }), "", now)?.reason).toBe("Codex's usage limit");
    expect(limitFromFailure(codex, failure({ codexErrorInfo: "rateLimitExceeded" }), "", now)?.reason).toBe("Codex's rate limit");
    expect(limitFromFailure(codex, failure({ codexErrorInfo: "sessionBudgetExceeded" }), "", now)?.reason).toBe("Codex's usage limit");
    // Claude: the spend cap, the rate limit and an account on hold.
    expect(limitFromFailure(claude, failure({ errorKind: "billing_error" }), "", now)?.reason).toBe("Claude Code's spend limit");
    expect(limitFromFailure(claude, failure({ errorKind: "rate_limit" }), "", now)?.reason).toBe("Claude Code's rate limit");
    expect(limitFromFailure(claude, failure({ errorKind: "account_on_hold" }), "", now)?.reason).toBe("Claude Code's usage limit");
    // The session-failure kinds both adapters use.
    for (const kind of ["quota_exhausted", "rate_limited", "budget_exhausted"]) {
      expect(limitFromFailure(codex, failure({ category: kind }), "", now)).toBeInstanceOf(UsageLimited);
      expect(limitFromFailure(claude, failure({ kind }), "", now)).toBeInstanceOf(UsageLimited);
    }
    expect(limitFromFailure(codex, failure({ codexErrorInfo: "contextWindowExceeded" }), "", now)).toBeUndefined();
  });

  it("keeps native error classification on the provider that owns it", () => {
    const claudeSentence = new Error("You've hit your usage limit.");
    expect(limitFromFailure(claude, claudeSentence, "", now)).toBeInstanceOf(UsageLimited);
    expect(limitFromFailure(codex, claudeSentence, "", now)).toBeUndefined();
    expect(limitFromFailure(claude, { data: { codexErrorInfo: "usageLimitExceeded" } }, "", now)).toBeUndefined();
  });

  it("takes the next time the clock shows what it says", () => {
    expect(clockTime("try again at 9:05 AM", now)).toBe(new Date(2026, 9, 18, 9, 5).getTime());
    expect(clockTime("Try again at 12:30 pm", now)).toBe(new Date(2026, 9, 18, 12, 30).getTime());
    expect(clockTime("try again at 16:00", now)).toBe(new Date(2026, 9, 17, 16, 0).getTime());
    expect(clockTime("your session limit resets 8:10pm (Europe/Bucharest)", now)).toBe(new Date(2026, 9, 17, 20, 10).getTime());
    expect(clockTime("later", now)).toBeUndefined();
  });
});
