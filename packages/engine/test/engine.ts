import { Engine as ProductionEngine, type EngineOptions } from "../src/engine.js";
import { ADAPTERS } from "../src/tools.js";

/** Test fixtures never probe the developer's live accounts. Usage tests opt in with their own command. */
export class Engine extends ProductionEngine {
  constructor(dataDir: string, options: EngineOptions = {}) {
    super(dataDir, {
      ...options,
      usageCommands: { ...Object.fromEntries(Object.keys(ADAPTERS).map(id => [id, null])), ...options.usageCommands },
    });
  }
}

export type { EngineOptions };
