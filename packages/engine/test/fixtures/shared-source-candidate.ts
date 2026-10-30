import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { scopesFor } from "@petrina/orchestrator";
import * as git from "@petrina/repositories/git";
import type { Engine } from "../engine.js";
import { materializePreparedWorktree } from "./shared-preparation.js";

/** Explicit source/publication inputs, admitted only after the actual shared source preparation succeeds. */
export function installSharedSourceCandidates(engine: Engine, candidates: ReadonlyMap<string, "version" | "none">, available: () => void): void {
  const phases = engine["driver"].workflow["phases"], original = phases.doStage;
  phases.doStage = async (scope, stage, signal) => {
    if (!candidates.has(scope.task.id)) return original(scope, stage, signal);
    const active = () => { available(); engine.stopRequested.signal.throwIfAborted(); signal.throwIfAborted(); };
    active();
    const task = engine.task(scope.task.id);
    if (task !== scope.task || !task.repositories || !task.repositories.some(work => work === scope.work))
      throw new Error("Prepared source input requires its canonical shared execution");
    if (engine.role(stage.roleId, task)?.result !== "build" || task.stageIndex !== task.plan?.stages.indexOf(stage))
      throw new Error("Prepared source input must enter the declared initial Builder boundary");
    const delivery = task.plan!.stages.findIndex((entry, index) => index > task.stageIndex && entry.kind === "gate" && entry.gate === "delivery");
    if (delivery < 0) throw new Error("Prepared source input requires the real delivery check");
    for (const bound of scopesFor(task)) {
      active();
      const work = bound.work, product = engine.productOf(bound);
      if (!product || product.id !== work.productId || work.source?.product.id !== work.productId
        || !work.source.confirmed || work.preparation !== "ready" || !work.worktree)
        throw new Error("Prepared source input cannot replace source approval, cloning or working-copy preparation");
      if (work.checks || work.checkSetup || work.reviewedSha || work.reviewedTree || work.conversation || work.builderSession
        || task.acceptancePassed || task.findings.length)
        throw new Error("Prepared source input cannot claim a prior agent, check, acceptance or review execution");
      if (candidates.get(task.id) === "none") {
        if (product.checks?.length) throw new Error("A no-command shared source input cannot replace configured checks");
        product.checks = []; product.checksBy = "coordinator";
      } else if (product.checks === undefined) engine.setProductChecks(product.id, [{ name: "Version", command: "git --version" }]);
      work.report = { summary: "Added a greeting.", changes: ["People see a greeting"], description: "A supplied native source/publication fixture input." };
      if (product.path && work.baseSha) {
        await materializePreparedWorktree(engine, bound, product.path, work.base ?? "origin/main", work.baseSha, "greeting.txt", "Hello (with left-pad)\n");
      } else {
        writeFileSync(join(work.worktree, "greeting.txt"), "Hello (with left-pad)\n");
        await git.commitChanges(work.worktree, engine["updates"].message(bound));
      }
      active();
    }
    // These earlier workflow stages are supplied preconditions, not executed or credited agent results.
    // No completion records, sessions, reviews, check bindings or acceptance evidence are created here.
    task.stageIndex = delivery; task.sub = 0;
    engine.commitNow(task);
    return "continue";
  };
}
