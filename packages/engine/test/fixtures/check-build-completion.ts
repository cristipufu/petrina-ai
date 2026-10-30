import { assignedCheckFailures, beginAgentStep, builderFindings } from "@petrina/core";
import { scopesFor } from "@petrina/orchestrator";
import * as git from "@petrina/repositories/git";
import type { Engine } from "../engine.js";
import { BuildResult } from "../../src/roles.js";

interface AcceptedBuilds {
  acceptedBuild(cwd: string, findingIds: readonly string[], fixing: boolean): unknown;
}

/** Supplied normalized replies omit provider/context work; real completion, commits and check snapshots remain. */
export function installCheckBuildCompletion(engine: Engine, taskId: string, agents: AcceptedBuilds, available: () => void): void {
  installAcceptedBuildCompletion(engine, taskId, agents, available, false);
}

/** The caller supplies accepted repair results for these exact prepared owners, never provider/session evidence. */
export function installAcceptedBuildCompletion(engine: Engine, taskId: string, agents: AcceptedBuilds, available: () => void, shared = true): void {
  const task = engine.task(taskId);
  if (!task || (!shared && task.repositories)) throw new Error("Accepted repairs require the declared task owner");
  const owners = new Map(scopesFor(task).map(scope => [scope.work.productId, {
    work: scope.work, path: scope.work.worktree, product: engine.productOf(scope), productPath: engine.productOf(scope)?.path,
  }]));
  const phases = engine["driver"].workflow["phases"], ordinary = phases.doStage;
  phases.doStage = async (scope, stage, signal) => {
    if (scope.task.id !== taskId || engine.role(stage.roleId, scope.task)?.result !== "build") return ordinary(scope, stage, signal);
    // A source conflict and all live/continued conversations still need their full native adapter.
    if (scope.work.updating || scope.work.conversation || scope.task.maintenance || (shared && scope.task.miss)) return ordinary(scope, stage, signal);
    const owner = owners.get(scope.work.productId);
    const active = () => {
      available(); engine.stopRequested.signal.throwIfAborted(); signal.throwIfAborted();
      if (engine.task(taskId) !== task || scope.task !== task || !owner || owner.work !== scope.work
        || !scopesFor(task).some(current => current.work === scope.work) || !owner.path || scope.work.worktree !== owner.path
        || !owner.product || engine.productOf(scope) !== owner.product || owner.product.id !== scope.work.productId || owner.product.path !== owner.productPath)
        throw new Error("Accepted repair lost its captured task, product or working copy");
    };
    active();
    if (!task.fixing || task.plan?.stages[task.stageIndex] !== stage || !scope.work.source?.confirmed
      || scope.work.pr || scope.work.release || scope.work.landed)
      throw new Error("Accepted repair requires its canonical prepared, undelivered execution");
    const profileId = task.agent?.profileId;
    if (!profileId || task.agent?.roleId !== stage.roleId) throw new Error("Accepted check repair requires actual workflow admission");
    delete scope.task.miss; scope.task.queued = [];
    const startingTree = scope.work.savedVersion?.tree ?? await git.contentTree(owner!.path!);
    active();
    const given = builderFindings(task, scope.work.productId), checkFailures = assignedCheckFailures(scope);
    // These are the exact native file changes and accepted output used by the ordinary scripted agent.
    const result = BuildResult.parse(agents.acceptedBuild(owner!.path!, given.map(finding => finding.id), true));
    const step = beginAgentStep(task, stage.roleId, profileId, Date.now(), engine.s.roles, undefined, scope.work);
    step.findingIds = given.map(finding => finding.id);
    const plannedProfileId = (task.repositories ? task.plan.products?.find(product => product.productId === scope.work.productId)?.builderProfileId : undefined) ?? stage.profileIds[0]!;
    const sourceName = scope.work.source.start.kind === "pull-request" ? `PR #${scope.work.source.start.number}` : scope.work.source.start.branch;
    await engine["work"]["buildCompletion"].complete(scope, { stageId: stage.id, roleId: stage.roleId,
      plannedProfileId, actualProfileId: profileId, result, maintenance: false, sourceName, startingTree, given, checkFailures });
    active();
    return engine["work"]["completion"].complete(scope, { stageId: stage.id, canEdit: true });
  };
}
