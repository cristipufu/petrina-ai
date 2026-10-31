import { join } from "node:path";
import { cpSync } from "node:fs";
import { repositorySeed } from "@petrina/test-support/repositories";
import { executionFor } from "@petrina/orchestrator";
import { draftOf } from "@petrina/core";
import type { EngineCaseOwner } from "./engine-cases.js";
import { scriptedToolProbe } from "../scripted-probes.js";
import { ScriptedAgents, scriptedResult } from "../scripted-agents.js";

/** One real turn with private Git/SQLite, not a planner/review/check/delivery journey. */
async function preparePromptApplication(owner: EngineCaseOwner, builderInstructions?: string) {
  const root = owner.root;
  const agents = new ScriptedAgents(({ result }) => {
    if (result !== "build") throw new Error(`Unexpected prompt-composition participant: ${result}`);
    return scriptedResult({ summary: "Read the configured checks", changes: [], answers: [], learnings: [] });
  });
  const engine = owner.open(join(root, "data"), {
    startAgentSession: agents.start,
    agentCommand: () => [process.execPath, join(import.meta.dir, "..", "unconfigured-service.ts"), "prompt composition"],
    toolProbe: scriptedToolProbe({ codex: { status: "ready" }, "claude-code": { status: "not-installed" }, grok: { status: "not-installed" }, antigravity: { status: "not-installed" }, opencode: { status: "not-installed" }, pi: { status: "not-installed" }, gh: { status: "not-installed" }, git: { status: "ready" } }),
  });
  engine.schedule = () => {};
    await engine.waitUntilReady();
    owner.check();
    const seed = await repositorySeed(), path = join(root, "repository");
    owner.check();
    cpSync(seed.clone, path, { recursive: true });
    engine.s.products.push({ id: "product", name: "Product", repo: "local/product", path, tone: "blue" });
    if (builderInstructions) engine.saveRole("builder", { ...draftOf(engine.role("builder")!), instructions: builderInstructions });
    const task = engine.task(engine.addTask({ productId: "product", title: "Inspect the builder input", backlog: true }))!;
    task.repository = { productId: "product", worktree: path, baseSha: seed.head, base: seed.head, branch: "main", delivery: "local" };
    task.plan = { rationale: "Only Builder input composition", plannerProfileId: "sol-high", stages: [{ id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-high"] }] };
    task.stageIndex = 0; task.state = "running";
    engine.setPoolPaused(false);
    return { engine, agents, task, scope: executionFor(task) };
}

export type PromptApplication = Awaited<ReturnType<typeof preparePromptApplication>>;

/** No Engine or repository escapes an unowned setup handoff. */
export function promptApplication<T>(owner: EngineCaseOwner, builderInstructions: string | undefined, body: (fixture: PromptApplication) => Promise<T>): Promise<T> {
  return owner.prepare(async () => { const fixture = await preparePromptApplication(owner, builderInstructions); owner.check(); return body(fixture); });
}
