import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { executionFor } from "@petrina/orchestrator";
import { git } from "@petrina/test-support/commands";
import type { Engine } from "../engine.js";
import type { World } from "../support.js";
import { cleanupBuildOutput } from "./cleanup-agents.js";

/** Start the real delivery/cleanup boundary from an explicitly completed private build and review. */
export async function addPreparedCleanupTask(engine: Engine, world: Pick<World, "script">, request: Parameters<Engine["addTask"]>[0]): Promise<string> {
  const id = engine.addTask({ ...request, backlog: true });
  const task = engine.task(id)!, scope = executionFor(task), product = engine.s.products.find(product => product.id === scope.work.productId)!;
  task.startedAt = Date.now(); task.state = "paused"; task.stageIndex = 2; task.holdsSlot = false;
  task.plan = { rationale: "Only delivery evidence and owned working-copy cleanup are under test", plannerProfileId: "sol-high", stages: [
    { id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
    { id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high"] },
    { id: "delivery", kind: "gate", title: "Your delivery check", roleId: "coordinator", profileIds: [], gate: "delivery" },
    { id: "publish", kind: "do", title: "Publish", roleId: "release-manager", profileIds: ["opus-high"] },
  ] };
  const choice = { productId: product.id, delivery: scope.work.delivery, startFrom: { kind: "default" as const } };
  scope.work.source = { ...await engine["sources"].resolve(task, choice), confirmed: true };
  await engine["driver"]["prepare"](scope, new AbortController().signal);
  writeFileSync(join(scope.work.worktree!, "greeting.txt"), "Hello\n");
  cleanupBuildOutput(world, scope.work.worktree!);
  await git(scope.work.worktree!, "add", "."); await git(scope.work.worktree!, "commit", "-qm", "Prepare the completed cleanup fixture change");
  scope.work.report = { summary: "Added the greeting", title: task.title, changes: ["People see a greeting"], description: "The completed fixture change" };
  scope.work.reviewedTree = await git(scope.work.worktree!, "rev-parse", "HEAD^{tree}");
  // No discovery turn belongs to this already-reviewed fixture; actual delivery still records its empty check evidence.
  product.checks = []; product.checksBy = "coordinator";
  task.state = "waiting";
  engine.commitNow(task);
  engine.schedule();
  return id;
}
