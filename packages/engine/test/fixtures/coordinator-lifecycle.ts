import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { State } from "@petrina/core";
import { executionFor } from "@petrina/orchestrator";
import { Engine } from "../engine.js";
import { EngineClient } from "../client.js";
import { CLI, Fakes, makeProduct, tempDir, SLOW, git } from "../support.js";
import { coordinatorLifetime } from "./coordinator-lifetime.js";

/** Actual native review/restart composition, starting at the review rather than replaying unrelated agents. */
export async function lifecycleFixture(roots: string[], options: { title?: string; limit?: number; reviewer?: "important" } = {}) {
  const root = tempDir("petrina-coordination-lifecycle-");
  roots.push(root);
  const home = join(root, "home"), fakes = new Fakes(join(root, "fakes"));
  const lifetime = await coordinatorLifetime(root);
  let seed: Engine | undefined, seedClosed = false;
  try {
    seed = new Engine(home, { agentCommand: () => undefined });
    seed.setPoolPaused(true);
    await seed.waitUntilReady(); await Promise.all([...seed.backgroundWork]);
    fakes.scenario({ controlled: true, ...(options.reviewer ? { reviewer: options.reviewer } : {}) });
    const path = await makeProduct(root), productId = "product";
    seed.s.products.push({ id: productId, name: "Example", path, repo: "local/product", defaultBranch: "main", tone: "blue", delivery: "local", checks: [], checksBy: "coordinator" });
    const taskId = seed.addTask({ productId, title: options.title ?? "Review work", description: "[no-check]", approveDelivery: true, backlog: true });
    const task = seed.task(taskId)!, scope = executionFor(task);
    task.plan = { rationale: "Only admitted review and lifecycle recovery are under test", plannerProfileId: "opus-high", stages: [
      { id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
      { id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high", "sol-high"], maxRounds: 2 },
      { id: "delivery", kind: "gate", title: "Your delivery check", roleId: "coordinator", profileIds: [], gate: "delivery" },
      { id: "publish", kind: "do", title: "Publish", roleId: "release-manager", profileIds: ["opus-high"] },
    ] };
    task.stageIndex = 1;
    scope.work.source = { ...await seed["sources"].resolve(task, { productId, startFrom: { kind: "default" }, delivery: "local" }), confirmed: true };
    await seed["driver"]["prepare"](scope, new AbortController().signal);
    writeFileSync(join(scope.work.worktree!, "greeting.txt"), "Hello\n");
    await git(scope.work.worktree!, "add", ".");
    await git(scope.work.worktree!, "commit", "-qm", "Prepare the completed greeting for review");
    scope.work.builderSession = { stageId: "build", profileId: "sol-xhigh", toolId: "codex", model: seed.profile("sol-xhigh")!.model, sessionId: "e26dcf46-357e-44bd-b9ec-20d0d63c7391" };
    scope.work.report = { summary: "Added the greeting", title: task.title, changes: ["People see a greeting"], description: "The already completed fixture build" };
    task.brief = { summary: "A greeting file.", forUsers: ["People see a greeting"], areas: ["Greeting"], acceptance: [{ text: "A greeting file exists" }], risks: [] };
    task.startedAt = Date.now(); task.state = "waiting";
    seed.setPoolLimit(options.limit ?? 3);
    seed.s.pool.paused = false;
    seed.commitNow(task);
    await seed.shutdown(); seedClosed = true;
    const engine = await lifetime.harness(home, fakes.dir), client = new EngineClient(home);
    const release = (id: string) => writeFileSync(join(fakes.dir, `release-${id}`), "go");
    const settle = async (s: State) => {
      for (const item of s.inbox)
        if (item.kind === "plan") await engine.act("approve", item.id);
        else if (item.kind === "question") await engine.act("answer", item.id, "Yes");
        else if (item.kind === "permission") await engine.act("allow", item.id, "once");
      for (const received of fakes.received()) if (received.role !== "code reviewer" && received.role !== "verifier") release(received.session);
    };
    const stop = async () => {
      try {
        try {
          const state = await engine.state();
          for (const entry of state.tasks) if (!["done", "cancelled", "pr-open"].includes(entry.state)) await engine.act("cancel", entry.id);
        } catch { /* The native owner may have already stopped; independent command/lease cleanup still confirms it. */ }
        await client.call("engine.stop", { requestId: "cleanup-review-lifecycle", wait: true, timeoutMs: 3000 * SLOW });
      } finally {
        try { await lifetime.close(); }
        catch (error) { const at = roots.indexOf(root); if (at >= 0) roots.splice(at, 1); throw error; }
      }
    };
    return { root, home, fakes, engine, client, productId, taskId, release, settle, stop, openDesktop: () => lifetime.app(home, [CLI, "app"]) };
  } catch (error) {
    const errors = [error];
    if (!seedClosed) try { await seed?.shutdown(); } catch (cleanup) { errors.push(cleanup); }
    try { await lifetime.close(); } catch (cleanup) { errors.push(cleanup); }
    if (errors.length > 1) { const at = roots.indexOf(root); if (at >= 0) roots.splice(at, 1); throw new AggregateError(errors, "Lifecycle setup failed and cleanup was not confirmed"); }
    throw error;
  }
}
