import { EXTRA_PROVIDER_IDS, PROVIDER_IDS, type CheckId, type ProviderId } from "@petrina/core";
import type { ToolProbe, ToolProbeResult } from "@petrina/orchestrator";

const OPTIONAL_PROVIDERS: ReadonlySet<string> = new Set(EXTRA_PROVIDER_IDS);

function createScriptedToolProbe(
  observations: Readonly<Partial<Record<CheckId, ToolProbeResult>>>,
  strict: boolean,
): ToolProbe {
  const reading = (id: CheckId): ToolProbeResult => {
    const result = observations[id];
    if (result) return { ...result };
    if (!strict && OPTIONAL_PROVIDERS.has(id)) return { status: "not-installed" };
    throw new Error(`No scripted tool probe for ${id}`);
  };
  return {
    absent: (id) => reading(id).status === "not-installed",
    async run(id, request) {
      if (request.signal.aborted) throw new Error("The scripted tools check was stopped");
      return reading(id);
    },
  };
}

/**
 * Explicit fixture observations. Baseline checks (`claude-code`, `codex`, `gh`, `git`) must be
 * supplied explicitly so no native login or executable is ever consulted; omitted optional extra
 * providers (`EXTRA_PROVIDER_IDS`) default deterministically to `not-installed`.
 */
export function scriptedToolProbe(observations: Readonly<Partial<Record<CheckId, ToolProbeResult>>>): ToolProbe {
  return createScriptedToolProbe(observations, false);
}

/** Require an explicit observation for every check ID, including optional extra providers. */
export function strictScriptedToolProbe(observations: Readonly<Partial<Record<CheckId, ToolProbeResult>>>): ToolProbe {
  return createScriptedToolProbe(observations, true);
}

/** Calibrated private fake-agent availability; native context and readiness-routing controls retain parity. */
export function privateAgentToolProbe(ready: readonly ProviderId[] = PROVIDER_IDS): ToolProbe {
  const observations: Partial<Record<CheckId, ToolProbeResult>> = {
    gh: { status: "unknown", detail: "This test must supply a scripted GitHub command." },
    git: { status: "ready" },
  };
  for (const id of PROVIDER_IDS) observations[id] = { status: ready.includes(id) ? "ready" : "logged-out" };
  return scriptedToolProbe(observations);
}
