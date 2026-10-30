import { endAgentStep, exhaustedAcceptanceFailure, findingCount, JOURNEY_WORDS, openStep, refreshProofs, reopenFinding, type Id } from "@petrina/core";
import { executionFor, scopesFor } from "./repository-context.js";
import type { RuntimeTask } from "./model.js";
import type { ReviewStage, ReviewWorkflowEffects, ReviewWorkflowHost } from "./ports/review-workflow.js";

/** The review phase owner: real preflight, participant and persistence work stays with its effects. */
export class ReviewWorkflow {
  constructor(private readonly host: ReviewWorkflowHost, private readonly effects: ReviewWorkflowEffects) {}

  async run(task: RuntimeTask, stage: ReviewStage, signal: AbortSignal): Promise<"continue" | "stop"> {
    const scope = executionFor(task);
    // Older saved tasks could reopen a fix while retaining the verdict on its previous code. An acceptance failure held for
    // the delivery decision is no review's to reopen: acceptance testing already tested its claims.
    for (const finding of task.findings) {
      if (finding.raisedBy !== "petrina" && finding.status === "open" && finding.answer?.fixed && (finding.reopenedAt ?? -Infinity) < finding.answer.at && (!finding.verification || finding.verification.at < finding.answer.at) && !exhaustedAcceptanceFailure(task, finding)) reopenFinding(finding, this.host.now());
    }
    // Older saved port marks did not prove the feature had completed ordinary review.
    if (scope.work.portReview && !scope.work.reviewedTree) {
      delete scope.work.portReview;
      delete task.hunt;
      delete scope.work.reviewedSha;
      // Its old conversation was briefed to look only at the port. A full review starts fresh,
      // including for a one-person review that would otherwise resume with only "continue".
      delete scope.work.conversation;
      this.host.checkpoint(task);
    }
    const round = task.rounds[stage.id] ?? 1;
    if (task.hunt?.stageId !== stage.id || task.hunt.round !== round) {
      // The work goes on top of the latest main before anyone reviews it: a conflict goes to the builder first,
      // so a port after the review (and a review of that port) stays the exception.
      let failedChecks = false;
      const eligibleProducts = new Set<Id>();
      for (const scope of scopesFor(task)) {
        if (task.repositories) task.activeProductId = scope.work.productId;
        if (!await this.effects.prepareChecks(scope, signal)) return "continue";
        // The product's checks run before any reviewer spends time: an agent's word never counts as passing.
        // A failed run is evidence too: it returns to the builder without spending a review round.
        try {
          const result = await this.effects.checks(scope, signal);
          failedChecks = result.kind !== "passed" || failedChecks;
          if (result.kind === "product-failed") eligibleProducts.add(result.productId);
        } catch (error) { if (this.effects.preparationChanged(error)) return "continue"; throw error; }
      }
      if (failedChecks) {
        // The check fix can reach beyond the port's conflicted files, so its review must be ordinary.
        for (const { work } of scopesFor(task)) {
          delete work.portReview;
          delete work.reviewedTree;
        }
        if (this.effects.backToBuilder(scope, eligibleProducts)) return "continue";
        // The round has not started: it waits here with its number, its reviewers' conversations and its
        // incremental anchor, and runs once the checks pass. No review is assumed from the Builder's answers.
        return this.effects.blocked(task);
      }
      if (task.repositories) task.activeProductId = task.leadProductId ?? task.repositories[0]!.productId;
      task.statusLine = "Preparing the review";
      if (task.proofRequests?.length) refreshProofs(task, await this.effects.versions(task));
      this.host.changed(task);
      const input = await this.effects.input(executionFor(task), signal);
      signal.throwIfAborted();
      task.hunt = { id: this.host.id(task), stageId: stage.id, round, reported: {}, findings: task.findings.length, input };
      this.host.changed(task);
      // Checks use their own bounded lane. Re-enter the driver to admit the first real reviewer.
      return "continue";
    }
    const reviewers = this.effects.pendingReviewers(task, stage);
    if (reviewers.length) {
      await this.effects.hunt(task, stage, reviewers, signal);
      if (stage.profileIds.length === 1) this.host.finishStep(task);
      else this.host.clearStep(task);
      // Changes made by hand: the round's box ends, and the review starts again from the first reviewer.
      if (task.rereview) endAgentStep(task, { outcome: this.raised(task), reason: JOURNEY_WORDS.reviewAgain }, this.host.now());
      this.host.rerun(task);
      // The voters' first slot qualifies again, maybe on another tool: back to the driver.
      return "continue";
    }
    const vote = this.effects.pendingVote(task, stage);
    if (vote?.voters.length) {
      // The reviewers' box ends with what they raised; the voters get a box of their own.
      const roleId = openStep(task)?.roleId;
      if (roleId === stage.roleId || (roleId && stage.roleIds?.includes(roleId))) endAgentStep(task, { outcome: this.raised(task), reason: JOURNEY_WORDS.toCheck(vote.findings.length) }, this.host.now());
      await this.effects.vote(task, vote, signal);
      return "continue";
    }
    const outcome = vote ? this.effects.finishBallot(task, vote) : this.raised(task);
    const reviewedVersions = task.hunt?.input?.trees;
    delete task.hunt;
    return this.effects.closeRound(task, stage, round, outcome, reviewedVersions);
  }

  /** Acceptance failures held for the delivery decision are not review findings. */
  raised(task: RuntimeTask): string {
    const recorded = openStep(task)?.result?.findings;
    return findingCount((recorded ? recorded.filter(finding => finding.status === "open") : task.findings.slice(task.hunt?.findings ?? 0))
      .filter(finding => !exhaustedAcceptanceFailure(task, finding)));
  }
}
