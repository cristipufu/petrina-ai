import { join } from "node:path";
import { Engine } from "../engine.js";
import { scriptedToolProbe } from "../scripted-probes.js";
import { checkAgents } from "./check-agents.js";
import { checkCommand } from "./check-command.js";

/** Actual Planner/driver/checkpoint composition before any working copy is approved or created. */
export async function plannerCheckpoint(root: string) {
  const agents = checkAgents(); agents.scenario({ planner: "short", controlled: true });
  const checks = checkCommand(root);
  const engine = new Engine(join(root, "data"), {
    startAgentSession: agents.start,
    agentCommand: () => [process.execPath, join(import.meta.dir, "..", "unconfigured-service.ts"), "planner checkpoint"],
    toolProbe: scriptedToolProbe({ "claude-code": { status: "ready" }, codex: { status: "ready" }, grok: { status: "not-installed" }, antigravity: { status: "not-installed" },
      gh: { status: "not-installed" }, git: { status: "ready" }, node: { status: "ready" } }),
  });
  try {
    engine.setPoolPaused(true); await engine.waitUntilReady();
    engine.s.products.push({ id: "product", name: "Product", repo: "local/checkpoint", tone: "blue", delivery: "local" });
    engine.setProductChecks("product", [{ name: "Welcome", command: checks.command("--pass") }]);
    const taskId = engine.addTask({ productId: "product", title: "Plan the greeting", description: "[no-check]", approvePlan: true });
    engine.setPoolPaused(false);
    return { engine, agents, taskId, runs: checks.runs };
  } catch (error) { await engine.shutdown(); throw error; }
}
