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

import {
  stopCheckProgress,
  type Commands,
  type Id,
} from "@petrina/core";
import type { AgentAdmissionDependencies, ParticipantAdmission } from "@petrina/orchestrator";
import { AcceptedPoints } from "./accepted-points.js";
import { CatalogCommands } from "./catalog-commands.js";
import { Checkpoints } from "./checkpoints.js";
import { Cleanup } from "./cleanup.js";
import { Connections } from "./connection.js";
import { Context } from "./context.js";
import { Design } from "./design.js";
import { Driver } from "./driver.js";
import { bindEngineCommands, type EngineBoundCommands } from "./engine-commands.js";
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

export interface Engine extends EngineBoundCommands {}

/** The engine: every command the window can send (Commands) is a method here. */
export class Engine extends Kernel implements Commands {
  override readonly agentAdmission: AgentAdmissionDependencies & { participant: ParticipantAdmission };
  override readonly readiness: Readiness;
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
    this.agentAdmission = this.driver.agentAdmission;
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
    Object.assign(
      this,
      bindEngineCommands({
        kernel: this,
        options,
        profileReader: this.profileReader,
        tools: this.tools,
        catalogCommands: this.catalogCommands,
        taskCommands: this.taskCommands,
        inboxCommands: this.inboxCommands,
        driver: this.driver,
        takeover: this.takeover,
        shipping: this.shipping,
        learnings: this.learnings,
        moveInQueue: (taskId, index) => this.moveInQueue(taskId, index),
      }),
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

  override schedule(): void {
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

  override startDriver(taskId: Id, resume = false): void {
    this.driver.startDriver(taskId, resume);
  }

  override tidy(taskId: Id): void {
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
    for (const run of [...this.runs.values(), ...[...this.helperRuns.values()].flatMap((entries) => [...entries])]) {
      request(() => run.flushMessages?.());
    }
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
}
