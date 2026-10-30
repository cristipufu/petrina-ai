import { join } from "node:path";
import { normalizePlan, type DeepMutable, type PlanDraft } from "@petrina/core";
import { executionFor } from "@petrina/orchestrator";
import type { Engine } from "../engine.js";
import type { EngineCaseOwner } from "./engine-cases.js";
import { attachReviewWorktree } from "./fake-agent-sessions.js";
import { localFixtureSource } from "./prepared-runtime.js";
import type { ProductRepository } from "@petrina/test-support/repositories";

/** Recording starts at the real participant being observed; earlier work is declared input. */
export async function prepareRecordingStage(owner: EngineCaseOwner, engine: Engine, id: string, first: "review" | "architect", initial: ProductRepository) {
  return owner.run(engine, async () => {
    const available = () => { owner.check(); engine.stopRequested.signal.throwIfAborted(); };
    available();
    const task = engine.task(id)!;
    if (task.state !== "backlog" || task.plan || task.journey?.length)
      throw new Error("Recording input must precede its first live participant");
    await localFixtureSource(engine, task, { initial, check: available }); available();
    const stages: PlanDraft["stages"] = [
      ...(first === "architect" ? [{ kind: "converge" as const, title: "Design", roleId: "architect", profileIds: ["opus-xhigh"],
        reviewerRoleId: "design-reviewer", reviewerProfileIds: ["sol-xhigh"], maxRounds: 2 }] : []),
      { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
      { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high", "sol-high"], maxRounds: 2 },
    ];
    const plan = normalizePlan({ task, result: { rationale: "Declared input for native participant recording", stages },
      roles: engine.s.roles, profiles: engine.s.profiles, plannerProfileId: "opus-high", releaseManagerProfileId: "opus-high", onUsable: id => engine.onUsable(id) });
    task.plan = structuredClone(plan) as DeepMutable<typeof plan>;
    task.risk = { level: "medium", why: "Declared recording input" };
    task.stageIndex = first === "review" ? plan.stages.findIndex(stage => stage.kind === "review-chain") : 0;
    task.sub = 0; task.approvePlan = false;
    const scope = executionFor(task), product = engine.s.products.find(product => product.id === task.productId)!;
    product.checks = []; product.checksBy = "coordinator";
    if (first === "review") {
      const base = scope.work.source!.initialSha!, branch = `recording-${id}`, worktree = join(owner.root, "review-input");
      const attached = await attachReviewWorktree(product.path!, { worktree, branch, id: `recording-${id}` }); available();
      Object.assign(scope.work, { worktree, branch, base: "main", baseSha: base, preparation: "ready",
        completedStages: plan.stages.slice(0, task.stageIndex).filter(stage => stage.kind === "do").map(stage => stage.id),
        report: { summary: "Supplied greeting", changes: ["People see a greeting"], tests: "Declared input; no earlier execution is claimed" } });
      await engine.rememberVersion(scope, attached.savedVersion); available();
    }
    engine.commitNow(task);
  });
}
