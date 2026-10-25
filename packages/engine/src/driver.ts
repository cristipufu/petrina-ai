import { AgentWorkflow, type AgentAdmissionCatalog, type AgentAdmissionReadiness, type AgentAdmissionErrors, type WorkspacePreparation, type AcceptancePreparation, type DeliveryCheckpointPreparation } from "@petrina/orchestrator";
import { executionFor, scopesFor, type RepositoryContext } from "@petrina/orchestrator";
// Scheduling and the task driver: who gets a slot next, the loop that runs a task's stages and stops at
// checkpoints, and putting interrupted work back in line after a restart.

import { committedCodeOf, versionsOf, designWorkKey, invalidateAcceptance } from "./repositories.js";
import { openProofs, proofDecision, proofTestNeeded, refreshProofs, requiredUnverified, sameVersions, shipsUnasked } from "@petrina/core";
import { join } from "node:path";
import { runtimeWaitHolds, withdrawAsks, type Id, type InboxItem } from "@petrina/core";
import * as git from "@petrina/repositories/git";
import { Kernel, Aborted, type MTask, type MStage, PLANNER_PROFILE, ScreenWait, SourceRefreshRequired, stepKey } from "./kernel.js";
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
  constructor(
    private readonly k: Kernel,
    planning: Planning,
    work: Work,
    design: Design,
    reviews: Reviews,
    private readonly checks: ProductChecks,
    private readonly guide: GuideKeeper,
    private readonly updates: Updates,
    private readonly learnings: Learnings,
    private readonly shipping: Shipping,
    private readonly connections: Connections,
    private readonly sources: Sources,
  ) {
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
      waitingFor: words => { const error = waitingFor(words); return { error, words: error.words, capacity: error instanceof WaitingForCapacity }; },
    };
    const shared = { ownership, catalog, readiness, errors };
    this.workflow = new AgentWorkflow({
      state: () => k.s, activeState: () => k.activeState(), task: id => k.task(id), taskDetails: id => k.taskDetails(id), now: () => Date.now(),
      stopped: () => k.stopped, draining: () => k.draining, drainLine: () => k.drainLine,
      admissionsClosed: task => k.taskAdmissionsClosed(task), admissionWait: task => k.taskAdmissionWait(task), sourceRefreshDue: task => k.taskSourceRefreshDue(task), stepStarted: task => k.taskStepStarted(task),
      blockers: task => k.blockers(task), column: task => k.columnFor(task), pauseStep: task => k.pauseStep(task), waitForUsage: (task, words) => k.waitForUsage(task, words),
      syncScreen: () => k.syncScreen(), syncDeliveryTurns: () => shipping.syncDeliveryTurns(), waitingForDelivery: task => shipping.waitingForTurn(task), expireLimits: () => { k.expireLimits(); }, armLimitTimer: () => k.armLimitTimer(),
      changed: () => k.commit(), checkpoint: task => k.commitNow(task), note: (task, tone, text) => k.log(task, tone, text), gate: (task, kind) => k.gate(task, kind), failed: (id, error) => k.fail(id, error), beginStage: scope => k.tracking.beginStage(scope),
      tidy: id => k.tidy(id), schedule: () => k.schedule(), idleChanged: () => k.syncIdleSleep(),
    }, {
      ...shared, plannerProfileId: PLANNER_PROFILE,
      checkPreparation: { claim: id => checks.claimPreparation(id), release: id => checks.releasePreparation(id) },
      phases: {
        prepareWorkspace: (task, stage, signal) => this.prepareWorkspace(task, stage, signal), prepareAcceptance: (scope, signal) => this.prepareAcceptance(scope, signal), deliveryCheckpoint: (scope, signal) => this.deliveryCheckpoint(scope, signal),
        planner: (task, signal) => planning.runPlanner(task, signal), doStage: (scope, stage, signal) => work.runDo(scope, stage, signal), converge: (scope, stage, signal) => design.runConverge(scope, stage, signal), review: (task, stage, signal) => reviews.runReview(task, stage, signal), delivery: (task, stage, signal) => shipping.deliver(task, stage, signal),
        nextReviewer: (task, stage) => reviews.nextAgent(task, stage), deliveryNeedsAgent: scope => needsReleaseManager(scope.work), carriedOver: task => shipping.askCarriedOver(task),
        clearUnpublishedOnFailure: task => this.clearUnpublishedOnFailure(task), finish: (id, signal) => this.finish(id, signal),
      },
    });
    k.agentAdmission = { ...shared, participant: this.workflow };
  }

  syncRuntimeWaits(): void { this.workflow.syncRuntimeWaits(); }
  schedule(): void { this.workflow.schedule(); }
  startDriver(taskId: Id, resume = false): void { this.workflow.startDriver(taskId, resume); }

  private async prepareWorkspace(current: MTask, stage: MStage | undefined, signal: AbortSignal): Promise<WorkspacePreparation> {
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
        if (work.preparation !== "ready") { await this.prepare(scope, signal); work.preparation = "ready"; this.k.commitNow(); }
      }
      if (stage?.kind === "do" && this.k.role(stage.roleId, current)?.canEdit) for (const work of current.repositories) {
        const scope: RepositoryContext = { task: current, work };
        current.activeProductId = work.productId;
        if (work.pr || work.release || work.landed) continue;
        await this.shipping.clearUnpublishedVersion(scope);
      }
      const editing = stage && this.k.role(stage.roleId, current)?.canEdit && (stage.kind === "do" || (stage.kind === "converge" && current.sub === 0));
      const progress = stage?.kind === "converge" ? designWorkKey(current, stage.id) : stage?.id;
      const nextProduct = current.repair?.products[current.repair.index] ?? (editing && progress ? current.repositories.find((work) => !work.completedStages.includes(progress))?.productId : undefined) ?? current.leadProductId ?? current.repositories[0]!.productId;
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
    if (current.stageIndex >= 0 && !scope.work.worktree) { this.k.gate(current, "plan"); return { kind: "stop" }; }
    return { kind: "ready", scope };
  }

  private async deliveryCheckpoint(scope: RepositoryContext, signal: AbortSignal): Promise<DeliveryCheckpointPreparation> {
    const current = scope.task;
    if (this.k.taskAdmissionsClosed(current)) {
      current.state = "waiting";
      current.holdsSlot = false;
      delete current.agent;
      current.column = this.k.columnFor(current);
      current.statusLine = this.k.taskAdmissionWait(current);
      this.k.commit();
      return { kind: "stop" };
    }
    const checking = scopesFor(current);
    let sentBack = false;
    for (const scope of checking) {
      const work = scope.work;
      if (current.repositories) { current.activeProductId = work.productId; if (work.pr || work.release || work.landed) continue; }
      await this.guide.writeGuide(scope);
      await this.learnings.write(scope);
      // What the coordinator checks is the work as it would land: one commit on top of the latest main.
      if ((await this.updates.upToDate(scope, signal)) === "conflict") { sentBack = true; break; }
      // Right before the coordinator is asked to ship, the checks run again on what would ship.
      const checkResult = await this.checks.checksBeforeDelivery(scope, signal, async () => await this.updates.upToDate(scope, signal) !== "conflict");
      if (checkResult === "returned") { sentBack = true; break; }
      if (checkResult === "exhausted") {
        this.checks.blocked(current);
        return { kind: "stop" };
      }
      await this.learnings.offer(scope);
      if (scope.work.delivery === "release" && current.repositories) {
        const releaseStage = current.plan!.stages.find((entry) => entry.kind === "do" && this.k.role(entry.roleId, current)?.result === "delivery")!;
        await this.shipping.releases.previewRelease(scope, releaseStage, signal);
      }
      const checkedHead = await git.head(scope.work.worktree!).catch(() => undefined);
      if (checkedHead) scope.work.checkedSha = checkedHead;
      else delete scope.work.checkedSha;
      if (current.repositories) work.nothingToPublish = scope.work.delivery !== "release" && checkedHead === scope.work.baseSha;
      const checkedPatch = checkedHead && checkedHead === scope.work.baseSha ? "empty" : await this.updates.patch(scope, checkedHead);
      if (checkedPatch) scope.work.checkedPatch = checkedPatch;
      else delete scope.work.checkedPatch;

    }
    if (sentBack) return { kind: "repeat" };
    const hasProofs = !!current.proofRequests?.length;
    const observed = hasProofs ? await committedCodeOf(current) : undefined;
    const versions = await invalidateAcceptance(current, observed?.versions) ?? observed?.versions ?? await versionsOf(current);
    refreshProofs(current, versions);
    // The tester tried an earlier version of the change: the final code gets one more pass first.
    const tester = current.plan!.stages.findIndex((entry) => entry.kind === "do" && this.k.role(entry.roleId, current)?.result === "checks");
    const acceptanceFailed = current.acceptancePassed === false;
    const changes = observed?.changes;
    const mainOnly = hasProofs && sameVersions(current.testedChanges, changes) && !sameVersions(current.testedVersions, versions);
    const ordinaryRetest = current.testedPatch !== undefined && (acceptanceFailed || (await this.checks.acceptanceVersion(scope, versions)) !== current.testedPatch);
    const requestedRetest = hasProofs && proofTestNeeded(current, mainOnly);
    // One rule with or without requested proof: a reproduced failure keeps its final retest after repair, while
    // required acceptance that could not be verified is never tried again unchanged. Extra probes decide neither.
    const reproducedFailure = current.journey?.findLast(step => step.kind === "agent" && step.endedAt !== undefined && this.k.role(step.roleId!, current)?.result === "checks")?.acceptanceChecks?.some(check => check.result === "fail");
    const acceptanceExhausted = (acceptanceFailed && current.acceptanceBlocked) || (requiredUnverified(current) && !reproducedFailure && !requestedRetest);
    const bounded = hasProofs && mainOnly && (current.proofRefreshes ?? 0) >= 2;
    if (hasProofs) current.proofRefreshBlocked = bounded && (ordinaryRetest || openProofs(current).some(request => request.status === "stale"));
    if (tester >= 0 && !acceptanceExhausted && !bounded && (ordinaryRetest || requestedRetest)) {
      if (hasProofs) {
        delete current.proofRefreshBlocked;
        if (mainOnly) current.proofRefreshes = (current.proofRefreshes ?? 0) + 1;
        current.proofRetestReason = openProofs(current).some(request => request.status === "pending") ? "requested" : mainOnly ? "main-moved" : current.testedChanges && !sameVersions(current.testedChanges, changes) ? "code-changed" : "requested";
      }
      current.retest = true;
      current.stageIndex = tester;
      current.sub = 0;
      this.k.log(current, "milestone", hasProofs ? current.proofRetestReason === "main-moved" ? "Final acceptance testing: main moved since the proof was recorded" : current.proofRetestReason === "code-changed" ? "Final acceptance testing: the task's code changed since acceptance testing" : "Final acceptance testing: a reviewer asked for proof on the final code" : "Trying the acceptance list once more on the final code");
      this.k.commit();
      return { kind: "repeat" };
    }
    if (hasProofs) current.checkedProofDecision = proofDecision(current, versions);
    if (this.shipsUnasked(current)) {
      if (hasProofs) current.approvedProofDecision = structuredClone(current.checkedProofDecision);
      for (const { work } of scopesFor(current)) {
        work.approvedSha = work.checkedSha;
        work.approvedPatch = work.checkedPatch;
        work.approvedFor = { by: "task", mode: work.delivery, destination: destination(work, this.k.s.products.find((product) => product.id === work.productId)) };
      }
      this.k.log(current, "milestone", current.proofDeliveryGate && !current.approveDelivery ? `${current.proofRequests?.length ? "Requested proof is current" : "Required acceptance is verified"} and checks passed: shipping without asking you, as this task's settings allow` : "Low risk, checks passed and nothing left to fix: shipping without asking you, as this product's settings allow");
      current.stageIndex += 1;
      current.sub = 0;
      this.k.commit();
      return { kind: "repeat" };
    }
    this.k.gate(current, "delivery");
    return { kind: "stop" };
  }

  private async prepareAcceptance(scope: RepositoryContext, signal: AbortSignal): Promise<AcceptancePreparation> {
    const current = scope.task;
    // Resolve an already-known stale base before spending checks or acceptance on it.
    // A saved helper finishes its version first; completed discovery does not defer the checks' update.
    let failed = false;
    let conflict = false;
    for (const scope of scopesFor(current)) {
      const work = scope.work;
      if (current.repositories) current.activeProductId = work.productId;
      const deferred = !!work.conversation;
      const testerFinishing = () => this.k.role(work.conversation?.roleId ?? "", current)?.result === "checks";
      if (!deferred && await this.updates.upToDate(scope, signal) === "conflict") { conflict = true; break; }
      let required = await this.checks.ensureChecks(scope, signal);
      if (deferred && !testerFinishing()) {
        const update = await this.updates.upToDate(scope, signal);
        if (update === "conflict") { conflict = true; break; }
        if (update === "moved") required = await this.checks.ensureChecks(scope, signal);
      }
      try {
        failed = await this.checks.failing(scope, signal, required, "acceptance", async () => testerFinishing() || await this.updates.upToDate(scope, signal) !== "conflict") || failed;
      } catch (error) { if (error instanceof CheckPreparationChanged) { conflict = true; break; } throw error; }

    }
    if (conflict) return { kind: "repeat" };
    if (failed) {
      for (const { work } of scopesFor(current)) {
        delete work.portReview;
        delete work.reviewedTree;
      }
      if (this.checks.backToBuilder(scope, "before acceptance testing")) return { kind: "repeat" };
      // Acceptance testing waits here, and starts once the checks pass on the current code.
      this.checks.blocked(current);
      return { kind: "stop" };
    }
    return { kind: "prepared" };
  }

  private async clearUnpublishedOnFailure(current: MTask): Promise<void> {
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
  private async refreshAfterWait(task: MTask, signal: AbortSignal): Promise<boolean> {
    const wait = task.runtimeWait;
    if (!wait?.refreshPending || runtimeWaitHolds(task)) return false;
    const scopes = scopesFor(task);
    const own = executionFor(task).work;
    const recovery = own.editAttempt;
    if (recovery?.failed) {
      if (recovery.step !== stepKey(task) || !own.worktree || await git.isClean(own.worktree)) {
        delete own.editAttempt;
        this.k.commitNow();
      }
      if (signal.aborted) throw new Aborted();
    }
    if (!this.k.taskSourceRefreshDue(task)) return false;
    if (!scopes.length || scopes.some(({ work }) => !work.worktree && !(task.repositories && (work.pr || work.release || work.landed)))) return false;
    // Persist each owner's unfinished work before I/O. A port keeps its own version until its
    // Builder finishes, while every companion still owes the strict source check now.
    wait.refreshProducts ??= scopes.map(({ work }) => work.productId);
    this.k.commitNow();
    // Preparation with no admitted reviewer is disposable; its round number and conversations are kept.
    if (task.hunt && !this.k.taskStepStarted(task)) delete task.hunt;
    let conflict = false;
    for (const scope of scopes) {
      if (signal.aborted) throw new Aborted();
      const { work } = scope;
      if (!wait.refreshProducts.includes(work.productId)) continue;
      const delivered = task.repositories && (work.pr || work.release || work.landed);
      // Existing ports and admitted publishing retain their exact saved version and recovery rules.
      if (!delivered && (work.updating || work.shipping?.step || work.shipping?.pushed)) continue;
      if (!delivered) {
        // A prepared delivery is bound to its old checked commit. Restore any release version
        // before folding, then let ordinary delivery preparation recheck and approve the candidate.
        await this.shipping.clearUnpublishedVersion(scope, true);
        const result = await this.updates.upToDate(scope, signal, true, true);
        if (signal.aborted) throw new Aborted();
        if (result === "conflict") { conflict = true; continue; }
      }
      wait.refreshProducts = wait.refreshProducts.filter(id => id !== work.productId);
      this.k.commitNow();
    }
    if (!wait.refreshProducts.length) {
      delete wait.refreshPending;
      delete wait.refreshProducts;
      delete wait.refreshAfterStep;
      this.k.log(task, "milestone", "The prerequisite wait ended; source checks are complete for the remaining work");
      this.k.commitNow();
    }
    return conflict;
  }

  /** An interrupted commit hook left the working copy detached. The task's commit is still on its branch. */
  private async recoverHook(scope: RepositoryContext): Promise<void> {
    if (!scope.work.worktree || !scope.work.hooking || !scope.work.branch) return;
    await git.reattach(scope.work.worktree, scope.work.branch);
    delete scope.work.hooking;
    this.k.commit();
  }

  /** The starting point is recorded and confirmed, and no proposed change is still waiting. */
  private sourceSettled(task: MTask): boolean {
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
      if (!fetched.ok && !fetched.missing) this.k.log(scope, "warn", `${fetched.timedOut ? "GitHub did not answer in time" : `Did not update from GitHub: ${this.connections.why(scope, fetched)}`}, so this task starts from the local copy`);
      if (await git.revParse(product.path, `refs/remotes/origin/${defaultBranch}`)) base = `origin/${defaultBranch}`;
    }
    if (!scope.work.worktree && scope.work.delivery === "local" && (!scope.work.source || scope.work.source.start.kind === "default") && base === defaultBranch && !await git.revParse(product.path, `refs/heads/${defaultBranch}`)) {
      // A changed remote default can leave the approved branch only at origin. Passing its
      // bare name makes git guess and attach the task copy to that destination branch.
      base = await git.revParse(product.path, `refs/remotes/origin/${defaultBranch}`) ?? base;
      if (savedCopy && savedCopy.base !== base) { savedCopy.base = base; this.k.commitNow(); }
    }
    // Stopped before its first copy was made: none is made. Only cancellation removes a newly made copy;
    // a pause, shutdown or resumed task keeps it, even though the old driver's signal is aborted.
    if (signal.aborted && !scope.work.worktree) throw new Aborted();
    if (own && !own.preparingCopy) {
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
    // Known before the builder starts, so it runs them too.
    await this.checks.noteHooks(scope);
    scope.work.base = scope.work.base ?? base;
    // Pin the commit actually checked out, before any agent starts; a shared source ref may move meanwhile.
    scope.work.baseSha = scope.work.baseSha ?? (await git.head(worktree));
    if (scope.work.source && scope.work.baseSha) scope.work.source.initialSha ??= scope.work.baseSha;
    if (!scope.work.savedVersion) await this.k.rememberVersion(scope);
    if (own) delete own.preparingCopy;
    this.k.commit();
  }

  /**
   * After a restart, nothing is running: put interrupted work back in line. A question stays in the
   * inbox for the conversation that asked it, without a slot; an open permission request goes.
   */
  recover(): void {
    const keep = (item: InboxItem) => {
      if (!item.blocking || item.kind === "maintenance-settings") return true;
      const task = this.k.task(item.taskId);
      return item.kind === "question" && task?.state === "needs-you" && (
        executionFor(task).work.conversation?.asked?.itemId === item.id
        || task.queued.some(message => Object.values(message.deliveries ?? {}).some(receipt => receipt.decisionId === item.id))
      );
    };
    for (const item of this.k.s.inbox.filter((entry) => !keep(entry))) {
      const task = this.k.task(item.taskId);
      if (!task) continue;
      // On the journey too: what went unanswered hangs under its step as withdrawn.
      withdrawAsks(task, [item.id], Date.now());
      if (item.kind === "permission") this.k.log(task, "warn", `Petrina restarted before you answered “${item.title}”, so it left your inbox. The agent will ask again if it still needs to`, item.roleId, item.profileId);
    }
    this.k.s.inbox = this.k.s.inbox.filter(keep);
    for (const task of this.k.s.tasks) {
      if (task.workValidating) { task.workValidating = false; task.workError = "Validation was interrupted. Apply the saved choices to check them again."; }
      if (task.driving) {
        // Still in the coordinator's hands: the step keeps its seat, and Hand back works as before.
        task.state = "needs-you";
        task.holdsSlot = true;
        continue;
      }
      if (this.k.s.inbox.some((item) => item.taskId === task.id && item.blocking)) {
        task.statusLine = "Waiting for your answer";
        delete task.agent;
      } else if (["running", "waiting"].includes(task.state) || (task.state === "needs-you" && !this.k.s.inbox.some((item) => item.taskId === task.id))) {
        task.state = "waiting";
        task.statusLine = "Waiting for a free slot";
        delete task.agent;
      }
      task.holdsSlot = false;
      // Nothing runs after a restart: agents that worked beside the main one are gone too.
      delete task.helpers;
    }
  }

  /** Low-risk work skips the delivery check only where the coordinator opted in, with nothing left that needs them. */
  private shipsUnasked(task: MTask): boolean {
    const scope = executionFor(task);
    return shipsUnasked(task, { products: this.k.s.products, product: this.k.productOf(task), checks: scope.work.checks });
  }
}
