import { afterAll, expect, it } from "bun:test";
import { join } from "node:path";
import { Engine } from "../../engine.js";
import { ADAPTERS, type ToolAdapter } from "@petrina/agent-runtime/tools";
import { UsageReader } from "@petrina/agent-runtime/usage-reader";
import { removeDir, tempDir } from "../../fixtures.js";
const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
it("drives a newly registered adapter's shared account reader without provider branches", async () => {
  const id = "fixture-reader-provider", path = tempDir("petrina-adapter-reader-"); roots.push(path);
  let reads = 0;
  const reading = { toolId: id, kind: "seven_day", status: "allowed" as const, utilization: 0.2 };
  const adapters = ADAPTERS as Record<string, ToolAdapter>;
  adapters[id] = { id, name: "Fixture", cli: "bun", command: [process.execPath], login: "open", models: ["Fixture"],
    options: { model: "model", effort: "effort", mode: "mode" }, mode: "auto",
    usageReader: { command: () => [process.execPath], create: options => new UsageReader({ name: "Fixture", record: options.record, changed: options.changed, log: options.log, read: async () => { reads++; return [reading]; } }) },
  };
  let engine: Engine | undefined;
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
    await engine.shutdown();
    await reader.refresh();
    expect(reads).toBe(1);
  } finally { await engine?.shutdown(); delete adapters[id]; }
});
