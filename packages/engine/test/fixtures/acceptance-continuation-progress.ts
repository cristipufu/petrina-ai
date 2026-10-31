import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizePlan, type DeepMutable } from "@petrina/core";
import { executionFor, repositoryView } from "@petrina/orchestrator";
import * as gitOps from "@petrina/repositories/git";
import { Engine } from "../engine.js";
import { createProductRepository } from "../fixtures.js";
import { scriptedToolProbe } from "../scripted-probes.js";
import type { EngineProcesses } from "./engine-processes.js";
import { installPreparedProduct } from "./prepared-product.js";

/** One seed Engine, owned before setup. The target reviewer/voter, clock and durable timing remain native. */
export function acceptanceProgressSeed(root: string) {
  let seed: Engine | undefined;
  return {
    async stop() { await seed?.shutdown(); },
    prepare(owners: EngineProcesses, home: string, role: "code-reviewer" | "security-reviewer") {
      return owners.prepare(async () => {
        const admitted = () => { if (owners.signal.aborted) throw new Error("Progress fixture setup was stopped before handoff"); };
        admitted();
        const { path: repo, initialSha: base } = await createProductRepository(root, { origin: "none" }); admitted();
        seed = new Engine(home, { admissionsClosed: true, agentCommand: () => undefined, terminals: () => [],
          toolProbe: scriptedToolProbe({ git: { status: "ready" }, gh: { status: "unknown" },
            "claude-code": { status: "ready" }, codex: { status: "ready" }, grok: { status: "ready" }, antigravity: { status: "ready" }, opencode: { status: "not-installed" }, pi: { status: "not-installed" } }),
        });
        seed.schedule = () => {}; seed.setPoolPaused(true);
        await seed.waitUntilReady(); admitted();
        const productId = installPreparedProduct(seed, { id: "clone", name: "Clone", repo: "local/clone", tone: "blue", path: repo,
          defaultBranch: "main", delivery: "local", approveDelivery: true });
        const product = seed.s.products.find(product => product.id === productId)!;
        product.checks = []; product.checksBy = "coordinator";
        const taskId = seed.addTask({ productId, title: "Check the greeting", approvePlan: true, backlog: true });
        const task = seed.task(taskId)!, scope = executionFor(task);
        admitted();
        const worktree = join(root, "reviewed-greeting"), branch = `progress-${taskId}`;
        await gitOps.ensureWorktree(repo, worktree, branch, base); admitted();
        writeFileSync(join(worktree, "greeting.txt"), "Hello\n");
        await gitOps.commitChanges(worktree, "Prepare the greeting for the native progress contract"); admitted();
        Object.assign(scope.work, { worktree, branch, base: "main", baseSha: base, preparation: "ready", delivery: "local",
          report: { summary: "Added a greeting.", changes: ["People see a greeting"] },
          source: { product: { ...product }, start: { kind: "default", branch: "main" }, destination: { mode: "local", kind: "branch", repo: product.repo, branch: "main" }, confirmed: true, initialSha: base } });
        const plan = normalizePlan({ task: repositoryView(scope), result: { rationale: "A small change: build it, one reviewer.",
          ...(role === "security-reviewer" ? { risk: { level: "high" as const } } : {}), stages: [
            { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
            { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high"], maxRounds: 1 },
          ] }, roles: seed.s.roles, profiles: seed.s.profiles, plannerProfileId: "sol-high", releaseManagerProfileId: "opus-high", onUsable: id => id });
        task.plan = structuredClone(plan) as DeepMutable<typeof plan>;
        const stage = task.plan.stages.find(stage => stage.kind === "review-chain" && stage.roleId === role)!;
        seed.addReviewer(taskId, stage.id, role === "security-reviewer" ? "opus-high" : "sol-high");
        task.stageIndex = task.plan.stages.findIndex(current => current.id === stage.id);
        scope.work.completedStages = task.plan.stages.slice(0, task.stageIndex).map(stage => stage.id);
        task.startedAt = Date.now(); task.state = "paused";
        task.steps = []; // Declared empty timing history: no preceding Builder execution is claimed.
        task.risk = { level: role === "security-reviewer" ? "high" : "medium", why: "Declared progress contract prerequisite" };
        seed.commitNow(task);
        await seed.shutdown(); seed = undefined; admitted();
        return { taskId, stage: task.plan.stages.find(current => current.id === stage.id)! };
      });
    },
  };
}
