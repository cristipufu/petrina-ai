import { checkOutcome, checkOwnershipConfirmed, findingKind, lastIndexWhere, repositoryPublished, type CheckRun, type Id } from "@petrina/core";
import { beginRepair } from "./repair.js";
import { scopesFor, type RepositoryContext } from "./repository-context.js";
import type { CheckRepairHost } from "./ports/check-repairs.js";

/** Check findings, episode closure and Builder returns. Native observations are supplied by their owning adapter. */
export class CheckRepairs {
  constructor(private readonly host: CheckRepairHost) {}
  settleFindings(scope: RepositoryContext, results: readonly CheckRun[], declared: ReadonlySet<string>): readonly CheckRun[] {
    const { task, work: repository } = scope;
    const failed = results.filter((run) => checkOutcome(run).kind === "failed");
    // An earlier failure settles on this run, whatever anyone answered about it.
    for (const finding of task.findings) {
      if ((finding.status === "open" || finding.status === "unverified") && findingKind(finding) === "product-check" && (!task.repositories || finding.productIds?.includes(repository.productId))) {
        const matching = results.find((run) => finding.text === `Check failed: ${run.name} (${run.command})`);
        if (!declared.has(finding.text) || (matching && checkOutcome(matching).kind === "passed")) finding.status = "fixed";
        else if (matching && checkOutcome(matching).kind !== "failed") finding.status = "unverified";
      }
    }
    this.recordFailedFindings(scope, failed);
    return failed;
  }

  recordFailedFindings(scope: RepositoryContext, failed: readonly CheckRun[]): void {
    const { task, work: repository } = scope;
    for (const run of failed) {
      const text = `Check failed: ${run.name} (${run.command})`;
      const finding = task.findings.findLast((finding) => findingKind(finding) === "product-check" && finding.text === text && (!task.repositories || finding.productIds?.includes(repository.productId)));
      if (finding) {
        finding.kind = "product-check";
        finding.status = "open";
        finding.severity = "blocking";
        finding.evidence = run.output.slice(-1500);
      } else task.findings.push({
        kind: "product-check",
        ...(task.repositories ? { productIds: [repository.productId] } : {}),
        id: this.host.id(task),
        text,
        evidence: run.output.slice(-1500),
        severity: "blocking",
        raisedBy: "petrina",
        confirmedBy: [],
        status: "open"
      });
    }
  }

  async closeEpisode(scope: RepositoryContext, state: { sha?: string; definition: string }, valid: () => boolean): Promise<void> {
    const { task, work } = scope;
    if (work.checkReturns === undefined || !work.worktree) return;
    if (task.findings.some((finding) => finding.status === "open" && findingKind(finding) === "product-check" && (!task.repositories || finding.productIds?.includes(work.productId)))) return;
    const definition = await this.host.definition(scope, state.sha);
    if (valid() && definition === state.definition) delete work.checkReturns;
  }

  backToBuilder(scope: RepositoryContext, when: string, eligibleProducts: ReadonlySet<Id>): boolean {
    const { task, work: repository } = scope;
    if (!eligibleProducts.size || !task.repositories && !eligibleProducts.has(repository.productId)) return false;
    const unresolved = scopesFor(task).find(({ work }) => {
      if (repositoryPublished(work)) return false;
      const rows = [...(Array.isArray(work.checks?.results) ? work.checks.results : []),
        ...(Array.isArray(work.checkSetup?.results) ? work.checkSetup.results.flatMap(result => result?.run ? [result.run] : []) : [])];
      // An old report with no native observations is unverified history, not a present liveness claim.
      return rows.some(run => run && (run.execution !== undefined || run.cleanupIncomplete !== undefined) && !checkOwnershipConfirmed(run));
    });
    if (unresolved) {
      this.host.log(
        unresolved,
        "warn",
        "Check cleanup has not been confirmed; no automatic Builder turn starts until the recorded process and output ownership is resolved"
      );
      return false;
    }
    if (task.repositories) {
      // A shared repair pass returns to one stage. From the delivery check or shipping it returns through the
      // first review after the builder, as a single product walks forward; nothing it changed is unreviewed.
      const stages = task.plan?.stages ?? [];
      const here = stages[task.stageIndex];
      const late = here?.gate === "delivery" || this.host.role(here?.roleId ?? "", task)?.result === "delivery";
      const builder = stages.findIndex((entry) => entry.kind === "do" && this.host.role(entry.roleId, task)?.result === "build");
      const review = late && !task.repositories.some(repositoryPublished) ? stages.findIndex((
        entry,
        index
      ) => index > builder && index < task.stageIndex && entry.kind === "review-chain") : -1;
      if (!beginRepair(this.host, task, "checks", review >= 0 ? review : task.stageIndex, { eligibleProducts })) return false;
      // Through review, the delivery check asks again. A pass returning to shipping keeps the approval, so the
      // changed work is compared with what was approved there and never ships on a withdrawn approval.
      if (review >= 0) for (const work of task.repositories) if (!repositoryPublished(work)) withdrawApproval(work);
      this.host.checkpoint();
      return true;
    }
    const builder = lastIndexWhere(
      task.plan?.stages ?? [],
      (
      entry,
      index
    ) => index < task.stageIndex && this.host.role(
      entry.roleId,
      task
    )?.result === "build"
    );
    if (builder < 0 || (repository.checkReturns ?? 0) >= 2) return false;
    repository.checkReturns = (repository.checkReturns ?? 0) + 1;
    withdrawApproval(repository);
    task.stageIndex = builder;
    task.sub = 0;
    task.fixing = true;
    this.host.log(scope, "warn", `Sent back to the builder: the checks failed ${when}`);
    this.host.changed();
    return true;
  }
}

/** A repair requires the coordinator to check the changed work again. */
function withdrawApproval(work: { approvedSha?: string; approvedPatch?: string; approvedFor?: unknown }): void {
  delete work.approvedSha;
  delete work.approvedPatch;
  delete work.approvedFor;
}
