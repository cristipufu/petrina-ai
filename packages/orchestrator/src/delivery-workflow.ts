import { beginPetrinaStep, companionText, completeAll, landingState, repositoryDelivered, syncRuntimeWait, undecidedAcceptanceGap } from "@petrina/core";
import type { RuntimeTask } from "./model.js";
import { executionFor, type RepositoryContext } from "./repository-context.js";
import type { DeliveryFailures, DeliveryPhaseEffects, DeliveryRecording, DeliveryStage, DeliveryWorkflowAdmission } from "./ports/delivery-workflow.js";

/** Actual delivery sequencing; the host retains native checks, source preparation and publication. */
export class DeliveryWorkflow {
  constructor(
    private readonly admission: DeliveryWorkflowAdmission,
    private readonly effects: DeliveryPhaseEffects,
    private readonly host: DeliveryRecording,
    private readonly failures: DeliveryFailures,
  ) {}

  /** Scheduler, native preparation and publication share the same admission decision. */
  beforePublishing(this: DeliveryWorkflow, scope: RepositoryContext, queuedCheck = false): void {
    const decision = this.admission.beforePublishing(scope, queuedCheck);
    if (decision.kind === "wait") throw this.failures.waiting(decision.reason);
    if (decision.kind === "refresh") throw this.failures.prerequisiteRefresh();
  }

  private stopIfAsked(this: DeliveryWorkflow, signal: AbortSignal): void {
    if (signal.aborted) throw this.failures.aborted();
  }

  async deliver(this: DeliveryWorkflow, task: RuntimeTask, stage: DeliveryStage, signal: AbortSignal): Promise<"continue" | "stop"> {
    try {
      if (task.repositories) {
        try { return await this.deliverMany(task, stage, signal); }
        finally {
          if (!this.host.stopped() && ["needs-you", "paused", "failed"].includes(task.state)) await this.clearUnpublishedPreparations(task);
        }
      }
      return await this.deliverOne(executionFor(task), stage, signal);
    } catch (error) {
      const failure = this.failures.classify(error);
      if (failure.kind === "decision" || failure.kind === "refresh") return "continue";
      throw error;
    } finally {
      // A conflict or renewed decision ends this delivery step even when the same driver carries on at a gate.
      if (task.plan?.stages[task.stageIndex]?.id !== stage.id) this.admission.releaseDeliveryTurn(task.id);
    }
  }


  async clearUnpublishedPreparations(this: DeliveryWorkflow, task: RuntimeTask): Promise<void> {
    for (const work of task.repositories!) {
      const scope: RepositoryContext = { task, work };
      if (work.pr || work.release || work.landed || work.shipping?.step || work.shipping?.pushed) continue;
      await this.effects.clearUnpublishedVersion(scope);
    }
  }


  private async deliverMany(this: DeliveryWorkflow, task: RuntimeTask, stage: DeliveryStage, signal: AbortSignal): Promise<"continue" | "stop"> {
    const epoch = this.admission.epoch(task);
    const lostTurn = () => epoch !== (this.admission.epoch(task));
    const closed = task.repositories!.filter((entry) => entry.pr?.state === "closed" && !entry.landingAccepted);
    const states = await completeAll(closed.map(work => {
      try { return this.effects.closedPullRequest({ task, work }); } catch (error) { return Promise.reject(error); }
    }));
    this.stopIfAsked(signal);
    for (const [index, work] of closed.entries()) {
      const state = states[index];
      if (state) work.pr!.state = state;
    }
    if (task.repositories!.some((work) => work.pr?.state === "closed" && !work.landingAccepted)) { this.finishMany(task); return "stop"; }
    // Complete preparation everywhere before the first publication. Already delivered records are immutable.
    for (const work of task.repositories!) {
      const scope: RepositoryContext = { task, work };
      if (repositoryDelivered(work)) continue;
      this.beforePublishing(scope);
      task.activeProductId = work.productId;
      if (scope.work.shipping?.step) {
        if (await this.effects.checkDelivery(scope, signal) === "stop" && !repositoryDelivered(work)) return "stop";

        if (repositoryDelivered(work)) continue;
      }
      if (!scope.work.shipping?.prepared) {
        if (scope.work.delivery !== "local") await this.effects.needGitHub(task);
        if (await this.effects.readyToShip(scope, signal) === "back") return "continue";
        if (lostTurn()) { this.admission.invalidateUnpublishedPreparations(task); return "continue"; }
        this.beforePublishing(scope);
        if (scope.work.delivery !== "release" && scope.work.baseSha === await this.effects.head(scope)) {
          work.nothingToPublish = true;
          this.host.log(task, "done", `${scope.work.source!.product.name}: Nothing to publish`);
          this.host.checkpoint();
          continue;
        }
        const result = await this.effects.prepare(scope, stage, signal);
        if (result !== "ready") return result;
        // A question can release the turn while a helper is finishing. Discard its result too,
        // then restart the preparation pass so earlier products refresh before anything publishes.
        if (lostTurn()) { this.admission.invalidateUnpublishedPreparations(task); return "continue"; }
      }
    }
    // Even an unchanged product can ask a question and take the shortcut above. Every unfinished
    // product must belong to this preparation pass before the first publication is admitted.
    if (lostTurn()) { this.admission.invalidateUnpublishedPreparations(task); return "continue"; }
    const preview = companionText(task.repositories!);
    if (preview) for (const work of task.repositories!) {

      if (!work.nothingToPublish && (work.delivery === "pull-request" || work.source?.destination.kind === "update-pr")) work.companion ??= { text: preview, state: "pending" };
    }
    this.host.checkpoint();
    for (const work of task.repositories!) {
      const scope: RepositoryContext = { task, work };
      if (repositoryDelivered(work)) continue;
      this.beforePublishing(scope);
      task.activeProductId = work.productId;
      if (scope.work.shipping?.prepared?.body && preview) scope.work.shipping.prepared.body = `${scope.work.shipping.prepared.body.replace(/\n*Part of a change across: [^\n]*$/u, "")}\n\n${preview}`;
      const result = await this.deliverOne(scope, stage, signal);

      if (!repositoryDelivered(work)) return result;
      if (work.pr?.state === "closed" && !work.landingAccepted) { this.finishMany(task); return "stop"; }
      if (signal.aborted || task.state === "cancelled") return "stop";
      task.state = "running";
      this.host.checkpoint();
    }
    if (!await this.effects.finishCompanions(task)) return "stop";
    this.finishMany(task);
    return "stop";
  }


  finishMany(this: DeliveryWorkflow, task: RuntimeTask): void {

    const landed = landingState(task.repositories!);
    delete task.agent;
    task.holdsSlot = false;
    if (task.repositories!.every(repositoryDelivered) && task.repositories!.every((work) => !work.companion || work.companion.state === "done") && !task.deliveryRecorded) { this.host.delivered(task); task.deliveryRecorded = true; }
    if (landed === "unfinished") {
      task.state = "needs-you"; task.column = "ready"; task.statusLine = "Confirmed deliveries are saved. Unfinished deliveries need retry";
      if (!this.host.hasDecision(task.id, ["stuck", "shipping"])) this.host.raise(task, "stuck", "Resume the unfinished deliveries");
    } else if (landed === "decision") {
      task.state = "needs-you";
      task.column = "ready";
      const closed = task.repositories!.filter((work) => work.pr?.state === "closed" && !work.landingAccepted);
      task.statusLine = `${closed.map((work) => work.source!.product.name).join(", ")}: pull request closed without merging. Your decision is needed`;
      // The question belongs to the closed product, so the others keep their own recorded results.
      if (!this.host.hasDecision(task.id, ["shipping"])) this.host.raise({ task, work: closed[0]! }, "shipping", task.statusLine, { body: "Confirmed deliveries remain saved. Dependent tasks stay blocked until you explicitly decide this change has landed." });
    } else if (landed === "waiting") {
      task.state = "pr-open"; task.column = "ready"; task.statusLine = "Waiting for every pull request to merge";
    } else if (landed === "landed") {
      const fresh = task.state !== "done";
      task.state = "done"; task.column = "done"; task.statusLine = "All products have landed"; task.finishedAt ??= this.host.now();
      if (fresh) this.host.done(task);
    }
    syncRuntimeWait(task, id => this.host.taskDetails(id), this.host.now());
    this.host.checkpoint();
    this.host.schedule();
  }


  private async deliverOne(this: DeliveryWorkflow, scope: RepositoryContext, stage: DeliveryStage, signal: AbortSignal): Promise<"continue" | "stop"> {
    const { task, work: repository } = scope;
    this.stopIfAsked(signal);
    this.beforePublishing(scope);
    if (!repository.shipping?.step) {
      // Nothing starts shipping to GitHub without a GitHub login: no half-done delivery.
      if (repository.delivery !== "local") await this.effects.needGitHub(task);
      this.stopIfAsked(signal);
      if (!repository.shipping?.prepared) {
        if ((await this.effects.readyToShip(scope, signal)) === "back") return "continue";
        this.beforePublishing(scope);
        const prepared = await this.effects.prepare(scope, stage, signal);
        if (prepared !== "ready") return prepared;
      }
    }
    // Check preparation or release notes may have finished after admissions closed. Publishing
    // is its own step; an already-started delivery still settles all of its saved steps.
    this.beforePublishing(scope);
    // Petrina's own step on the journey, from its first look on GitHub until it went out.
    beginPetrinaStep(task, "delivery", this.host.now(), repository);
    // Looked up before publishing, and first after an interruption: what is already there is recorded, not made again.
    try {
      if ((await this.effects.checkDelivery(scope, signal)) === "stop") return "stop";
      if (task.proofRequests?.length && !await this.effects.proofApprovalCurrent(task, signal, true)) {
        await this.effects.returnForDecision(task, "proof");
        return "continue";
      }
      // After what already went out is recorded: a prepared delivery, a retry or work from before this check still asks first.
      if (undecidedAcceptanceGap(task)) {
        await this.effects.returnForDecision(task, "acceptance");
        return "continue";
      }
      return (await this.effects.publish(scope, signal)) === "done" ? "stop" : "continue";
    } catch (error) {
      const failure = this.failures.classify(error);
      if (failure.kind !== "source-moved") throw error;
      this.stopIfAsked(signal);
      await this.effects.prepareAgain(scope, failure.message);
      return "continue";
    }
  }

}
