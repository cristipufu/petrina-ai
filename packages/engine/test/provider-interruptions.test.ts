import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentProfile } from "@petrina/core";
import { AgentRun } from "@petrina/agent-runtime/acp-run";
import type { NativeRetryReport } from "@petrina/orchestrator";
import { claudeInterruptions, codexInterruptions, GROK_OVERLOADED, grokInterruptions, type SessionNotice } from "@petrina/agent-runtime/provider-interruptions";
import { ADAPTERS } from "@petrina/agent-runtime/tools";
import { limitFromFailure, ModelAtCapacity, UsageLimited } from "@petrina/agent-runtime/usage";
import type { NativeStep, Scenario } from "./fake-agent.js";
import { rejectionOf } from "@petrina/test-support/rejections";
import { isAuthRequired } from "@petrina/agent-runtime/probe";
import { Fakes, removeDir, tempDir, waitFor } from "./fixtures.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

const PROFILES = {
  codex: { id: "sol-high", toolId: "codex", model: "sol", modelId: "gpt-6.1-sol", effort: "high" },
  grok: { id: "grok-high", toolId: "grok", model: "Grok 4.7", modelId: "grok-4.7", effort: "high" },
  claude: { id: "opus-high", toolId: "claude-code", model: "Opus 5.5", modelId: "opus", effort: "high" },
} as const satisfies Record<string, AgentProfile>;

// Representative envelopes, as each installed connector sends them in the mode Petrina uses.

/** codex-acp 2.2.2 without typed session failures: Codex's own retry rides a session info update. */
const codexRetry = (codexErrorInfo: unknown, willRetry = true) => ({
  sessionUpdate: "session_info_update",
  _meta: { codex: { error: { message: "Reconnecting... 2/5 (stream disconnected before completion: error sending request)", codexErrorInfo, additionalDetails: null, turnId: "turn-1", willRetry } } },
});
const STREAM_LOST = { responseStreamDisconnected: { httpStatusCode: null } };
const CONNECT_FAILED = { httpConnectionFailed: { httpStatusCode: null } };

/** Grok 1.0.62's own route, with the fields as its recorded conversations carry them. */
const grokRetry = (reason: string, extra: Record<string, unknown> = {}) => ({
  method: "_x.ai/session/update",
  params: { update: { sessionUpdate: "retry_state", type: "retrying", attempt: 1, max_retries: 15, reason, error_type: "http", ...extra } },
});
const DNS = "request error: error sending request for url (https://cli-chat-proxy.grok.com/v1/responses): client error (Connect): dns error: failed to lookup address information: nodename nor servname provided, or not known";
const RESET = "request error: error sending request for url (https://cli-chat-proxy.grok.com/v1/responses): client error (SendRequest): connection error: connection reset";
const GARBLED = "reqwest error stream: Transport error: error decoding response body";

const update = (value: unknown): SessionNotice => ({ kind: "update", sessionId: "s", update: value });
const extension = (value: { method: string; params: unknown }): SessionNotice => ({ kind: "extension", ...value });
const air = (category: string, severity: "warning" | "error", title: string, actions: string[] = ["retry", "new_session"]) => ({ jetbrains: { air: { version: 1, sessionFailure: { id: "turn:error", revision: 1, category, severity, title, actions } } } });

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
    expect(ADAPTERS.antigravity!.interruptions).toBeUndefined();
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

/** One conversation on the fake connector, as `profile`'s tool. Steps are released by files, never by waiting. */
async function conversation(profile: AgentProfile, scenario: Scenario = {}, reopen?: string, dir = tempDir("petrina-interruptions-")) {
  if (!roots.includes(dir)) roots.push(dir);
  new Fakes(dir).scenario(scenario);
  const reports: (NativeRetryReport | undefined)[] = [];
  const steps: string[] = [];
  const run = await AgentRun.start({
    profile, cwd: dir, browser: false, command: [process.execPath, join(import.meta.dir, "fake-agent.ts"), dir, "--record-initialize"], env: {}, signal: new AbortController().signal,
    ...(reopen ? { reopen } : {}),
    callbacks: { onActivity() {}, onPlanStep: (line) => steps.push(line), onPermission: async () => "deny" as const, onRetrying: (report) => reports.push(report) },
  });
  const release = (name: string) => writeFileSync(join(dir, name), "");
  /** Notices are handled in order: once this plan line arrives, everything sent before it has been read. */
  const reached = (line: string) => waitFor(() => steps.includes(line), `the plan line "${line}"`);
  return { dir, run, reports, steps, release, reached };
}

const script = (steps: NativeStep[], reply = "Done.", late?: NativeStep[]) => `NATIVE-STEPS ${JSON.stringify({ steps, reply, ...(late ? { late } : {}) })}`;
const checkpoint = (line: string): NativeStep => ({ update: { sessionUpdate: "plan", entries: [{ content: line, status: "in_progress", priority: "medium" }] } });
const said = (text: string): NativeStep => ({ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
const asUpdate = (value: unknown): NativeStep => ({ update: value as never });
const asNotice = (value: { method: string; params: Record<string, unknown> }): NativeStep => ({ notice: value });

describe.concurrent("a native retry during a turn", () => {
  it("requests typed failures and rejects an exhausted transport once, preserving streamed prose and later recovery", async () => {
    const { run, dir, reports } = await conversation(PROFILES.codex);
    try {
      const initialize = JSON.parse(readFileSync(join(dir, "initialize.jsonl"), "utf8").trim());
      expect(initialize.clientCapabilities._meta.jetbrains.air.capabilities).toContain("sessionFailure");
      const error = await rejectionOf(run.prompt(`NATIVE-STEPS ${JSON.stringify({ steps: [asUpdate({ sessionUpdate: "session_info_update", _meta: air("connection", "warning", "Reconnecting") }), said("The draft is saved.")], reply: "I could not finish reconnecting.", meta: air("connection", "error", "stream disconnected before completion") })}`));
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("stream disconnected before completion");
      expect(error).not.toBeInstanceOf(UsageLimited);
      expect(error).not.toBeInstanceOf(ModelAtCapacity);
      expect(reports[0]?.cause).toBe("network");
      const recovered = await run.prompt(`NATIVE-STEPS ${JSON.stringify({ steps: [asUpdate({ sessionUpdate: "session_info_update", _meta: air("connection", "warning", "Reconnecting") })], reply: "Recovered normally. A previous turn said 'stream disconnected before completion'.", meta: air("connection", "warning", "Reconnecting") })}`);
      expect(recovered.text).toContain("Recovered normally.");
    } finally { await run.stop(); }
  });
  it("reports Codex reconnecting once, keeps it through repeats and earlier calls' updates, and ends it on fresh output", async () => {
    const { run, reports, release, reached } = await conversation(PROFILES.codex);
    try {
      const turn = run.prompt(script([
        asUpdate({ sessionUpdate: "tool_call", toolCallId: "read-1", title: "Read", kind: "read", status: "in_progress" }),
        asUpdate(codexRetry(STREAM_LOST)), asUpdate(codexRetry(STREAM_LOST)), asUpdate(codexRetry(CONNECT_FAILED)),
        checkpoint("retrying"),
        { wait: "go-stale" },
        // An update to an earlier call, an account report and a to-do line are not the model working again.
        asUpdate({ sessionUpdate: "tool_call_update", toolCallId: "read-1", status: "completed" }),
        asUpdate({ sessionUpdate: "usage_update", used: 10, size: 100 }),
        checkpoint("stale"),
        { wait: "go-resume" },
        said("Back to the greeting."),
        checkpoint("resumed"),
      ], "Back to the greeting. Done."));
      await reached("retrying");
      expect(reports).toEqual([{ toolId: "codex", profileId: "sol-high", sessionId: run.sessionId, cause: "network" }]);
      release("go-stale");
      await reached("stale");
      expect(reports).toHaveLength(1);
      release("go-resume");
      await reached("resumed");
      expect(reports).toEqual([{ toolId: "codex", profileId: "sol-high", sessionId: run.sessionId, cause: "network" }, undefined]);
      const result = await turn;
      expect(result.stopReason).toBe("end_turn");
      expect(reports).toHaveLength(2);
    } finally { await run.stop(); }
  });

  it("reads Grok's own route, changes only when the cause changes, and stops when Grok's retries end", async () => {
    const { run, reports, reached } = await conversation(PROFILES.grok);
    try {
      await run.prompt(script([
        // Another conversation's notice is not this participant's.
        asNotice({ ...grokRetry(DNS), params: { ...grokRetry(DNS).params, sessionId: "another-session" } }),
        asNotice(grokRetry("API error (status 429 Too Many Requests): slow down", { error_type: "rate_limit" })),
        checkpoint("ignored"),
        asNotice(grokRetry(DNS)), asNotice(grokRetry(DNS, { attempt: 2 })),
        asNotice(grokRetry(GARBLED)),
        asNotice(grokRetry(RESET)),
        asNotice({ method: "_x.ai/session/update", params: { update: { sessionUpdate: "retry_state", type: "exhausted", attempts: 15, reason: RESET } } }),
        checkpoint("ended"),
      ]));
      await reached("ended");
      expect(reports.map((report) => report?.cause)).toEqual(["network", "transient", "network", undefined]);
      expect(reports[0]).toEqual({ toolId: "grok", profileId: "grok-high", sessionId: run.sessionId, cause: "network" });
    } finally { await run.stop(); }
  });

  it("is never a capacity stop: a warning before a failure or a finished turn leaves the ending to decide", async () => {
    const codex = await conversation(PROFILES.codex);
    try {
      const failed = await codex.run.prompt(script([
        asUpdate(codexRetry("serverOverloaded")),
        { fail: { code: -32603, message: "Internal error", data: { message: "stream disconnected before completion: error sending request" } } },
      ])).catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(Error);
      expect(failed).not.toBeInstanceOf(ModelAtCapacity);
      expect(failed).not.toBeInstanceOf(UsageLimited);
      expect((failed as Error).message).toContain("stream disconnected");
      // The turn ended, so the retry is over.
      expect(codex.reports.map((report) => report?.cause)).toEqual(["transient", undefined]);
      const finished = await codex.run.prompt(script([asUpdate(codexRetry("serverOverloaded")), checkpoint("warned")], "The greeting is finished."));
      expect(finished.text).toBe("The greeting is finished.");
      expect(codex.reports.map((report) => report?.cause)).toEqual(["transient", undefined, "transient", undefined]);
    } finally { await codex.run.stop(); }
  });

  it("ignores Grok's replayed notices while a conversation reopens, and notices that arrive after the turn", async () => {
    const first = await conversation(PROFILES.grok, { reopen: "load" });
    let reopened: AgentRun | undefined;
    try {
      // One notice right behind the turn's answer, possibly read before the turn has wound down, and one well after it.
      await first.run.prompt(script([asNotice(grokRetry(DNS)), said("Still here.")], "Done.", [asNotice(grokRetry(DNS)), checkpoint("right after"), { wait: "go-late" }, asNotice(grokRetry(DNS)), checkpoint("late")]));
      await first.reached("right after");
      expect(first.reports.map((report) => report?.cause)).toEqual(["network", undefined]);
      first.release("go-late");
      await first.reached("late");
      expect(first.reports).toHaveLength(2);
      const session = first.run.sessionId;
      await first.run.stop();
      const again = await conversation(PROFILES.grok, { reopen: "load" }, session, first.dir);
      reopened = again.run;
      expect(again.run.reopened).toBe("load");
      await again.run.prompt(script([checkpoint("after reopening")]));
      await again.reached("after reopening");
      expect(again.reports).toEqual([]);
    } finally { await first.run.stop(); await reopened?.stop(); }
  });
});

describe.concurrent("a terminal capacity stop in each tool's own shape", () => {
  const stop = async (profile: AgentProfile, scenario: Scenario) => {
    const { run } = await conversation(profile, scenario);
    try {
      const error = await run.prompt("Add a greeting").catch((failure: unknown) => failure);
      return { error, sessionId: run.sessionId };
    } finally { await run.stop(); }
  };

  it("recognizes Claude's explicit overload and keeps what it had said", async () => {
    const { error, sessionId } = await stop(PROFILES.claude, { capacity: [{ model: "opus", shape: "claude", partial: true }] });
    expect(error).toBeInstanceOf(ModelAtCapacity);
    expect(error).toMatchObject({ toolId: "claude-code", modelId: "opus", profileId: "opus-high", sessionId, said: "I drafted the greeting before the model filled up." });
    expect((error as ModelAtCapacity).retryAfterMs).toBeUndefined();
  });

  it("recognizes Grok's overload sentence", async () => {
    const { error, sessionId } = await stop(PROFILES.grok, { capacity: [{ model: "grok-4.7", shape: "grok" }] });
    expect(error).toBeInstanceOf(ModelAtCapacity);
    expect(error).toMatchObject({ toolId: "grok", modelId: "grok-4.7", profileId: "grok-high", sessionId });
  });

  it("leaves a busy service, a server error and an account limit reported in the same turn on their usual paths", async () => {
    const busy = await stop(PROFILES.grok, { capacity: [{ model: "grok-4.7", shape: "grok-busy" }] });
    expect(busy.error).not.toBeInstanceOf(ModelAtCapacity);
    expect(busy.error).not.toBeInstanceOf(UsageLimited);
    const server = await stop(PROFILES.claude, { capacity: [{ model: "opus", shape: "claude-server" }] });
    expect(server.error).not.toBeInstanceOf(ModelAtCapacity);
    expect(server.error).not.toBeInstanceOf(UsageLimited);
    // Claude said the account is out during this turn: that limit keeps its own handling.
    const limited = await stop(PROFILES.claude, { capacity: [{ model: "opus", shape: "claude" }], usage: [{ model: "opus", status: "rejected", type: "five_hour", resetsAt: Math.round(Date.now() / 1000) + 3600 }] });
    expect(limited.error).toBeInstanceOf(UsageLimited);
  });
});
