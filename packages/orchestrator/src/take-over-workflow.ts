import { lastIndexWhere, type Id } from "@petrina/core";
import type { RuntimeTask } from "./model.js";
import { executionFor, type RepositoryContext } from "./repository-context.js";

export interface TakeOverTamperObservation {
  readonly productId: Id;
  readonly sha: string;
  readonly problems: readonly string[];
}

export interface TakeOverTamperOutcome {
  readonly scope: RepositoryContext;
  readonly problems: readonly string[];
}

/** Why hand back cannot go on with the working copy as it is, in plain words. */
export function takeOverBranchProblem(
  work: { readonly worktree?: string; readonly branch?: string },
  agentWorktree: string,
  where: { readonly branch?: string; readonly busy?: string },
): string | undefined {
  if (where.busy) {
    return `The working copy is in the middle of ${where.busy}. Finish it or abort it in your terminal, then hand back.`;
  }
  const separate = agentWorktree !== work.worktree;
  if (separate && where.branch) {
    return "The reviewer's working copy switched to a branch. Return it to where the reviewer was working, then hand back.";
  }
  if (!separate && where.branch !== work.branch) {
    return "The working copy is no longer on the task's branch. Switch back to it in your terminal, then hand back.";
  }
  return undefined;
}

export function invalidateHandEditedRepositoryWork(
  task: RuntimeTask,
  work: NonNullable<RuntimeTask["repository"]>,
): void {
  if (work.checks) work.checks.current = false;
  delete work.reviewedTree;
  delete work.checkedSha;
  delete work.checkedPatch;
  task.handChanges = true;
}

/**
 * Record tamper-check results for hand-edited products, add deduplicated blocking findings,
 * and mark a prior or current review chain for rereview when no review chain remains ahead.
 */
export function applyTakeOverHandChanges(
  task: RuntimeTask,
  inspections: readonly TakeOverTamperObservation[],
  options: { readonly now?: number; readonly nextFindingId: () => Id },
): TakeOverTamperOutcome[] {
  const now = options.now ?? Date.now();
  const outcomes: TakeOverTamperOutcome[] = [];
  for (const { productId, sha, problems } of inspections) {
    const scope = executionFor(task, productId);
    scope.work.tamper = { at: now, sha, problems: [...problems] };
    for (const problem of problems) {
      const alreadyOpen = task.findings.some(
        (finding) =>
          finding.text === problem
          && finding.status === "open"
          && (!task.repositories || finding.productIds?.includes(productId)),
      );
      if (!alreadyOpen) {
        task.findings.push({
          ...(task.repositories ? { productIds: [productId] } : {}),
          id: options.nextFindingId(),
          text: problem,
          severity: "blocking",
          raisedBy: "petrina",
          confirmedBy: [],
          status: "open",
        });
      }
    }
    outcomes.push({ scope, problems });
  }
  task.handChanges = true;
  const stages = task.plan?.stages ?? [];
  if (!stages.some((stage, index) => index > task.stageIndex && stage.kind === "review-chain")) {
    const chain =
      stages[task.stageIndex]?.kind === "review-chain"
        ? task.stageIndex
        : lastIndexWhere(stages, (stage, index) => index < task.stageIndex && stage.kind === "review-chain");
    if (chain >= 0) task.rereview = stages[chain]!.id;
  }
  return outcomes;
}
