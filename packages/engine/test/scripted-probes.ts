import type { CheckId } from "@petrina/core";
import type { ToolProbe, ToolProbeResult } from "@petrina/orchestrator";

/** Explicit fixture observations. Missing scripts fail; no native login or executable is consulted. */
export function scriptedToolProbe(observations: Readonly<Partial<Record<CheckId, ToolProbeResult>>>): ToolProbe {
  const reading = (id: CheckId) => {
    const result = observations[id];
    if (!result) throw new Error(`No scripted tool probe for ${id}`);
    return { ...result };
  };
  return {
    absent: id => reading(id).status === "not-installed",
    async run(id, request) {
      if (request.signal.aborted) throw new Error("The scripted tools check was stopped");
      return reading(id);
    },
  };
}
