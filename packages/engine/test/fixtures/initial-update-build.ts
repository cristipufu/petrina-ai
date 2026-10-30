import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beginAgentStep } from "@petrina/core";
import { executionFor } from "@petrina/orchestrator";
import * as git from "@petrina/repositories/git";
import type { Engine } from "../engine.js";
import { BuildResult } from "../../src/roles.js";
import { materializePreparedWorktree, readRef, readWorktreeCommit } from "./shared-preparation.js";

/** The first normalized build is a supplied input; source admission, completion and every later turn stay real. */
export function installInitialUpdateBuild(engine: Engine, taskId: string, input: {
  acceptedInitialBuild(path: string, signal: AbortSignal): Promise<unknown>;
  beforeBuild(): Promise<void>;
}, available: () => void): void {
  const task = engine.task(taskId);
  if (!task || task.repositories || task.fixing || task.maintenance || task.miss)
    throw new Error("An initial update input requires its canonical single-product task");
  const scope = executionFor(task), work = scope.work, product = engine.productOf(scope), productPath = product?.path;
  const stage = task.plan?.stages[task.stageIndex];
  if (!stage || stage.kind !== "do" || engine.role(stage.roleId, task)?.result !== "build" || !productPath || !work.source?.confirmed)
    throw new Error("An initial update input requires the approved source and declared Builder stage");
  const phases = engine["driver"].workflow["phases"], ordinary = phases.doStage;
  let accepted = false;
  phases.doStage = async (bound, current, signal) => {
    if (bound.task.id !== taskId || accepted) return ordinary(bound, current, signal);
    const path = work.worktree;
    const active = () => {
      available(); engine.stopRequested.signal.throwIfAborted(); signal.throwIfAborted();
      if (engine.task(taskId) !== task || bound.task !== task || bound.work !== work || executionFor(task).work !== work
        || engine.productOf(bound) !== product || product?.path !== productPath || !path || work.worktree !== path)
        throw new Error("The initial update input lost its captured task, product or working copy");
    };
    active();
    if (current !== stage || task.plan?.stages[task.stageIndex] !== stage || task.fixing || task.maintenance || task.miss
      || work.updating || work.conversation || work.builderSession || !work.baseSha || !work.branch || !work.source?.confirmed
      || work.pr || work.release || work.landed || task.findings.length)
      throw new Error("The initial update input cannot replace a repair, conversation or completed execution");
    const profileId = task.agent?.profileId;
    if (!profileId || task.agent?.roleId !== stage.roleId)
      throw new Error("The initial update input requires actual workflow admission");
    const startingTree = readWorktreeCommit(path!)?.tree ?? await git.contentTree(path!); active();
    // Native source movements still occur after actual worktree preparation and before the accepted edits.
    await input.beforeBuild(); active();
    const result = BuildResult.parse(await input.acceptedInitialBuild(path!, signal)); active();
    accepted = true;
    const branch = work.source.destination.branch ?? product.defaultBranch ?? "main";
    const currentMainSha = readRef(join(productPath, ".git"), `refs/heads/${branch}`);
    const greetingPath = join(path!, "greeting.txt");
    if (currentMainSha === work.baseSha && existsSync(greetingPath)) {
      const seed = await materializePreparedWorktree(engine, bound, productPath, work.base ?? branch, work.baseSha, "greeting.txt", readFileSync(greetingPath, "utf8"));
      active();
      const buildEffects = engine["work"]["buildCompletion"]["effects"];
      const origSaveChanges = buildEffects.saveChanges.bind(buildEffects);
      const origFold = engine["updates"].fold.bind(engine["updates"]);
      const origTree = buildEffects.tree.bind(buildEffects);
      buildEffects.saveChanges = async (s) => (s.work === work ? undefined : origSaveChanges(s));
      engine["updates"].fold = async (s) => {
        if (s.work === work) {
          engine["updates"]["observedHeads"].set(work, seed.head);
          return { fork: work.baseSha!, version: { head: seed.head, tree: seed.tree } };
        }
        return origFold(s);
      };
      buildEffects.tree = async (s) => (s.work === work ? seed.tree : origTree(s));
      try {
        beginAgentStep(task, stage.roleId, profileId, Date.now(), engine.s.roles, undefined, work);
        const sourceName = work.source.start.kind === "pull-request" ? `PR #${work.source.start.number}` : work.source.start.branch;
        await engine["work"]["buildCompletion"].complete(bound, { stageId: stage.id, roleId: stage.roleId,
          plannedProfileId: stage.profileIds[0]!, actualProfileId: profileId, result, maintenance: false,
          sourceName, startingTree, given: [], checkFailures: [] });
      } finally {
        buildEffects.saveChanges = origSaveChanges;
        engine["updates"].fold = origFold;
        buildEffects.tree = origTree;
      }
      active();
      return engine["work"]["completion"].complete(bound, { stageId: stage.id, canEdit: true });
    }
    beginAgentStep(task, stage.roleId, profileId, Date.now(), engine.s.roles, undefined, work);
    const sourceName = work.source.start.kind === "pull-request" ? `PR #${work.source.start.number}` : work.source.start.branch;
    await engine["work"]["buildCompletion"].complete(bound, { stageId: stage.id, roleId: stage.roleId,
      plannedProfileId: stage.profileIds[0]!, actualProfileId: profileId, result, maintenance: false,
      sourceName, startingTree, given: [], checkFailures: [] });
    active();
    return engine["work"]["completion"].complete(bound, { stageId: stage.id, canEdit: true });
  };
}
