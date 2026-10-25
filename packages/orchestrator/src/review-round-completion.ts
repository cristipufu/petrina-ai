import { coveredByDecision, endAgentStep, exhaustedAcceptanceFailure, findingCount, JOURNEY_WORDS as W, noteRoundEnd, openStep, passedOpenWords, reviewBlocking, reviewDecisionFor, reviewRoundEnd, type Id, type Stage, type Task } from "@petrina/core";
import { beginRepair } from "./repair.js";
import { executionFor, scopesFor } from "./repository-context.js";
import type { RuntimeTask } from "./model.js";
import type { ReviewRoundCompletionHost } from "./ports/review-round.js";

/** Finish the actual admitted round; input preparation, native observations and execution remain boundaries. */
export class ReviewRoundCompletion {
  constructor(private readonly host: ReviewRoundCompletionHost) {}

  async finish(task: RuntimeTask, stage: Stage, round: number, outcome: string, reviewedVersions?: Readonly<Record<Id, string>>): Promise<"continue" | "stop"> {
    const scope = executionFor(task);
    // Acceptance failures held for the delivery decision neither send the work back nor count toward the round.
    const open = reviewBlocking(task as unknown as Task);
    // The coordinator's decision to continue still covers its findings only on the task's own change it was made on.
    const continued = task.reviewDecision?.accepted && task.reviewDecision.covers?.length;
    let changes = continued ? await this.host.ownChanges(task) : undefined;
    const covered = changes ? coveredByDecision(task as unknown as Task, changes) : new Set<Id>();
    const end = reviewRoundEnd(task as unknown as Task, stage as Stage, round, this.host.roles(), covered);
    // A decision raised below records the change it is made on, read before anything else moves.
    if (end.kind === "used up" || (end.kind === "send back" && task.repositories)) changes ??= await this.host.ownChanges(task);
    noteRoundEnd(task, stage.id, open.length);
    // A port review is one round: whatever it found, the rounds after it are ordinary ones.
    const port = scope.work.portReview !== undefined;
    const incremental = this.host.incrementalReview(stage.roleId);
    delete scope.work.portReview;
    // Resolve each owner once. An incremental round records the HEAD and its tree
    // together; security rounds keep their code-review anchors unchanged.
    const scopes = scopesFor(task);
    const anchors = await Promise.all(scopes.map(async ({ work }) => {
      if (!work.worktree) return {};
      if (incremental) return this.host.anchor({ task, work }, { incremental: true, passed: end.kind === "passed" });
      return task.repositories && end.kind === "passed" ? this.host.anchor({ task, work }, { incremental: false, passed: true }) : {};
    }));
    for (const [index, { work }] of scopes.entries()) {
      const anchor = anchors[index]!;
      if (end.kind === "passed") {
        if (work.worktree && (task.repositories || incremental)) work.reviewedTree = anchor.tree;
        const step = openStep(task);
        const reviewed = reviewedVersions?.[work.productId];
        if (step && reviewed) step.checkReviews = [...(step.checkReviews ?? []), { productId: work.productId, tree: reviewed, at: this.host.now(), stageId: stage.id, round }];
      } else if (work === scope.work) delete work.reviewedTree;
      if (incremental) {
        if (anchor.head) work.reviewedSha = anchor.head;
        else delete work.reviewedSha;
      }
    }
    this.host.reviewEnd(task, round, end.kind === "send back" ? "sent-back" : end.kind === "used up" ? "rounds-used" : "passed");
    const pendingProofs = task.proofRequests?.filter(request => request.status !== "proved" && request.status !== "already-current").length ?? 0;
    const passed = [W.reviewPassed, ...(end.kind === "passed" && end.covered ? [W.coveredOpen(end.covered)] : []), ...(pendingProofs ? [`${pendingProofs} proof request${pendingProofs === 1 ? "" : "s"} for final acceptance testing`] : [])].join("; ");
    const reason = end.kind === "send back" ? { reason: W.sentBack(end.open), tone: "back" as const } : end.kind === "used up" ? { reason: W.stillOpen(end.open), tone: "back" as const } : { reason: passed };
    endAgentStep(task, { outcome, ...reason }, this.host.now());
    if (end.kind === "send back") {
      task.rounds[stage.id] = round + 1;
      if (task.repositories) {
        if (beginRepair(this.host, task, "review", task.stageIndex, { covered })) return "continue";
        this.host.releaseInput(task);
        // Continue through any remaining acceptance stage after the decision, before delivery approval.
        const delivery = task.plan!.stages.findIndex((entry, index) => index > task.stageIndex && entry.kind === "gate" && entry.gate === "delivery");
        if (delivery < 0) throw new Error("The plan has no delivery check after review");
        task.stageIndex += 1;
        task.sub = 0;
        this.host.note(task, "warn", "No builder can take the remaining findings, so the decision goes to you");
        task.reviewDecision = reviewDecisionFor(task, stage.id, round, this.host.now(), changes!);
        this.host.openDeliveryDecision(task);
        return "stop";
      }
      task.stageIndex = end.builder;
      task.sub = 0;
      task.fixing = true;
      this.host.note(task, "warn", `Sent back to the builder: ${findingCount(open)}`);
      this.host.changed(task);
      return "continue";
    }
    this.host.releaseInput(task);
    task.stageIndex += 1;
    task.sub = 0;
    if (end.kind === "used up") {
      this.host.note(task, "warn", `Review rounds used up: ${findingCount(open)} still open`);
      // With blocking findings left, the coordinator always looks before anything ships.
      task.reviewDecision = reviewDecisionFor(task, stage.id, round, this.host.now(), changes!);
      this.host.openDeliveryDecision(task);
      return "stop";
    } else {
      this.host.note(task, "done", `${port ? "Port review" : "Review"} passed: ${passedOpenWords(task.findings.filter((finding) => !exhaustedAcceptanceFailure(task as unknown as Task, finding)), covered)}`);
    }
    this.host.changed(task);
    return "continue";

  }
}
