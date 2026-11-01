import { join } from "node:path";
import type { EngineCaseOwner } from "./engine-cases.js";
import { scriptedToolProbe } from "../scripted-probes.js";
import { checkAgents } from "./check-agents.js";
import { checkCommand } from "./check-command.js";

/** Actual Planner/driver/checkpoint composition before any working copy is approved or created. */
async function preparePlannerCheckpoint(owner: EngineCaseOwner) {
  const root = owner.root;
  const agents = checkAgents(); agents.scenario({ planner: "short", controlled: true });
  const checks = checkCommand(root);
  const engine = owner.open(join(root, "data"), {
    startAgentSession: agents.start,
    agentCommand: () => [process.execPath, join(import.meta.dir, "..", "unconfigured-service.ts"), "planner checkpoint"],
    toolProbe: scriptedToolProbe({ "claude-code": { status: "ready" }, codex: { status: "ready" }, gh: { status: "not-installed" }, git: { status: "ready" } }),
  });
    engine.setPoolPaused(true); await engine.waitUntilReady();
    owner.check();
    engine.s.products.push({ id: "product", name: "Product", repo: "local/checkpoint", tone: "blue", delivery: "local" });
    engine.setProductChecks("product", [{ name: "Welcome", command: checks.command("--pass") }]);
    const taskId = engine.addTask({ productId: "product", title: "Plan the greeting", description: "[no-check]", approvePlan: true });
    engine.setPoolPaused(false);
    return { engine, agents, taskId, runs: checks.runs };
}

/** The real recipe and its consumer share the registered case lifetime. */
export function plannerCheckpoint<T>(owner: EngineCaseOwner, body: (fixture: Awaited<ReturnType<typeof preparePlannerCheckpoint>>) => Promise<T>): Promise<T> {
  return owner.prepare(async () => { const fixture = await preparePlannerCheckpoint(owner); owner.check(); return body(fixture); });
}
