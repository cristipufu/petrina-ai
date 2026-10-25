import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { executionFor, scopesFor } from "@petrina/orchestrator";
import * as git from "@petrina/repositories/git";
import { versionsOf } from "../../src/repositories.js";
import type { Engine } from "../engine.js";

/**
 * Delivery-only contracts begin with an already built/reviewed change. Resolve its actual sources and make
 * real task worktrees, instead of running an unrelated Planner, design convergence and review panel. Native
 * check execution and the delivery gate are never replaced. A contract asserting Builder receipts requests
 * real build turns; other contracts supply an ordinary saved build result as their explicit input.
 */
export async function prepareSharedDelivery(engine: Engine, id: string, options: { build?: "run"; acceptance?: boolean; risk?: "low" } = {}) {
  await engine.waitUntilReady();
  const task = engine.task(id)!;
  if (task.state !== "backlog" || engine.drivers.has(id)) throw new Error("Prepare only a private, unstarted backlog fixture");
  const schedule = engine.schedule, paused = engine.s.pool.paused;
  engine.schedule = () => {};
  try {
    engine.setPoolPaused(false);
    task.plan = { rationale: "Delivery's already completed prerequisites", plannerProfileId: "sonnet-medium", stages: [
      { id: "build", title: "Build", kind: "do", roleId: "builder", profileIds: ["sol-xhigh"] },
      { id: "review", title: "Review", kind: "review-chain", roleId: "code-reviewer", profileIds: ["opus-high"], maxRounds: 2 },
      { id: "delivery-check", title: "Your delivery check", kind: "gate", gate: "delivery", roleId: "release-manager", profileIds: [] },
      { id: "ship", title: "Deliver", kind: "do", roleId: "release-manager", profileIds: ["sol-high"] },
    ] };
    task.stageIndex = 0;
    const sources = engine["sources"];
    const approval = task.approveDelivery;
    await sources.propose(task, task.selectedProducts);
    sources.confirm(task);
    // The test's explicit coordinator choice is the saved plan input, after source resolution.
    task.approveDelivery = approval;
    const signal = new AbortController().signal;
    task.state = "running";
    task.startedAt = Date.now();
    for (const scope of scopesFor(task)) {
      const product = engine.s.products.find(product => product.id === scope.work.productId)!;
      if (!product.checks) engine.setProductChecks(product.id, [{ name: "Version", command: "git --version" }]);
      await engine["driver"]["prepare"](scope, signal);
      scope.work.preparation = "ready";
    }
    const build = task.plan.stages[0]!;
    for (const scope of scopesFor(task)) {
      task.activeProductId = scope.work.productId;
      if (options.build === "run") await engine["work"].runDo(scope, build, signal);
      else {
        writeFileSync(join(scope.work.worktree!, "greeting.txt"), "Hello\n");
        await git.commitAll(scope.work.worktree!, "Added a greeting.");
        scope.work.report = { summary: "Added a greeting.", changes: ["People see a greeting"], tests: "Petrina runs the configured checks." };
        (scope.work.completedStages ??= []).push(build.id);
      }
      // Review is a saved prerequisite here. These observations identify its actual private code.
      const observed = await git.commitVersion(scope.work.worktree!);
      scope.work.reviewedTree = observed.tree;
      scope.work.reviewedSha = observed.head;
    }
    if (options.acceptance) {
      const versions = await versionsOf(task);
      task.brief = { summary: "A shared greeting", forUsers: [], areas: [], risks: [], acceptance: [
        { text: "A greeting file exists", productIds: task.repositories!.map(work => work.productId), versions, met: true, verification: "passed" },
      ] };
      task.acceptancePassed = true;
    }
    if (options.risk) task.risk = { level: options.risk, why: "Only the greeting's words change." };
    task.activeProductId = executionFor(task, task.leadProductId).work.productId;
    task.stageIndex = 2;
    task.sub = 0;
    task.state = "waiting";
    task.holdsSlot = false;
    engine.commitNow(task);
    return task;
  } finally { engine.setPoolPaused(paused); engine.schedule = schedule; }
}
