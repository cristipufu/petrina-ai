import { existsSync } from "node:fs";
import { reviewerAt } from "@petrina/core";
import { executionFor } from "@petrina/orchestrator";
import { ReviewResult } from "../../src/roles.js";
import type { Engine } from "../engine.js";

/** Supply the first round's reviewer reports; actual native preflight/input and voter admission still run. */
export function installScreenVerifierReports(engine: Engine, taskId: string, available: () => void): void {
  const task = engine.task(taskId);
  if (!task || task.repositories || engine.drivers.has(taskId) || task.hunt || task.findings.length)
    throw new Error("Prepared verifier reports require the idle, unreviewed private task");
  const scope = executionFor(task), work = scope.work, path = work.worktree;
  const product = engine.productOf(scope), productPath = product?.path;
  const stage = task.plan?.stages[task.stageIndex];
  if (!path || !productPath || !work.source?.confirmed || !work.report || !stage || stage.kind !== "review-chain"
    || stage.profileIds.length !== 2 || stage.profileIds[0] !== "opus-high" || stage.profileIds[1] !== "sol-high"
    || stage.profileIds.some((_, index) => engine.role(reviewerAt(stage, index), task)?.result !== "findings"))
    throw new Error("Prepared verifier reports require the declared initial two-reviewer round");
  const reviews = engine["reviews"], effects = reviews["workflow"]["effects"], ordinary = effects.hunt;
  let accepted = false;
  effects.hunt = async (current, currentStage, places, signal) => {
    if (current.id !== taskId || accepted) return ordinary(current, currentStage, places, signal);
    const round = task.hunt;
    const active = () => {
      available(); engine.stopRequested.signal.throwIfAborted(); signal.throwIfAborted();
      if (engine.task(taskId) !== task || current !== task || currentStage !== stage || task.plan?.stages[task.stageIndex] !== stage
        || executionFor(task).work !== work || work.worktree !== path || engine.productOf(scope) !== product || product?.path !== productPath
        || !round?.input || task.hunt?.id !== round.id || task.hunt?.input !== round.input || !existsSync(round.input.file))
        throw new Error("Prepared verifier reports lost their captured owner or actual round input");
    };
    active();
    if (round!.round !== 1 || round!.stageId !== stage.id || Object.keys(round!.reported).length || task.findings.length
      || work.conversation || work.builderSession || task.screen || !task.agent || engine.role(task.agent.roleId, task)?.result !== "findings"
      || places.length !== 2 || places.some((place, index) => place.key !== String(index) || place.profileId !== stage.profileIds[index]))
      throw new Error("Prepared verifier reports cannot replace an executed or continued participant");
    for (const [index, place] of places.entries()) {
      const result = ReviewResult.parse(index === 0
        ? { verdict: "fail", findings: [{ text: "The greeting is missing on the welcome page.", where: "greeting.txt", severity: "important", evidence: "Opened the welcome page" }] }
        : { verdict: "pass", findings: [{ text: "Consider a friendlier greeting.", severity: "nit" }] });
      await reviews["applyReview"](scope, stage, result, place.profileId, reviewerAt(stage, index), place.key);
      active();
      reviews["reportAccepted"](task, place.key);
    }
    accepted = true;
    // No provider conversation, input, result receipt or usage is invented for these supplied reports.
  };
}
