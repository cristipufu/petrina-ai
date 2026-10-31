import { afterAll } from "bun:test";
import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { expect, it } from "bun:test";
import { join } from "node:path";
import type { CheckId } from "@petrina/core";
import type { ToolProbeResult } from "@petrina/orchestrator";
import { Engine } from "../../engine.js";

import { scriptedToolProbe } from "../../scripted-probes.js";
const engineCases = engineCaseFixtures();
afterAll(() => engineCases.close());


it("records explicit probe results through the real host and restart without resolving native commands", async () => {
  return engineCases.use("petrina-scripted-probes-", async caseOwner => {
  const root = caseOwner.root;
  const observations = {
    "claude-code": { status: "ready" }, codex: { status: "unknown", detail: "The fixture could not confirm the login" },
    grok: { status: "logged-out" }, antigravity: { status: "not-installed" },
    opencode: { status: "not-installed" }, pi: { status: "not-installed" },
    gh: { status: "ready", account: "fixture-account" },
    git: { status: "ready" },
  } as const satisfies Record<CheckId, ToolProbeResult>;
  const options = { toolProbe: scriptedToolProbe(observations), agentCommand: () => { throw new Error("Readiness must not open a native agent"); } };
  let engine: Engine | undefined;
  try {
    engine = caseOwner.open(join(root, "data"), options);
    const checking = engine;
    await caseOwner.run(checking, () => checking.checkTools());
    const checks = engine.getState().setup!.checks;
    expect(checks).toHaveLength(8);
    for (const check of checks) {
      expect(check).toEqual({ id: check.id, ...observations[check.id], at: expect.any(Number) });
      expect(check.checking).toBeUndefined();
    }
    expect(engine["tools"].pending()).toEqual({ checking: [], stopping: [] });
    await caseOwner.stop(engine);
    engine = caseOwner.open(join(root, "data"), options);
    expect(engine.getState().setup!.checks).toEqual(checks);
  } finally { if (engine) await caseOwner.stop(engine); }

  });
});
