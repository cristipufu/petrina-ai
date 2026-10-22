import { Engine as ProductionEngine, type EngineOptions } from "../src/engine.js";
import { ADAPTERS } from "../src/tools.js";
import { noMachineRecords } from "./fixtures.js";

/**
 * Test fixtures never probe the developer's live accounts or this Mac's power log. Usage tests opt in with their
 * own command; interruption tests supply their own sleep records.
 */
export class Engine extends ProductionEngine {
  constructor(dataDir: string, options: EngineOptions = {}) {
    super(dataDir, {
      ...options,
      usageCommands: { ...Object.fromEntries(Object.keys(ADAPTERS).map(id => [id, null])), ...options.usageCommands },
      machineRecords: options.machineRecords ?? noMachineRecords,
    });
  }
}

export type { EngineOptions };
