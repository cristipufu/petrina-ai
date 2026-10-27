import { expect, it } from "bun:test";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { ADAPTERS, type ToolAdapter } from "@petrina/agent-runtime/tools";
import { UsageReader } from "@petrina/agent-runtime/usage-reader";
import { tempDir } from "../../fixtures.js";
import { directDrivers, removeFixtureRoot } from "../../fixtures/direct-drivers.js";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { rejectionOf } from "@petrina/test-support/rejections";

const install = (id: string, create: NonNullable<ToolAdapter["usageReader"]>["create"]) => {
  const adapters = ADAPTERS as Record<string, ToolAdapter>;
  adapters[id] = { id, name: "Fixture", cli: "bun", command: [process.execPath], login: "open", models: ["Fixture"],
    options: { model: "model", effort: "effort", mode: "mode" }, mode: "auto", usageReader: { command: () => [process.execPath], create } };
  return () => { delete adapters[id]; };
};

it("drives a newly registered adapter's shared account reader without provider branches", async () => {
  const id = "fixture-reader-provider", path = tempDir("petrina-adapter-reader-"), owner = directDrivers(path);
  let reads = 0;
  const reading = { toolId: id, kind: "seven_day", status: "allowed" as const, utilization: 0.2 };
  const restore = install(id, options => new UsageReader({ name: "Fixture", record: options.record, changed: options.changed, log: options.log, read: async () => { reads++; return [reading]; } }));
  try {
    await setupWithCleanup(() => owner.prepare(async () => {
      const engine = owner.open(join(path, "home"), { agentCommand: () => undefined, usageCommands: { [id]: [process.execPath] }, terminals: () => [] });
      engine.setPoolPaused(true);
      const reader = engine.usageCoordinator.readers.get(id)!;
      await owner.run(engine, () => reader.refresh(60_000));
      engine.usage({ view: "analytics", period: "today" });
      await owner.run(engine, () => reader.refresh(60_000));
      expect(reads).toBe(1);
      expect(engine.windowState().pool.usageReads?.[id]?.state).toBe("reported");
      expect(engine.s.pool.usage).toContainEqual(expect.objectContaining(reading));
      await engine.shutdown();
      await reader.refresh();
      expect(reads).toBe(1);
    }), () => owner.close());
    await owner.close();
  } finally { try { await owner.close(); } finally { restore(); } }
});

for (const failure of [new Error("Registered account cleanup failed"), undefined]) it(`joins a generic reader's retained cleanup at Engine shutdown: ${String(failure)}`, async () => {
  const id = "fixture-stopping-reader", root = tempDir("petrina-stopping-reader-"), owner = directDrivers(root);
  let engine: ReturnType<typeof owner.open> | undefined, known = false;
  const restore = install(id, options => new UsageReader({ name: "Fixture", record: options.record, changed: options.changed, log() {}, read: async context => {
    // A modeled unavailable native-cleanup boundary, not an actual process claim.
    context.onGone(Promise.reject(failure)); return [];
  } }));
  try {
    engine = await owner.prepare(async () => owner.open(join(root, "home"), { agentCommand: () => undefined, usageCommands: { [id]: [process.execPath] }, terminals: () => [] }));
    await owner.run(engine, () => engine!.usageCoordinator.readers.get(id)!.refresh());
    expect(await rejectionOf(engine.shutdown())).toBe(failure);
    const closed = await rejectionOf(owner.close());
    let original = closed;
    while (original instanceof AggregateError && original.errors.length === 1) original = original.errors[0];
    expect(original).toBe(failure);
    expect(existsSync(root)).toBe(true);
    expect(() => engine!.store.database.query("SELECT 1").get()).toThrow();
    known = true;
  } finally {
    await Promise.allSettled([owner.close()]);
    // This read has no actors. Independently close the actual Store before controlled disposal.
    let safe = false;
    try { if (engine) { engine.store.close(); safe = true; } }
    finally { restore(); }
    if (known && safe) removeFixtureRoot(root);
  }
});
