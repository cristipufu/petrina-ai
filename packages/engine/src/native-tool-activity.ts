import { ADAPTERS } from "./tools.js";
import { createToolActivity } from "./tool-activity.js";

/** Native composition retains the shared provider registry; formatting itself consumes only observations. */
export const { browserTarget, kindOf, fileOf, describeTool, isPlumbing, commandOf } = createToolActivity(meta => {
  for (const adapter of Object.values(ADAPTERS)) {
    const metadata = adapter.toolMetadata?.(meta);
    if (metadata) return metadata;
  }
});
export type { ToolActivity } from "./tool-activity.js";
