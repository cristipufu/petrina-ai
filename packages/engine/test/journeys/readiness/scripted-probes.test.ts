import { expect, it } from "bun:test";
import { join } from "node:path";
import type { CheckId } from "@petrina/core";
import type { ToolProbeResult } from "@petrina/orchestrator";
import { Engine } from "../../engine.js";
import { removeDir, tempDir } from "../../fixtures.js";
import { scriptedToolProbe } from "../../scripted-probes.js";

it("records explicit probe results through the real host and restart without resolving native commands", async () => {
  const root = tempDir("petrina-scripted-probes-");
  const observations = {
    "claude-code": { status: "ready" }, codex: { status: "unknown", detail: "The fixture could not confirm the login" },
    grok: { status: "logged-out" }, antigravity: { status: "not-installed" }, gh: { status: "ready", account: "fixture-account" },
    git: { status: "ready" }, node: { status: "ready" },
  } as const satisfies Record<CheckId, ToolProbeResult>;
  const options = { toolProbe: scriptedToolProbe(observations), agentCommand: () => { throw new Error("Readiness must not open a native agent"); } };
  let engine: Engine | undefined;
  try {
    engine = new Engine(join(root, "data"), options);
    await engine.checkTools();
    const checks = engine.getState().setup!.checks;
    expect(checks).toHaveLength(7);
    for (const check of checks) {
      expect(check).toEqual({ id: check.id, ...observations[check.id], at: expect.any(Number) });
      expect(check.checking).toBeUndefined();
    }
    expect(engine["tools"].pending()).toEqual({ checking: [], stopping: [] });
    await engine.shutdown();
    engine = new Engine(join(root, "data"), options);
    expect(engine.getState().setup!.checks).toEqual(checks);
  } finally { await engine?.shutdown(); removeDir(root); }
});
