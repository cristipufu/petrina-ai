import { join } from "node:path";
import type { Scenario } from "../fake-agent.js";
import { Engine } from "../engine.js";
import { Fakes, makeProduct, removeDir, tempDir } from "../fixtures.js";
import { executionFor } from "@petrina/orchestrator";
import type { CheckId } from "@petrina/core";
import { ENGINE_TEST_ROOT } from "./runtime-paths.js";

/** A real focused turn boundary: private Git/SQLite and native ACP, without planning or a browser. */
export async function nativeCoordinatorTask(prefix: string, title: string, scenario: Partial<Scenario>, description?: string) {
  const root = tempDir(prefix);
  let engine: Engine | undefined;
  try {
    const repo = await makeProduct(root), fakes = new Fakes(join(root, "fake"));
    fakes.scenario(scenario);
    engine = new Engine(join(root, "data"), {
      agentCommand: () => [process.execPath, join(ENGINE_TEST_ROOT, "fake-agent.ts"), fakes.dir],
      browser: false,
    });
    engine.schedule = () => {};
    await engine.waitUntilReady();
    engine.s.setup!.checks = engine.s.tools.map(tool => ({ id: tool.id as CheckId, status: "ready" }));
    engine.s.tools.forEach(tool => { tool.status = "ready"; });
    engine.s.pool.paused = false;
    engine.s.products.push({ id: "p", name: "Product", path: repo, repo: "local/product", tone: "blue" });
    const task = engine.task(engine.addTask({ productId: "p", title, description, backlog: true }))!;
    const scope = executionFor(task);
    Object.assign(scope.work, { worktree: repo, branch: "main", base: "main" });
    const owned = engine;
    return { root, repo, fakes, engine: owned, task, scope, async dispose() {
      await owned.shutdown();
      removeDir(root);
    } };
  } catch (error) {
    try { await engine?.shutdown(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "Coordinator fixture setup failed and its cleanup could not be confirmed."); }
    removeDir(root);
    throw error;
  }
}
