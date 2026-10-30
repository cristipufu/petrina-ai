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

const privateAgents = ["claude-code", "codex", "grok", "antigravity"] as const;

/** Calibrated private fake-agent availability; native context and readiness-routing controls retain parity. */
export function privateAgentToolProbe(ready: readonly (typeof privateAgents)[number][] = privateAgents): ToolProbe {
  const observations: Partial<Record<CheckId, ToolProbeResult>> = {
    gh: { status: "unknown", detail: "This test must supply a scripted GitHub command." }, git: { status: "ready" }, node: { status: "ready" },
  };
  for (const id of privateAgents) observations[id] = { status: ready.includes(id) ? "ready" : "logged-out" };
  return scriptedToolProbe(observations);
}
