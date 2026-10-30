// The real engine: the same state the UI renders, driven by real agents over ACP.
// Each task runs as one async driver while it holds a pool slot. Gates and the queue
// live in state; questions and permissions wait on the coordinator in code.
// Three rules make restarts safe: what the coordinator says during a step is on disk before any
// agent sees it, and kept until the step finishes; each step's conversation is noted the moment it
// opens, so its agent picks it up after a restart; and shipping is never repeated blindly.
//
// Engine is the thin front: the coordinator's commands live here. Each part of the work lives in a
// module of its own (driver, planning, design, work, review, shipping, take-over, product checks,
// review guide, tools check, turns, context, catalog/task/inbox commands), and they share state
// and bookkeeping through the kernel.

import * as library from "@petrina/core";
import {
  SCREEN_HOUR_MS,
  stopCheckProgress,
  type AskAnswer,
  type Clone,
  type Commands,
  type DeliveryMode,
  type HandBackPreview,
  type Id,
  type Launched,
  type NewTaskInput,
  type ProductSettings,
  type RoleDraft,
  type SaidContext,
  type ScreenMode,
  type SetupStep,
  type UsageRequest,
  type UsageViewFor,
  type WorkChoice,
} from "@petrina/core";
import { AcceptedPoints } from "./accepted-points.js";
import { CatalogCommands } from "./catalog-commands.js";
import { Checkpoints } from "./checkpoints.js";
import { Cleanup } from "./cleanup.js";
import { Connections } from "./connection.js";
import { Context } from "./context.js";
import { Design } from "./design.js";
import { Driver } from "./driver.js";
import { prepareRecoveredTasks, startEngineBackgroundLoops } from "./engine-startup.js";
import { ExtraValidations } from "./extra-validations.js";
import { FollowUps } from "./follow-ups.js";
import { GuideKeeper } from "./guide-keeper.js";
import { InboxCommands } from "./inbox-commands.js";
import { Kernel, type EngineOptions } from "./kernel.js";
import { Learnings } from "./learnings.js";
import { Planning } from "./planning.js";
import { ProductChecks } from "./product-checks.js";
import { ProfileChoiceReader } from "./profile-choices.js";
import { Readiness } from "./readiness.js";
import { Reviews } from "./review.js";
import { Shipping } from "./shipping.js";
import { Sources } from "./sources.js";
import { TakeOver } from "./take-over.js";
import { TaskCommands } from "./task-commands.js";
import { ToolChecks } from "./tool-checks.js";
import { Turns } from "./turn.js";
import { Updates } from "./update.js";
import { Work } from "./work.js";

export type { EngineOptions } from "./kernel.js";
export type { NewTaskInput, SaidContext } from "@petrina/core";

/** The engine: every command the window can send (Commands) is a method here. */
export class Engine extends Kernel implements Commands {
  private readonly profileReader: ProfileChoiceReader;
  private readonly tools: ToolChecks;
  private readonly sources: Sources;
  private readonly turns: Turns;
  private readonly guide: GuideKeeper;
  private readonly context: Context;
  private readonly checks: ProductChecks;
  readonly extraValidations: ExtraValidations;
  private readonly shipping: Shipping;
  private readonly connections: Connections;
  private readonly updates: Updates;
  private readonly learnings: Learnings;
  private readonly reviews: Reviews;
  private readonly design: Design;
  private readonly planning: Planning;
  private readonly work: Work;
  private readonly takeover: TakeOver;
  private readonly driver: Driver;
  private readonly checkpoints: Checkpoints;
  private readonly cleanup: Cleanup;
  private readonly followUps: FollowUps;
  private readonly acceptedPoints: AcceptedPoints;
  private readonly catalogCommands: CatalogCommands;
  private readonly taskCommands: TaskCommands;
  private readonly inboxCommands: InboxCommands;
  readonly startupSweep: Promise<void>;
  private shutdownDone?: Promise<void>;

  trackFinding<T>(
    taskId: Id,
    findingId: Id,
    targetTaskId: Id,
    record: (link: { taskId: Id; findingId: Id; targetTaskId: Id }) => T,
  ): Promise<T> {
    return this.followUps.trackFinding(taskId, findingId, targetTaskId, record);
  }

  constructor(dataDir: string, options: EngineOptions = {}) {
    super(dataDir, options);
    this.profileReader = new ProfileChoiceReader(this);
    this.tools = new ToolChecks(this);
    this.readiness = new Readiness(this, this.tools);
    this.connections = new Connections(this);
    this.sources = new Sources(this, this.connections);
    this.turns = new Turns(this, this.tools, this.sources);
    this.guide = new GuideKeeper(this, this.turns);
    this.context = new Context(this, this.guide, (scope) => this.checks.current(scope));
    this.checks = new ProductChecks(this, this.turns, this.context);
    this.updates = new Updates(this, this.connections, this.sources);
    this.shipping = new Shipping(this, this.turns, this.updates, this.checks, this.connections, this.tools);
    this.onCoordinatorWait = (task) => {
      const checks = this.checks.releaseForDecision(task.id);
      const delivery = this.shipping.yieldForDecision(task);
      // Only a resource handoff needs a wake. The asking caller records its question first.
      if (checks || delivery) queueMicrotask(() => this.schedule());
    };
    this.learnings = new Learnings(this);
    this.reviews = new Reviews(this, this.turns, this.context, this.checks, this.learnings, this.updates);
    this.design = new Design(this, this.turns, this.context);
    this.planning = new Planning(this, this.turns, this.sources);
    this.work = new Work(this, this.turns, this.context, this.guide, this.updates, this.learnings, this.checks);
    this.takeover = new TakeOver(this);
    this.checkpoints = new Checkpoints(this, this.sources);
    this.driver = new Driver(
      this,
      this.planning,
      this.work,
      this.design,
      this.reviews,
      this.checks,
      this.guide,
      this.updates,
      this.learnings,
      this.shipping,
      this.connections,
      this.sources,
    );
    this.cleanup = new Cleanup(this);
    this.followUps = new FollowUps(this);
    this.taskCommands = new TaskCommands(this, this.sources, this.cleanup);
    this.catalogCommands = new CatalogCommands(this, this.tools, (input) => this.taskCommands.createTask(input));
    this.inboxCommands = new InboxCommands(
      this,
      this.takeover,
      this.tools,
      this.checks,
      this.shipping,
      this.cleanup,
      this.guide,
      this.learnings,
      this.checkpoints,
    );
    this.onTaskDone = (task) => {
      this.extraValidations?.cancelTask(task.id);
      void this.followUps.noteDone(task);
    };
    this.beforeCaptureRemoval = (task) => this.followUps.beforeRemoval(task);
    this.acceptedPoints = new AcceptedPoints(this);
    prepareRecoveredTasks(this, this.shipping);
    this.extraValidations = new ExtraValidations(this);
    this.startupSweep = startEngineBackgroundLoops({
      kernel: this,
      options,
      shipping: this.shipping,
      driver: this.driver,
      checks: this.checks,
      tools: this.tools,
      followUps: this.followUps,
      cleanup: this.cleanup,
      acceptedPoints: this.acceptedPoints,
      pollRoutines: () => this.pollRoutines(),
      pollPullRequests: () => this.pollPullRequests(),
      checkpointStepTimes: () => this.checkpointStepTimes(),
    });
  }

  private checkpointStepTimes(): void {
    try {
      const hasRunningClock = this.s.tasks.some(
        (task) =>
          task.stepClock?.since !== undefined
          || Object.values(task.hunt?.work ?? {}).some((work) => work.clock?.since !== undefined),
      );
      if (!this.stopped && hasRunningClock) this.save();
    } catch (error) {
      console.error("Could not save step times:", error);
    }
  }

  override async waitUntilReady(): Promise<void> {
    await super.waitUntilReady();
    await this.extraValidations.ready;
  }

  /** A synchronous admission decision, saved before the ordinary driver sees it. */
  pollRoutines(now = Date.now()): void {
    this.catalogCommands.pollRoutines(now);
  }

  schedule(): void {
    if (this.stopped) return;
    if (!this.startupComplete) {
      this.driver.syncRuntimeWaits();
      this.syncScreen();
      this.commitNow();
      this.startupSchedulePending = true;
      return;
    }
    this.extraValidations.pump();
    this.checkQueue.pump();
    if (this.extraRecovery) return;
    this.pollRoutines();
    this.driver.schedule();
    // That pass may release task prerequisites; their saved extra requests join immediately.
    this.extraValidations.pump();
  }

  private pollPullRequests(): void {
    void this.trackWork(this.shipping.monitor.pollPullRequests()).catch((error) =>
      console.error("Could not refresh pull requests:", error),
    );
  }

  startDriver(taskId: Id, resume = false): void {
    this.driver.startDriver(taskId, resume);
  }

  tidy(taskId: Id): void {
    void this.trackWork(this.cleanup.removeCopy(taskId));
  }

  /** Save and close immediately; resolves once agents and their remaining file handling have stopped. */
  shutdown(): Promise<void> {
    if (this.shutdownDone) return this.shutdownDone;
    if (this.stopped) return Promise.resolve();
    let done!: () => void;
    let failed!: (error: unknown) => void;
    this.shutdownDone = new Promise<void>((resolve, reject) => {
      done = resolve;
      failed = reject;
    });
    const synchronousFailures: unknown[] = [];
    const stateFailures: unknown[] = [];
    const request = (stop: () => void) => {
      try {
        stop();
      } catch (error) {
        synchronousFailures.push(error);
      }
    };
    // Stopped first: stopping agents still changes state, and nothing may save after the store closes.
    this.stopped = true;
    request(() => this.stopRequested.abort());
    request(() => this.events.stop());
    request(() => this.stopIdleSleep());
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    for (const timer of this.timers) clearInterval(timer);
    const observe = <T>(start: () => Promise<T>): Promise<T> => {
      try {
        return start();
      } catch (error) {
        return Promise.reject(error);
      }
    };
    const usageStopped = observe(() => this.usageCoordinator.stop());
    request(() => this.readiness.stop());
    request(() => this.screens.stop());
    const runs = [
      ...this.runs.entries(),
      ...[...this.helperRuns.entries()].flatMap(([taskId, entries]) => [...entries].map((run) => [taskId, run] as const)),
    ];
    for (const controller of this.drivers.values()) request(() => controller.abort());
    // Keep request order and method receivers, even when one entered stop throws synchronously.
    const owners = [
      this.startupReady,
      usageStopped,
      observe(() => this.extraValidations.shutdown()),
      observe(() => this.tools.shutdown()),
      observe(() => this.profileReader.stop()),
      observe(() => this.followUps.stop()),
    ];
    const agentStops = runs.map(([taskId, run]) => observe(() => this.stopAgent(taskId, run)));
    const draining = Promise.allSettled([...owners, ...agentStops, ...this.settling.values()]).then(async (outcomes) => {
      // A driver can hand file handling to the background while it settles. Re-read ownership after
      // each group, including work registered by that cleanup, before callers may remove its folders.
      for (;;) {
        const pending = [...this.backgroundWork, ...this.copyCleanups.values()];
        if (!pending.length) break;
        await Promise.allSettled(pending);
      }
      // Turns can release their scheduling entries before their bounded cleanup
      // finishes. Its task-owned receipt remains authoritative after driver drain.
      const cleanup = await this.agentCleanup.wait().then(() => undefined, (error) => ({ error }));
      return { owners: outcomes.slice(1, owners.length), cleanup };
    });
    const saveAndCloseLog = () => {
      // An ordinary quit keeps each step's working time up to now, and not the time Petrina is closed.
      this.s.now = Date.now();
      for (const task of this.s.tasks) {
        this.pauseStep(task, this.s.now);
        stopCheckProgress(task, this.s.now);
      }
      try {
        this.save();
      } catch (error) {
        console.error("Could not save while stopping:", error);
      } finally {
        // Turns still running stay unfinished in the log: the next start marks them lost.
        this.tracking.close();
      }
    };
    // Ordinary state and interrupted-turn semantics never wait behind container cleanup.
    try {
      saveAndCloseLog();
    } catch (error) {
      stateFailures.push(error);
    }
    // Startup recovery and outstanding extra work may still own private resources. State is
    // already saved above; keep the database available until those operations settle.
    const closeAfterDrain = !this.startupComplete || this.s.extraValidations?.length;
    const closeStore = () => {
      try {
        this.store.close();
      } catch (error) {
        stateFailures.push(error);
      }
    };
    if (!closeAfterDrain) closeStore();
    void draining
      .then((outcomes) => {
        if (closeAfterDrain) closeStore();
        const errors = [...synchronousFailures];
        for (const outcome of outcomes.owners) if (outcome.status === "rejected") errors.push(outcome.reason);
        if (outcomes.cleanup) errors.push(outcomes.cleanup.error);
        errors.push(...stateFailures);
        if (errors.length === 1) throw errors[0];
        if (errors.length) throw new AggregateError(errors, "Engine shutdown could not confirm all cleanup");
      })
      .then(done, failed);
    return this.shutdownDone;
  }

  // ── Profiles, routines, roles, products and first-run setup ────────────

  profileChoices({ toolId, modelId, refresh = false }: library.ProfileChoiceRequest) {
    return this.profileReader.read(toolId, modelId, refresh);
  }
  saveProfile(draft: library.ProfileDraft, clientId: Id, profileId?: Id): Promise<Id> {
    return this.catalogCommands.saveProfile(draft, clientId, profileId);
  }
  removeProfile(profileId: Id): void {
    this.catalogCommands.removeProfile(profileId);
  }
  saveRoutine(draft: library.RoutineDraft, routineId?: Id): Id {
    return this.catalogCommands.saveRoutine(draft, routineId);
  }
  setRoutineEnabled(routineId: Id, enabled: boolean): void {
    this.catalogCommands.setRoutineEnabled(routineId, enabled);
  }
  removeRoutine(routineId: Id): void {
    this.catalogCommands.removeRoutine(routineId);
  }
  resolveMaintenanceSettings(taskId: Id, choice: "keep" | "stop"): void {
    this.catalogCommands.resolveMaintenanceSettings(taskId, choice);
  }
  saveRole(roleId: Id, draft: RoleDraft): void {
    this.catalogCommands.saveRole(roleId, draft);
  }
  addRole(draft: RoleDraft): Id {
    return this.catalogCommands.addRole(draft);
  }
  resetRole(roleId: Id): void {
    this.catalogCommands.resetRole(roleId);
  }
  removeRole(roleId: Id): void {
    this.catalogCommands.removeRole(roleId);
  }
  addProduct(input: string, name?: string): Promise<Id> {
    return this.catalogCommands.addProduct(input, name);
  }
  setProductDelivery(productId: Id, delivery: DeliveryMode, approveDelivery: boolean): void {
    this.catalogCommands.setProductDelivery(productId, delivery, approveDelivery);
  }
  setProductChecks(productId: Id, checks: readonly { name: string; command: string }[] | null): void {
    this.catalogCommands.setProductChecks(productId, checks);
  }
  setProductCheckSetup(productId: Id, requirements: readonly library.CheckPrerequisite[]): void {
    this.catalogCommands.setProductCheckSetup(productId, requirements);
  }
  updateProduct(productId: Id, settings: ProductSettings): void {
    this.catalogCommands.updateProduct(productId, settings);
  }
  removeProduct(productId: Id): void {
    this.catalogCommands.removeProduct(productId);
  }
  checkTools(): Promise<void> {
    return this.tools.checkAll().then(() => {
      if (!this.stopped) this.schedule();
    });
  }
  findClones(): Promise<Clone[]> {
    return this.catalogCommands.findClones();
  }
  setSetupStep(step: SetupStep): void {
    this.catalogCommands.setSetupStep(step);
  }
  skipSetup(): void {
    this.catalogCommands.skipSetup();
  }
  dismissTip(): void {
    this.catalogCommands.dismissTip();
  }
  openGuide(url: string): void {
    this.catalogCommands.openGuide(url);
  }
  setTerminal(terminalId: Id): void {
    this.catalogCommands.setTerminal(terminalId);
  }

  // ── Tasks, backlog, queue, prerequisites, pool and screen ──────────────

  usage<R extends UsageRequest>(request: R): UsageViewFor<R> {
    return this.tracking.usage(request);
  }
  reportImage(taskId: string, imageId: string): Promise<Blob | undefined> {
    return this.taskCommands.reportImage(taskId, imageId);
  }
  previewImage(taskId: Id, path: string, productId?: Id): Promise<{ mime: string; data: string }> {
    return this.taskCommands.previewImage(taskId, path, productId);
  }
  startFirstTask(input: NewTaskInput & { clientId: Id }): Id {
    return this.taskCommands.startFirstTask(input);
  }
  addTask(input: NewTaskInput, schedule = true): Id {
    return this.taskCommands.addTask(input, schedule);
  }
  queueTask(taskId: Id): void {
    this.taskCommands.queueTask(taskId);
  }
  combineBacklog(taskIds: Id[], title: string, clientId: Id): Promise<Id> {
    return this.taskCommands.combineBacklog(taskIds, title, clientId);
  }
  moveToBacklog(taskId: Id): void {
    this.taskCommands.moveToBacklog(taskId);
  }
  updateBacklog(taskId: Id, changes: { title: string; description: string }): void {
    this.taskCommands.updateBacklog(taskId, changes);
  }
  setTaskStart(taskId: Id, choice: WorkChoice): Promise<void> {
    return this.taskCommands.setTaskStart(taskId, choice);
  }
  setTaskProducts(taskId: Id, choices: readonly WorkChoice[]): Promise<void> {
    return this.taskCommands.setTaskProducts(taskId, choices);
  }
  setTaskAddition(taskId: Id, repository: string, name: string, path: string): Promise<void> {
    return this.taskCommands.setTaskAddition(taskId, repository, name, path);
  }
  setTaskApproval(taskId: Id, ask: boolean): void {
    this.taskCommands.setTaskApproval(taskId, ask);
  }
  moveInQueue(taskId: Id, index: number): void {
    this.taskCommands.moveInQueue(taskId, index);
  }
  moveToTop(taskId: Id): void {
    this.moveInQueue(taskId, 0);
  }
  placeInQueue(taskId: Id, anchorId: Id, side: "before" | "after"): number {
    return this.taskCommands.placeInQueue(taskId, anchorId, side);
  }
  moveVisibleInQueue(taskId: Id, visibleIds: Id[], direction: -1 | 1): number {
    return this.taskCommands.moveVisibleInQueue(taskId, visibleIds, direction);
  }
  setHeld(taskId: Id, held: boolean): void {
    this.taskCommands.setHeld(taskId, held);
  }
  setAfter(taskId: Id, after: readonly Id[]): void {
    this.taskCommands.setAfter(taskId, after);
  }
  setRuntimeWait(taskId: Id, after: readonly Id[], reason: string, requestId: string): boolean {
    return this.taskCommands.setRuntimeWait(taskId, after, reason, requestId);
  }
  setStageProfile(
    taskId: Id,
    stageId: Id,
    list: "profileIds" | "reviewerProfileIds",
    index: number,
    profileId: Id,
  ): void {
    this.taskCommands.setStageProfile(taskId, stageId, list, index, profileId);
  }
  addReviewer(taskId: Id, stageId: Id, profileId: Id): void {
    this.taskCommands.addReviewer(taskId, stageId, profileId);
  }
  setPoolLimit(limit: number): void {
    this.driver.workflow.setPoolLimit(limit);
  }
  setToolCap(toolId: Id, cap: number): void {
    this.driver.workflow.setToolCap(toolId, cap);
  }
  setPoolPaused(paused: boolean): void {
    this.driver.workflow.setPoolPaused(paused);
  }
  setScreenUse(mode: ScreenMode): void {
    this.screens.setScreenUse(mode, this.options.screenHourMs ?? SCREEN_HOUR_MS);
  }
  allowScreen(taskId: Id): void {
    this.screens.allowScreen(taskId);
  }
  setTaskScreen(taskId: Id, allowed: boolean): void {
    this.screens.setTaskScreen(taskId, allowed);
  }

  // ── Interventions, messages, inbox decisions and take-over ─────────────

  pause(taskId: Id): void {
    this.inboxCommands.pause(taskId);
  }
  resume(taskId: Id): void {
    this.inboxCommands.resume(taskId);
  }
  cancel(taskId: Id): void {
    this.inboxCommands.cancel(taskId);
  }
  retry(itemId: Id): Promise<void> {
    return this.inboxCommands.retry(itemId);
  }
  rerunChecks(itemId: Id): void {
    this.inboxCommands.rerunChecks(itemId);
  }
  sendMessage(taskId: Id, text: string, mode: "now" | "queue" | "interrupt" = "now", clientId?: Id): Id | undefined {
    return this.inboxCommands.sendMessage(taskId, text, mode, clientId);
  }
  removeQueued(taskId: Id, messageId: Id): void {
    this.inboxCommands.removeQueued(taskId, messageId);
  }
  answer(itemId: Id, answer: string, context: SaidContext = {}, how: AskAnswer = "answered"): void {
    this.inboxCommands.answer(itemId, answer, context, how);
  }
  decideForMe(itemId: Id): void {
    this.inboxCommands.decideForMe(itemId);
  }
  allow(itemId: Id, scope: "once" | "always" = "once"): void {
    this.inboxCommands.allow(itemId, scope);
  }
  deny(itemId: Id, note?: string, context: SaidContext = {}): void {
    this.inboxCommands.deny(itemId, note, context);
  }
  approve(itemId: Id): void | Promise<void> {
    return this.inboxCommands.approve(itemId);
  }
  requestChanges(itemId: Id, note: string): void {
    this.inboxCommands.requestChanges(itemId, note);
  }
  decline(itemId: Id): void {
    this.inboxCommands.decline(itemId);
  }
  takeOver(taskId: Id, how: "open" | "copy" = "open"): Promise<Launched> {
    return this.takeover.takeOver(taskId, how);
  }
  reopenTerminal(taskId: Id, how: "open" | "copy" = "open"): Promise<Launched> {
    return this.takeover.reopenTerminal(taskId, how);
  }
  handBackPreview(taskId: Id): Promise<HandBackPreview> {
    return this.takeover.handBackPreview(taskId);
  }
  handBack(taskId: Id, note = "", anyway = false): Promise<void> {
    return this.takeover.handBack(taskId, note, anyway);
  }
  checkShipping(itemId: Id): void {
    this.shipping.checkShipping(itemId);
  }
  shipAgain(itemId: Id): void {
    this.shipping.shipAgain(itemId);
  }
  markDone(itemId: Id): void {
    this.shipping.markDone(itemId);
  }
  addLessons(itemId: Id, keep: number[]): void {
    this.learnings.accept(itemId, keep);
  }
}
