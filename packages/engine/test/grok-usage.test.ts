import { afterAll, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { turnTokens } from "@petrina/core";
import { AgentRun, reportOf } from "@petrina/agent-runtime/acp-run";
import { Engine } from "./engine.js";
import { grokTurnReport } from "@petrina/agent-runtime/grok-report";
import { ENGINE_PROFILES } from "@petrina/agent-runtime/tools";
import { removeDir, tempDir, testBrowserRoot, waitFor } from "./fixtures.js";

import { billing } from "../../agent-runtime/test/fixtures/grok-account-report.js";
import { server as fixtureServer } from "../../agent-runtime/test/fixtures/grok-account.js";

// Conversations started here keep their browsers, in this file's own browser folder.
const roots: string[] = [testBrowserRoot()];
const browsers = roots[0]!;
afterAll(() => roots.forEach(removeDir));
function server(plan: unknown) { const value = fixtureServer(plan); roots.push(value.dir); return value; }
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("Grok whole-prompt token accounting", () => {
  it("counts all model calls once and separates cached input without counting thinking twice", () => {
    // Observed from the installed CLI: 12 model calls, not just its final response.
    const counts = { inputTokens: 663075, outputTokens: 28494, cachedReadTokens: 577024, cacheCreationTokens: 0, reasoningTokens: 26708, totalTokens: 691569 };
    const report = reportOf({ _meta: { totalTokens: 500000, inputTokens: 100, outputTokens: 5, usage: { ...counts, modelUsage: { "grok-4.7-build": counts } } } }, "grok");
    const result = turnTokens({ toolId: "grok", report });
    expect(result.tokens).toEqual({ input: 86051, cacheRead: 577024, cacheWrite: 0, output: 28494, reasoning: 26708, total: 691569 });
    expect(result.lines).toEqual([{ model: "grok-4.7-build", ...result.tokens }]);
    expect(result.mainOnly).toBe(false);
    expect(report?.model).toBe("grok-4.7-build");
  });

  it("receives Grok metadata through a real ACP prompt and preserves a zero-token turn", async () => {
    const cwd = tempDir("petrina-grok-prompt-"); roots.push(cwd);
    const run = await AgentRun.start({ profile: ENGINE_PROFILES.find(p => p.id === "grok-xhigh")!, cwd, browserTempRoot: browsers, command: [process.execPath, join(import.meta.dir, "fake-agent.ts"), "--tool=grok"], signal: new AbortController().signal, callbacks: { onActivity() {}, onPlanStep() {}, onPermission: async () => "deny" } });
    try {
      const result = await run.prompt("You are the Researcher in Petrina. Hand back notes.");
      expect(turnTokens({ toolId: "grok", report: result.report }).tokens).toMatchObject({ input: 100, cacheRead: 1000, output: 50, total: 1150 });
    } finally { await run.stop(); }
    expect(grokTurnReport({ _meta: { usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cacheCreationTokens: 0 } } })?.main?.total).toBe(0);
  });
});

describe("Grok account usage", () => {
  it("shares one cached reader across engine startup, Analytics and agent refreshes, and retains the chart history", async () => {
    const fake = server(billing(85));
    const engine = new Engine(join(fake.dir, "data"), { agentCommand: () => [], usageCommands: { grok: fake.command }, toolPath: () => "/fake/tool" });
    try {
      await waitFor(() => engine.getState().pool.usage?.some(r => r.toolId === "grok"), "Grok's startup reading");
      for (let n = 0; n < 5; n++) { engine.readUsage("grok"); engine.usage({ view: "analytics", period: "today" }); }
      await engine.usageCoordinator.readers.get("grok")!.refresh(60_000);
      expect(fake.asked().filter(r => r.method === "_x.ai/billing")).toHaveLength(1);
      expect(engine.usage({ view: "analytics", period: "today" }).limits.tools.find(t => t.toolId === "grok")?.limits[0]?.latest.utilization).toBe(0.85);
      writeFileSync(join(fake.dir, "billing.json"), JSON.stringify({ hang: true, ignoreStop: true }));
      const reading = engine.usageCoordinator.readers.get("grok")!.refresh();
      await waitFor(() => fake.asked().filter(r => r.method === "_x.ai/billing").length === 2, "a pending account read");
      const pid = fake.asked().at(-1)!.pid;
      await engine.shutdown();
      await waitFor(() => !alive(pid), "shutdown to stop its account reader", 5000);
      await reading;
    } finally { await engine.shutdown(); }
  });

  it("shows failed account refreshes to the window without changing the last confirmed percentage or its age", async () => {
    const fake = server(billing(57));
    const engine = new Engine(join(fake.dir, "data"), { agentCommand: () => [], usageCommands: { grok: fake.command }, toolPath: () => "/fake/tool" });
    try {
      await waitFor(() => engine.windowState().pool.usageReads?.grok?.state === "reported", "a confirmed account reading");
      const report = engine.windowState().pool.usage!.find((entry) => entry.toolId === "grok")!;
      writeFileSync(join(fake.dir, "billing.json"), JSON.stringify({ error: "Meter unavailable" }));
      await engine.usageCoordinator.readers.get("grok")!.refresh();
      const pool = engine.windowState().pool;
      expect(pool.usageReads?.grok?.state).toBe("unavailable");
      expect(pool.usage!.find((entry) => entry.toolId === "grok")).toEqual(report);
      expect(report.utilization).toBe(0.57);
    } finally { await engine.shutdown(); }
  });
});
