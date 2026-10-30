import { join } from "node:path";
import { executionFor } from "@petrina/orchestrator";
import * as git from "@petrina/repositories/git";
import type { Engine } from "../engine.js";
import { attachReviewWorktree } from "./fake-agent-sessions.js";

/** A supplied built change; every screen request, review/check turn and detached copy still runs natively. */
export async function prepareScreenReview(engine: Engine, id: string, checks: "discover" | "none", available: () => void): Promise<void> {
  const task = engine.task(id);
  if (!task || task.repositories || engine.drivers.has(id)) throw new Error("A prepared screen review requires its idle single-product task");
  const scope = executionFor(task), work = scope.work, product = engine.productOf(scope), productPath = product?.path;
  const stageIndex = task.plan?.stages.findIndex(stage => stage.kind === "review-chain" && engine.role(stage.roleId, task)?.result === "findings") ?? -1;
  if (stageIndex < 0 || !productPath || !work.source?.confirmed || work.conversation || work.builderSession || work.checks || task.hunt)
    throw new Error("A prepared screen review cannot replace existing participant or check evidence");
  const active = () => {
    available(); engine.stopRequested.signal.throwIfAborted();
    if (engine.task(id) !== task || executionFor(task).work !== work || engine.productOf(scope) !== product || product?.path !== productPath)
      throw new Error("The prepared screen review lost its captured owner");
  };
  active();
  if (checks === "none") {
    if (product!.checks?.length) throw new Error("Prepared screen inputs cannot replace configured commands");
    product!.checks = []; product!.checksBy = "coordinator";
  } else if (product!.checks !== undefined) throw new Error("A native Check finder must start before checks have been supplied");
  const branch = work.branch ?? git.branchName(task.title, task.id);
  const path = work.worktree ?? join(engine.dataDir, "worktrees", product!.id, task.id);
  const attached = await attachReviewWorktree(productPath, { worktree: path, branch, id: `${product!.id}-${task.id}` }); active();
  if (!work.branch) engine.log(scope, "milestone", "Set up a fresh working copy");
  work.branch = branch;
  work.worktree = path;
  await engine["checks"].noteHooks(scope); active();
  const defaultBranch = product!.defaultBranch ?? "main";
  work.base = work.base ?? (work.delivery === "local" ? defaultBranch : `origin/${defaultBranch}`);
  work.baseSha = work.baseSha ?? attached.initialSha;
  if (work.source && work.baseSha) work.source.initialSha ??= work.baseSha;
  await engine.rememberVersion(scope, attached.savedVersion); active();
  work.report = { summary: "The greeting is ready for independent review", changes: ["A greeting was added"] };
  task.stageIndex = stageIndex;
  // This is an accepted starting input, not an executed Builder session, review, check or provider result.
  engine.commitNow(task);
}
