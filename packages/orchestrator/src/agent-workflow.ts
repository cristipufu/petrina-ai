import { runtimeWaitHolds, syncRuntimeWait, AFTER_WORDS, balanced, lastIndexWhere, pickStarts, queueOf, screenReady, slotWait, slotUses, syncWait, stepKey, type AgentProfile, type Candidate, type Id, type Task } from "@petrina/core";
import { executionFor } from "./repository-context.js";
import { testerCheckKey } from "./tester-preparation.js";
import { waitForAgentUsage } from "./agent-step-state.js";
import type { RuntimeTask as MTask } from "./model.js";
import type { SelectionReadiness as ReadinessNeed } from "./profile-selection.js";
import type { AgentWorkflowHost, AgentWorkflowDependencies, SelectedParticipant } from "./ports/agent-workflow.js";

const USAGE_WAIT = "Waiting for usage";

/** The actual live scheduler and per-stage admission loop; native preparation is supplied explicitly. */
export class AgentWorkflow {
  readonly preparedTesters = new Map<Id, string>();
  private readonly ownership: AgentWorkflowDependencies["ownership"];
  private readonly catalog: AgentWorkflowDependencies["catalog"];
  private readonly readiness: AgentWorkflowDependencies["readiness"];
  private readonly errors: AgentWorkflowDependencies["errors"];
  private readonly phases: AgentWorkflowDependencies["phases"];
  private readonly checks: AgentWorkflowDependencies["checkPreparation"];
  constructor(private readonly host: AgentWorkflowHost, private readonly dependencies: AgentWorkflowDependencies) {
    this.ownership = dependencies.ownership;
    this.catalog = dependencies.catalog;
    this.readiness = dependencies.readiness;
    this.errors = dependencies.errors;
    this.phases = dependencies.phases;
    this.checks = dependencies.checkPreparation;
  }

  private testerCheckKey(task: MTask): string {
    return testerCheckKey(task, this.host.state().products);
  }

  private testerNeedsChecks(task: MTask): boolean {
    const scope = executionFor(task);
    const stage = task.plan?.stages[task.stageIndex];
    return stage?.kind === "do" && this.catalog.role(stage.roleId, task)?.result === "checks" && !task.retest && scope.work.conversation?.roleId !== stage.roleId
      && this.preparedTesters.get(task.id) !== this.testerCheckKey(task);
  }

  private pendingAgent(task: MTask) {
    const scope = executionFor(task);
    const pending = this.ownership.pendingAdmissions.get(task.id);
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
    for (const task of this.host.state().tasks) {
      if (!task.runtimeWait) continue;
      if (runtimeWaitHolds(task) && !task.runtimeWait.refreshAfterStep && this.host.stepStarted(task)) task.runtimeWait.refreshAfterStep = stepKey(task);
      syncRuntimeWait(task, id => this.host.taskDetails(id), this.host.now());
      const yieldedReadiness = runtimeWaitHolds(task) && this.readiness.yieldHeld(task);
      if (runtimeWaitHolds(task) && (yieldedReadiness || !this.ownership.drivers.has(task.id) && !this.ownership.settling.has(task.id) && !task.driving) && ["running", "waiting"].includes(task.state)) {
        if (yieldedReadiness) this.host.pauseStep(task);
        task.state = "waiting";
        task.holdsSlot = false;
        delete task.agent;
        task.statusLine = this.host.admissionWait(task);
        task.column = this.host.column(task);
        syncRuntimeWait(task, id => this.host.taskDetails(id), this.host.now());
      }
    }
  }

  schedule(): void {
    if (this.host.stopped()) return;
    this.syncRuntimeWaits();
    this.host.syncDeliveryTurns();
    for (const id of this.preparedTesters.keys()) {
      const task = this.host.state().tasks.find((task) => task.id === id);
      if (!task || !["running", "waiting"].includes(task.state)) this.preparedTesters.delete(id);
    }
    if (this.host.draining()) {
      // Settings and permission answers still update the app while admissions are closed.
      this.host.syncScreen();
      for (const task of this.host.state().tasks) {
        if (task.state === "waiting" && !runtimeWaitHolds(task) && screenReady(task as Task, this.host.activeState(), this.host.now())) {
          task.statusLine = this.host.draining() ? this.host.drainLine() : "Waiting for the pool to resume";
        }
      }
      this.host.changed();
      return;
    }
    // Limits that ended no longer hold anyone back.
    this.host.expireLimits();
    this.host.syncScreen();
    const now = this.host.now();
    const continuing: Candidate[] = [];
    // A task waiting for others to land stays out of the running and says what it waits for.
    const blocked = (task: MTask): boolean => {
      const waitingFor = this.host.blockers(task);
      syncWait(task, waitingFor, (id) => this.host.task(id), this.host.now());
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
      const group = this.ownership.groups.get(entry.id);
      return !!group && !group.running(member);
    };
    for (const task of this.host.state().tasks.filter((entry) => entry.state === "waiting" || (entry.state === "needs-you" && entry.screen && !entry.screen.granted) || grantedResume(entry)).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))) {
      // `settling` holds the driver's promise for the whole run, not only its cleanup. A live screen
      // group is that same driver: skipping it leaves an allowed reviewer beside a peer forever.
      const liveScreen = !!(task.screen?.member && this.ownership.groups.has(task.id));
      if ((this.ownership.settling.has(task.id) || this.ownership.drivers.has(task.id)) && !liveScreen) continue;
      if (runtimeWaitHolds(task) || blocked(task)) continue;
      // A screen request also has to be allowed and first in line.
      if (!screenReady(task as Task, this.host.activeState(), now)) continue;
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
        if (!this.ownership.drivers.has(task.id) && this.reserveAgent(task)) this.startDriver(task.id);
        continue;
      }
      const candidate = { ...this.catalog.profile(seat.agent.profileId), taskId: task.id, toolId: seat.toolId };
      // A peer's question, or the reviewer already on the screen, keeps the line the group set.
      if (!grantedResume(task)) task.statusLine = slotWait(this.host.activeState(), candidate) ?? "Waiting for a free slot";
      continuing.push(candidate);
    }
    // A review member whose model wait ended while its peers work is work in progress too: one seat each.
    const rejoining = new Set<Id>();
    for (const [taskId, group] of this.ownership.groups) {
      for (const candidate of group.returning?.() ?? []) {
        continuing.push(candidate);
        rejoining.add(taskId);
      }
    }
    // Work in progress first, the tool with more of its limit left ahead; then the queue in its order.
    const candidates = balanced(continuing, this.host.state().pool, now);
    for (const task of queueOf(this.host.state().tasks as Task[])) {
      if (this.ownership.drivers.has(task.id) || this.ownership.settling.has(task.id)) continue;
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
      candidates.push({ ...this.catalog.profile(seat.agent?.profileId ?? ""), taskId: task.id, toolId: seat.toolId });
    }

    for (const taskId of pickStarts({ candidates, inUse: slotUses(this.host.activeState()), pool: this.host.state().pool, now })) {
      const task = this.host.task(taskId);
      // The group checks the seat again as it brings the member back, so a seat taken meanwhile is never exceeded.
      if (rejoining.has(taskId)) {
        this.ownership.groups.get(taskId)?.rejoin?.();
        continue;
      }
      const group = task?.screen?.member ? this.ownership.groups.get(taskId) : undefined;
      // Same as above: the live group is the driver that is still settling, and it has to resume.
      if (!task || ((this.ownership.settling.has(taskId) || this.ownership.drivers.has(taskId)) && !group)) continue;
      if (task.state === "queued") {
        task.startedAt = this.host.now();
        task.stageIndex = task.maintenance ? 0 : -1;
        this.host.note(task, "milestone", "Started from the queue");
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
    this.host.armLimitTimer();
    this.host.changed();
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
    const room = task ? (toolId: Id, profile: AgentProfile) => !slotWait(this.host.activeState(), { ...profile, taskId: task.id, toolId }) : undefined;
    const choice = this.catalog.choose(next, task, room);
    if (!choice) return { agent: next, toolId: this.catalog.profile(next.profileId)?.toolId ?? "unknown" };
    if (choice.kind === "none") return { toolId: "none", waiting: choice.waiting, ...(choice.readiness ? { readiness: choice.readiness } : {}) };
    if (next.requiredToolId && next.requiredToolId !== choice.profile.toolId) return { toolId: next.requiredToolId, waiting: "Waiting for the remaining independent voter" };
    return { agent: { roleId: next.roleId, profileId: choice.profile.id }, toolId: choice.profile.toolId };
  }

  /** A saved participant's uncertain tool: record its first wait and start or join the shared check, never while admissions are closed. */
  private resolveReadiness(need: ReadinessNeed | undefined): void {
    if (need && !this.host.admissionsClosed(need.scope.task)) void this.readiness.resolve(need);
  }

  /**
   * The live step's next participant. A step that already holds its main place keeps it, charged to the saved
   * participant's tool, while that participant's bounded readiness decision settles, then qualifies again from there.
   * Retention ends with the decision's limit or a task hold: the step then waits without a place, as any other.
   */
  private async admitNext(task: MTask, signal: AbortSignal): Promise<boolean | "refresh"> {
    for (;;) {
      if (this.host.admissionsClosed(task)) return this.reserveAgent(task);
      if (this.host.sourceRefreshDue(task)) return "refresh";
      const need = this.seatFor(task).readiness;
      if (!need || !this.readiness.hold(task, need)) return this.reserveAgent(task);
      const kept = await this.readiness.resolveHeld(need, signal);
      if (signal.aborted) throw this.errors.aborted();
      if (!kept) return false;
    }
  }

  /** Take the slot and name its agent together, or start work needing no agent, before any I/O. */
  private reserveAgent(task: MTask): boolean {
    const deliveryWait = !this.host.admissionsClosed(task) ? this.host.waitingForDelivery(task) : undefined;
    const { agent: next, toolId, waiting: noOne, readiness } = this.seatFor(task);
    const preparing = this.needsCheckPreparation(task);
    let waiting = runtimeWaitHolds(task) ? this.host.admissionWait(task) : deliveryWait ?? noOne ?? (this.host.admissionsClosed(task) ? this.host.admissionWait(task) : next ? slotWait(this.host.activeState(), { ...this.catalog.profile(next.profileId), taskId: task.id, toolId }) : undefined);
    if (deliveryWait) this.checks.release(task.id);
    if (!waiting && preparing && !this.checks.claim(task.id)) waiting = "Waiting for room to prepare the product checks";
    if (!preparing) this.checks.release(task.id);
    if (waiting) {
      task.state = "waiting";
      task.holdsSlot = false;
      delete task.agent;
      task.column = this.host.column(task);
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
    if (next) task.agent = { ...next, since: this.host.now(), step: 0 };
    else delete task.agent;
    task.column = this.host.column(task);
    task.statusLine = preparing ? "Preparing the product's checks" : next ? `${this.catalog.role(next.roleId, task)?.name ?? next.roleId} is starting` : "Getting ready";
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
    if (task.stageIndex < 0) return { roleId: "planner", profileId: this.catalog.onUsable(this.dependencies.plannerProfileId) };
    const stage = task.plan?.stages[task.stageIndex];
    if (!stage) return undefined;
    switch (stage.kind) {
      case "do":
        // Petrina publishes by itself: the Release Manager's seat is needed only for a release's notes.
        if (this.catalog.role(stage.roleId, task)?.result === "delivery" && !this.phases.deliveryNeedsAgent(scope)) return undefined;
        return { roleId: stage.roleId, profileId: (task.repositories && this.catalog.role(stage.roleId, task)?.result === "build" ? task.plan?.products?.find((work) => work.productId === scope.work.productId)?.builderProfileId : undefined) ?? stage.profileIds[0] ?? this.dependencies.plannerProfileId };
      case "converge":
        return task.sub === 0
          ? { roleId: stage.roleId, profileId: stage.profileIds[0] ?? this.dependencies.plannerProfileId }
          : { roleId: stage.reviewerRoleId ?? "design-reviewer", profileId: stage.reviewerProfileIds?.[0] ?? "sol-xhigh" };
      case "review-chain":
        return this.phases.nextReviewer(task, stage);
      case "gate":
        return undefined;
    }
  }

  /** `resume`: the agent already has its seat (a hand back), so its step carries on whatever the pool is doing. */
  startDriver(taskId: Id, resume = false): void {
    const done = this.drive(taskId, resume);
    this.ownership.settling.set(taskId, done);
    this.host.idleChanged();
    void done.finally(() => {
      if (this.ownership.settling.get(taskId) === done) {
        this.ownership.settling.delete(taskId);
      }
      // Delivered or cancelled: now that nothing uses the working copy, it can go.
      this.host.tidy(taskId);
      // A resumed task waits for file handling; newly landed prerequisites also release extra checks.
      this.host.schedule();
      this.host.idleChanged();
    });
  }

  private async drive(taskId: Id, resume = false): Promise<void> {
    const controller = new AbortController();
    this.ownership.drivers.set(taskId, controller);
    const { signal } = controller;
    const task = () => {
      const found = this.host.task(taskId);
      if (!found) throw this.errors.aborted();
      return found;
    };
    try {
      // A delivery from before the update: nothing happens, not even an update from GitHub, until the coordinator chooses.
      if (executionFor(task()).work.shipping?.carriedOver) {
        this.phases.carriedOver(task());
        return;
      }

      for (;;) {
        if (signal.aborted) throw this.errors.aborted();
        const current = task();
        let scope = executionFor(current);
        if (runtimeWaitHolds(current)) {
          this.waitForUsage(current, this.host.admissionWait(current));
          return;
        }
        if (current.reviewDecision?.accepted === false) { this.host.gate(current, "delivery"); return; }
        const stage = current.stageIndex < 0 ? undefined : current.plan?.stages[current.stageIndex];
        if (!stage || this.catalog.role(stage.roleId, current)?.result !== "checks") this.preparedTesters.delete(taskId);
        const prepared = await this.phases.prepareWorkspace(current, stage, signal);
        if (prepared.kind === "repeat") continue;
        if (prepared.kind === "stop") return;
        scope = prepared.scope;
        // Nothing ships while changes made by hand wait for review: the last review chain looks at them first.
        if (stage && current.handChanges && (stage.gate === "delivery" || this.catalog.role(stage.roleId, current)?.result === "delivery")) {
          const chain = lastIndexWhere(current.plan!.stages, (entry) => entry.kind === "review-chain");
          if (chain >= 0) {
            current.stageIndex = chain;
            current.sub = 0;
            current.fixing = false;
            delete current.hunt;
            this.host.note(current, "milestone", "Reviewing your changes before anything ships: the review starts again from the first reviewer");
            this.host.changed();
            continue;
          }
          delete current.handChanges;
        }
        // Acceptance was tried on this change already. Fixes are reviewed, and the final code is tried once more
        // right before the delivery check, so a tester pass per fix round is spared.
        if (stage?.kind === "do" && this.catalog.role(stage.roleId, current)?.result === "checks" && !current.retest && current.testedPatch !== undefined && (!current.repositories || current.acceptancePassed)) {
          this.host.note(current, "milestone", "Acceptance will be tried once more on the final code, right before your delivery check");
          current.stageIndex += 1;
          current.sub = 0;
          this.host.changed();
          continue;
        }
        // Plan and design checkpoints need no work; delivery preparation can update files and run checks.
        if (stage?.kind === "gate") {
          // On the way back to the check where changes were asked, earlier design checks are not asked again.
          if (stage.gate === "design" && current.returnToCheck !== undefined && current.stageIndex < current.returnToCheck) {
            this.host.note(current, "milestone", "Went past the earlier design check you already approved, back to the one where you asked for changes");
            current.stageIndex += 1;
            current.sub = 0;
            this.host.changed();
            continue;
          }
          delete current.returnToCheck;
          if (stage.gate === "delivery") {
            const prepared = await this.phases.deliveryCheckpoint(scope, signal);
            if (prepared.kind === "repeat") continue;
            return;
          }
          this.host.gate(current, stage.gate ?? "delivery");
          return;
        }
        // Petrina is stopping: the step waits for the restart instead of starting an agent it would cut short.
        if (this.host.admissionsClosed(current)) {
          current.state = "waiting";
          current.holdsSlot = false;
          delete current.agent;
          current.column = this.host.column(current);
          current.statusLine = this.host.admissionWait(current);
          this.host.changed();
          return;
        }
        // Running agents finish; every following agent must qualify again, even on the same tool.
        if (resume) resume = false;
        else {
          const admission = await this.admitNext(current, signal);
          if (admission === "refresh" || this.host.sourceRefreshDue(current)) continue;
          if (!admission) { this.host.changed(); return; }
        }
        this.host.changed();
        // The stage (or planning) is under way from here: a slot is held for it, or it needs none.
        this.host.beginStage(scope);
        // Give acceptance testing verified automated evidence first, so it can focus on the user cases.
        // Read-only review reuses this same run; changing code still requires fresh evidence.
        if (this.testerNeedsChecks(current)) {
          const prepared = await this.phases.prepareAcceptance(scope, signal);
          if (prepared.kind === "stop") return;
          if (prepared.kind === "repeat") continue;
          this.preparedTesters.set(taskId, this.testerCheckKey(current));
          this.checks.release(taskId);
          continue;
        }
        if (current.stageIndex < 0) {
          // Pausing while the copy is made already has a plan. Planning again would start a second one.
          if (!current.plan) await this.phases.planner(current, signal);
          scope = executionFor(current);
          if (current.confirmWork || current.workError || !scope.work.source?.confirmed) {
            this.host.gate(current, "plan");
            return;
          }
          // Show me the plan first stays editable until it is approved. Skipping that check prepares on the next pass.
          if (current.approvePlan) {
            this.host.gate(current, "plan");
            return;
          }
          current.stageIndex = 0;
          current.sub = 0;
          this.host.changed();
          continue;
        }
        if (!stage) throw new Error("The plan ended without a delivery");
        const next =
          stage.kind === "do"
            ? this.catalog.role(stage.roleId, current)?.result === "delivery"
              ? await this.phases.delivery(current, stage, signal)
              : await this.phases.doStage(scope, stage, signal)
            : stage.kind === "converge"
              ? await this.phases.converge(scope, stage, signal)
              : await this.phases.review(current, stage, signal);
        if (next === "stop") return;
      }
    } catch (error) {
      const problem = this.errors.classify(error);
      if (signal.aborted || problem.kind === "abort" || problem.kind === "screen") return;
      if (problem.kind === "source-refresh") {
        this.waitForUsage(task(), "Waiting to bring the work onto the required source");
        return;
      }
      if (this.host.task(taskId)?.maintenance?.settingsDecision && !this.host.task(taskId)?.maintenance?.settingsDecision?.choice) return;
      if (problem.kind === "usage") {
        // Admission may close during an awaited preparation step. Every such exit must
        // release its reservation and remain schedulable, even if the callee only threw.
        const current = this.host.task(taskId);
        if (current && ["running", "waiting"].includes(current.state)) this.waitForUsage(current, this.host.draining() ? this.host.drainLine() : problem.words);
        return;
      }
      const current = task();
      await this.phases.clearUnpublishedOnFailure(current);
      this.host.failed(taskId, error);
    } finally {
      this.checks.release(taskId);
      if (this.host.task(taskId)?.state !== "waiting") this.preparedTesters.delete(taskId);
      if (this.ownership.drivers.get(taskId) === controller) this.ownership.drivers.delete(taskId);
      await this.phases.finish(taskId, signal);
    }
  }


  waitForUsage(task: MTask, words: string): void {
    waitForAgentUsage(task, words, this.host.now(), () => this.host.column(task));
    this.host.checkpoint();
  }

  /** Last-moment selected-profile gate, before any native session starts. */
  qualify({ task, profile, roleId, step }: SelectedParticipant, signal: AbortSignal): void {
    if (signal.aborted) throw this.errors.aborted();
    if (this.host.admissionsClosed(task)) throw this.errors.usage(this.host.admissionWait(task));
    if (this.host.sourceRefreshDue(task)) throw this.errors.sourceRefresh();
    if (!task.holdsSlot || this.catalog.profile(task.agent?.profileId ?? "")?.toolId !== profile.toolId) {
      const waiting = this.host.admissionsClosed(task) ? this.host.admissionWait(task) : slotWait(this.host.activeState(), { ...profile, taskId: task.id, toolId: profile.toolId });
      if (waiting) {
        this.ownership.pendingAdmissions.set(task.id, { step, roleId, profileId: profile.id });
        throw this.errors.usage(waiting);
      }
    }
    this.ownership.pendingAdmissions.delete(task.id);
  }

  /** Clock/journey setup remains with the caller; no recording or await is inserted here. */
  activate({ task, profile, roleId, reviewKey }: SelectedParticipant) {
    task.agent = { roleId, profileId: profile.id, since: this.host.now(), step: 0, ...(reviewKey ? { reviewKey } : {}) };
    task.state = this.host.state().inbox.some(item => item.taskId === task.id && item.blocking) ? "needs-you" : "running";
    task.holdsSlot = true;
    task.column = this.host.column(task);
    return task.agent;
  }

  setPoolLimit(limit: number): void {
    this.host.state().pool.limit = Math.max(1, Math.min(12, Math.round(limit)));
    this.host.changed();
    this.host.schedule();
  }
  setToolCap(toolId: Id, cap: number): void {
    if (!this.host.state().tools.some(tool => tool.id === toolId)) throw new Error("Unknown tool");
    this.host.state().pool.toolCaps = { ...this.host.state().pool.toolCaps, [toolId]: Math.max(1, Math.min(12, Math.round(cap))) };
    this.host.changed();
    this.host.schedule();
  }
  setPoolPaused(paused: boolean): void {
    if (!paused && this.host.draining()) throw new Error("Petrina is stopping or restarting. Wait for that operation to finish before resuming.");
    this.host.state().pool.paused = paused;
    this.host.checkpoint();
    this.host.schedule();
  }
}
