import { expect, it } from "bun:test";
import { turnTokens } from "@petrina/core";
import { AgentRun } from "../../../src/acp-run.js";
import { ENGINE_PROFILES } from "../../../src/tools.js";
import { removeDir, tempDir } from "@petrina/test-support/fixtures";
import { nativeSession } from "../../fixtures/native-session.js";
it("receives Grok metadata through a real ACP prompt", async () => {
  const cwd = tempDir("petrina-grok-prompt-");
  const counts = { inputTokens: 1100, outputTokens: 50, cachedReadTokens: 1000, cacheCreationTokens: 0, reasoningTokens: 20, totalTokens: 1150 };
  const peer = nativeSession(cwd, { prompt: { steps: [], reply: "The protocol response is complete.", meta: { totalTokens: 50000, inputTokens: 100, outputTokens: 5, usage: { ...counts, modelUsage: { "grok-4.7-build": counts } } } } });
  let run: AgentRun | undefined;
  try {
    run = await AgentRun.start({ profile: ENGINE_PROFILES.find(p => p.id === "grok-xhigh")!, cwd, browser: false, command: peer.command, signal: new AbortController().signal, callbacks: { onActivity() {}, onPlanStep() {}, onPermission: async () => "deny" } });
    const result = await run.prompt("Native Grok accounting response");
    expect(turnTokens({ toolId: "grok", report: result.report }).tokens).toMatchObject({ input: 100, cacheRead: 1000, output: 50, total: 1150 });
  } finally { await run?.stop(); removeDir(cwd); }
});
