import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { normalizePlan, type DeepMutable } from "@petrina/core";
import { executionFor } from "@petrina/orchestrator";
import type { Engine } from "../engine.js";
import { instructionPlan, type instructionAgents, type InstructionScript } from "./instruction-agents.js";
import { localFixtureSource } from "./prepared-runtime.js";
import { materializePreparedWorktree } from "./shared-preparation.js";
import type { ProductRepository } from "@petrina/test-support/repositories";

/** Call inside the Engine case owner: declarations stop before the first relevant actual participant. */
export async function preparedInstructionTask(engine: Engine, request: Parameters<Engine["addTask"]>[0], agents: Pick<ReturnType<typeof instructionAgents>, "acceptedBuild">,
  script: InstructionScript, input: { entry: "builder" | "review"; checks: "none" | "version"; reviewed?: true; initial?: ProductRepository }, check: () => void): Promise<string> {
  const available = () => { check(); engine.stopRequested.signal.throwIfAborted(); };
  available(); await engine.waitUntilReady(); available();
  const id = engine.addTask({ ...request, backlog: true }), task = engine.task(id)!, scope = executionFor(task);
  const product = engine.s.products.find(product => product.id === scope.work.productId)!;
  await localFixtureSource(engine, task, input.initial ? { initial: input.initial, check: available } : undefined); available();
  const plan = normalizePlan({ task, result: instructionPlan(script), roles: engine.s.roles, profiles: engine.s.profiles,
    plannerProfileId: "sol-high", releaseManagerProfileId: "opus-high", onUsable: id => engine.onUsable(id) });
  task.plan = structuredClone(plan) as DeepMutable<typeof plan>;
  task.stageIndex = input.entry === "builder" ? 0 : plan.stages.findIndex(stage => stage.kind === "review-chain");
  if (task.stageIndex < 0) throw new Error("The instruction fixture has no requested stage");
  task.approvePlan = false;
  const checks = input.checks === "none" ? [] : [{ name: "Version", argv: ["git", "--version"] }];
  if (product.checks === undefined) { product.checks = checks; product.checksBy = "coordinator"; }
  else if (JSON.stringify(product.checks) !== JSON.stringify(checks)) throw new Error("The instruction fixture cannot replace a product's existing checks");
  if (input.entry === "review") {
    const base = scope.work.source!.initialSha!, branch = `instruction-review-${id}`;
    const worktree = join(engine.dataDir, "worktrees", product.id, id);
    mkdirSync(worktree, { recursive: true });
    const report = agents.acceptedBuild(worktree, task.title);
    Object.assign(scope.work, { worktree, branch, base: "main", baseSha: base, preparation: "ready", report,
      completedStages: plan.stages.slice(0, task.stageIndex).map(stage => stage.id) });
    const extraFiles = script.ownFiles ? { [`${task.title.toLowerCase().replace(/\W+/g, "-")}.txt`]: `${task.title}\n` } : undefined;
    await materializePreparedWorktree(engine, scope, product.path!, "main", base, "greeting.txt", "Hello\n", "Prepare the supplied instruction-review change", extraFiles);
    available();
  }
  if (scope.work.checks || scope.work.checkSetup || scope.work.builderSession || task.reviewSessions || task.journey?.some(step => step.kind === "agent"))
    throw new Error("Prepared instruction input cannot claim check or participant execution");
  if (input.reviewed) {
    const stage = task.plan.stages[task.stageIndex], position = task.stageIndex;
    const next = task.plan.stages[position + 1], path = scope.work.worktree, productPath = product.path, source = scope.work.source;
    const active = () => {
      available();
      if (engine.task(id) !== task || executionFor(task).work !== scope.work || engine.productOf(scope) !== product
        || product.path !== productPath || scope.work.worktree !== path || scope.work.source !== source
        || task.plan?.stages[position] !== stage || task.plan?.stages[position + 1] !== next || task.repositories || task.hunt
        || scope.work.checks || scope.work.checkSetup || scope.work.conversation || task.reviewSessions
        || task.findings.length || task.journey?.some(step => step.kind === "agent"))
        throw new Error("The supplied reviewed instruction input lost its unexecuted owner");
    };
    active();
    if (input.entry !== "review" || !path || stage?.kind !== "review-chain" || stage.profileIds.length !== 1
      || engine.role(stage.roleId, task)?.result !== "findings" || next?.kind !== "gate" || next.gate !== "delivery"
      || script.reviewer || script.learnings || script.guide || script.hold?.title === task.title)
      throw new Error("The supplied reviewed instruction input must lead directly to its delivery check");
    // This is an accepted prerequisite, not a reviewer execution or passing product check.
    // The actual completion owner pins the real copy and advances its ordinary review state.
    const result = await engine["reviews"]["closeReviewRound"](task, stage, 1, "Supplied review prerequisite");
    active();
    if (result !== "continue" || task.stageIndex !== position + 1 || !scope.work.reviewedTree)
      throw new Error("The supplied instruction review did not reach its actual delivery check");
  }
  task.startedAt = Date.now(); task.state = "waiting";
  engine.commitNow(task); engine.schedule();
  return id;
}
