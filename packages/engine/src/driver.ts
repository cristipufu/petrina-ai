import {
  WaitSourceRefresh,
  DeliveryCheckpoint,
  AcceptancePreflight,
  AgentWorkflow,
  recoverStartupWork,
  type AgentAdmissionDependencies,
  type AgentAdmissionCatalog,
  type AgentAdmissionReadiness,
  type AgentAdmissionErrors,
  type ParticipantAdmission,
  type WorkspacePreparation,
  type AcceptancePreparation,
  type DeliveryCheckpointPreparation
} from "@petrina/orchestrator";
import { executionFor, nextWorkspaceProduct, type RepositoryContext } from "@petrina/orchestrator";
// Scheduling and the task driver: who gets a slot next, the loop that runs a task's stages and stops at
// checkpoints, and putting interrupted work back in line after a restart.

import { committedCodeOf, versionsOf, designWorkKey, invalidateAcceptance } from "./repositories.js";
import { shipsUnasked } from "@petrina/core";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Id } from "@petrina/core";
import * as git from "@petrina/repositories/git";
import { Kernel, Aborted, type RuntimeTask, type MutableStage, PLANNER_PROFILE, ScreenWait, SourceRefreshRequired } from "./kernel.js";
import { WaitingForUsage, WaitingForCapacity, waitingFor } from "./usage.js";
import type { Sources } from "./sources.js";
import type { Planning } from "./planning.js";
import type { Work } from "./work.js";
import type { Design } from "./design.js";
import type { Reviews } from "./review.js";
import { CheckPreparationChanged, type ProductChecks } from "./product-checks.js";
import type { GuideKeeper } from "./guide-keeper.js";
import type { Updates } from "./update.js";
import type { Learnings } from "./learnings.js";
import type { Connections } from "./connection.js";
import { destination, needsReleaseManager, type Shipping } from "./shipping.js";

export class Driver {
  readonly workflow: AgentWorkflow;
  readonly agentAdmission: AgentAdmissionDependencies & { participant: ParticipantAdmission };
  private readonly checkpoint: DeliveryCheckpoint;
  private readonly acceptancePreflight: AcceptancePreflight;
  private readonly waitRefresh: WaitSourceRefresh;
  constructor(
    private readonly k: Kernel,
    planning: Planning,
    work: Work,
    design: Design,
    reviews: Reviews,
    private readonly checks: ProductChecks,
    guide: GuideKeeper,
    updates: Updates,
    learnings: Learnings,
    private readonly shipping: Shipping,
    private readonly connections: Connections,
    private readonly sources: Sources,
  ) {
    this.acceptancePreflight = new AcceptancePreflight({
      role: (id, task) => k.role(id, task), blocked: task => checks.blocked(task),
      backToBuilder: (scope, products) => checks.backToBuilder(scope, "before acceptance testing", products),
    }, {
      upToDate: (scope, signal) => updates.upToDate(scope, signal),
      ensureChecks: (scope, signal) => checks.ensureChecks(scope, signal),
      failing: (scope, signal, required, prepare) => checks.failing(scope, signal, required, "acceptance", prepare),
      preparationChanged: error => error instanceof CheckPreparationChanged,
    });
    this.waitRefresh = new WaitSourceRefresh({
      due: task => k.taskSourceRefreshDue(task), stepStarted: task => k.taskStepStarted(task),
      checkpoint: () => k.commitNow(), note: (task, tone, text) => k.log(task, tone, text), aborted: () => new Aborted(),
    }, {
      clean: scope => git.isClean(scope.work.worktree!),
      clearUnpublishedVersion: (scope, preserve) => shipping.clearUnpublishedVersion(scope, preserve),
      update: (scope, signal) => updates.upToDate(scope, signal, true, true),
    });
    const ownership = { drivers: k.drivers, settling: k.settling, pendingAdmissions: k.pendingAgentAdmissions, groups: k.screenGroups };
    const catalog: AgentAdmissionCatalog = {
      profile: id => k.profile(id), role: (id, task) => k.role(id, task), onUsable: id => k.onUsable(id),
      choose: (request, task, room) => k.choose(request.profileId, task, request.roleId, room, request.reviewerKey),
    };
    const readiness: AgentAdmissionReadiness = {
      hold: (task, need) => k.readiness.hold(task, need), open: need => k.readiness.open(need),
      resolve: need => k.readiness.resolve(need), resolveHeld: (need, signal, yieldPlace) => k.readiness.resolveHeld(need, signal, yieldPlace),
      yieldHeld: task => k.readiness.yieldHeld(task), charge: (task, need, key) => k.readiness.charge(task, need, key),
    };
    const errors: AgentAdmissionErrors = {
      aborted: () => new Aborted(), sourceRefresh: () => new SourceRefreshRequired(), screenWait: () => new ScreenWait(), usage: words => new WaitingForUsage(words),
      classify: error => error instanceof WaitingForUsage ? { kind: "usage", error, words: error.words, capacity: error instanceof WaitingForCapacity }
        : error instanceof Aborted ? { kind: "abort" } : error instanceof ScreenWait ? { kind: "screen" } : error instanceof SourceRefreshRequired ? { kind: "source-refresh" } : { kind: "failure" },
      waitingFor: words => {
        const error = waitingFor(words);
        return { error, words: error.words, capacity: error instanceof WaitingForCapacity };
      },
    };
    const shared = { ownership, catalog, readiness, errors };
    this.checkpoint = new DeliveryCheckpoint({
      admissionsClosed: task => k.taskAdmissionsClosed(task), admissionWait: task => k.taskAdmissionWait(task), column: task => k.columnFor(task),
      role: (id, task) => k.role(id, task), blocked: task => checks.blocked(task),
      note: (task, tone, text) => k.log(task, tone, text), checkpoint: () => k.commit(), gate: task => k.gate(task, "delivery"),
      shipsUnasked: task => this.shipsUnasked(task), destination: scope => destination(
        scope.work,
        k.s.products.find(product => product.id === scope.work.productId)
      ),
    }, {
      writeGuide: scope => guide.writeGuide(scope), writeLearnings: scope => learnings.write(scope),
      upToDate: (scope, signal) => {
        updates.clearObservedHead(scope);
        return updates.upToDate(scope, signal);
      },
      checksBeforeDelivery: (scope, signal, prepare) => checks.checksBeforeDelivery(scope, signal, prepare), offerLearnings: scope => learnings.offer(scope),
      previewRelease: async (
        scope,
        stage,
        signal
      ) => {
        updates.clearObservedHead(scope);
        await shipping.releases.previewRelease(
        scope,
        stage,
        signal
      );
        updates.clearObservedHead(scope);
      },
      head: scope => {
        const known = updates.consumeObservedHead(scope);
        return known ? Promise.resolve(known) : git.head(scope.work.worktree!);
      },
      patch: (scope, head) => updates.patch(scope, head), committedCode: task => committedCodeOf(task),
      invalidateAcceptance: (task, versions) => invalidateAcceptance(task, versions), versions: task => versionsOf(task),
      acceptanceVersion: (scope, versions) => checks.acceptanceVersion(scope, versions),
    });
    this.workflow = new AgentWorkflow({
      state: () => k.s, activeState: () => k.activeState(), task: id => k.task(id), taskDetails: id => k.taskDetails(id), now: () => Date.now(),
      stopped: () => k.stopped, draining: () => k.draining, drainLine: () => k.drainLine,
      admissionsClosed: task => k.taskAdmissionsClosed(task), admissionWait: task => k.taskAdmissionWait(task), sourceRefreshDue: task => k.taskSourceRefreshDue(task), stepStarted: task => k.taskStepStarted(task),
      blockers: task => k.blockers(task), column: task => k.columnFor(task), pauseStep: task => k.pauseStep(task), waitForUsage: (
        task,
        words
      ) => k.waitForUsage(
        task,
        words
      ),
      syncScreen: () => k.syncScreen(), syncDeliveryTurns: () => shipping.syncDeliveryTurns(), waitingForDelivery: task => shipping.waitingForTurn(task), expireLimits: () => { k.expireLimits(); }, armLimitTimer: () => k.armLimitTimer(),
      changed: () => k.commit(), checkpoint: task => k.commitNow(task), note: (
        task,
        tone,
        text
      ) => k.log(
        task,
        tone,
        text
      ), gate: (
        task,
        kind
      ) => k.gate(
        task,
        kind
      ), failed: (
        id,
        error
      ) => k.fail(
        id,
        error
      ), beginStage: scope => k.tracking.beginStage(scope),
      tidy: id => k.tidy(id), schedule: () => k.schedule(), idleChanged: () => k.syncIdleSleep(),
      trackWork: work => k.trackWork(work), reportDriverError: (id, error) => { console.error(`Could not finish task ${id}:`, error); },
    }, {
      ...shared, plannerProfileId: PLANNER_PROFILE,
      checkPreparation: { claim: id => checks.claimPreparation(id), release: id => checks.releasePreparation(id) },
      phases: {
        prepareWorkspace: (
          task,
          stage,
          signal
        ) => this.prepareWorkspace(
          task,
          stage,
          signal
        ), prepareAcceptance: (
          scope,
          signal
        ) => this.prepareAcceptance(
          scope,
          signal
        ), deliveryCheckpoint: (
          scope,
          signal
        ) => this.deliveryCheckpoint(
          scope,
          signal
        ),
        planner: (
          task,
          signal
        ) => planning.runPlanner(
          task,
          signal
        ), doStage: (
          scope,
          stage,
          signal
        ) => work.runDo(
          scope,
          stage,
          signal
        ), converge: (
          scope,
          stage,
          signal
        ) => design.runConverge(
          scope,
          stage,
          signal
        ), review: (
          task,
          stage,
          signal
        ) => reviews.runReview(
          task,
          stage,
          signal
        ), delivery: (
          task,
          stage,
          signal
        ) => shipping.deliver(
          task,
          stage,
          signal
        ),
        nextReviewer: (
          task,
          stage
        ) => reviews.nextAgent(
          task,
          stage
        ), deliveryNeedsAgent: scope => needsReleaseManager(scope.work), carriedOver: task => shipping.askCarriedOver(task),
        clearUnpublishedOnFailure: task => this.clearUnpublishedOnFailure(task), finish: (id, signal) => this.finish(id, signal),
      },
    });
    this.agentAdmission = { ...shared, participant: this.workflow };
  }

  syncRuntimeWaits(): void { this.workflow.syncRuntimeWaits(); }
  schedule(): void { this.workflow.schedule(); }
  startDriver(taskId: Id, resume = false): void { this.workflow.startDriver(taskId, resume); }

  private async prepareWorkspace(current: RuntimeTask, stage: MutableStage | undefined, signal: AbortSignal): Promise<WorkspacePreparation> {
    await this.k.agentCleanup.wait(current.id);
    let scope = executionFor(current);
    // A restart can find the working copy detached by an interrupted commit hook. Put it back before
    // review or delivery reads that original starting version as the task's work.
    if (scope.work.worktree && scope.work.hooking) await this.recoverHook(scope);
    if (await this.refreshAfterWait(current, signal)) return { kind: "repeat" };
    // The copy waits until the starting point is confirmed. While the plan check is still open it waits
    // too, including for the default branch, so that check can still change the product, the start or the delivery.
    if (current.repositories && !current.confirmWork && current.stageIndex >= 0) {
      for (const work of current.repositories) {
        const scope: RepositoryContext = { task: current, work };
        current.activeProductId = work.productId;
        await this.sources.addApproved(current, work.productId, signal);
        if (work.preparation !== "ready") {
          await this.prepare(scope, signal);
          work.preparation = "ready";
          this.k.commitNow();
        }
      }
      if (stage?.kind === "do" && this.k.role(stage.roleId, current)?.canEdit) for (const work of current.repositories) {
        const scope: RepositoryContext = { task: current, work };
        current.activeProductId = work.productId;
        if (work.pr || work.release || work.landed) continue;
        await this.shipping.clearUnpublishedVersion(scope);
      }
      const editing = stage && this.k.role(stage.roleId, current)?.canEdit && (stage.kind === "do" || (stage.kind === "converge" && current.sub === 0));
      const progress = stage?.kind === "converge" ? designWorkKey(current, stage.id) : stage?.id;
      const nextProduct = nextWorkspaceProduct(current, editing ? progress : undefined);
      current.activeProductId = nextProduct;
      scope = executionFor(current);
    }
    if (current.maintenance && !scope.work.source) {
      if (!this.k.s.products.some(product => product.id === current.maintenance!.product.id)) throw new Error("The maintenance product was removed. This run cannot change products.");
      scope.work.source = { ...await this.sources.resolve(current, scope.work.workChoice!, current.maintenance.product), confirmed: true };
      this.k.commitNow(current);
    }
    if (!scope.work.worktree && this.sourceSettled(current) && (current.stageIndex >= 0 || !current.approvePlan)) await this.prepare(scope, signal);
    // A release can precede the first working copy. Preparation must not admit the next step
    // until every owner has also crossed the strict post-wait source boundary.
    if (await this.refreshAfterWait(current, signal)) return { kind: "repeat" };
    if (current.stageIndex >= 0 && !scope.work.worktree) {
      this.k.gate(current, "plan");
      return { kind: "stop" };
    }
    return { kind: "ready", scope };
  }

  private deliveryCheckpoint(scope: RepositoryContext, signal: AbortSignal): Promise<DeliveryCheckpointPreparation> {
    return this.checkpoint.run(scope, signal);
  }

  private async prepareAcceptance(scope: RepositoryContext, signal: AbortSignal): Promise<AcceptancePreparation> {
    return this.acceptancePreflight.run(scope, signal);
  }

  private async clearUnpublishedOnFailure(current: RuntimeTask): Promise<void> {
    await this.k.agentCleanup.wait(current.id);
    if (current.repositories) {
      for (const work of current.repositories) {
        const scope: RepositoryContext = { task: current, work };
        if (work.pr || work.release || work.landed || work.shipping?.step || work.shipping?.pushed) continue;
        await this.shipping.clearUnpublishedVersion(scope);
      }
    }
  }
  private async finish(taskId: Id, signal: AbortSignal): Promise<void> {
      // Cancelled during a publishing step: what went out is looked up and kept.
      try {
        if (signal.aborted && !this.k.stopped) await this.shipping.monitor.settleCancelled(taskId, true);
      } finally { this.shipping.finishDeliveryTurn(taskId); }
  }

  /** Reuse ordinary source updates and evidence gates; waiting itself changes no conversations or rounds. */
  private refreshAfterWait(task: RuntimeTask, signal: AbortSignal): Promise<boolean> {
    return this.waitRefresh.run(task, signal);
  }

  /** An interrupted commit hook left the working copy detached. The task's commit is still on its branch. */
  private async recoverHook(scope: RepositoryContext): Promise<void> {
    if (!scope.work.worktree || !scope.work.hooking || !scope.work.branch) return;
    await git.reattach(scope.work.worktree, scope.work.branch);
    delete scope.work.hooking;
    this.k.commit();
  }

  /** The starting point is recorded and confirmed, and no proposed change is still waiting. */
  private sourceSettled(task: RuntimeTask): boolean {
    const scope = executionFor(task);
    if (task.confirmWork || task.workError || task.proposedSource) return false;
    // Planning is still open, so the planner may change the starting point. Nothing is fetched yet.
    if (task.stageIndex < 0 && !task.plan) return false;
    if (scope.work.source) return scope.work.source.confirmed;
    // A task already past planning, from before starting points were recorded, keeps a copy.
    return task.stageIndex >= 0;
  }

  private async prepare(scope: RepositoryContext, signal: AbortSignal): Promise<void> {
    const { task } = scope;
    await this.k.copyCleanups.get(task.id);
    if (signal.aborted) throw new Aborted();
    const product = this.k.repositoryOf(scope);
    if (!product?.path) throw new Error(`${product?.name ?? "This product"} has no local copy`);
    const own = task.repositories?.find((work) => work.productId === scope.work.productId);
    const savedCopy = own?.preparingCopy;
    const branch = scope.work.branch ?? savedCopy?.branch ?? git.branchName(task.title, task.id);
    const worktree = scope.work.worktree ?? savedCopy?.path ?? join(this.k.dataDir, "worktrees", product.id, task.id);
    const defaultBranch = product.defaultBranch ?? "main";
    let base = savedCopy?.base ?? defaultBranch;
    if (!savedCopy && !scope.work.worktree && scope.work.source?.start.kind !== "default") {
      const fetched = await this.sources.fetch(scope, signal);
      base = fetched.sha;
    }
    // A new working copy starts from the latest main: GitHub's for GitHub deliveries, the main clone's own for local ones.
    if (!savedCopy && !scope.work.worktree && scope.work.delivery !== "local" && (!scope.work.source || scope.work.source.start.kind === "default")) {
      const fetched = await this.connections.fetchDefault(scope, signal);
      // A stalled or refused fetch never holds a task: it works from the local copy.
      if (!fetched.ok && !fetched.missing) this.k.log(
        scope,
        "warn",
        `${fetched.timedOut ? "GitHub did not answer in time" : `Did not update from GitHub: ${this.connections.why(
        scope,
        fetched
      )}`}, so this task starts from the local copy`
      );
      if (fetched.ok || await git.revParse(product.path, `refs/remotes/origin/${defaultBranch}`)) base = `origin/${defaultBranch}`;
    }
    if (!scope.work.worktree && scope.work.delivery === "local" && (!scope.work.source || scope.work.source.start.kind === "default") && base === defaultBranch && !existsSync(join(
      product.path,
      ".git",
      "refs",
      "heads",
      defaultBranch
    )) && !await git.revParse(
      product.path,
      `refs/heads/${defaultBranch}`
    )) {
      // A changed remote default can leave the approved branch only at origin. Passing its
      // bare name makes git guess and attach the task copy to that destination branch.
      base = await git.revParse(product.path, `refs/remotes/origin/${defaultBranch}`) ?? base;
      if (savedCopy && savedCopy.base !== base) {
        savedCopy.base = base;
        this.k.commitNow();
      }
    }
    // Stopped before its first copy was made: none is made. Only cancellation removes a newly made copy;
    // a pause, shutdown or resumed task keeps it, even though the old driver's signal is aborted.
    if (signal.aborted && !scope.work.worktree) throw new Aborted();
    if (own && !own.preparingCopy && (!scope.work.worktree || scope.work.baseSha == null || !scope.work.savedVersion)) {
      own.preparingCopy = { path: worktree, branch, base: await git.revParse(product.path, base) ?? base };
      this.k.commitNow();
    }
    await git.ensureWorktree(product.path, worktree, branch, own?.preparingCopy?.base ?? base);
    if (!scope.work.branch && !signal.aborted) this.k.log(scope, "milestone", "Set up a fresh working copy");
    scope.work.branch = branch;
    scope.work.worktree = worktree;
    if (signal.aborted) throw new Aborted();
    // Petrina stopped while a pre-commit hook ran: the working copy goes back on its branch first.
    if (scope.work.hooking) {
      await git.reattach(worktree, branch);
      delete scope.work.hooking;
    }
    if (signal.aborted) throw new Aborted();
    // Known before the builder starts, so it runs them too.
    await this.checks.noteHooks(scope);
    if (signal.aborted) throw new Aborted();
    scope.work.base = scope.work.base ?? base;
    const observed = scope.work.baseSha == null || !scope.work.savedVersion ? await git.commitVersion(worktree) : undefined;
    if (signal.aborted) throw new Aborted();
    // Pin the commit actually checked out, before any agent starts; a shared source ref may move meanwhile.
    // Keep HEAD's throwing fallback when the paired observation is unavailable.
    const baseSha = scope.work.baseSha ?? observed?.head ?? await git.head(worktree);
    if (signal.aborted) throw new Aborted();
    scope.work.baseSha = baseSha;
    if (scope.work.source && scope.work.baseSha) scope.work.source.initialSha ??= scope.work.baseSha;
    if (!scope.work.savedVersion) await this.k.rememberVersion(scope, observed);
    if (signal.aborted) throw new Aborted();
    if (own) delete own.preparingCopy;
    this.k.commit();
  }

  /**
   * After a restart, nothing is running: put interrupted work back in line. A question stays in the
   * inbox for the conversation that asked it, without a slot; an open permission request goes.
   */
  recover(): void {
    this.k.s.inbox = recoverStartupWork(this.k.s.tasks, this.k.s.inbox, {
      onDroppedPermission: (task, item) =>
        this.k.log(
          task,
          "warn",
          `Petrina restarted before you answered “${item.title}”, so it left your inbox. The agent will ask again if it still needs to`,
          item.roleId,
          item.profileId,
        ),
    });
  }

  /** Low-risk work skips the delivery check only where the coordinator opted in, with nothing left that needs them. */
  private shipsUnasked(task: RuntimeTask): boolean {
    const scope = executionFor(task);
    return shipsUnasked(
      task,
      {
      products: this.k.s.products,
      product: this.k.productOf(task),
      checks: scope.work.checks,
      checkSetup: scope.work.checkSetup,
      checkSetupInvalidated: scope.work.checkSetupInvalidated
    }
    );
  }
}
