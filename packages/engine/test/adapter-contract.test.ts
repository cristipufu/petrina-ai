import { afterAll, expect, it } from "bun:test";
import { join } from "node:path";
import { AgentRun, reportOf } from "../src/acp-run.js";
import { ADAPTERS, type ToolAdapter } from "../src/tools.js";
import { Engine } from "./engine.js";
import { UsageReader } from "../src/usage-reader.js";
import { limitFromFailure } from "../src/usage.js";
import { Fakes, removeDir, tempDir } from "./support.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

it("drives a newly registered adapter's sessions, reports and shared account reader without provider branches", async () => {
  const id = "fixture-provider", path = tempDir("petrina-adapter-contract-"); roots.push(path);
  const fakes = new Fakes(path); fakes.scenario({ reopen: "resume" });
  const profile = { id: "fixture-high", toolId: id, model: "Fixture", modelId: "opus", effort: "high" as const };
  let environments = 0, metas = 0, verified = 0, reads = 0;
  const reading = { toolId: id, kind: "seven_day", status: "allowed" as const, utilization: 0.2 };
  const adapters = ADAPTERS as Record<string, ToolAdapter>;
  adapters[id] = {
    id, name: "Fixture", cli: "bun", command: [process.execPath], login: "open", models: ["Fixture"],
    options: { model: "model", effort: "effort", mode: "mode" }, mode: "auto",
    prepareEnv: env => { expect(env).not.toBe(process.env); environments++; },
    prepareSessionMeta: async (meta, { cwd, browser }) => { expect(cwd).toBe(path); expect(browser).toBe(false); metas++; return meta; },
    verifySessionSettings: (_profile, settings) => { expect(settings).toMatchObject({ model: "opus", effort: "high" }); verified++; },
    parseTurnReport: () => ({ main: { total: 42 } }),
    parseLimitError: data => data.fixtureOut ? { kind: "rate" } : undefined,
    usageReader: { command: () => [process.execPath], create: options => new UsageReader({
      name: "Fixture", record: options.record, changed: options.changed, log: options.log,
      read: async () => { reads++; return [reading]; },
    }) },
  };
  let engine: Engine | undefined, run: AgentRun | undefined;
  try {
    engine = new Engine(join(path, "home"), { agentCommand: () => undefined, usageCommands: { [id]: [process.execPath] }, terminals: () => [] });
    engine.setPoolPaused(true);
    const reader = engine.usageCoordinator.readers.get(id)!;
    await reader.refresh(60_000);
    engine.usage({ view: "analytics", period: "today" });
    await reader.refresh(60_000);
    expect(reads).toBe(1);
    expect(engine.windowState().pool.usageReads?.[id]?.state).toBe("reported");
    expect(engine.s.pool.usage).toContainEqual(expect.objectContaining(reading));
    const options = { profile, cwd: path, browser: false, command: [process.execPath, join(import.meta.dir, "fake-agent.ts"), path], env: {}, signal: new AbortController().signal,
      callbacks: { onActivity() {}, onPlanStep() {}, onPermission: async () => "deny" as const } };
    run = await AgentRun.start(options);
    const session = run.sessionId; await run.stop();
    run = await AgentRun.start({ ...options, reopen: session });
    expect(run.reopened).toBe("resume");
    expect([environments, metas, verified]).toEqual([2, 2, 2]);
    expect(reportOf({}, id)).toEqual({ main: { total: 42 } });
    expect(limitFromFailure(profile, { data: { fixtureOut: true } }, "", Date.now())?.reason).toBe("Fixture's rate limit");
    await engine.shutdown();
    await reader.refresh();
    expect(reads).toBe(1);
  } finally { await run?.stop(); await engine?.shutdown(); delete adapters[id]; }
});
