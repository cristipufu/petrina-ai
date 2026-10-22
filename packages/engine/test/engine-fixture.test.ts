import { expect, it, spyOn } from "bun:test";
import { Engine } from "./engine.js";
import { ADAPTERS } from "../src/tools.js";
import { removeDir, tempDir } from "./support.js";

it("never creates a native usage reader by default, but lets a test explicitly supply its own", async () => {
  const path = tempDir("petrina-usage-fixture-");
  const adapters = Object.values(ADAPTERS).filter(adapter => adapter.usageReader);
  const calls: string[] = [];
  const overrides = adapters.map(adapter => spyOn(adapter.usageReader!, "create").mockImplementation(() => {
    calls.push(adapter.id);
    return { refresh: async () => {}, stop() {}, snapshot() {} } as ReturnType<NonNullable<typeof adapter.usageReader>["create"]>;
  }));
  let engine: Engine | undefined;
  try {
    engine = new Engine(path, { toolPath: () => "/controlled/installed", awakeObserver: () => {}, terminals: () => [] });
    await engine.waitUntilReady();
    expect(calls).toEqual([]);
    expect(engine.usageCoordinator.readers.size).toBe(0);
    await engine.shutdown();
    const selected = adapters[0]!;
    engine = new Engine(path, { usageCommands: { [selected.id]: ["fixture-owned-cli"] }, awakeObserver: () => {}, terminals: () => [] });
    await engine.waitUntilReady();
    expect(calls).toEqual([selected.id]);
    expect([...engine.usageCoordinator.readers.keys()]).toEqual([selected.id]);
  } finally {
    await engine?.shutdown();
    overrides.forEach(override => override.mockRestore());
    removeDir(path);
  }
});
