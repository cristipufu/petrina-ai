// Delivering finished work, by Petrina itself, with no agent (except Release Manager notes).
// Every publishing step is saved before it starts, and an interrupted delivery is looked up before anything goes out again.

import { type Id, type ShippingStep } from "@petrina/core";
import {
  DeliveryAdmission, DeliveryRecovery, DeliveryWorkflow, type RepositoryContext,
} from "@petrina/orchestrator";
import * as git from "@petrina/repositories/git";
import { CompanionLinks } from "./companion-links.js";
import { Unreachable, type Connections } from "./connection.js";
import { Aborted, type Kernel, type MutableStage, type RuntimeTask } from "./kernel.js";
import { PrMonitor } from "./pr-monitor.js";
import type { ProductChecks } from "./product-checks.js";
import { ReleasePrep } from "./release-prep.js";
import {
  DecisionNeeded, destination, formatPullRequestBody, isProofApprovalCurrent, landLocalDelivery,
  needsReleaseManager, noteCancelledLocalDelivery, prepareDelivery, PrerequisiteRefresh,
  publishLocalDelivery, publishPrUpdateDelivery, publishPullRequestDelivery, publishReleaseDelivery,
  pushMainBranch, rememberConfirmedDelivery, resetBackToWork, SourceMoved, type ShippingPublishHooks,
} from "./shipping-publishers.js";
import { ShippingVerifier, type DeliveryEvidence } from "./shipping-verifier.js";
import type { ToolChecks } from "./tool-checks.js";
import type { Turns } from "./turn.js";
import type { Updates } from "./update.js";
import { WaitingForUsage } from "./usage.js";

/** A delivery from before the update, which Petrina leaves to the coordinator. */
export { CARRIED_OVER } from "@petrina/orchestrator";
export { destination, needsReleaseManager };

export class Shipping {
  readonly releases: ReleasePrep;
  readonly monitor: PrMonitor;
  readonly verifier: ShippingVerifier;
  private readonly companions: CompanionLinks;
  private readonly admission: DeliveryAdmission;
  private readonly workflow: DeliveryWorkflow;
  private readonly recovery: DeliveryRecovery;

  constructor(
    private readonly k: Kernel,
    private readonly turns: Turns,
    private readonly updates: Updates,
    private readonly checks: ProductChecks,
    private readonly connections: Connections,
    private readonly tools: ToolChecks,
  ) {
    this.admission = new DeliveryAdmission({
      task: (id) => k.task(id),
      roleResult: (id, task) => k.role(id, task)?.result,
      destination: (scope) => destination(scope.work, k.repositoryOf(scope)),
      branch: (scope) => scope.work.source?.destination.branch ?? k.repositoryOf(scope)?.defaultBranch ?? "main",
      reserveOrder: () => k.checkQueue.reserveOrder(),
      rememberOrder: (id, order) => checks.deliveryOrders.set(id, order),
      forgetOrder: (id) => { checks.deliveryOrders.delete(id); },
      hasOrder: (id) => checks.deliveryOrders.has(id),
      hasDriver: (id) => k.drivers.has(id),
      hasSettling: (id) => k.settling.has(id),
      taskAdmissionsClosed: (task) => k.taskAdmissionsClosed(task),
      taskAdmissionWait: (task) => k.taskAdmissionWait(task),
      admissionsClosed: () => k.admissionsClosed,
      poolPaused: () => k.s.pool.paused,
      draining: () => k.draining,
      stopped: () => k.stopped,
      extraRecovery: () => k.extraRecovery,
    });
    this.releases = new ReleasePrep(k, turns, connections);
    this.companions = new CompanionLinks(k);
    this.verifier = new ShippingVerifier(k, connections);
    this.workflow = new DeliveryWorkflow(
      this.admission,
      {
        restoredChecks: (scope, signal) => this.checks.failing(scope, signal, undefined, "publishing"),
        closedPullRequest: ({ work }) => k.github.prState(work.source!.product.repo, work.pr!.number),
        needGitHub: (task) => this.tools.needGitHub(task),
        readyToShip: (scope, signal) => this.readyToShip(scope, signal),
        head: (scope) => {
          const observed = this.updates.consumeObservedHead(scope);
          return observed ? Promise.resolve(observed) : git.head(scope.work.worktree!);
        },
        patch: (scope, ref) => this.updates.patch(scope, ref),
        upToDate: (scope, signal) => {
          this.updates.clearObservedHead(scope);
          return this.updates.upToDate(scope, signal, true);
        },
        checkOrder: (taskId) => this.checks.deliveryOrders.get(taskId),
        checksBeforeShipping: async (scope, signal, preparation) => {
          this.updates.clearObservedHead(scope);
          try {
            return await this.checks.checksBeforeShipping(scope, signal, preparation);
          } finally {
            this.updates.clearObservedHead(scope);
          }
        },
        prepare: (scope, stage, signal) => this.prepare(scope, stage, signal),
        checkDelivery: (scope, signal) => this.checkDelivery(scope, signal),
        proofApprovalCurrent: (task, signal, prepared) => this.proofApprovalCurrent(task, signal, prepared),
        returnForDecision: (task, why) => this.returnForDecision(task, why),
        backToWork: (scope) => this.backToWork(scope),
        publish: (scope, signal) => this.publish(scope, signal),
        prepareAgain: (scope, why) => this.prepareAgain(scope, why),
        clearUnpublishedVersion: (scope) => this.clearUnpublishedVersion(scope),
        finishCompanions: (task) => this.companions.finish(task),
      },
      {
        clearStep: (scope) => k.clearStep(scope),
        checksBlocked: (task) => this.checks.blocked(task),
        productName: (scope) => k.repositoryOf(scope)!.name,
        defaultBranch: (scope) => k.repositoryOf(scope)?.defaultBranch,
        findingId: (task) => k.id(task.id),
        gate: (task, problem) => k.gate(task, "delivery", problem),
        fail: (id, error) => k.fail(id, error),
        changed: () => k.commit(),
        noteScope: (scope, tone, text) => k.log(scope, tone, text),
        destination: (scope) => destination(scope.work, k.repositoryOf(scope)),
        sourceName: (scope) =>
          scope.work.source?.start.kind === "pull-request"
            ? `PR #${scope.work.source.start.number}`
            : (scope.work.source?.start.branch ?? k.repositoryOf(scope)?.defaultBranch ?? "main"),
        stopped: () => k.stopped,
        now: () => Date.now(),
        taskDetails: (id) => k.taskDetails(id),
        role: (id, task) => k.role(id, task),
        hasDecision: (taskId, kinds) => k.s.inbox.some((item) => item.taskId === taskId && kinds.includes(item.kind)),
        raise: (target, kind, title, details) => { k.raise(target, kind, title, false, details); },
        log: (task, tone, text) => k.log(task, tone, text),
        delivered: (task) => k.tracking.delivered(task),
        done: (task) => k.onTaskDone?.(task),
        checkpoint: () => k.commitNow(),
        schedule: () => k.schedule(),
      },
      {
        aborted: () => new Aborted(),
        waiting: (reason) => new WaitingForUsage(reason),
        prerequisiteRefresh: () => new PrerequisiteRefresh(),
        classify: (error) =>
          error instanceof DecisionNeeded
            ? { kind: "decision" }
            : error instanceof PrerequisiteRefresh
              ? { kind: "refresh" }
              : error instanceof SourceMoved
                ? { kind: "source-moved", message: error.message }
                : { kind: "other" },
      },
    );
    this.recovery = new DeliveryRecovery(
      {
        get state() { return k.s; },
        get boot() { return k.boot; },
        now: () => Date.now(),
        task: (id) => k.task(id),
        repository: (scope) => k.repositoryOf(scope),
        taskDetails: (id) => k.taskDetails(id),
        log: (target, tone, text) => k.log(target, tone, text),
        raise: (target, kind, title, blocking, extra) => { k.raise(target, kind, title, blocking, extra); },
        commit: () => k.commit(),
        commitNow: () => k.commitNow(),
        delivered: (target) => k.tracking.delivered(target),
        done: (task) => k.onTaskDone?.(task),
        takeItem: (id) => k.takeItem(id),
        toWaiting: (task) => k.toWaiting(task),
        clearStep: (task) => k.clearStep(task),
        schedule: () => k.schedule(),
        tidy: (id) => k.tidy(id),
      },
      {
        lookForDelivery: (scope) => this.verifier.lookForDelivery(scope),
        noteCancelledLocal: (scope) => this.noteCancelledLocal(scope),
        landLocal: (scope, signal, tested, how) => this.landLocal(scope, signal, tested, how),
        rememberDelivery: (scope, sha, branch) => this.rememberDelivery(scope, sha, branch),
        clearApproval: (scope) => this.clearApproval(scope),
        finishMany: (task) => this.finishMany(task),
        checkUnrecordedPullRequest: (scope) => this.monitor.checkUnrecordedPullRequest(scope),
      },
      { aborted: () => new Aborted(), unreachable: (text) => new Unreachable(text) },
    );
    this.monitor = new PrMonitor(k, this.verifier, {
      recordDelivery: (scope, evidence, signal) => this.recordDelivery(scope, evidence, signal),
      finishMany: (task) => this.finishMany(task),
    });
  }

  private publishHooks(): ShippingPublishHooks {
    return {
      k: this.k,
      turns: this.turns,
      checks: this.checks,
      connections: this.connections,
      releases: this.releases,
      verifier: this.verifier,
      workflow: this.workflow,
      recovery: this.recovery,
      beforePublishing: (scope) => this.beforePublishing(scope),
      branchTip: (scope) => this.branchTip(scope),
      pullRequestBody: (scope) => this.pullRequestBody(scope),
      preparationFailed: (scope, summary, signal) => this.preparationFailed(scope, summary, signal),
      prepareAgain: (scope, why) => this.prepareAgain(scope, why),
      backToWork: (scope) => this.backToWork(scope),
      proofApprovalCurrent: (task, signal, prepared) => this.proofApprovalCurrent(task, signal, prepared),
      returnForDecision: (task, why) => this.returnForDecision(task, why),
      saveStep: (scope, step, status) => this.saveStep(scope, step, status),
      publishStep: (scope, signal, step, status, run) => this.publishStep(scope, signal, step, status, run),
      recordPr: (scope, pr, how) => this.recordPr(scope, pr, how),
      recordLanded: (scope, branch, sha, how) => this.recordLanded(scope, branch, sha, how),
      landLocal: (scope, signal, tested, how) => this.landLocal(scope, signal, tested, how),
      pushMain: (scope, signal, branch, at) => this.pushMain(scope, signal, branch, at),
    };
  }

  waitingForTurn(task: RuntimeTask): string | undefined { return this.admission.waitingForTurn(task); }
  releaseDeliveryTurn(taskId: Id): void { this.admission.releaseDeliveryTurn(taskId); }
  yieldForDecision(task: RuntimeTask): boolean { return this.admission.yieldForDecision(task); }
  finishDeliveryTurn(taskId: Id): void { this.admission.finishDeliveryTurn(taskId); }
  syncDeliveryTurns(): void { this.admission.syncDeliveryTurns(); }

  deliver(task: RuntimeTask, stage: MutableStage, signal: AbortSignal): Promise<"continue" | "stop"> {
    return this.workflow.deliver(task, stage, signal);
  }

  private beforePublishing(scope: RepositoryContext, queuedCheck = false): void {
    this.workflow.beforePublishing(scope, queuedCheck);
  }

  private finishMany(task: RuntimeTask): void { this.workflow.finishMany(task); }

  clearUnpublishedVersion(scope: RepositoryContext, preserveAttempts = false): Promise<void> {
    return this.workflow.clearUnpublishedVersion(scope, preserveAttempts);
  }

  private readyToShip(scope: RepositoryContext, signal: AbortSignal): Promise<"ready" | "back"> {
    return this.workflow.readyToShip(scope, signal);
  }

  private proofApprovalCurrent(task: RuntimeTask, signal: AbortSignal, prepared = false): Promise<boolean> {
    return isProofApprovalCurrent(this.k, this.releases, this.verifier, task, signal, prepared);
  }

  private returnForDecision(task: RuntimeTask, why: "proof" | "acceptance"): Promise<void> {
    return this.workflow.returnForDecision(task, why);
  }

  private prepare(scope: RepositoryContext, stage: MutableStage, signal: AbortSignal): Promise<"ready" | "continue" | "stop"> {
    return prepareDelivery(this.publishHooks(), scope, stage, signal);
  }

  private pullRequestBody(scope: RepositoryContext): string {
    return formatPullRequestBody(this.k, scope);
  }

  private preparationFailed(scope: RepositoryContext, summary: string, signal: AbortSignal): Promise<"continue" | "stop"> {
    return this.workflow.preparationFailed(scope, summary, signal);
  }

  private prepareAgain(scope: RepositoryContext, why: string): Promise<"again"> {
    return this.workflow.prepareAgain(scope, why);
  }

  private backToWork(scope: RepositoryContext): Promise<void> {
    return resetBackToWork(this.k, this.releases, (s) => this.branchTip(s), scope);
  }

  private branchTip(scope: RepositoryContext): Promise<string | undefined> {
    const { work: repository } = scope;
    return git.revParse(repository.worktree!, `refs/heads/${repository.branch!}`);
  }

  private clearApproval(scope: RepositoryContext): void {
    this.workflow.clearApproval(scope);
  }

  private async publish(scope: RepositoryContext, signal: AbortSignal): Promise<"done" | "again"> {
    const { work: repository } = scope;
    const hooks = this.publishHooks();
    if (repository.source?.start.kind === "pull-request") return publishPrUpdateDelivery(hooks, scope, signal);
    if (repository.source?.start.kind === "branch" && repository.delivery !== "release" && !(await this.verifier.sourceCurrent(scope, signal))) {
      return this.prepareAgain(scope, "The approved starting branch moved on GitHub");
    }
    if (repository.delivery === "pull-request") return publishPullRequestDelivery(hooks, scope, signal);
    if (repository.delivery === "release") return publishReleaseDelivery(hooks, scope, signal);
    return this.publishLocal(scope, signal);
  }

  private saveStep(scope: RepositoryContext, step: ShippingStep, status: string): void {
    const { task, work: repository } = scope;
    this.beforePublishing(scope);
    repository.shipping!.step = step;
    repository.shipping!.boot = this.k.boot;
    task.statusLine = status;
    this.k.commitNow();
  }

  private publishStep<T>(scope: RepositoryContext, signal: AbortSignal, step: ShippingStep, status: string, run: () => Promise<T>): Promise<T> {
    return this.connections.serial(scope.work.productId, () => {
      if (signal.aborted) throw new Aborted();
      this.saveStep(scope, step, status);
      return run();
    });
  }

  private publishLocal(scope: RepositoryContext, signal: AbortSignal): Promise<"done" | "again"> {
    return publishLocalDelivery(this.publishHooks(), scope, signal);
  }

  private landLocal(scope: RepositoryContext, signal: AbortSignal, tested: string, how?: "found" | "moved"): Promise<"done"> {
    return landLocalDelivery(this.publishHooks(), scope, signal, tested, how);
  }

  private pushMain(scope: RepositoryContext, signal: AbortSignal, branch: string, at: string): Promise<boolean> {
    return pushMainBranch(this.publishHooks(), scope, signal, branch, at);
  }

  private checkDelivery(scope: RepositoryContext, signal: AbortSignal) { return this.recovery.checkDelivery(scope, signal); }
  private recordDelivery(
    scope: RepositoryContext,
    evidence: DeliveryEvidence,
    signal: AbortSignal
  ) { return this.recovery.recordDelivery(
    scope,
    evidence,
    signal
  ); }
  private recordPr(scope: RepositoryContext, pr: { number: number; url: string; state: "open" | "merged" | "closed" }, how?: "opened" | "updated") {
    return this.recovery.recordPr(scope, pr, how);
  }
  private recordLanded(scope: RepositoryContext, branch: string, sha: string, how?: "found" | "moved") {
    return this.recovery.recordLanded(scope, branch, sha, how);
  }
  carryOverShipping(): void { this.recovery.carryOverShipping(); }
  askCarriedOver(task: RuntimeTask): void { this.recovery.askCarriedOver(task); }
  checkShipping(itemId: Id): void { this.recovery.checkShipping(itemId); }
  shipAgain(itemId: Id): void { this.recovery.shipAgain(itemId); }
  markDone(itemId: Id): void { this.recovery.markDone(itemId); }

  private noteCancelledLocal(scope: RepositoryContext): Promise<boolean | "unknown"> {
    return noteCancelledLocalDelivery(this.publishHooks(), scope);
  }

  private rememberDelivery(scope: RepositoryContext, sha: string, branch: string): Promise<void> {
    return rememberConfirmedDelivery(this.k, scope, sha, branch);
  }
}
