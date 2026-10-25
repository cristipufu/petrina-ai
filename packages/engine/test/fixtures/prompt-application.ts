import { join } from "node:path";
import { cpSync } from "node:fs";
import { repositorySeed } from "@petrina/test-support/repositories";
import { executionFor } from "@petrina/orchestrator";
import { draftOf } from "@petrina/core";
import { Engine } from "../engine.js";
import { scriptedToolProbe } from "../scripted-probes.js";
import { ScriptedAgents, scriptedResult } from "../scripted-agents.js";

/** One real turn with private Git/SQLite, not a planner/review/check/delivery journey. */
export async function promptApplication(root: string, builderInstructions?: string) {
  const agents = new ScriptedAgents(({ result }) => {
    if (result !== "build") throw new Error(`Unexpected prompt-composition participant: ${result}`);
    return scriptedResult({ summary: "Read the configured checks", changes: [], answers: [], learnings: [] });
  });
  const engine = new Engine(join(root, "data"), {
    startAgentSession: agents.start,
    agentCommand: () => [process.execPath, join(import.meta.dir, "..", "unconfigured-service.ts"), "prompt composition"],
    toolProbe: scriptedToolProbe({ codex: { status: "ready" }, "claude-code": { status: "not-installed" }, grok: { status: "not-installed" }, antigravity: { status: "not-installed" }, gh: { status: "not-installed" }, git: { status: "ready" }, node: { status: "ready" } }),
  });
  engine.schedule = () => {};
  try {
    await engine.waitUntilReady();
    const seed = await repositorySeed(), path = join(root, "repository"); cpSync(seed.clone, path, { recursive: true });
    engine.s.products.push({ id: "product", name: "Product", repo: "local/product", path, tone: "blue" });
    if (builderInstructions) engine.saveRole("builder", { ...draftOf(engine.role("builder")!), instructions: builderInstructions });
    const task = engine.task(engine.addTask({ productId: "product", title: "Inspect the builder input", backlog: true }))!;
    task.repository = { productId: "product", worktree: path, baseSha: seed.head, base: seed.head, branch: "main", delivery: "local" };
    task.plan = { rationale: "Only Builder input composition", plannerProfileId: "sol-high", stages: [{ id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-high"] }] };
    task.stageIndex = 0; task.state = "running";
    engine.setPoolPaused(false);
    return { engine, agents, task, scope: executionFor(task) };
  } catch (error) { await engine.shutdown(); throw error; }
}
