import { afterAll, expect, it } from "bun:test";
import { join } from "node:path";
import { CHECK_IDS, EXTRA_PROVIDER_IDS, type CheckId } from "@petrina/core";
import type { ToolProbeResult } from "@petrina/orchestrator";
import { Engine } from "../../engine.js";
import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { strictScriptedToolProbe } from "../../scripted-probes.js";

const engineCases = engineCaseFixtures();
afterAll(() => engineCases.close());

it("records explicit probe results through the real host and restart without resolving native commands", async () => {
  return engineCases.use("petrina-scripted-probes-", async (caseOwner) => {
    const root = caseOwner.root;
    const extraDefaults = Object.fromEntries(
      EXTRA_PROVIDER_IDS.map((id) => [id, id === "grok" ? ({ status: "logged-out" } as const) : ({ status: "not-installed" } as const)]),
    );
    const observations = {
      "claude-code": { status: "ready" },
      codex: { status: "unknown", detail: "The fixture could not confirm the login" },
      ...extraDefaults,
      gh: { status: "ready", account: "fixture-account" },
      git: { status: "ready" },
    } as Record<CheckId, ToolProbeResult>;
    const options = {
      toolProbe: strictScriptedToolProbe(observations),
      agentCommand: () => {
        throw new Error("Readiness must not open a native agent");
      },
    };
    let engine: Engine | undefined;
    try {
      engine = caseOwner.open(join(root, "data"), options);
      const checking = engine;
      await caseOwner.run(checking, () => checking.checkTools());
      const checks = engine.getState().setup!.checks;
      expect(checks).toHaveLength(CHECK_IDS.length);
      for (const check of checks) {
        expect(check).toEqual({ id: check.id, ...observations[check.id], at: expect.any(Number) });
        expect(check.checking).toBeUndefined();
      }
      expect(engine["tools"].pending()).toEqual({ checking: [], stopping: [] });
      await caseOwner.stop(engine);
      engine = caseOwner.open(join(root, "data"), options);
      expect(engine.getState().setup!.checks).toEqual(checks);
    } finally {
      if (engine) await caseOwner.stop(engine);
    }
  });
});
