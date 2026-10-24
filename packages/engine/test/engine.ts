import { Engine as ProductionEngine, type EngineOptions } from "../src/engine.js";
import { ADAPTERS } from "../src/tools.js";
import { noMachineRecords } from "./fixtures.js";
import { join } from "node:path";
import { writeFixtureJson } from "./fixture-json.js";

/** Child fixtures reconstruct their runtime effects; JSON must never turn them into empty adapters. */
export function writeFixtureEngineOptions(path: string, options: EngineOptions): void {
  if (options.files !== undefined) throw new TypeError("File effects are process-local. Configure them inside the child fixture instead of serializing them.");
  if (options.startAgentSession !== undefined) throw new TypeError("Agent sessions are process-local. Configure them inside the child fixture instead of serializing them.");
  writeFixtureJson(path, options);
}

/** One boundary policy for in-process engines and the app-mode harness. Explicit stand-ins override it. */
export function fixtureEngineOptions(dataDir: string, options: EngineOptions = {}): EngineOptions {
  const missing = (service: string) => [process.execPath, join(import.meta.dir, "unconfigured-service.ts"), service];
  return {
    home: join(dataDir, "home"),
    terminals: () => [],
    awakeObserver: () => {},
    // Native Git and Node are prerequisites. All account-bearing services need explicit stand-ins.
    which: name => ["git", "node"].includes(name) ? Bun.which(name, { PATH: process.env.PATH ?? "" }) : null,
    gh: missing("GitHub"),
    containerTool: missing("container"),
    browser: false,
    ...options,
    requireAgentCommand: true,
    usageCommands: { ...Object.fromEntries(Object.keys(ADAPTERS).map(id => [id, null])), ...options.usageCommands },
    machineRecords: options.machineRecords ?? noMachineRecords,
  };
}

/**
 * Test fixtures never probe the developer's live accounts or this Mac's power log. Usage tests opt in with their
 * own command; interruption tests supply their own sleep records.
 */
export class Engine extends ProductionEngine {
  constructor(dataDir: string, options: EngineOptions = {}) {
    super(dataDir, fixtureEngineOptions(dataDir, options));
  }
}

export type { EngineOptions };
