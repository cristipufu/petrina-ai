import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentProfile } from "@petrina/core";
import { AgentRun } from "../../../src/acp-run.js";
import type { NativeRetryReport } from "@petrina/orchestrator";
import { GROK_OVERLOADED } from "../../../src/provider-interruptions.js";
import { ModelAtCapacity, UsageLimited } from "../../../src/failures.js";
import { rejectionOf } from "@petrina/test-support/rejections";
import { removeDir, tempDir, waitFor } from "@petrina/test-support/fixtures";
import { writeFixtureJson } from "@petrina/test-support/fixture-json";
import type { NativeStep, NativePrompt } from "../../fixtures/protocol-actions.js";
interface PeerScenario { reopen?: "load" | "resume"; prompt?: NativePrompt }
const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
const claudeOverload: NativeStep = { fail: { code: -32603, message: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', data: { errorKind: "overloaded" } } };
import { PROFILES, codexRetry, STREAM_LOST, CONNECT_FAILED, grokRetry, DNS, RESET, GARBLED, air } from "../../fixtures/provider-envelopes.js";

/** One conversation on the fake connector, as `profile`'s tool. Steps are released by files, never by waiting. */
async function conversation(profile: AgentProfile, scenario: PeerScenario = {}, reopen?: string, dir = tempDir("petrina-interruptions-")) {
  if (!roots.includes(dir)) roots.push(dir);
  writeFixtureJson(join(dir, ".native-peer.json"), { ...scenario, recordInitialize: true });
  const reports: (NativeRetryReport | undefined)[] = [];
  const steps: string[] = [];
  const run = await AgentRun.start({
    profile, cwd: dir, browser: false, command: [process.execPath, join(import.meta.dir, "../../fixtures/session-agent.ts"), dir, "--record-initialize"], env: {}, signal: new AbortController().signal,
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
  const stop = async (profile: AgentProfile, scenario: NativePrompt) => {
    const { run } = await conversation(profile, { prompt: scenario });
    try {
      const error = await run.prompt("Add a greeting").catch((failure: unknown) => failure);
      return { error, sessionId: run.sessionId };
    } finally { await run.stop(); }
  };

  it("recognizes Claude's explicit overload and keeps what it had said", async () => {
    const { error, sessionId } = await stop(PROFILES.claude, { steps: [said("I drafted the greeting before the model filled up."), claudeOverload] });
    expect(error).toBeInstanceOf(ModelAtCapacity);
    expect(error).toMatchObject({ toolId: "claude-code", modelId: "opus", profileId: "opus-high", sessionId, said: "I drafted the greeting before the model filled up." });
    expect((error as ModelAtCapacity).retryAfterMs).toBeUndefined();
  });

  it("recognizes Grok's overload sentence", async () => {
    const { error, sessionId } = await stop(PROFILES.grok, { steps: [{ fail: { code: -32603, message: GROK_OVERLOADED } }] });
    expect(error).toBeInstanceOf(ModelAtCapacity);
    expect(error).toMatchObject({ toolId: "grok", modelId: "grok-4.7", profileId: "grok-high", sessionId });
  });

  it("leaves a busy service, a server error and an account limit reported in the same turn on their usual paths", async () => {
    const busy = await stop(PROFILES.grok, { steps: [{ fail: { code: -32603, message: "Internal error", data: { message: "The service is busy. Please try again later.", http_status: 503 } } }] });
    expect(busy.error).not.toBeInstanceOf(ModelAtCapacity);
    expect(busy.error).not.toBeInstanceOf(UsageLimited);
    const server = await stop(PROFILES.claude, { steps: [{ fail: { code: -32603, message: "API Error: 500 Internal server error", data: { errorKind: "server_error" } } }] });
    expect(server.error).not.toBeInstanceOf(ModelAtCapacity);
    expect(server.error).not.toBeInstanceOf(UsageLimited);
    // Claude said the account is out during this turn: that limit keeps its own handling.
    const limited = await stop(PROFILES.claude, { steps: [asUpdate({ sessionUpdate: "usage_update", used: 100, size: 1000, _meta: { "_claude/rateLimit": { status: "rejected", rateLimitType: "five_hour", resetsAt: Math.round(Date.now() / 1000) + 3600 } } }), claudeOverload] });
    expect(limited.error).toBeInstanceOf(UsageLimited);
  });
});
