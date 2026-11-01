import { engineCaseFixtures } from "./engine-cases.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { State } from "@petrina/core";
import { executionFor } from "@petrina/orchestrator";
import { childState } from "@petrina/platform/process-tree";
import * as gitOps from "@petrina/repositories/git";
import { readConnection } from "../../src/instance.js";
import { EngineClient } from "../client.js";
import { CLI, Fakes, makeProduct, tempDir, waitFor, SLOW } from "../support.js";
import { privateAgentToolProbe } from "../scripted-probes.js";
import { coordinatorLifetimes } from "./coordinator-lifetime.js";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import type { LifecycleStore } from "@petrina/storage/lifecycle-store";

/** A seed can finish stopping after cleanup began; no replacement storage may open then. */
export async function coordinatorStoreAfterSeed(signal: AbortSignal, shutdown: () => Promise<void>, openStore: () => LifecycleStore): Promise<LifecycleStore> {
  await shutdown();
  if (signal.aborted) throw new Error("Coordinator setup closed while stopping its seed");
  return openStore();
}

/** Actual native review/restart composition, starting at the review rather than replaying unrelated agents. */
export async function lifecycleFixture(lifetimes: ReturnType<typeof coordinatorLifetimes>, options: { title?: string; limit?: number; reviewer?: "important" } = {}) {
  const root = tempDir("petrina-coordination-lifecycle-");
  const seedCases = engineCaseFixtures();
  const lifetime = await lifetimes.open(root, { stopPeers: () => seedCases.close() });
  return setupWithCleanup(() => lifetime.prepare(async () => {
    await lifetime.ready;
    if (lifetime.signal.aborted) throw new Error("Coordinator fixture closed before its seed opened");
    const home = join(root, "home"), fakes = new Fakes(join(root, "fakes"));
    const { productId, taskId } = await seedCases.use("petrina-coordination-seed-", async caseOwner => {
    const check = () => { caseOwner.check(); if (lifetime.signal.aborted) throw new Error("Coordinator seed closed before setup finished"); };
    check();
    const seed = caseOwner.open(home, { agentCommand: () => undefined, toolProbe: privateAgentToolProbe() });
    const prepared = await caseOwner.run(seed, async () => {
    seed.setPoolPaused(true);
    await seed.waitUntilReady(); check(); await Promise.all([...seed.backgroundWork]); check();
    fakes.scenario({ controlled: true, ...(options.reviewer ? { reviewer: options.reviewer } : {}) });
    const path = await makeProduct(root, { origin: "none" }); check();
    const productId = "product";
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
    const source = await seed["sources"].resolve(task, { productId, startFrom: { kind: "default" }, delivery: "local" }); check();
    scope.work.source = { ...source, confirmed: true };
    await seed["driver"]["prepare"](scope, caseOwner.signal); check();
    writeFileSync(join(scope.work.worktree!, "greeting.txt"), "Hello\n");
    await gitOps.commitChanges(scope.work.worktree!, "Prepare the completed greeting for review"); check();
    scope.work.builderSession = { stageId: "build", profileId: "sol-xhigh", toolId: "codex", model: seed.profile("sol-xhigh")!.model, sessionId: "e26dcf46-357e-44bd-b9ec-20d0d63c7391" };
    scope.work.report = { summary: "Added the greeting", title: task.title, changes: ["People see a greeting"], description: "The already completed fixture build" };
    task.brief = { summary: "A greeting file.", forUsers: ["People see a greeting"], areas: ["Greeting"], acceptance: [{ text: "A greeting file exists" }], risks: [] };
    task.startedAt = Date.now(); task.state = "waiting";
    seed.setPoolLimit(options.limit ?? 3);
    seed.s.pool.paused = false;
    seed.commitNow(task);

    return { productId, taskId };
    });
    await caseOwner.stop(seed);
    return prepared;
    });
    if (lifetime.signal.aborted) throw new Error("Coordinator setup closed before the app opened");
    const engine = await lifetime.harness(home, fakes.dir), client = new EngineClient(home);
    const release = (id: string) => writeFileSync(join(fakes.dir, `release-${id}`), "go");
    const settle = (s: State) => lifetime.prepare(async () => {
      for (const item of s.inbox)
        if (item.kind === "plan") await engine.act("approve", item.id);
        else if (item.kind === "question") await engine.act("answer", item.id, "Yes");
        else if (item.kind === "permission") await engine.act("allow", item.id, "once");
      for (const received of fakes.received()) if (received.role !== "code reviewer" && received.role !== "verifier") release(received.session);
    });
    const stop = async () => {
      await setupWithCleanup(() => lifetime.prepare(async () => {
        const activePid = readConnection(home)?.pid;
        try {
          const state = await engine.state();
          for (const entry of state.tasks) if (!["done", "cancelled", "pr-open"].includes(entry.state)) await engine.act("cancel", entry.id);
        } catch { /* The native owner may have already stopped; independent command/lease cleanup still confirms it. */ }
        await client.call("engine.stop", { requestId: "cleanup-review-lifecycle", wait: true, timeoutMs: 3000 * SLOW });
        const finalPid = readConnection(home)?.pid ?? activePid;
        if (finalPid !== undefined && finalPid !== engine.proc.pid) {
          await waitFor(async () => (await childState(finalPid)) === "ended", "the restarted engine process to exit", 10_000);
        }
      }), () => lifetime.close());
      await lifetime.close();
    };
    return { root, home, fakes, engine, client, productId, taskId, release, settle, stop, run: lifetime.prepare, openDesktop: () => lifetime.app(home, [CLI, "app"]) };
  }), () => lifetime.close());
}
