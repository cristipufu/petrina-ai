import { describe, expect, it } from "bun:test";
import { createProviderInterruptions, GROK_OVERLOADED } from "../../../src/provider-interruptions.js";
import { createLimitParsing } from "../../../src/provider-refusals.js";
import { UsageLimited, isAuthRequired } from "../../../src/failures.js";
import { claudeLimit, codexLimit, grokLimit } from "../../../src/provider-limits.js";
const { claude: claudeInterruptions, codex: codexInterruptions, grok: grokInterruptions } = createProviderInterruptions(() => Object.assign(new Error("Authentication required"), { code: -32000 }));
const providerLimits = { "claude-code": { name: "Claude Code", parseLimitError: claudeLimit }, codex: { name: "Codex", parseLimitError: codexLimit }, grok: { name: "Grok", parseLimitError: grokLimit }, antigravity: { name: "Antigravity" } };
const { limitFromFailure } = createLimitParsing(id => providerLimits[id as keyof typeof providerLimits]);
import { PROFILES, codexRetry, STREAM_LOST, CONNECT_FAILED, grokRetry, DNS, RESET, GARBLED, update, extension, air } from "../../fixtures/provider-envelopes.js";

describe("reading each tool's own interruption reports", () => {
  it("distinguishes typed reconnect warnings, terminal failures, cancellation and account limits", () => {
    const failure = codexInterruptions.failure!;
    const response = (category: string, actions: string[]) => ({ stopReason: "end_turn", _meta: air(category, "error", "The provider's actual diagnostic", actions) });
    expect(codexInterruptions.notice!(update({ sessionUpdate: "session_info_update", _meta: air("connection", "warning", "Reconnecting") }))).toEqual({ retrying: "network" });
    expect(failure({ stopReason: "end_turn", _meta: air("connection", "warning", "Reconnecting") })).toBeUndefined();
    expect(failure({ stopReason: "cancelled", _meta: air("connection", "error", "Connection failed") })).toBeUndefined();
    expect(codexInterruptions.notice!(update({ sessionUpdate: "session_info_update", _meta: air("connection", "error", "A past turn failed") }))).toBeUndefined();
    const lost = failure(response("connection", ["retry", "new_session"]))!;
    expect(lost.message).toContain("Codex's connection failed");
    expect(limitFromFailure(PROFILES.codex, lost, "", Date.now())).toBeUndefined();
    expect(isAuthRequired(failure(response("access", ["login"])))).toBe(true);
    for (const actions of [[], ["retry"]]) expect(limitFromFailure(PROFILES.codex, failure(response("limit", actions)), "", Date.now())).toBeInstanceOf(UsageLimited);
    expect(limitFromFailure(PROFILES.codex, failure(response("limit", ["new_session"])), "", Date.now())).toBeUndefined();
    expect(limitFromFailure(PROFILES.codex, failure(response("service", ["retry"])), "", Date.now())).toBeUndefined();
    expect(failure({ stopReason: "end_turn" })).toBeUndefined();
  });
  it("shows Codex's own transport retries as reconnecting, and other retries without claiming the network", () => {
    const notice = codexInterruptions.notice!;
    expect(notice(update(codexRetry(STREAM_LOST)))).toEqual({ retrying: "network" });
    expect(notice(update(codexRetry(CONNECT_FAILED)))).toEqual({ retrying: "network" });
    expect(notice(update(codexRetry({ responseStreamConnectionFailed: { httpStatusCode: 502 } })))).toEqual({ retrying: "network" });
    // A full model Codex is still retrying by itself is only "retrying": it is not a capacity stop.
    expect(notice(update(codexRetry("serverOverloaded")))).toEqual({ retrying: "transient" });
    expect(notice(update(codexRetry("internalServerError")))).toEqual({ retrying: "transient" });
    expect(notice(update(codexRetry(null)))).toEqual({ retrying: "transient" });
    // Account, rate and sign-in retries, and terminal errors, are not shown.
    for (const info of ["usageLimitExceeded", "rateLimitExceeded", "unauthorized", "sessionBudgetExceeded", { responseStreamDisconnected: { httpStatusCode: 429 } }, { httpConnectionFailed: { httpStatusCode: 401 } }]) expect(notice(update(codexRetry(info)))).toBeUndefined();
    expect(notice(update(codexRetry(STREAM_LOST, false)))).toBeUndefined();
    expect(notice(update({ sessionUpdate: "session_info_update", title: "Greeting" }))).toBeUndefined();
    expect(notice(update({ sessionUpdate: "notice", severity: "warning", title: "Configuration warning" }))).toBeUndefined();
    expect(notice(extension(grokRetry(DNS)))).toBeUndefined();
  });

  it("tells Grok's lost connections from its other retries by the reason it reports", () => {
    const notice = grokInterruptions.notice!;
    for (const reason of [DNS, RESET, "Connection problem; retrying request", "request error: error sending request for url (https://cli-chat-proxy.grok.com/v1/responses): client error (SendRequest): http2 error: keep-alive timed out: operation timed out"]) {
      expect(notice(extension(grokRetry(reason)))).toEqual({ retrying: "network" });
    }
    expect(notice(extension(grokRetry("API error (status 520 <unknown status code>): Connection to Grok timed out or was interrupted. Please try again. (HTTP 520).", { error_type: "api" })))).toEqual({ retrying: "network" });
    // The same broad error type also covers a reply that could not be decoded: retrying, with no network claim.
    expect(notice(extension(grokRetry(GARBLED)))).toEqual({ retrying: "transient" });
    expect(notice({ kind: "extension", method: "x.ai/session/update", params: grokRetry(DNS).params })).toEqual({ retrying: "network" });
    // Its own retries ended: the turn ends through its usual result or error.
    expect(notice(extension({ method: "_x.ai/session/update", params: { update: { sessionUpdate: "retry_state", type: "exhausted", attempts: 15, reason: DNS } } }))).toEqual({ stopped: true });
    expect(notice(extension({ method: "_x.ai/session/update", params: { update: { sessionUpdate: "retry_state", type: "failed", error_type: "api", message: "API error (status 402 Payment Required): Grok Build usage balance exhausted" } } }))).toEqual({ stopped: true });
    // Rate, billing and sign-in retries are not an interruption; other routes and updates are not Grok's retry state.
    expect(notice(extension(grokRetry("API error (status 429 Too Many Requests): The service is temporarily at capacity.", { error_type: "rate_limit" })))).toBeUndefined();
    expect(notice(extension(grokRetry("Unauthorized (401)", { error_type: "auth" })))).toBeUndefined();
    expect(notice(extension({ method: "_x.ai/session/update", params: { update: { sessionUpdate: "auto_compact_started", tokens_used: 1 } } }))).toBeUndefined();
    expect(notice(extension({ method: "_auth/status_update", params: grokRetry(DNS).params }))).toBeUndefined();
    expect(notice(update(grokRetry(DNS).params.update))).toBeUndefined();
  });

  it("confirms capacity only from each tool's explicit terminal overload", () => {
    const claude = claudeInterruptions.capacity!, grok = grokInterruptions.capacity!, codex = codexInterruptions.capacity!;
    expect(claude({ code: -32603, message: "Internal error: API Error: 529 Overloaded", data: { errorKind: "overloaded" } }, "")).toEqual({});
    for (const errorKind of ["rate_limit", "billing_error", "authentication_failed", "server_error", "unknown", undefined]) {
      expect(claude({ code: -32603, message: "Internal error: API Error: 500", data: errorKind ? { errorKind } : {} }, "")).toBeUndefined();
    }
    // Words alone never establish it.
    expect(claude("Claude is temporarily overloaded.", "Claude is temporarily overloaded.")).toBeUndefined();
    expect(grok({ code: -32603, message: GROK_OVERLOADED }, "")).toEqual({});
    expect(grok({ code: -32000, message: "Rate limited", data: "The service is temporarily at capacity. Please retry your request shortly." }, "")).toBeUndefined();
    expect(grok({ code: -32603, message: "Internal error", data: { message: "The service is busy. Please try again later.", http_status: 503 } }, "")).toBeUndefined();
    expect(grok(GROK_OVERLOADED, GROK_OVERLOADED)).toBeUndefined();
    // Codex keeps its sentence and its overloaded code.
    expect(codex({ data: { codexErrorInfo: "serverOverloaded" } }, "")).toEqual({});
    expect(codex({}, "Done.\n\nSelected model is at capacity. Please try a different model.")).toEqual({});
  });

  it("keeps account, rate and billing failures on their own paths, and a full model off the account", () => {
    const now = Date.now();
    expect(limitFromFailure(PROFILES.claude, { message: "Internal error: API Error: 529", data: { errorKind: "overloaded" } }, "", now)).toBeUndefined();
    expect(limitFromFailure(PROFILES.claude, { message: "Internal error", data: { errorKind: "rate_limit" } }, "", now)?.reason).toBe("Claude Code's rate limit");
    expect(limitFromFailure(PROFILES.claude, { message: "Internal error", data: { errorKind: "billing_error" } }, "", now)?.reason).toBe("Claude Code's spend limit");
    expect(limitFromFailure(PROFILES.grok, { message: GROK_OVERLOADED }, "", now)).toBeUndefined();
    expect(limitFromFailure(PROFILES.grok, { message: "Internal error", data: { message: "API error (status 402 Payment Required): Grok Build usage balance exhausted", http_status: 402 } }, "", now)?.reason).toContain("usage balance exhausted");
    expect(limitFromFailure({ id: "argon-high", toolId: "antigravity", model: "Gemini 4 Argon", modelId: "gemini-4-argon", effort: "high" }, { message: "Internal error", data: { message: "Error 503, Message: The service is currently unavailable., Status: UNAVAILABLE" } }, "", now)).toBeUndefined();
  });
});
