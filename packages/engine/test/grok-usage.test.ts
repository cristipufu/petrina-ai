import { expectRejection } from "./rejections.js";
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { modelSplit, turnTokens } from "@petrina/core";
import { Database } from "bun:sqlite";
import { AgentRun, reportOf } from "../src/acp-run.js";
import { Engine } from "./engine.js";
import { grokReports, grokTurnReport, readGrokUsage } from "../src/grok-usage.js";
import { ENGINE_PROFILES } from "../src/tools.js";
import { WorkLog } from "../src/worklog.js";
import { removeDir, tempDir, testBrowserRoot, waitFor } from "./support.js";

// Conversations started here keep their browsers, in this file's own browser folder.
const roots: string[] = [testBrowserRoot()];
const browsers = roots[0]!;
afterAll(() => roots.forEach(removeDir));
const end = "2026-10-24T14:20:55.543+00:00";
const billing = (percent = 11) => ({ config: { creditUsagePercent: percent, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end }, prepaidBalance: { val: 12345 } } });
function server(plan: unknown) {
  const dir = tempDir("petrina-grok-usage-"); roots.push(dir);
  writeFileSync(join(dir, "billing.json"), JSON.stringify(plan));
  const asked = () => existsSync(join(dir, "requests.jsonl")) ? readFileSync(join(dir, "requests.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { pid: number; method: string }) : [];
  return { dir, asked, command: [process.execPath, join(import.meta.dir, "fake-grok-usage.ts"), dir] };
}
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

  it("keeps the resolved model's tokens and agent time on the same Analytics row", () => {
    const db = new Database(":memory:");
    try {
      const log = new WorkLog(db);
      log.startTurn({ id: "resolved", taskId: "task", productId: "product", stageId: "build", stageTitle: "Build", stageKind: "do", round: 1, fixing: false, roleId: "builder", toolId: "grok", profileId: "grok-xhigh", sessionId: "session", reason: "first", startedAt: 1, modelAsked: "grok-4.7", modelRan: "grok-4.7", mainOnly: false, helpers: 0 });
      log.endTurn("resolved", { end: "finished", endedAt: 11, workMs: 10, mainOnly: false, helpers: 0, modelRan: "grok-4.7-build", tokens: { input: 100, cacheRead: 1000, output: 50, total: 1150 } }, [{ model: "grok-4.7-build", input: 100, cacheRead: 1000, output: 50, total: 1150 }]);
      const rows = modelSplit(log.turns({}), log.lines({}));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ label: "Grok 4.7", tokens: { value: 1150 }, time: { value: 10 } });
      expect(log.turns({})[0]?.modelAsked).toBe("grok-4.7");
    } finally { db.close(); }
  });

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

  it("reads the installed CLI extension without creating a session or sending a prompt, then stops", async () => {
    const fake = server(billing());
    expect(await readGrokUsage({ command: fake.command, env: process.env })).toEqual(grokReports(billing()));
    expect(fake.asked().map(r => r.method)).toEqual(["initialize", "_x.ai/billing"]);
    await waitFor(() => !alive(fake.asked()[0]!.pid), "the account reader to stop", 5000);
  });

  it("stops an unresponsive CLI, and reports refusal and missing executables without an AI turn", async () => {
    const hanging = server({ hang: true, ignoreStop: true });
    let pid: number | undefined;
    await expectRejection(readGrokUsage({ command: hanging.command, env: process.env, timeoutMs: 500, onProcess: (child) => { pid = child.pid; } }), "in time");
    expect(pid).toBeGreaterThan(0);
    await waitFor(() => !alive(pid!), "the hanging Grok reader to stop", 5000);
    const refused = server({ error: "Authentication required" });
    await expectRejection(readGrokUsage({ command: refused.command, env: process.env }), "Authentication required");
    await expectRejection(readGrokUsage({ command: [join(refused.dir, "no-such-grok")], env: process.env }), "could not start");
  });

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
      engine.shutdown();
      await waitFor(() => !alive(pid), "shutdown to stop its account reader", 5000);
      await reading;
    } finally { engine.shutdown(); }
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
