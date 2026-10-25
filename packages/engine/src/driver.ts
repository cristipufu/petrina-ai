import { testerCheckKey } from "@petrina/orchestrator";
import { executionFor, scopesFor, type RepositoryContext } from "@petrina/orchestrator";
// Scheduling and the task driver: who gets a slot next, the loop that runs a task's stages and stops at
// checkpoints, and putting interrupted work back in line after a restart.

import { committedCodeOf, versionsOf, designWorkKey, invalidateAcceptance } from "./repositories.js";
import { acceptanceGap, openProofs, proofDecision, proofGap, proofTestNeeded, refreshProofs, requiredUnverified, sameVersions } from "@petrina/core";
import { join } from "node:path";
import { runtimeWaitHolds, syncRuntimeWait, AFTER_WORDS, balanced, lastIndexWhere, pickStarts, queueOf, screenReady, slotWait, slotUses, syncWait, withdrawAsks, type AgentProfile, type Candidate, type Id, type InboxItem, type Task } from "@petrina/core";
import * as git from "@petrina/repositories/git";
import { Kernel, Aborted, type MTask, PLANNER_PROFILE, ScreenWait, SourceRefreshRequired, stepKey } from "./kernel.js";
import { WaitingForUsage } from "./usage.js";
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
import type { ReadinessNeed } from "./readiness.js";
import { destination, needsReleaseManager, type Shipping } from "./shipping.js";

/** How a status line starts while a task waits for a tool to be out of its usage limit. */
const USAGE_WAIT = "Waiting for usage";

export class Driver {
  private readonly preparedTesters = new Map<Id, string>();
  constructor(
    private readonly k: Kernel,
    private readonly planning: Planning,
    private readonly work: Work,
    private readonly design: Design,
    private readonly reviews: Reviews,
    private readonly checks: ProductChecks,
    private readonly guide: GuideKeeper,
    private readonly updates: Updates,
    private readonly learnings: Learnings,
    private readonly shipping: Shipping,
    private readonly connections: Connections,
    private readonly sources: Sources,
  ) {}

  private testerCheckKey(task: MTask): string {
    return testerCheckKey(task, this.k.s.products);
  }

  private testerNeedsChecks(task: MTask): boolean {
    const scope = executionFor(task);
    const stage = task.plan?.stages[task.stageIndex];
    return stage?.kind === "do" && this.k.role(stage.roleId, task)?.result === "checks" && !task.retest && scope.work.conversation?.roleId !== stage.roleId
      && this.preparedTesters.get(task.id) !== this.testerCheckKey(task);
  }

  private pendingAgent(task: MTask) {
    const scope = executionFor(task);
    const pending = this.k.pendingAgentAdmissions.get(task.id);
    if (pending?.step === stepKey(task)) return pending;
    const conversation = scope.work.conversation;
    return conversation?.step === stepKey(task) && ["check-finder", "guide-keeper"].includes(conversation.roleId)
      ? { roleId: conversation.roleId, profileId: conversation.profileId } : undefined;
  }

  private needsCheckPreparation(task: MTask): boolean {
    if (this.pendingAgent(task) || task.screen) return false;
    const stage = task.plan?.stages[task.stageIndex];
    return this.testerNeedsChecks(task) || stage?.gate === "delivery"
      || (stage?.kind === "review-chain" && (task.hunt?.stageId !== stage.id || task.hunt.round !== (task.rounds[stage.id] ?? 1)));
  }

  syncRuntimeWaits(): void {
    for (const task of this.k.s.tasks) {
      if (!task.runtimeWait) continue;
      if (runtimeWaitHolds(task) && !task.runtimeWait.refreshAfterStep && this.k.taskStepStarted(task)) task.runtimeWait.refreshAfterStep = stepKey(task);
      syncRuntimeWait(task, id => this.k.taskDetails(id), Date.now());
      const yieldedReadiness = runtimeWaitHolds(task) && this.k.readiness.yieldHeld(task);
      if (runtimeWaitHolds(task) && (yieldedReadiness || !this.k.drivers.has(task.id) && !this.k.settling.has(task.id) && !task.driving) && ["running", "waiting"].includes(task.state)) {
        if (yieldedReadiness) this.k.pauseStep(task);
        task.state = "waiting";
        task.holdsSlot = false;
        delete task.agent;
        task.statusLine = this.k.taskAdmissionWait(task);
        task.column = this.k.columnFor(task);
        syncRuntimeWait(task, id => this.k.taskDetails(id), Date.now());
      }
    }
  }

  schedule(): void {
    if (this.k.stopped) return;
    this.syncRuntimeWaits();
    this.shipping.syncDeliveryTurns();
    for (const id of this.preparedTesters.keys()) {
      const task = this.k.s.tasks.find((task) => task.id === id);
      if (!task || !["running", "waiting"].includes(task.state)) this.preparedTesters.delete(id);
    }
    if (this.k.draining) {
      // Settings and permission answers still update the app while admissions are closed.
      this.k.syncScreen();
      for (const task of this.k.s.tasks) {
        if (task.state === "waiting" && !runtimeWaitHolds(task) && screenReady(task as Task, this.k.activeState(), Date.now())) {
          task.statusLine = this.k.draining ? this.k.drainLine : "Waiting for the pool to resume";
        }
      }
      this.k.commit();
      return;
    }
    // Limits that ended no longer hold anyone back.
    this.k.expireLimits();
    this.k.syncScreen();
    const now = Date.now();
    const continuing: Candidate[] = [];
    // A task waiting for others to land stays out of the running and says what it waits for.
    const blocked = (task: MTask): boolean => {
      const waitingFor = this.k.blockers(task);
      syncWait(task, waitingFor, (id) => this.k.task(id), Date.now());
      if (!waitingFor.length) return false;
      const line = AFTER_WORDS.waiting(waitingFor.map((other) => other.title));
      if (task.statusLine !== line) task.statusLine = line;
      return true;
    };
    // A granted screen member who is not in the group right now still needs a seat, even while a peer
    // works (the task stays "running") or a peer's question is open (the task stays "needs-you").
    const grantedResume = (entry: MTask): boolean => {
      const member = entry.screen?.granted ? entry.screen.member : undefined;
      if (!member) return false;
      const group = this.k.screenGroups.get(entry.id);
      return !!group && !group.running(member);
    };
    for (const task of this.k.s.tasks.filter((entry) => entry.state === "waiting" || (entry.state === "needs-you" && entry.screen && !entry.screen.granted) || grantedResume(entry)).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))) {
      // `settling` holds the driver's promise for the whole run, not only its cleanup. A live screen
      // group is that same driver: skipping it leaves an allowed reviewer beside a peer forever.
      const liveScreen = !!(task.screen?.member && this.k.screenGroups.has(task.id));
      if ((this.k.settling.has(task.id) || this.k.drivers.has(task.id)) && !liveScreen) continue;
      if (runtimeWaitHolds(task) || blocked(task)) continue;
      // A screen request also has to be allowed and first in line.
      if (!screenReady(task as Task, this.k.activeState(), now)) continue;
      if (!grantedResume(task) && (task.statusLine.startsWith("Waiting for “") || task.statusLine.startsWith(USAGE_WAIT))) task.statusLine = "Waiting for a free slot";
      const seat = this.seatFor(task);
      // Everyone who could work this step is out of usage: it waits for a limit to end, and takes no slot.
      // A saved participant's uncertain tool is checked once meanwhile, still without a slot.
      if (seat.waiting) {
        task.statusLine = seat.waiting;
        this.resolveReadiness(seat.readiness);
        continue;
      }
      // Publishing with no agent needs no slot, but still waits for the pool to resume.
      if (!seat.agent) {
        if (!this.k.drivers.has(task.id) && this.reserveAgent(task)) this.startDriver(task.id);
        continue;
      }
      const candidate = { ...this.k.profile(seat.agent.profileId), taskId: task.id, toolId: seat.toolId };
      // A peer's question, or the reviewer already on the screen, keeps the line the group set.
      if (!grantedResume(task)) task.statusLine = slotWait(this.k.activeState(), candidate) ?? "Waiting for a free slot";
      continuing.push(candidate);
    }
    // A review member whose model wait ended while its peers work is work in progress too: one seat each.
    const rejoining = new Set<Id>();
    for (const [taskId, group] of this.k.screenGroups) {
      for (const candidate of group.returning?.() ?? []) {
        continuing.push(candidate);
        rejoining.add(taskId);
      }
    }
    // Work in progress first, the tool with more of its limit left ahead; then the queue in its order.
    const candidates = balanced(continuing, this.k.s.pool, now);
    for (const task of queueOf(this.k.s.tasks as Task[])) {
      if (this.k.drivers.has(task.id) || this.k.settling.has(task.id)) continue;
      // On hold too, a task stops waiting the moment the tasks it waits for land; it just does not start.
      if (runtimeWaitHolds(task) || blocked(task as MTask)) continue;
      // What it waited for landed or was cancelled: back to plain queue words.
      if (task.statusLine.startsWith("Waiting for “") || task.statusLine.startsWith(USAGE_WAIT)) (task as MTask).statusLine = "In the queue";
      if (task.held) continue;
      const seat = this.seatFor(task as MTask);
      if (seat.waiting) {
        (task as MTask).statusLine = seat.waiting;
        this.resolveReadiness(seat.readiness);
        continue;
      }
      candidates.push({ ...this.k.profile(seat.agent?.profileId ?? ""), taskId: task.id, toolId: seat.toolId });
    }

    for (const taskId of pickStarts({ candidates, inUse: slotUses(this.k.activeState()), pool: this.k.s.pool, now })) {
      const task = this.k.task(taskId);
      // The group checks the seat again as it brings the member back, so a seat taken meanwhile is never exceeded.
      if (rejoining.has(taskId)) {
        this.k.screenGroups.get(taskId)?.rejoin?.();
        continue;
      }
      const group = task?.screen?.member ? this.k.screenGroups.get(taskId) : undefined;
      // Same as above: the live group is the driver that is still settling, and it has to resume.
      if (!task || ((this.k.settling.has(taskId) || this.k.drivers.has(taskId)) && !group)) continue;
      if (task.state === "queued") {
        task.startedAt = Date.now();
        task.stageIndex = task.maintenance ? 0 : -1;
        this.k.log(task, "milestone", "Started from the queue");
      }
      // The group already has its peer's seat. Resuming the granted member must not take the task's
      // card off a question or off the reviewer who is still working.
      if (group && task.screen?.granted) {
        group.continue();
        continue;
      }
      if (this.reserveAgent(task)) {
        // The screen is this agent's from now until its step ends.
        if (task.screen && !task.screen.granted) task.screen.granted = true;
        if (group) group.continue();
        else this.startDriver(taskId);
      }
    }
    this.k.armLimitTimer();
    this.k.commit();
  }

  /**
   * Who would work this task's next step: its planned agent, or a stand-in while the planned tool or model is
   * out of usage. `waiting` says why nobody can; `toolId` is the tool the slot is for.
   */
  private seatFor(task: MTask) {
    return this.seatOf(this.nextAgent(task), task);
  }

  private seatOf(next: { roleId: Id; profileId: Id; reviewerKey?: string; requiredToolId?: Id } | undefined, task?: MTask): { agent?: { roleId: Id; profileId: Id }; toolId: Id; waiting?: string; readiness?: ReadinessNeed } {
    if (!next) return { toolId: "none" };
    // This task's own slot does not count: it is the seat being filled. A stand-in whose tool is full yields.
    const room = task ? (toolId: Id, profile: AgentProfile) => !slotWait(this.k.activeState(), { ...profile, taskId: task.id, toolId }) : undefined;
    const choice = this.k.choose(next.profileId, task, next.roleId, room, next.reviewerKey);
    if (!choice) return { agent: next, toolId: this.k.profile(next.profileId)?.toolId ?? "unknown" };
    if (choice.kind === "none") return { toolId: "none", waiting: choice.waiting, ...(choice.readiness ? { readiness: choice.readiness } : {}) };
    if (next.requiredToolId && next.requiredToolId !== choice.profile.toolId) return { toolId: next.requiredToolId, waiting: "Waiting for the remaining independent voter" };
    return { agent: { roleId: next.roleId, profileId: choice.profile.id }, toolId: choice.profile.toolId };
  }

  /** A saved participant's uncertain tool: record its first wait and start or join the shared check, never while admissions are closed. */
  private resolveReadiness(need: ReadinessNeed | undefined): void {
    if (need && !this.k.taskAdmissionsClosed(need.scope.task)) void this.k.readiness.resolve(need);
  }

  /**
   * The live step's next participant. A step that already holds its main place keeps it, charged to the saved
   * participant's tool, while that participant's bounded readiness decision settles, then qualifies again from there.
   * Retention ends with the decision's limit or a task hold: the step then waits without a place, as any other.
   */
  private async admitNext(task: MTask, signal: AbortSignal): Promise<boolean | "refresh"> {
    for (;;) {
      if (this.k.taskAdmissionsClosed(task)) return this.reserveAgent(task);
      if (this.k.taskSourceRefreshDue(task)) return "refresh";
      const need = this.seatFor(task).readiness;
      if (!need || !this.k.readiness.hold(task, need)) return this.reserveAgent(task);
      const kept = await this.k.readiness.resolveHeld(need, signal);
      if (signal.aborted) throw new Aborted();
      if (!kept) return false;
    }
  }

  /** Take the slot and name its agent together, or start work needing no agent, before any I/O. */
  private reserveAgent(task: MTask): boolean {
    const deliveryWait = !this.k.taskAdmissionsClosed(task) ? this.shipping.waitingForTurn(task) : undefined;
    const { agent: next, toolId, waiting: noOne, readiness } = this.seatFor(task);
    const preparing = this.needsCheckPreparation(task);
    let waiting = runtimeWaitHolds(task) ? this.k.taskAdmissionWait(task) : deliveryWait ?? noOne ?? (this.k.taskAdmissionsClosed(task) ? this.k.taskAdmissionWait(task) : next ? slotWait(this.k.activeState(), { ...this.k.profile(next.profileId), taskId: task.id, toolId }) : undefined);
    if (deliveryWait) this.checks.releasePreparation(task.id);
    if (!waiting && preparing && !this.checks.claimPreparation(task.id)) waiting = "Waiting for room to prepare the product checks";
    if (!preparing) this.checks.releasePreparation(task.id);
    if (waiting) {
      task.state = "waiting";
      task.holdsSlot = false;
      delete task.agent;
      task.column = this.k.columnFor(task);
      task.statusLine = waiting;
      // Without a place, a saved participant's uncertain tool is still checked once.
      this.resolveReadiness(readiness);
      return false;
    }
    if (task.screen && next && task.screen.profileId !== next.profileId) {
      task.screen.profileId = next.profileId;
      task.screen.heard = false;
    }
    task.state = "running";
    task.holdsSlot = !!next;
    if (next) task.agent = { ...next, since: Date.now(), step: 0 };
    else delete task.agent;
    task.column = this.k.columnFor(task);
    task.statusLine = preparing ? "Preparing the product's checks" : next ? `${this.k.role(next.roleId, task)?.name ?? next.roleId} is starting` : "Getting ready";
    return true;
  }

  private nextAgent(task: MTask): { roleId: Id; profileId: Id; reviewerKey?: string; requiredToolId?: Id } | undefined {
    const scope = executionFor(task);
    if (task.screen) {
      const reviewerKey = task.screen.member?.startsWith("review-") ? task.screen.member.slice(7) : task.plan?.stages[task.stageIndex]?.profileIds.length === 1 ? "0" : undefined;
      return { roleId: task.screen.roleId, profileId: task.screen.profileId, reviewerKey };
    }
    const pending = this.pendingAgent(task);
    if (pending) return pending;
    if (this.needsCheckPreparation(task)) return undefined;
    if (task.stageIndex < 0) return { roleId: "planner", profileId: this.k.onUsable(PLANNER_PROFILE) };
    const stage = task.plan?.stages[task.stageIndex];
    if (!stage) return undefined;
    switch (stage.kind) {
      case "do":
        // Petrina publishes by itself: the Release Manager's seat is needed only for a release's notes.
        if (this.k.role(stage.roleId, task)?.result === "delivery" && !needsReleaseManager(scope.work)) return undefined;
        return { roleId: stage.roleId, profileId: (task.repositories && this.k.role(stage.roleId, task)?.result === "build" ? task.plan?.products?.find((work) => work.productId === scope.work.productId)?.builderProfileId : undefined) ?? stage.profileIds[0] ?? PLANNER_PROFILE };
      case "converge":
        return task.sub === 0
          ? { roleId: stage.roleId, profileId: stage.profileIds[0] ?? PLANNER_PROFILE }
          : { roleId: stage.reviewerRoleId ?? "design-reviewer", profileId: stage.reviewerProfileIds?.[0] ?? "sol-xhigh" };
      case "review-chain":
        return this.reviews.nextAgent(task, stage);
      case "gate":
        return undefined;
    }
  }

  /** `resume`: the agent already has its seat (a hand back), so its step carries on whatever the pool is doing. */
  startDriver(taskId: Id, resume = false): void {
    const done = this.drive(taskId, resume);
    this.k.settling.set(taskId, done);
    this.k.syncIdleSleep();
    void done.finally(() => {
      if (this.k.settling.get(taskId) === done) {
        this.k.settling.delete(taskId);
      }
      // Delivered or cancelled: now that nothing uses the working copy, it can go.
      this.k.tidy(taskId);
      // A resumed task waits for file handling; newly landed prerequisites also release extra checks.
      this.k.schedule();
      this.k.syncIdleSleep();
    });
  }

  private async drive(taskId: Id, resume = false): Promise<void> {
    const controller = new AbortController();
    this.k.drivers.set(taskId, controller);
    const { signal } = controller;
    const task = () => {
      const found = this.k.task(taskId);
      if (!found) throw new Aborted();
      return found;
    };
    try {
      // A delivery from before the update: nothing happens, not even an update from GitHub, until the coordinator chooses.
      if (executionFor(task()).work.shipping?.carriedOver) {
        this.shipping.askCarriedOver(task());
        return;
      }

      for (;;) {
        if (signal.aborted) throw new Aborted();
        const current = task();
        let scope = executionFor(current);
        if (runtimeWaitHolds(current)) {
          this.k.waitForUsage(current, this.k.taskAdmissionWait(current));
          return;
        }
        if (current.reviewDecision?.accepted === false) { this.k.gate(current, "delivery"); return; }
        const stage = current.stageIndex < 0 ? undefined : current.plan?.stages[current.stageIndex];
        if (!stage || this.k.role(stage.roleId, current)?.result !== "checks") this.preparedTesters.delete(taskId);
        // A restart can find the working copy detached by an interrupted commit hook. Put it back before
        // review or delivery reads that original starting version as the task's work.
        if (scope.work.worktree && scope.work.hooking) await this.recoverHook(scope);
        if (await this.refreshAfterWait(current, signal)) continue;
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
        if (await this.refreshAfterWait(current, signal)) continue;
        if (current.stageIndex >= 0 && !scope.work.worktree) { this.k.gate(current, "plan"); return; }
        // Nothing ships while changes made by hand wait for review: the last review chain looks at them first.
        if (stage && current.handChanges && (stage.gate === "delivery" || this.k.role(stage.roleId, current)?.result === "delivery")) {
          const chain = lastIndexWhere(current.plan!.stages, (entry) => entry.kind === "review-chain");
          if (chain >= 0) {
            current.stageIndex = chain;
            current.sub = 0;
            current.fixing = false;
            delete current.hunt;
            this.k.log(current, "milestone", "Reviewing your changes before anything ships: the review starts again from the first reviewer");
            this.k.commit();
            continue;
          }
          delete current.handChanges;
        }
        // Acceptance was tried on this change already. Fixes are reviewed, and the final code is tried once more
        // right before the delivery check, so a tester pass per fix round is spared.
        if (stage?.kind === "do" && this.k.role(stage.roleId, current)?.result === "checks" && !current.retest && current.testedPatch !== undefined && (!current.repositories || current.acceptancePassed)) {
          this.k.log(current, "milestone", "Acceptance will be tried once more on the final code, right before your delivery check");
          current.stageIndex += 1;
          current.sub = 0;
          this.k.commit();
          continue;
        }
        // Plan and design checkpoints need no work; delivery preparation can update files and run checks.
        if (stage?.kind === "gate") {
          // On the way back to the check where changes were asked, earlier design checks are not asked again.
          if (stage.gate === "design" && current.returnToCheck !== undefined && current.stageIndex < current.returnToCheck) {
            this.k.log(current, "milestone", "Went past the earlier design check you already approved, back to the one where you asked for changes");
            current.stageIndex += 1;
            current.sub = 0;
            this.k.commit();
            continue;
          }
          delete current.returnToCheck;
          if (stage.gate === "delivery") {
            if (this.k.taskAdmissionsClosed(current)) {
              current.state = "waiting";
              current.holdsSlot = false;
              delete current.agent;
              current.column = this.k.columnFor(current);
              current.statusLine = this.k.taskAdmissionWait(current);
              this.k.commit();
              return;
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
                return;
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
            if (sentBack) continue;
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
              continue;
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
              continue;
            }
          }
          this.k.gate(current, stage.gate ?? "delivery");
          return;
        }
        // Petrina is stopping: the step waits for the restart instead of starting an agent it would cut short.
        if (this.k.taskAdmissionsClosed(current)) {
          current.state = "waiting";
          current.holdsSlot = false;
          delete current.agent;
          current.column = this.k.columnFor(current);
          current.statusLine = this.k.taskAdmissionWait(current);
          this.k.commit();
          return;
        }
        // Running agents finish; every following agent must qualify again, even on the same tool.
        if (resume) resume = false;
        else {
          const admission = await this.admitNext(current, signal);
          if (admission === "refresh" || this.k.taskSourceRefreshDue(current)) continue;
          if (!admission) { this.k.commit(); return; }
        }
        this.k.commit();
        // The stage (or planning) is under way from here: a slot is held for it, or it needs none.
        this.k.tracking.beginStage(scope);
        // Give acceptance testing verified automated evidence first, so it can focus on the user cases.
        // Read-only review reuses this same run; changing code still requires fresh evidence.
        if (this.testerNeedsChecks(current)) {
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
          if (conflict) continue;
          if (failed) {
            for (const { work } of scopesFor(current)) {
              delete work.portReview;
              delete work.reviewedTree;
            }
            if (this.checks.backToBuilder(scope, "before acceptance testing")) continue;
            // Acceptance testing waits here, and starts once the checks pass on the current code.
            this.checks.blocked(current);
            return;
          }
          this.preparedTesters.set(taskId, this.testerCheckKey(current));
          this.checks.releasePreparation(taskId);
          continue;
        }
        if (current.stageIndex < 0) {
          // Pausing while the copy is made already has a plan. Planning again would start a second one.
          if (!current.plan) await this.planning.runPlanner(current, signal);
          scope = executionFor(current);
          if (current.confirmWork || current.workError || !scope.work.source?.confirmed) {
            this.k.gate(current, "plan");
            return;
          }
          // Show me the plan first stays editable until it is approved. Skipping that check prepares on the next pass.
          if (current.approvePlan) {
            this.k.gate(current, "plan");
            return;
          }
          current.stageIndex = 0;
          current.sub = 0;
          this.k.commit();
          continue;
        }
        if (!stage) throw new Error("The plan ended without a delivery");
        const next =
          stage.kind === "do"
            ? this.k.role(stage.roleId, current)?.result === "delivery"
              ? await this.shipping.deliver(current, stage, signal)
              : await this.work.runDo(scope, stage, signal)
            : stage.kind === "converge"
              ? await this.design.runConverge(scope, stage, signal)
              : await this.reviews.runReview(current, stage, signal);
        if (next === "stop") return;
      }
    } catch (error) {
      if (signal.aborted || error instanceof Aborted || error instanceof ScreenWait) return;
      if (error instanceof SourceRefreshRequired) {
        this.k.waitForUsage(task(), "Waiting to bring the work onto the required source");
        return;
      }
      if (this.k.task(taskId)?.maintenance?.settingsDecision && !this.k.task(taskId)?.maintenance?.settingsDecision?.choice) return;
      if (error instanceof WaitingForUsage) {
        // Admission may close during an awaited preparation step. Every such exit must
        // release its reservation and remain schedulable, even if the callee only threw.
        const current = this.k.task(taskId);
        if (current && ["running", "waiting"].includes(current.state)) this.k.waitForUsage(current, this.k.draining ? this.k.drainLine : error.words);
        return;
      }
      const current = task();
      if (current.repositories) {
        for (const work of current.repositories) {
          const scope: RepositoryContext = { task: current, work };
          if (work.pr || work.release || work.landed || work.shipping?.step || work.shipping?.pushed) continue;
          await this.shipping.clearUnpublishedVersion(scope);
        }
      }
      this.k.fail(taskId, error);
    } finally {
      this.checks.releasePreparation(taskId);
      if (this.k.task(taskId)?.state !== "waiting") this.preparedTesters.delete(taskId);
      if (this.k.drivers.get(taskId) === controller) this.k.drivers.delete(taskId);
      // Cancelled during a publishing step: what went out is looked up and kept.
      try {
        if (signal.aborted && !this.k.stopped) await this.shipping.monitor.settleCancelled(taskId, true);
      } finally { this.shipping.finishDeliveryTurn(taskId); }
    }
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
    if (task.reviewDecision) return false;
    if (proofGap(task)) return false;
    // The added check lifts on a complete, current pass of every required item, even when an extra probe could not be verified.
    if (task.proofDeliveryGate && !task.approveDelivery && task.acceptancePassed === true && !acceptanceGap(task) && !task.findings.some(finding => finding.status === "open" && finding.severity === "blocking")) return true;
    // Shared work also needs the saved task choice and combined acceptance; single-product work keeps
    // the product's existing low-risk opt-in, even when its ordinary deliveries ask first.
    if (task.repositories && (task.approveDelivery || task.acceptancePassed !== true)) return false;
    if (task.repositories && (!task.repositories.every((work) => this.k.s.products.find((product) => product.id === work.productId)?.shipLowRisk && !!work.checks?.results.length && work.checks.results.every((run) => run.ok)))) return false;
    if (task.risk?.level !== "low" || !this.k.productOf(task)?.shipLowRisk) return false;
    if (task.acceptanceUnverified || task.acceptancePassed === false) return false;
    if (task.findings.some((finding) => finding.status === "open" && finding.severity === "blocking")) return false;
    return scope.work.checks?.results.every((run) => run.ok) ?? true;
  }
}
