// Coordinator checkpoint decisions. Validation precedes removal; state and recovery stay atomic.
import { acceptanceGap, afterChangesAsked, CALL_WORDS, checkProblem, endYouStep, JOURNEY_WORDS as W, repositoryPublished, reviewDecisionPending, type AcceptanceGap, type DeepMutable, type Id } from "@petrina/core";
import type { Kernel } from "./kernel.js";
import { executionFor, scopesFor } from "./repository-context.js";
import { beginRepair } from "./repositories.js";
import { destination, type Shipping } from "./shipping.js";
import type { Sources } from "./sources.js";

type CheckpointHost = Pick<Kernel, "s" | "task" | "takeItem" | "tracking" | "log" | "say" | "id" | "remember" | "checkStage" | "clearStep" | "stepNote" | "toWaiting" | "commit" | "commitNow" | "schedule" | "productOf" | "gate" | "role">;

export class Checkpoints {
  constructor(private readonly k: CheckpointHost, private readonly sources: Pick<Sources, "confirm">, private readonly shipping: Pick<Shipping, "clearDelivery">) {}

  approve(itemId: Id): void {
    const kind = this.k.s.inbox.find((entry) => entry.id === itemId)?.kind;
    if (kind && !["plan", "design", "delivery", "disagreement"].includes(kind)) throw new Error(`That is a ${kind} request. Answer it in your inbox; it has not been removed.`);
    const pending = this.k.s.inbox.find((entry) => entry.id === itemId);
    const pendingTask = pending && this.k.task(pending.taskId);
    if (pending?.kind === "delivery" && pendingTask && !reviewDecisionPending(pendingTask) && checkProblem({ repositories: pendingTask.repositories, checks: executionFor(pendingTask).work.checks })) {
      throw new Error("The product's checks are failing or unverified. Run the checks again or ask for changes; delivery has not been approved.");
    }
    if (pending?.kind === "plan" && pendingTask) this.sources.confirm(pendingTask);
    const item = this.k.takeItem(itemId);
    const task = item && this.k.task(item.taskId);
    if (!item || !task) return;
    if (["plan", "design", "delivery", "disagreement"].includes(item.kind)) this.k.tracking.answered(task, item, "approved");
    switch (item.kind) {
      case "plan":
        this.k.log(task, "you", "You approved the plan");
        endYouStep(task, { outcome: W.approved, reason: W.youApproved }, Date.now());
        task.stageIndex = 0;
        break;
      case "design":
        this.k.log(task, "you", "You approved the design");
        endYouStep(task, { outcome: W.approved, reason: W.youApproved }, Date.now());
        task.stageIndex += 1;
        break;
      case "delivery":
        if (reviewDecisionPending(task)) {
          task.reviewDecision!.accepted = true;
          this.k.log(task, "you", "You accepted the unresolved review for final verification; delivery is not approved");
          endYouStep(task, { outcome: "Continue to final checks", reason: "unresolved review accepted; delivery is not approved" }, Date.now());
          break;
        }
        this.k.log(task, "you", "You approved the delivery");
        if (task.proofRequests?.length) task.approvedProofDecision = structuredClone(task.checkedProofDecision);
        // Approval covers the required acceptance gap shown here; its items stay unverified.
        const gap = acceptanceGap(task);
        if (gap) task.approvedAcceptanceGap = gap as DeepMutable<AcceptanceGap>;
        else delete task.approvedAcceptanceGap;
        endYouStep(task, { outcome: W.approved, reason: W.youApproved }, Date.now());
        for (const scope of scopesFor(task)) {
          scope.work.approvedSha = scope.work.checkedSha;
          scope.work.approvedPatch = scope.work.checkedPatch;
          scope.work.approvedFor = { by: "coordinator", mode: scope.work.delivery, destination: destination(scope.work, this.k.productOf(scope)) };
        }
        // After review rounds ran out, the check was raised on the delivery stage itself.
        if (task.plan?.stages[task.stageIndex]?.kind === "gate") task.stageIndex += 1;
        break;
      case "disagreement":
        this.k.log(task, "you", "You sided with the architect");
        endYouStep(task, { outcome: W.sided, reason: W.youSided }, Date.now());
        for (const objection of task.objections) {
          if (objection.status !== "open") continue;
          objection.status = "rejected";
          objection.decidedBy = "coordinator";
        }
        task.stageIndex += 1;
        break;
      default:
        return;
    }
    task.sub = 0;
    this.k.toWaiting(task);
    this.k.commit();
    this.k.schedule();
  }

  requestChanges(itemId: Id, note: string): void {
    // Refused, not dropped: the window keeps the note to send again.
    if (!this.k.s.inbox.some((entry) => entry.id === itemId)) throw new Error("That check isn't waiting any more, so your note wasn't applied. Send it again on the task.");
    const item = this.k.takeItem(itemId);
    const task = item && this.k.task(item.taskId);
    const scope = task ? executionFor(task) : undefined;
    if (!item || !task) return;
    this.k.tracking.answered(task, item, "changes");
    const call = item.kind === "disagreement";
    this.k.log(task, "you", call ? CALL_WORDS.made(note) : `You asked for changes: ${note}`);
    this.k.say(task, "you", note);
    endYouStep(task, call ? { outcome: W.madeCall, reason: W.yourCall, tone: "back" } : { outcome: W.changes, reason: W.changesAsked, tone: "back" }, Date.now());
    const id = this.k.id(task.id);
    // A review decision is asked after the flow moved past its review: the note belongs to that review, not the next stage,
    // and so does the same check raised again below. What an older check never recorded stays unknown.
    const decided = this.k.checkStage(task, item);
    this.k.remember(task, note, id, item.kind, decided);
    // The call reaches the architect in a section of its own; any other note goes to the next agent.
    if (!call) task.queued.push({ id, text: note, at: Date.now() });
    // The change request starts the next step: it is the first thing that step keeps (a call is kept on the task).
    // Nothing was working on a step at a check, so it leaves no record.
    this.k.clearStep(task);
    if (!call) this.k.stepNote(task, "changes", note, { id });
    const fromCheck = task.stageIndex;
    afterChangesAsked(task, item.kind, note, Date.now(), this.k.s.roles);
    if (item.kind === "delivery") {
      delete task.proofRefreshes;
      delete task.proofRefreshBlocked;
      delete task.approvedProofDecision;
      delete task.checkedProofDecision;
      delete task.approvedAcceptanceGap;
      delete task.acceptanceRun;
      delete task.proofRetestReason;
      // A new coordinator request authorizes another bounded attempt at acceptance fixes.
      delete scope!.work.acceptanceReturns;
      delete task.acceptanceBlocked;
      delete task.acceptanceUnverified;
      // The Guide keeper looks for what reviewers missed, only when they had passed it: if Important findings
      // were open (the rounds ran out), the reviewers had caught it, and nothing was missed.
      if (!task.findings.some((finding) => finding.status === "open" && finding.severity === "blocking")) task.miss = { note, at: Date.now() };
      this.shipping.clearDelivery(scope!);
      if (task.repositories) {

        for (const work of task.repositories) if (!repositoryPublished(work)) delete work.acceptanceReturns;
        const open = task.findings.filter((finding) => finding.status === "open" && finding.severity === "blocking");
        if (open.length) {
          const review = task.plan!.stages.findIndex((stage, index) => index > task.stageIndex && stage.kind === "review-chain");
          // A check problem raised before the review (at acceptance testing) returns there, then walks on through review.
          const back = review >= 0 && fromCheck > task.stageIndex && fromCheck < review ? fromCheck : review;
          if (!beginRepair(this.k, task, "review", back)) {
            task.stageIndex = fromCheck;
            this.k.gate(task, "delivery", undefined, undefined, decided);
            return;
          }
        } else {
          const products = task.repositories.filter((work) => !repositoryPublished(work)).map((work) => work.productId);
          const lead = task.leadProductId;
          if (lead && products.includes(lead)) products.splice(0, 0, ...products.splice(products.indexOf(lead), 1));
          if (!products.length) { task.stageIndex = fromCheck; this.k.gate(task, "delivery", undefined, undefined, decided); return; }
          task.repair = { products, index: 0, returnStage: task.stageIndex + 1, kind: "review" };
          task.activeProductId = products[0]!;
          task.fixing = true;
        }
      }
    }
    this.k.toWaiting(task);
    this.k.commitNow();
    this.k.schedule();
  }

}
