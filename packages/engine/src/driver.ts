// Scheduling and the task driver: who gets a slot next, the loop that runs a task's stages and stops at
// checkpoints, and putting interrupted work back in line after a restart.

import { designWorkKey, invalidateAcceptance } from "./repositories.js";
import { join } from "node:path";
import { AFTER_WORDS, balanced, lastIndexWhere, pickStarts, queueOf, screenReady, slotWait, slotUses, syncWait, withdrawAsks, type Candidate, type Id, type InboxItem, type Task } from "@petrina/core";
import * as git from "./git.js";
import { Kernel, Aborted, type MTask, PLANNER_PROFILE, ScreenWait, stepKey } from "./kernel.js";
import { WaitingForUsage } from "./usage.js";
import type { Sources } from "./sources.js";
import type { Planning } from "./planning.js";
import type { Work } from "./work.js";
import type { Design } from "./design.js";
import type { Reviews } from "./review.js";
import type { ProductChecks } from "./product-checks.js";
import type { GuideKeeper } from "./guide-keeper.js";
import type { Updates } from "./update.js";
import type { Learnings } from "./learnings.js";
import type { Connections } from "./connection.js";
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
    this.k.saveRepository(task);
    // A shared task's active product changes while preparing/checking copies. Its
    // readiness belongs to the complete set, never to that temporary projection.
    const evidence = task.repositories
      ? task.repositories.map((work) => [work.productId, work.baseSha, work.checks?.at, work.checks?.current])
      : [[task.productId, task.baseSha, task.checks?.at, task.checks?.current]];
    return JSON.stringify([stepKey(task), task.handChanges, evidence,
      this.k.s.products.filter((product) => product.id === task.productId || task.repositories?.some((work) => work.productId === product.id)).map((product) => [product.id, product.checks])]);
  }

  private testerNeedsChecks(task: MTask): boolean {
    const stage = task.plan?.stages[task.stageIndex];
    return stage?.kind === "do" && this.k.role(stage.roleId)?.result === "checks" && !task.retest && task.conversation?.roleId !== stage.roleId
      && this.preparedTesters.get(task.id) !== this.testerCheckKey(task);
  }

  private pendingAgent(task: MTask) {
    const pending = this.k.pendingAgentAdmissions.get(task.id);
    if (pending?.step === stepKey(task)) return pending;
    const conversation = task.conversation;
    return conversation?.step === stepKey(task) && ["check-finder", "guide-keeper"].includes(conversation.roleId)
      ? { roleId: conversation.roleId, profileId: conversation.profileId } : undefined;
  }

  private needsCheckPreparation(task: MTask): boolean {
    if (this.pendingAgent(task) || task.screen) return false;
    const stage = task.plan?.stages[task.stageIndex];
    return this.testerNeedsChecks(task) || stage?.gate === "delivery"
      || (stage?.kind === "review-chain" && (task.hunt?.stageId !== stage.id || task.hunt.round !== (task.rounds[stage.id] ?? 1)));
  }

  schedule(): void {
    if (this.k.stopped) return;
    for (const id of this.preparedTesters.keys()) {
      const task = this.k.s.tasks.find((task) => task.id === id);
      if (!task || !["running", "waiting"].includes(task.state)) this.preparedTesters.delete(id);
    }
    if (this.k.draining) {
      // Settings and permission answers still update the app while admissions are closed.
      this.k.syncScreen();
      for (const task of this.k.s.tasks) {
        if (task.state === "waiting" && screenReady(task as Task, this.k.activeState(), Date.now())) {
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
      if (blocked(task)) continue;
      // A screen request also has to be allowed and first in line.
      if (!screenReady(task as Task, this.k.activeState(), now)) continue;
      if (!grantedResume(task) && (task.statusLine.startsWith("Waiting for “") || task.statusLine.startsWith(USAGE_WAIT))) task.statusLine = "Waiting for a free slot";
      const seat = this.seatFor(task);
      // Everyone who could work this step is out of usage: it waits for a limit to end, and takes no slot.
      if (seat.waiting) {
        task.statusLine = seat.waiting;
        continue;
      }
      // Publishing with no agent needs no slot, but still waits for the pool to resume.
      if (!seat.agent) {
        if (!this.k.drivers.has(task.id) && this.reserveAgent(task)) this.startDriver(task.id);
        continue;
      }
      const candidate = { taskId: task.id, toolId: seat.toolId };
      // A peer's question, or the reviewer already on the screen, keeps the line the group set.
      if (!grantedResume(task)) task.statusLine = slotWait(this.k.activeState(), candidate) ?? "Waiting for a free slot";
      continuing.push(candidate);
    }
    // Work in progress first, the tool with more of its limit left ahead; then the queue in its order.
    const candidates = balanced(continuing, this.k.s.pool, now);
    const checkBacklog = this.k.s.tasks.filter((task) => task.startedAt !== undefined && ["running", "waiting"].includes(task.state) && this.needsCheckPreparation(task)).length;
    for (const task of queueOf(this.k.s.tasks as Task[])) {
      if (this.k.drivers.has(task.id) || this.k.settling.has(task.id)) continue;
      // On hold too, a task stops waiting the moment the tasks it waits for land; it just does not start.
      if (blocked(task as MTask)) continue;
      // What it waited for landed or was cancelled: back to plain queue words.
      if (task.statusLine.startsWith("Waiting for “") || task.statusLine.startsWith(USAGE_WAIT)) (task as MTask).statusLine = "In the queue";
      if (task.held) continue;
      if (checkBacklog >= Math.max(1, this.k.s.pool.limit)) {
        (task as MTask).statusLine = "Waiting for room in the check queue";
        continue;
      }
      const seat = this.seatOf({ roleId: "planner", profileId: this.k.onUsable(PLANNER_PROFILE) });
      if (seat.waiting) {
        (task as MTask).statusLine = seat.waiting;
        continue;
      }
      candidates.push({ taskId: task.id, toolId: seat.toolId });
    }

    for (const taskId of pickStarts({ candidates, inUse: slotUses(this.k.activeState()), pool: this.k.s.pool, now })) {
      const task = this.k.task(taskId);
      const group = task?.screen?.member ? this.k.screenGroups.get(taskId) : undefined;
      // Same as above: the live group is the driver that is still settling, and it has to resume.
      if (!task || ((this.k.settling.has(taskId) || this.k.drivers.has(taskId)) && !group)) continue;
      if (task.state === "queued") {
        task.startedAt = Date.now();
        task.stageIndex = -1;
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

  private seatOf(next: { roleId: Id; profileId: Id; reviewerKey?: string; requiredToolId?: Id } | undefined, task?: MTask): { agent?: { roleId: Id; profileId: Id }; toolId: Id; waiting?: string } {
    if (!next) return { toolId: "none" };
    // This task's own slot does not count: it is the seat being filled. A stand-in whose tool is full yields.
    const room = task ? (toolId: Id) => !slotWait(this.k.activeState(), { taskId: task.id, toolId }) : undefined;
    const choice = this.k.choose(next.profileId, task, next.roleId, room, next.reviewerKey);
    if (!choice) return { agent: next, toolId: this.k.profile(next.profileId)?.toolId ?? "unknown" };
    if (choice.kind === "none") return { toolId: "none", waiting: choice.waiting };
    if (next.requiredToolId && next.requiredToolId !== choice.profile.toolId) return { toolId: next.requiredToolId, waiting: "Waiting for the remaining independent voter" };
    return { agent: { roleId: next.roleId, profileId: choice.profile.id }, toolId: choice.profile.toolId };
  }

  /** Take the slot and name its agent together, or start work needing no agent, before any I/O. */
  private reserveAgent(task: MTask): boolean {
    const { agent: next, toolId, waiting: noOne } = this.seatFor(task);
    const preparing = this.needsCheckPreparation(task);
    let waiting = noOne ?? (this.k.admissionsClosed ? (this.k.draining ? this.k.drainLine : "Waiting for the pool to resume") : next ? slotWait(this.k.activeState(), { taskId: task.id, toolId }) : undefined);
    if (!waiting && preparing && !this.checks.claimPreparation(task.id)) waiting = "Waiting for room to prepare the product checks";
    if (!preparing) this.checks.releasePreparation(task.id);
    if (waiting) {
      task.state = "waiting";
      task.holdsSlot = false;
      delete task.agent;
      task.column = this.k.columnFor(task);
      task.statusLine = waiting;
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
    task.statusLine = preparing ? "Preparing the product's checks" : next ? `${this.k.role(next.roleId)?.name ?? next.roleId} is starting` : "Getting ready";
    return true;
  }

  private nextAgent(task: MTask): { roleId: Id; profileId: Id; reviewerKey?: string; requiredToolId?: Id } | undefined {
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
        if (stage.roleId === "release-manager" && !needsReleaseManager(task)) return undefined;
        return { roleId: stage.roleId, profileId: (task.repositories && this.k.role(stage.roleId)?.result === "build" ? task.plan?.products?.find((work) => work.productId === task.productId)?.builderProfileId : undefined) ?? stage.profileIds[0] ?? PLANNER_PROFILE };
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
      // A resumed task waits for its previous driver's file handling before starting another one.
      this.schedule();
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
      if (task().shipping?.carriedOver) {
        this.shipping.askCarriedOver(task());
        return;
      }

      for (;;) {
        if (signal.aborted) throw new Aborted();
        const current = task();
        const stage = current.stageIndex < 0 ? undefined : current.plan?.stages[current.stageIndex];
        if (!stage || this.k.role(stage.roleId)?.result !== "checks") this.preparedTesters.delete(taskId);
        // A restart can find the working copy detached by an interrupted commit hook. Put it back before
        // review or delivery reads that original starting version as the task's work.
        if (current.worktree && current.hooking) await this.recoverHook(current);
        // The copy waits until the starting point is confirmed. While the plan check is still open it waits
        // too, including for the default branch, so that check can still change the product, the start or the delivery.
        if (current.repositories && !current.confirmWork && current.stageIndex >= 0) {
          for (const work of current.repositories) {
            this.k.selectRepository(current, work.productId);
            await this.sources.addApproved(current, work.productId, signal);
            if (work.preparation !== "ready") { await this.prepare(current, signal); work.preparation = "ready"; this.k.commitNow(); }
          }
          if (stage?.kind === "do" && this.k.role(stage.roleId)?.canEdit) for (const work of current.repositories) {
            this.k.selectRepository(current, work.productId);
            if (work.pr || work.release || work.landed) continue;
            await this.shipping.clearUnpublishedVersion(current);
          }
          const editing = stage && this.k.role(stage.roleId)?.canEdit && (stage.kind === "do" || (stage.kind === "converge" && current.sub === 0));
          const progress = stage?.kind === "converge" ? designWorkKey(current, stage.id) : stage?.id;
          const nextProduct = current.repair?.products[current.repair.index] ?? (editing && progress ? current.repositories.find((work) => !work.completedStages.includes(progress))?.productId : undefined) ?? current.leadProductId ?? current.repositories[0]!.productId;
          this.k.selectRepository(current, nextProduct);
        }
        if (!current.worktree && this.sourceSettled(current) && (current.stageIndex >= 0 || !current.approvePlan)) await this.prepare(current, signal);
        if (current.stageIndex >= 0 && !current.worktree) { this.k.gate(current, "plan"); return; }
        // Nothing ships while changes made by hand wait for review: the last review chain looks at them first.
        if (stage && current.handChanges && (stage.gate === "delivery" || stage.roleId === "release-manager")) {
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
        if (stage?.kind === "do" && stage.roleId === "tester" && !current.retest && current.testedPatch !== undefined && (!current.repositories || current.acceptancePassed)) {
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
            if (this.k.s.pool.paused || this.k.draining) {
              current.state = "waiting";
              current.holdsSlot = false;
              delete current.agent;
              current.column = this.k.columnFor(current);
              current.statusLine = this.k.draining ? this.k.drainLine : "Waiting for the pool to resume";
              this.k.commit();
              return;
            }
            const checking = current.repositories ?? [undefined];
            let sentBack = false;
            for (const work of checking) {
              if (work) { this.k.selectRepository(current, work.productId); if (work.pr || work.release || work.landed) continue; }
            await this.guide.writeGuide(current);
            await this.learnings.write(current);
            // What the coordinator checks is the work as it would land: one commit on top of the latest main.
            if ((await this.updates.upToDate(current, signal)) === "conflict") { sentBack = true; break; }
            // Right before the coordinator is asked to ship, the checks run again on what would ship.
            const checkResult = await this.checks.checksBeforeDelivery(current, signal);
            if (checkResult === "returned") { sentBack = true; break; }
            if (checkResult === "exhausted") {
              this.k.saveRepository(current);
              this.k.gate(current, "delivery");
              return;
            }
            await this.learnings.offer(current);
            if (current.delivery === "release" && current.repositories) {
              const releaseStage = current.plan!.stages.find((entry) => entry.kind === "do" && entry.roleId === "release-manager")!;
              await this.shipping.previewRelease(current, releaseStage, signal);
            }
            const checkedHead = await git.head(current.worktree!).catch(() => undefined);
            if (checkedHead) current.checkedSha = checkedHead;
            if (work) work.nothingToPublish = current.delivery !== "release" && checkedHead === current.baseSha;
            const checkedPatch = await this.updates.patch(current);
            if (checkedPatch) current.checkedPatch = checkedPatch;
            this.k.saveRepository(current);
            }
            if (sentBack) continue;
            await invalidateAcceptance(current);
            // The tester tried an earlier version of the change: the final code gets one more pass first.
            const tester = current.plan!.stages.findIndex((entry) => entry.kind === "do" && entry.roleId === "tester");
            const acceptanceFailed = current.acceptancePassed === false;
            const acceptanceExhausted = (acceptanceFailed && current.acceptanceBlocked) || current.acceptanceUnverified === true;
            if (tester >= 0 && current.testedPatch !== undefined && !acceptanceExhausted && (acceptanceFailed || (await this.checks.acceptanceVersion(current)) !== current.testedPatch)) {
              current.retest = true;
              current.stageIndex = tester;
              current.sub = 0;
              this.k.log(current, "milestone", "Trying the acceptance list once more on the final code");
              this.k.commit();
              continue;
            }
            const head = await git.head(current.worktree!).catch(() => undefined);
            if (head) current.checkedSha = head;
            const patch = await this.updates.patch(current);
            if (patch) current.checkedPatch = patch;
            // What agents learned on the way: offered to the coordinator without holding the delivery up.
            await this.learnings.offer(current);
            if (this.shipsUnasked(current)) {
              if (head) current.approvedSha = head;
              if (patch) current.approvedPatch = patch;
              current.approvedFor = { by: "task", mode: current.delivery, destination: destination(current, this.k.productOf(current)) };
              if (current.repositories) {
                this.k.saveRepository(current);
                for (const work of current.repositories) {
                  work.approvedSha = work.checkedSha; work.approvedPatch = work.checkedPatch;
                  work.approvedFor = { by: "task", mode: work.delivery, destination: destination(work, this.k.s.products.find((product) => product.id === work.productId)) };
                }
              }
              this.k.log(current, "milestone", "Low risk, checks passed and nothing left to fix: shipping without asking you, as this product's settings allow");
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
        if (this.k.admissionsClosed) {
          current.state = "waiting";
          current.holdsSlot = false;
          delete current.agent;
          current.column = this.k.columnFor(current);
          current.statusLine = this.k.draining ? this.k.drainLine : "Waiting for the pool to resume";
          this.k.commit();
          return;
        }
        // Running agents finish; every following agent must qualify again, even on the same tool.
        if (resume) resume = false;
        else if (!this.reserveAgent(current)) {
          this.k.commit();
          return;
        }
        this.k.commit();
        // The stage (or planning) is under way from here: a slot is held for it, or it needs none.
        this.k.tracking.beginStage(current);
        // Give acceptance testing verified automated evidence first, so it can focus on the user cases.
        // Read-only review reuses this same run; changing code still requires fresh evidence.
        if (this.testerNeedsChecks(current)) {
          // Resolve an already-known stale base before spending checks or acceptance on it.
          // A saved Tester or Check finder first finishes the version it was already examining.
          if (!current.conversation && (await this.updates.upToDate(current, signal)) === "conflict") continue;
          let failed = false;
          let conflict = false;
          for (const work of current.repositories ?? [undefined]) {
            if (work) this.k.selectRepository(current, work.productId);
            if (!current.conversation && await this.updates.upToDate(current, signal) === "conflict") { conflict = true; break; }
            failed = await this.checks.failing(current, signal, await this.checks.ensureChecks(current, signal)) || failed;
            this.k.saveRepository(current);
          }
          if (conflict) continue;
          if (failed) {
            delete current.portReview;
            delete current.reviewedTree;
            if (this.checks.backToBuilder(current, "before acceptance testing")) continue;
            const delivery = current.plan!.stages.findIndex((entry, index) => index > current.stageIndex && entry.gate === "delivery");
            if (delivery < 0) throw new Error("The product's checks fail before acceptance testing");
            current.stageIndex = delivery;
            current.sub = 0;
            this.k.log(current, "warn", "Checks still fail: acceptance testing waits, and the decision goes to you");
            this.k.commit();
            continue;
          }
          this.preparedTesters.set(taskId, this.testerCheckKey(current));
          this.checks.releasePreparation(taskId);
          continue;
        }
        if (current.stageIndex < 0) {
          // Pausing while the copy is made already has a plan. Planning again would start a second one.
          if (!current.plan) await this.planning.runPlanner(current, signal);
          if (current.confirmWork || current.workError || !current.source?.confirmed) {
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
            ? stage.roleId === "release-manager"
              ? await this.shipping.deliver(current, stage, signal)
              : await this.work.runDo(current, stage, signal)
            : stage.kind === "converge"
              ? await this.design.runConverge(current, stage, signal)
              : await this.reviews.runReview(current, stage, signal);
        if (next === "stop") return;
      }
    } catch (error) {
      if (signal.aborted || error instanceof Aborted || error instanceof ScreenWait) return;
      if (error instanceof WaitingForUsage) {
        // Admission may close during an awaited preparation step. Every such exit must
        // release its reservation and remain schedulable, even if the callee only threw.
        const current = this.k.task(taskId);
        if (current && ["running", "waiting"].includes(current.state)) this.k.waitForUsage(current, this.k.draining ? this.k.drainLine : error.words);
        return;
      }
      const current = task();
      if (current.repositories) {
        const failedProduct = current.productId;
        for (const work of current.repositories) {
          if (work.pr || work.release || work.landed || work.shipping?.step || work.shipping?.pushed) continue;
          this.k.selectRepository(current, work.productId);
          await this.shipping.clearUnpublishedVersion(current);
        }
        this.k.selectRepository(current, failedProduct);
      }
      this.k.fail(taskId, error);
    } finally {
      this.checks.releasePreparation(taskId);
      if (this.k.task(taskId)?.state !== "waiting") this.preparedTesters.delete(taskId);
      if (this.k.drivers.get(taskId) === controller) this.k.drivers.delete(taskId);
      // Cancelled during a publishing step: what went out is looked up and kept.
      if (signal.aborted && !this.k.stopped) await this.shipping.settleCancelled(taskId, true);
    }
  }

  /** An interrupted commit hook left the working copy detached. The task's commit is still on its branch. */
  private async recoverHook(task: MTask): Promise<void> {
    if (!task.worktree || !task.hooking || !task.branch) return;
    await git.reattach(task.worktree, task.branch);
    delete task.hooking;
    this.k.commit();
  }

  /** The starting point is recorded and confirmed, and no proposed change is still waiting. */
  private sourceSettled(task: MTask): boolean {
    if (task.confirmWork || task.workError || task.proposedSource) return false;
    // Planning is still open, so the planner may change the starting point. Nothing is fetched yet.
    if (task.stageIndex < 0 && !task.plan) return false;
    if (task.source) return task.source.confirmed;
    // A task already past planning, from before starting points were recorded, keeps a copy.
    return task.stageIndex >= 0;
  }

  private async prepare(task: MTask, signal: AbortSignal): Promise<void> {
    await this.k.copyCleanups.get(task.id);
    if (signal.aborted) throw new Aborted();
    const product = this.k.repositoryOf(task);
    if (!product?.path) throw new Error(`${product?.name ?? "This product"} has no local copy`);
    const own = task.repositories?.find((work) => work.productId === task.productId);
    const savedCopy = own?.preparingCopy;
    const branch = task.branch ?? savedCopy?.branch ?? git.branchName(task.title, task.id);
    const worktree = task.worktree ?? savedCopy?.path ?? join(this.k.dataDir, "worktrees", product.id, task.id);
    const defaultBranch = product.defaultBranch ?? "main";
    let base = savedCopy?.base ?? defaultBranch;
    if (!savedCopy && !task.worktree && task.source?.start.kind !== "default") {
      const fetched = await this.sources.fetch(task, signal);
      base = fetched.sha;
    }
    // A new working copy starts from the latest main: GitHub's for GitHub deliveries, the main clone's own for local ones.
    if (!savedCopy && !task.worktree && task.delivery !== "local" && (!task.source || task.source.start.kind === "default")) {
      const fetched = await this.connections.fetchDefault(task, signal);
      // A stalled or refused fetch never holds a task: it works from the local copy.
      if (!fetched.ok && !fetched.missing) this.k.log(task, "warn", `${fetched.timedOut ? "GitHub did not answer in time" : `Did not update from GitHub: ${this.connections.why(task, fetched)}`}, so this task starts from the local copy`);
      if (await git.revParse(product.path, `refs/remotes/origin/${defaultBranch}`)) base = `origin/${defaultBranch}`;
    }
    if (!task.worktree && task.delivery === "local" && (!task.source || task.source.start.kind === "default") && base === defaultBranch && !await git.revParse(product.path, `refs/heads/${defaultBranch}`)) {
      // A changed remote default can leave the approved branch only at origin. Passing its
      // bare name makes git guess and attach the task copy to that destination branch.
      base = await git.revParse(product.path, `refs/remotes/origin/${defaultBranch}`) ?? base;
      if (savedCopy && savedCopy.base !== base) { savedCopy.base = base; this.k.commitNow(); }
    }
    // Stopped before its first copy was made: none is made. Only cancellation removes a newly made copy;
    // a pause, shutdown or resumed task keeps it, even though the old driver's signal is aborted.
    if (signal.aborted && !task.worktree) throw new Aborted();
    if (own && !own.preparingCopy) {
      own.preparingCopy = { path: worktree, branch, base: await git.revParse(product.path, base) ?? base };
      this.k.commitNow();
    }
    await git.ensureWorktree(product.path, worktree, branch, own?.preparingCopy?.base ?? base);
    if (!task.branch && !signal.aborted) this.k.log(task, "milestone", "Set up a fresh working copy");
    task.branch = branch;
    task.worktree = worktree;
    if (signal.aborted) throw new Aborted();
    // Petrina stopped while a pre-commit hook ran: the working copy goes back on its branch first.
    if (task.hooking) {
      await git.reattach(worktree, branch);
      delete task.hooking;
    }
    // Known before the builder starts, so it runs them too.
    await this.checks.noteHooks(task);
    task.base = task.base ?? base;
    // Pin the commit actually checked out, before any agent starts; a shared source ref may move meanwhile.
    task.baseSha = task.baseSha ?? (await git.head(worktree));
    if (task.source && task.baseSha) task.source.initialSha ??= task.baseSha;
    if (own) delete own.preparingCopy;
    this.k.commit();
  }

  /**
   * After a restart, nothing is running: put interrupted work back in line. A question stays in the
   * inbox for the conversation that asked it, without a slot; an open permission request goes.
   */
  recover(): void {
    const keep = (item: InboxItem) => {
      if (!item.blocking) return true;
      const task = this.k.task(item.taskId);
      return item.kind === "question" && task?.state === "needs-you" && task.conversation?.asked?.itemId === item.id;
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
    // Shared work also needs the saved task choice and combined acceptance; single-product work keeps
    // the product's existing low-risk opt-in, even when its ordinary deliveries ask first.
    if (task.repositories && (task.approveDelivery || task.acceptancePassed !== true)) return false;
    if (task.repositories && (!task.repositories.every((work) => this.k.s.products.find((product) => product.id === work.productId)?.shipLowRisk && !!work.checks?.results.length && work.checks.results.every((run) => run.ok)))) return false;
    if (task.risk?.level !== "low" || !this.k.productOf(task)?.shipLowRisk) return false;
    if (task.acceptanceUnverified || task.acceptancePassed === false) return false;
    if (task.findings.some((finding) => finding.status === "open" && finding.severity === "blocking")) return false;
    return task.checks?.results.every((run) => run.ok) ?? true;
  }
}
