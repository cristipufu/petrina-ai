import { beginPetrinaStep, endPetrinaStep, companionText, completeAll, landingState, repositoryDelivered, syncRuntimeWait, undecidedAcceptanceGap, petrinaMoment, lastIndexWhere, JOURNEY_WORDS as W } from "@petrina/core";
import { clearDeliveryPreparation } from "./delivery-return.js";
import { addDeliveryCheck } from "./delivery-gate.js";
import type { RuntimeTask } from "./model.js";
import { executionFor, scopesFor, type RepositoryContext, type RepositoryWork } from "./repository-context.js";
import type { DeliveryFailures, DeliveryPhaseEffects, DeliveryRecording, DeliveryStage, DeliveryWorkflowAdmission } from "./ports/delivery-workflow.js";

/** Whether the delivery step needs an agent now: only a release, for its notes, until they are written. */
export function needsReleaseManager(task: RepositoryWork): boolean {
  return task.delivery === "release" && !task.shipping?.prepared && !task.shipping?.step && !task.shipping?.carriedOver;
}

/** Preparations restarted after source movement, before asking the coordinator. */
const MAX_MOVES = 3;
/** Failed preparations before returning the decision to the coordinator. */
const MAX_FAILURES = 2;

/** Actual delivery sequencing; the host retains native checks, source preparation and publication. */
export class DeliveryWorkflow {
  constructor(
    private readonly admission: DeliveryWorkflowAdmission,
    private readonly effects: DeliveryPhaseEffects,
    private readonly host: DeliveryRecording,
    private readonly failures: DeliveryFailures,
  ) {}

  /** A known-unpublished version commit is preparation, so it never reaches an editing role. */
  async clearUnpublishedVersion(scope: RepositoryContext, preserveAttempts = false): Promise<void> {
    const { work: repository } = scope;
    if (!repository.shipping?.step && !repository.shipping?.pushed && repository.shipping?.start) {
      const { moves, failures } = repository.shipping;
      await this.effects.backToWork(scope);
      // Waiting invalidates the candidate, not the delivery attempts that actually happened.
      if (preserveAttempts) repository.shipping = { moves, failures };
      else delete repository.shipping;
      this.host.checkpoint();
    }
  }

  async readyToShip(scope: RepositoryContext, signal: AbortSignal): Promise<"ready" | "back"> {
    if (await this.readyCandidate(scope, signal) === "back") return "back";
    let order = this.effects.checkOrder(scope.task.id);
    const preparation = Object.assign(async () => await this.readyCandidate(scope, signal) === "ready", {
      beforeQueue: () => {
        this.beforePublishing(scope, true);
        const current = this.effects.checkOrder(scope.task.id);
        // A first turn follows the source preparation above. Only losing an existing turn
        // can make that preparation obsolete without a wait in the check line.
        const changed = order !== undefined && current !== order;
        order = current;
        return changed;
      },
    });
    if (await this.effects.checksBeforeShipping(scope, signal, preparation) !== "passed") return "back";
    const { task } = scope;
    if (task.proofRequests?.length && !await this.effects.proofApprovalCurrent(task, signal)) {
      await this.returnForDecision(task, "proof");
      return "back";
    }
    if (undecidedAcceptanceGap(task)) {
      await this.returnForDecision(task, "acceptance");
      return "back";
    }
    return "ready";
  }

  /** The same source and approval rule applies before queuing and again after a check-line wait. */
  async readyCandidate(scope: RepositoryContext, signal: AbortSignal): Promise<"ready" | "back"> {
    const { task, work: repository } = scope;
    // A version change from an earlier preparation is the delivery's, never the work's: it goes first.
    await this.effects.backToWork(scope);
    const check = lastIndexWhere(task.plan?.stages ?? [], (entry, index) => index < task.stageIndex && entry.gate === "delivery");
    const backToCheck = (line: string): "back" => {
      delete task.approvedProofDecision;
      delete task.approvedAcceptanceGap;
      this.clearApproval(scope);
      clearDeliveryPreparation(scope);
      task.stageIndex = check;
      task.sub = 0;
      petrinaMoment(task, "delivery", { outcome: W.askAgain, reason: W.changedSinceApproval, tone: "back" }, this.host.now());
      this.host.noteScope(scope, "warn", line);
      this.host.changed();
      return "back";
    };
    const allowed = repository.approvedFor;
    if (allowed && (allowed.mode !== repository.delivery || allowed.destination !== this.host.destination(scope))) {
      if (check >= 0) return backToCheck("Where it goes changed after it was approved, so it needs your OK again");
      this.clearApproval(scope);
    }
    // Before anything moves (an approval from before patch-ids were kept goes by its commit).
    const sourceName = this.host.sourceName(scope);
    const approved = repository.approvedPatch ?? (repository.approvedSha ? await this.effects.patch(scope, repository.approvedSha) : undefined);
    const update = await this.effects.upToDate(scope, signal);
    if (update === "conflict") return "back";
    const sameCommit = approved && check >= 0 && update === "current" && repository.approvedSha
      && await this.effects.head(scope).catch(() => undefined) === repository.approvedSha;
    if (approved && check >= 0 && !sameCommit && (await this.effects.patch(scope)) !== approved) {
      return backToCheck(update === "moved" ? `${sourceName === "main" ? "Main" : sourceName} moved on, and on top of it this change reads differently from what you approved, so Petrina asks you again` : "The work changed after you approved the delivery, so Petrina asks you again");
    }
    return "ready";
  }

  async preparationFailed(scope: RepositoryContext, summary: string, signal: AbortSignal): Promise<"continue" | "stop"> {
    const { task, work: repository } = scope;
    const shipping = repository.shipping!;
    await this.effects.backToWork(scope);
    const failures = shipping.failures + 1;
    const reason = /[.!?]$/.test(summary.trim()) ? summary.trim() : `${summary.trim()}.`;
    if (task.repositories) {
      // Only delivery preparation changed. Keep the reviewed work and its approval; no builder owns this failure.
      delete repository.shipping;
      this.host.clearStep(scope);

      await this.clearUnpublishedPreparations(task);
      // Check the restored work, so failures belonging only to the removed version do not reach a builder.
      const restoredChecks = await this.effects.restoredChecks(scope, signal);
      if (restoredChecks.kind === "blocked") { this.host.checksBlocked(task); return "stop"; }

      const delivery = lastIndexWhere(task.plan?.stages ?? [], (entry, index) => index < task.stageIndex && entry.kind === "gate" && entry.gate === "delivery");
      if (delivery < 0) throw new Error("The plan has no delivery check before release preparation");
      task.stageIndex = delivery;
      task.sub = 0;
      const problem = `${this.host.productName(scope)}: getting the release ready failed. ${reason} Nothing was published. Your approved work is saved; try delivery again or send it back with a note.`;
      this.host.noteScope(scope, "warn", problem);
      this.host.gate(task, problem);
      return "stop";
    }
    task.findings.push({ id: this.host.findingId(task), text: `Getting the delivery ready failed, so nothing was published: ${reason}`, severity: "blocking", raisedBy: "petrina", confirmedBy: [], status: "open" });
    repository.shipping = { moves: 0, failures };
    this.clearApproval(scope);
    delete task.agent;
    // Nothing was handed back, so no record for estimates.
    this.host.clearStep(scope);
    const builder = lastIndexWhere(task.plan?.stages ?? [], (entry) => this.host.role(entry.roleId, task)?.result === "build" && entry.kind === "do");
    if (builder >= 0) {
      task.stageIndex = builder;
      task.sub = 0;
      task.fixing = true;
    }
    this.host.noteScope(scope, "warn", `Not ready to publish: ${reason} Nothing was published; it goes back to the builder.`);
    this.host.checkpoint();
    if (failures < MAX_FAILURES && builder >= 0) return "continue";
    this.host.fail(task.id, new Error(`Getting the delivery ready failed ${failures} times, so Petrina stopped and published nothing. The last reason: ${reason} Try again to send it back to the builder, or cancel it.`));
    return "stop";
  }

  /** The default branch moved before a release or local delivery went out: Petrina gets it ready again. */
  async prepareAgain(scope: RepositoryContext, why: string): Promise<"again"> {
    const { task, work: repository } = scope;
    if (task.proofRequests?.length) {
      await this.returnForDecision(task, "proof");
      return "again";
    }
    const shipping = repository.shipping!;
    const branch = repository.source?.start.branch ?? this.host.defaultBranch(scope) ?? "main";
    if (shipping.moves >= MAX_MOVES) {
      // A Retry gets a fresh set of attempts.
      shipping.moves = 0;
      this.host.checkpoint();
      throw new Error(`${why} again: ${branch} kept moving while Petrina was delivering, so it stopped after ${MAX_MOVES} new preparations and published nothing. Retry when it is quiet.`);
    }
    // The version change goes: the work is brought up to date again, and gets a fresh version.
    await this.effects.backToWork(scope);
    repository.shipping = { ...(shipping.start ? { start: shipping.start } : {}), moves: shipping.moves + 1, failures: shipping.failures };
    const place = repository.source?.start.kind === "pull-request" ? `PR #${repository.source.start.number}` : branch;
    endPetrinaStep(task, { outcome: place === "main" ? W.mainMovedOn : `${place} moved on`, reason: W.readyAgain }, this.host.now());
    this.host.noteScope(scope, "warn", `${why}, so Petrina gets it ready again (${shipping.moves + 1} of ${MAX_MOVES})`);
    this.host.checkpoint();
    return "again";
  }


  /** Return every still-unpublished product to the same coordinator decision. */
  async returnForDecision(task: RuntimeTask, why: "proof" | "acceptance"): Promise<void> {
    // An approval with no record covering this run's unavailable items, such as one saved before Petrina kept that record.
    const approved = !!task.approvedAcceptanceGap || scopesFor(task).some(({ work }) => work.approvedFor?.by === "coordinator");
    for (const scope of scopesFor(task)) {
      if (scope.work.pr || scope.work.release || scope.work.landed || scope.work.shipping?.pushed) continue;
      await this.effects.backToWork(scope);
      this.clearApproval(scope);
      delete scope.work.shipping;
    }
    delete task.approvedProofDecision;
    delete task.checkedProofDecision;
    delete task.approvedAcceptanceGap;
    if (why === "acceptance") addDeliveryCheck(this.host, task);
    task.stageIndex = task.plan!.stages.findIndex(entry => entry.kind === "gate" && entry.gate === "delivery");
    if (task.stageIndex < 0) throw new Error(why === "proof" ? "Requested proof needs a coordinator delivery check before publishing." : "Unverified acceptance needs a coordinator delivery check before publishing.");
    task.sub = 0;
    if (why === "proof") {
      petrinaMoment(task, "delivery", { outcome: "Nothing published; a new delivery decision is needed", reason: "The versions or requested proof differ from your delivery decision", tone: "back" }, this.host.now());
      this.host.log(task, "warn", "Nothing more was published: the code versions or requested proof changed after the delivery decision. Petrina asks you again.");
    } else {
      petrinaMoment(task, "delivery", { outcome: "Nothing published; your delivery decision is needed", reason: "Required acceptance could not be verified", tone: "back" }, this.host.now());
      this.host.log(task, "warn", approved
        ? "Nothing was published: Petrina has no record that your approval covered the acceptance checks that could not be verified, so it asks you about them first."
        : "Nothing was published: required acceptance could not be verified and has no decision from you yet. Petrina asks you first.");
    }
    this.host.checkpoint();
  }

  clearApproval(scope: RepositoryContext): void {
    delete scope.work.approvedSha;
    delete scope.work.approvedPatch;
    delete scope.work.approvedFor;
  }

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
