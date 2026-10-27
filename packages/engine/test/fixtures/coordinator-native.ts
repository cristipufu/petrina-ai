import { join } from "node:path";
import type { Scenario } from "../fake-agent.js";
import type { Engine } from "../engine.js";
import type { EngineCaseOwner } from "./engine-cases.js";
import { Fakes, makeProduct } from "../fixtures.js";
import { executionFor } from "@petrina/orchestrator";
import type { CheckId } from "@petrina/core";
import { ENGINE_TEST_ROOT } from "./runtime-paths.js";

/** A real focused turn boundary: private Git/SQLite and native ACP, without planning or a browser. */
async function prepareNativeCoordinatorTask(owner: EngineCaseOwner, title: string, scenario: Partial<Scenario>, description?: string) {
  const root = owner.root;
  let engine: Engine | undefined;

    const repo = await makeProduct(root); owner.check();
    const fakes = new Fakes(join(root, "fake"));
    fakes.scenario(scenario);
    engine = owner.open(join(root, "data"), {
      agentCommand: () => [process.execPath, join(ENGINE_TEST_ROOT, "fake-agent.ts"), fakes.dir],
      browser: false,
    });
    engine.schedule = () => {};
    await engine.waitUntilReady();
    owner.check();
    engine.s.setup!.checks = engine.s.tools.map(tool => ({ id: tool.id as CheckId, status: "ready" }));
    engine.s.tools.forEach(tool => { tool.status = "ready"; });
    engine.s.pool.paused = false;
    engine.s.products.push({ id: "p", name: "Product", path: repo, repo: "local/product", tone: "blue" });
    const task = engine.task(engine.addTask({ productId: "p", title, description, backlog: true }))!;
    const scope = executionFor(task);
    Object.assign(scope.work, { worktree: repo, branch: "main", base: "main" });
    const owned = engine;
    return { root, repo, fakes, engine: owned, task, scope, async dispose() {
      await owner.stop(owned);
    } };

}

export type NativeCoordinatorTask = Awaited<ReturnType<typeof prepareNativeCoordinatorTask>>;

/** The recipe and consumer must stay within the caller's actual Engine case. */
export function nativeCoordinatorTask<T>(owner: EngineCaseOwner, body: (fixture: NativeCoordinatorTask) => Promise<T>, title: string, scenario: Partial<Scenario>, description?: string): Promise<T> {
  return owner.prepare(async () => { const fixture = await prepareNativeCoordinatorTask(owner, title, scenario, description); owner.check(); return body(fixture); });
}
