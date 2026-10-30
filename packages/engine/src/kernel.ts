// The engine's shared state and the few operations every part of it uses: lookups, the timeline and
// session, the inbox, and saving. Feature modules get this, never the Engine itself.

import { randomBytes } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import * as library from "@petrina/core";
import {
  bindParticipantSessionLine,
  blockingDependencies,
  BUILT_IN_ROLES,
  clearRunningTools,
  clearTaskStep,
  columnOf,
  finishTaskStep,
  involvesProduct,
  libraryRoles,
  NO_ROLE_CHANGES,
  queueOf,
  restoreProfileCatalog,
  runtimeWaitHolds,
  runtimeWaitView,
  runtimeWaitWords,
  saySessionLine,
  stepTag,
  stopCheckProgress,
  stopTaskActivity,
  TAKE_OVER_WORDS,
  withdrawAsks,
  type AgentProfile,
  type CheckId,
  type Column,
  type DeepMutable,
  type GateKind,
  type HistoryPage,
  type HistoryQuery,
  type Id,
  type InboxItem,
  type InboxKind,
  type Role,
  type State,
  type StepNote,
  type Task,
} from "@petrina/core";
import {
  drainRuntime,
  executionOf,
  inFlightWork,
  keepsIdleSleep,
  pauseAgentStep,
  restoreRepositoryState,
  resumeAgentAfterReply,
  StepOwnership,
  waitForAgentUsage,
  type AgentAdmissionDependencies,
  type AgentSession,
  type GitHubService,
  type ParticipantAdmission,
  type RepositoryContext,
} from "@petrina/orchestrator";
import { localFiles, type FileOperations } from "@petrina/platform/file-operations";
import { githubService } from "@petrina/repositories/github-service";
import { Store } from "@petrina/storage/store";
import { recoverBrowserTemps } from "@petrina/agent-runtime/browser";
import { detectTerminals, thisMachine, type FoundTerminal } from "@petrina/agent-runtime/terminal";
import { ADAPTERS, detectTools, ENGINE_PROFILES } from "@petrina/agent-runtime/tools";
import type { ModelAtCapacity, UsageInfo, UsageLimited } from "@petrina/agent-runtime/usage";
import { AcceptanceRestorations } from "./acceptance-restorations.js";
import { AgentCleanup } from "./agent-cleanup.js";
import { IdleSleepAssertion } from "./awake.js";
import { CheckQueue } from "./check-queue.js";
import {
  Aborted,
  abortable,
  CHECK_FINDER_PROFILE,
  checksLine,
  GUIDE_KEEPER_PROFILE,
  MaintenanceProfileProblem,
  MAX_SESSION_LINES,
  MAX_TIMELINE,
  notReady,
  PLANNER_PROFILE,
  RELEASE_MANAGER_PROFILE,
  renameRoles,
  RISK_WORD,
  ScreenWait,
  setupOf,
  SourceRefreshRequired,
  stepKey,
  TONES,
  ToolProblem,
  type EngineOptions,
  type MutableStage,
  type RuntimeState,
  type RuntimeTask,
} from "./engine-options.js";
import {
  checkStageOf,
  failTask,
  finishParallelReviewWork,
  raiseGate,
  raiseInboxItem,
  rememberCoordinatorNote,
  showParallelReviewWork,
  type RaiseExtra,
} from "./kernel-gates.js";
import type { MessageTurn } from "./messages.js";
import type { Readiness } from "./readiness.js";
import { ScreenCoordinator } from "./screen-coordinator.js";
import { StateProjection } from "./state-projection.js";
import { Tracking } from "./tracking.js";
import { UsageCoordinator, type Selection } from "./usage-coordinator.js";
import { WorkflowEvents } from "./workflow-events.js";

export {
  Aborted,
  abortable,
  CHECK_FINDER_PROFILE,
  checksLine,
  GUIDE_KEEPER_PROFILE,
  MaintenanceProfileProblem,
  MAX_SESSION_LINES,
  MAX_TIMELINE,
  notReady,
  PLANNER_PROFILE,
  RELEASE_MANAGER_PROFILE,
  renameRoles,
  RISK_WORD,
  ScreenWait,
  SourceRefreshRequired,
  stepKey,
  TONES,
  ToolProblem,
  type EngineOptions,
  type MutableStage,
  type RuntimeState,
  type RuntimeTask,
};

export abstract class Kernel {
  /** One actual scheduler/participant/group boundary, composed by the Engine before agents can run. */
  agentAdmission!: AgentAdmissionDependencies & { participant: ParticipantAdmission };
  private readonly projection = new StateProjection(this, (task) => renameRoles({ ...this.s, tasks: [task], inbox: [] }));
  private readonly acceptanceRestorations = new AcceptanceRestorations(this);
  readonly screens = new ScreenCoordinator(this);
  readonly usageCoordinator = new UsageCoordinator(this);
  /** Bounded readiness rechecks for saved participants; the engine supplies them with its tool checks. */
  readiness!: Readiness;
  /** Set by the Engine: what starts drivers and fills free slots. */
  abstract schedule(): void;
  abstract startDriver(taskId: Id, resume?: boolean): void;
  /** Set by the Engine: a task may be finished with its working copy; it goes once nothing uses it. */
  abstract tidy(taskId: Id): void;
  /** Set by the Engine: a task has just become done, so a confirmed older bug can become a backlog card. */
  onTaskDone?: (task: RuntimeTask) => void;
  /** Set by the Engine: copy follow-up pictures before a done task's captures are removed. */
  beforeCaptureRemoval?: (task: RuntimeTask) => Promise<void>;
  /** A coordinator decision yields pre-publication resource ownership before waiting for its reply. */
  onCoordinatorWait?: (task: RuntimeTask) => void;
  private readonly followUpHolds = new Map<Id, number>();

  /** Keep a just-finished task in memory until its follow-up card has copied what it needs. */
  holdFollowUp(id: Id): () => void {
    this.followUpHolds.set(id, (this.followUpHolds.get(id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.followUpHolds.get(id) ?? 1) - 1;
      if (next <= 0) this.followUpHolds.delete(id);
      else this.followUpHolds.set(id, next);
    };
  }

  followsUpHeld(id: Id): boolean {
    return (this.followUpHolds.get(id) ?? 0) > 0;
  }

  /** Browser recovery is asynchronous; startup stays gated until its owned processes are gone. */
  protected readonly startupReady: Promise<void>;
  protected startupComplete = false;
  protected startupSchedulePending = false;
  readonly files: FileOperations;
  readonly github: GitHubService;
  readonly stepOwnership = new StepOwnership({
    role: (id, task) => this.role(id, task),
    group: (id) => this.screenGroups.get(id),
  });

  readonly s: RuntimeState;
  readonly store: Store;
  /** The work log: every agent turn and notable moment, the permanent product list and the tools' limits. */
  readonly tracking: Tracking;
  /** Compact workflow events, recorded on every change through the state projection and retained per run. */
  readonly events: WorkflowEvents;
  private readonly idleSleep: IdleSleepAssertion;
  readonly listeners = new Set<() => void>();
  /** Reports whose chosen captures are being checked, by line id. Kept outside saved task state. */
  readonly pendingReportIds = new Set<string>();
  readonly drivers = new Map<Id, AbortController>();
  /** An internal preparation role that still needs ordinary tool and pool admission. */
  readonly pendingAgentAdmissions = new Map<Id, { step: string; roleId: Id; profileId: Id }>();
  readonly runs = new Map<Id, AgentSession>();
  readonly agentCleanup = new AgentCleanup();
  readonly messageTurns = new Map<Id, Map<string, MessageTurn>>();
  /** Agents working beside a task's main one on the same step (reviewers hunting at once, voters). */
  readonly helperRuns = new Map<Id, Set<AgentSession>>();
  /** Finished-task working copies being removed. */
  readonly cleanupJobs = new Set<Id>();
  readonly waiting = new Map<Id, { resolve: (value: string) => void; reject: (error: Error) => void }>();
  saveTimer: ReturnType<typeof setTimeout> | undefined;
  /** A to-do item is in memory and not in the snapshot on disk yet. */
  private todoPending = false;
  /** Text already updated in memory, awaiting one bounded detail/persistence notification. */
  private readonly streamedTasks = new Set<RuntimeTask>();
  private streamTimer: ReturnType<typeof setTimeout> | undefined;
  readonly timers: ReturnType<typeof setInterval>[] = [];
  /** Set by shutdown: work that ends afterwards (a turn cut off by the stop) changes nothing. */
  stopped = false;
  /** Optional background evidence reads end when stopping is requested, before admitted work drains. */
  readonly stopRequested = new AbortController();
  /** Stopping is under way: no new agent starts, and reviewers and voters in flight hand back first. */
  draining = false;
  drainReason: "stop" | "restart" = "restart";
  /** Cleanup and delivery lookups outside a task driver still belong to a drain. */
  readonly backgroundWork = new Set<Promise<unknown>>();
  readonly checkQueue = new CheckQueue(
    () => this.options.checkRuns ?? 1,
    () => (this.admissionsClosed ? (this.draining ? this.drainLine : "Waiting for the pool to resume") : undefined),
    () => this.draining || this.stopped,
  );
  /** Live check callers awaiting capacity; they keep their FIFO entry while the pool is paused. */
  readonly waitingChecks = new Map<Id, number>();
  extraRecovery = false;
  extraCheckBlocker?: () => string | undefined;
  extraChecksActive?: () => boolean;
  /** This run of the engine, to tell a restart from a pause. */
  readonly boot = randomBytes(6).toString("hex");
  /** Each driver until it has fully stopped, clean-up included. */
  readonly settling = new Map<Id, Promise<void>>();
  /** Tasks Petrina is taking over, opening a terminal for again, or handing back right now. */
  readonly switching = new Map<Id, keyof typeof TAKE_OVER_WORDS.busy>();
  readonly machine = thisMachine();
  /** Why Claude Code's sandbox could not start in this run of Petrina: later agents run without it, and say so. */
  sandboxOff: string | undefined;
  /** The terminals on this machine, the usual one first. */
  readonly found: FoundTerminal[];

  constructor(
    readonly dataDir: string,
    readonly options: EngineOptions = {},
  ) {
    this.files = options.files ?? localFiles;
    this.github = options.github ?? githubService(options.gh);
    this.store = new Store(join(dataDir, "petrina.db"), { debugSql: options.debugSql });
    try {
      const loaded = this.store.loadActive((state) => {
        for (const task of state.tasks) restoreRepositoryState(task as RuntimeTask);
        renameRoles(state as RuntimeState);
      });
      this.s = (loaded ?? this.empty()) as RuntimeState;
      this.s.backgroundAgents = [];
      // An injected agent command is the engine test seam. Never let fake-agent tests spawn a real
      // system sleep assertion; production launches use the default unless they inject an observer.
      const awakeObserver = options.awakeObserver ?? (options.agentCommand ? () => {} : undefined);
      this.idleSleep = new IdleSleepAssertion(awakeObserver ? { observe: awakeObserver } : {});
      this.draining = options.admissionsClosed ?? false;
      if (loaded) {
        renameRoles(this.s);
        // Nothing worked while Petrina was stopped: a step's working time ends at the last moment it saved.
        for (const task of this.s.tasks) {
          this.pauseStep(task, this.s.now);
          stopCheckProgress(task, this.s.now);
          clearRunningTools(task);
        }
      }
      this.s.roleChanges = (loaded?.roleChanges ?? structuredClone(NO_ROLE_CHANGES)) as RuntimeState["roleChanges"];
      this.s.roles = libraryRoles(this.s.roleChanges) as RuntimeState["roles"];
      restoreProfileCatalog(this.s);
      // Tests stand in the tools' own apps: those count as installed.
      this.s.tools = detectTools(
        options.requireAgentCommand ? (id) => Boolean(options.toolPath?.(id) || options.agentCommand) : undefined,
      ).map((tool) => (options.toolPath?.(tool.id) ? { ...tool, status: "ready" as const } : tool)) as RuntimeState["tools"];
      this.s.setup = setupOf(loaded) as RuntimeState["setup"];
      if (this.s.setup && !loaded?.setup && this.store.history.info().total > 0) this.s.setup.done = true;
      this.s.planner = this.onUsable(PLANNER_PROFILE);
      this.found = options.terminals?.() ?? detectTerminals(this.machine);
      this.s.terminals = this.found.map(({ id, name }) => ({ id, name }));
      this.tracking = new Tracking(this);
      this.tracking.start();
      // What is loaded is the starting point: observation begins here, and only later changes are events.
      this.events = new WorkflowEvents(this, options.eventRetention);
      this.events.baseline(this.s.tasks);
      this.usageCoordinator.startReaders(this.dataDir, options);
      this.acceptanceRestorations.recoverStoppedRestorations();
    } catch (error) {
      this.stopped = true;
      const failures: unknown[] = [];
      for (const close of [
        () => this.usageCoordinator.stop(),
        () => this.idleSleep?.shutdown(),
        () => this.tracking?.close(),
        () => this.store.close(),
      ]) {
        try {
          close();
        } catch (failure) {
          failures.push(failure);
        }
      }
      if (failures.length) {
        throw new AggregateError([error, ...failures], "Engine construction failed and its resources could not all be closed");
      }
      throw error;
    }
    // Do not start native recovery for a synchronously failed construction with no returned owner.
    const browserRecovery = options.browserRecovery?.bind(options) ?? recoverBrowserTemps;
    let recovering: Promise<void>;
    try {
      recovering = browserRecovery(join(dataDir, "browser-temp"), options.browserTempRoot);
    } catch (error) {
      recovering = Promise.reject(error);
    }
    this.startupReady = recovering.then(() => {
      this.startupComplete = true;
      if (this.startupSchedulePending && !this.stopped) this.schedule();
    });
    // Launch awaits startupReady to report recovery failures. Consume an otherwise
    // unobserved rejection for direct Engine users while leaving the original promise rejectable.
    void this.startupReady.catch(() => undefined);
  }

  waitUntilReady(): Promise<void> {
    return this.startupReady;
  }

  /** A product scope covers a task that retains the product, live or archived. Archived membership comes from the history index, never a complete body. */
  readonly taskInvolves = (taskId: Id, productId: Id): boolean => {
    const task = this.s.tasks.find((entry) => entry.id === taskId);
    if (task) return involvesProduct(task, productId);
    const archived = this.store.history.item(taskId);
    return !!archived && (archived.productIds ?? [archived.productId]).includes(productId);
  };

  /** Whether a task exists, live or archived, from the history index alone: no archived body is read. */
  readonly taskKnown = (taskId: Id): boolean =>
    this.s.tasks.some((entry) => entry.id === taskId) || this.store.history.has(taskId);

  /** A live review group can reopen its waiting screen member without stopping its peers. */
  get screenGroups() {
    return this.screens.groups;
  }

  /** Discarded review copies finish cleaning up before the task can start fresh. */
  get copyCleanups() {
    return this.screens.copyCleanups;
  }

  get drainLine(): string {
    return this.drainReason === "stop" ? "Waiting: Petrina is stopping" : "Waiting: Petrina is restarting";
  }

  get admissionsClosed(): boolean {
    return this.extraRecovery || this.draining || this.s.pool.paused || this.stopped;
  }

  trackWork<T>(work: Promise<T>): Promise<T> {
    // Drains wait for completion; the caller owns the result and any failure.
    const tracked = work.finally(() => this.backgroundWork.delete(tracked)).catch(() => undefined);
    this.backgroundWork.add(tracked);
    return work;
  }

  /** A quiet check waiter does not prevent pool pause completing; a stop/restart still drains its caller. */
  isPausedCheck(taskId: Id): boolean {
    return (
      this.s.pool.paused
      && !this.draining
      && this.waitingChecks.has(taskId)
      && !this.runs.has(taskId)
      && !this.helperRuns.get(taskId)?.size
    );
  }

  /** The same admission boundary as a paused pool, scoped to one task. Running work is never aborted. */
  taskAdmissionsClosed(task: RuntimeTask | Id): boolean {
    const current = typeof task === "string" ? this.task(task) : task;
    return this.admissionsClosed || (!!current && runtimeWaitHolds(current));
  }

  taskAdmissionWait(task: RuntimeTask): string {
    if (runtimeWaitHolds(task)) return runtimeWaitWords(runtimeWaitView(task, (id) => this.taskDetails(id))!);
    return this.draining ? this.drainLine : "Waiting for the pool to resume";
  }

  /** Saved history defers catch-up only for work that can actually continue on that version. */
  taskStepStarted(task: RuntimeTask): boolean {
    return this.stepOwnership.started(task);
  }

  /** A readiness reservation is no input. Every new admission must cross any source boundary now owed. */
  taskSourceRefreshDue(task: RuntimeTask): boolean {
    return this.stepOwnership.refreshDue(task);
  }

  /** Agents whose work is lost by a restart: reviewers and voters working side by side (never reopened) and a Release Manager mid-delivery. */
  inFlight(): number {
    return this.inFlightWithCleanup(this.agentCleanup.size);
  }

  private inFlightWithCleanup(cleanup: number): number {
    const agents = this.runs.size + [...this.helperRuns.values()].reduce((sum, runs) => sum + runs.size, 0);
    return (
      agents
      || inFlightWork({
        agents: 0,
        settling: [...this.settling.keys()].filter((id) => !this.isPausedCheck(id)).length,
        copyCleanups: this.copyCleanups.size,
        background: this.backgroundWork.size + cleanup,
        terminals: this.s.tasks.filter((task) => task.driving && !this.isPausedCheck(task.id)).length,
      })
    );
  }

  /** A failed receipt still blocks reuse/disposal, but cannot finish by waiting in this engine. */
  drainObservation() {
    const cleanup = this.agentCleanup.snapshot();
    return { pending: this.inFlightWithCleanup(cleanup.waiting), cleanup };
  }

  /** Keep macOS awake only while this engine still owns active work or its cleanup. */
  syncIdleSleep(): void {
    if (this.stopped) {
      this.idleSleep.setActive(false);
      return;
    }
    const owned = {
      drivers: [...this.drivers.keys()].some((id) => !this.isPausedCheck(id)),
      settling: [...this.settling.keys()].some((id) => !this.isPausedCheck(id)),
      agents: this.runs.size > 0,
      helpers: [...this.helperRuns.values()].some((runs) => runs.size > 0) || this.agentCleanup.pending > 0,
      screenGroups: this.screenGroups.size > 0,
      switching: this.switching.size > 0,
      copyCleanups: this.copyCleanups.size > 0,
      cleanupJobs: this.cleanupJobs.size > 0,
    };
    const knownActive = keepsIdleSleep({ ...owned, stopped: this.stopped, extraChecks: false });
    const active = knownActive
      || keepsIdleSleep({ ...owned, stopped: this.stopped, extraChecks: !this.stopped && !!this.extraChecksActive?.() });
    this.idleSleep.setActive(active);
  }

  stopIdleSleep(): void {
    this.idleSleep.shutdown();
  }

  /**
   * Before stopping: no new agent starts, and the ones a restart would make start over get up to `limitMs` to
   * hand back. `onWait` hears how many are left each time it changes. Returns how many were still in flight.
   */
  async drain(limitMs: number, onWait?: (left: number) => void): Promise<number> {
    return drainRuntime(
      {
        requestStop: () => {
          this.draining = true;
          this.stopRequested.abort();
          this.checkQueue.pump();
        },
        stopped: () => this.stopped,
        inFlight: () => this.drainObservation().pending,
        failure: () => this.agentCleanup.snapshot().failure,
      },
      { now: () => Date.now(), sleep: (ms) => Bun.sleep(ms) },
      limitMs,
      onWait,
    );
  }

  /** Current engine work only. Completed bodies are loaded separately when somebody opens one. */
  activeState = (): State => this.s;
  getState = (): State => this.projection.getState();
  windowState = (): State => this.projection.windowState();
  historyPage = (request: HistoryQuery): HistoryPage => this.projection.historyPage(request);
  taskDetails = (id: Id): Task | undefined => this.projection.taskDetails(id);

  saveArchivedTask(task: RuntimeTask): void {
    this.projection.saveArchivedTask(task);
  }

  /** Only saved extra-work ownership keeps the store open for late shutdown evidence. */
  extraValidationTask(id: Id): RuntimeTask | undefined {
    const record = this.s.extraValidations?.find((entry) => entry.id === id);
    return record ? this.projection.task(record.taskId, true) : undefined;
  }

  saveExtraValidationTask(id: Id, task: RuntimeTask, line: Task["timeline"][number]): void {
    const record = this.s.extraValidations?.find((entry) => entry.id === id && entry.taskId === task.id);
    if (!record) throw new Error("Extra validation no longer owns this task's cleanup.");
    if (this.stopped) this.store.saveExtraValidationEvidence(record, line, MAX_TIMELINE, this.s.extraValidations, this.s.seq);
    else this.projection.saveArchivedTask(task);
  }

  forgetProductHistory(productId: Id): void {
    this.projection.forgetProductHistory(productId);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The tasks this one still waits for. */
  blockers(task: RuntimeTask): RuntimeTask[] {
    return blockingDependencies(task, (id) => this.task(id));
  }

  /** The step the coordinator drove finished: its review chain runs again from the first reviewer, without using up a round. */
  rerun(task: RuntimeTask): boolean {
    const id = task.rereview;
    if (!id) return false;
    delete task.rereview;
    const index = task.plan?.stages.findIndex((stage) => stage.id === id) ?? -1;
    if (index < 0) return false;
    task.stageIndex = index;
    task.sub = 0;
    task.fixing = false;
    delete task.hunt;
    this.log(task, "milestone", "Reviewing your changes: the review starts again from the first reviewer");
    this.commit();
    return true;
  }

  /**
   * `checks`: a check problem's own title and explanation, raised wherever the failing checks stopped the task.
   * `decides`: the stage a check raised again still decides (null when its original recorded none).
   */
  gate(
    task: RuntimeTask,
    gate: GateKind,
    problem?: string,
    checks?: { title: string; body: string },
    decides?: Id | null,
  ): void {
    raiseGate(this, task, gate, problem, checks, decides);
  }

  /** `by`: the agent asking, when it is not the task's main one (a reviewer working beside others). */
  raise(
    target: RuntimeTask | RepositoryContext,
    kind: InboxKind,
    title: string,
    blocking: boolean,
    extra: RaiseExtra = {},
    by: { roleId: Id; profileId: Id } | undefined = undefined,
  ): Id {
    return raiseInboxItem(this, target, kind, title, blocking, extra, by);
  }

  fail(taskId: Id, error: unknown): void {
    failTask(this, taskId, error);
  }

  /** The agent tools the squad uses now: Ready ones, or if none is, those Petrina couldn't check. */
  usableTools(): CheckId[] {
    return this.usageCoordinator.usableTools();
  }

  /** The same kind of profile on a tool the squad can use. Unchanged when its tool is usable, or when none is. */
  onUsable(profileId: Id): Id {
    return this.usageCoordinator.onUsable(profileId);
  }

  /**
   * The stage a waiting check decides: recorded on it, else a pending review decision's review. Undefined: the current
   * stage. Null: unknown, for an older delivery check that recorded none while the flow stands away from the delivery
   * check (as when raised again after a review decision), so the current stage is not where it was asked.
   */
  checkStage(task: RuntimeTask, item: InboxItem): Id | null | undefined {
    return checkStageOf(task, item);
  }

  /** `stageId`: the stage a checkpoint decides (null when unknown); by default, that of a check waiting on the task. */
  remember(task: RuntimeTask, text: string, id?: Id, kind?: InboxKind, stageId?: Id | null): void {
    rememberCoordinatorNote(this, task, text, id, kind, stageId);
  }

  /** Keep what the coordinator said for the current step, until the step finishes. */
  stepNote(task: RuntimeTask, kind: StepNote["kind"], text: string, extra: { id?: Id; about?: string } = {}): void {
    task.stepNotes = [
      ...(task.stepNotes ?? []),
      { id: extra.id ?? this.id(task.id), at: Date.now(), kind, text, ...(extra.about ? { about: extra.about } : {}) },
    ];
  }

  /**
   * The step handed back its result: a short record of it is kept for estimates, unless it was started again
   * (a restart, a pause, Try again, a stand-in), and the next step starts clean, in a new conversation.
   */
  finishStep(target: RuntimeTask | RepositoryContext): void {
    const scope = executionOf(target);
    const { task, work: repository } = scope;
    finishTaskStep(task, repository, Date.now());
    delete task.capacityResume;
    delete task.capacityRetries;
    delete task.capacityPaused;
    this.pendingAgentAdmissions.delete(task.id);
    this.releaseScreen(task);
  }

  /** The next step starts clean: nothing said in this one, no conversation, no to-do item, no clock. */
  clearStep(target: RuntimeTask | RepositoryContext): void {
    const scope = executionOf(target);
    const { task, work: repository } = scope;
    clearTaskStep(task, repository);
    delete task.capacityResume;
    delete task.capacityRetries;
    delete task.capacityPaused;
    this.releaseScreen(task);
    this.stopStep(task);
  }

  /** A reopened reviewer or voter still works in its own copy, including during terminal take-over. */
  agentWorktree(target: RuntimeTask | RepositoryContext): string {
    return this.screens.agentWorktree(target);
  }

  /** Pause, cancel or failure discards saved screen conversations and their separate working copies. */
  discardScreenTurns(task: RuntimeTask): void {
    return this.screens.discardScreenTurns(task);
  }

  /**
   * The agent asked for the screen. Allowed and free: it has it now, in the same conversation. Otherwise its
   * conversation closes but is kept, its slot frees at once, and the task waits: for the coordinator's OK (with
   * a quiet inbox item), or for its turn.
   */
  askScreen(task: RuntimeTask, roleId: Id, profileId: Id, reason: string, member?: string): boolean {
    return this.screens.askScreen(task, roleId, profileId, reason, member);
  }

  /** Wait without a slot; a screen attempt that ran out of usage returns to the end of the queue. */
  waitForScreen(task: RuntimeTask): void {
    return this.screens.waitForScreen(task);
  }

  /** Keep each waiting request's status line and quiet inbox item in step with who may use the screen now. */
  syncScreen(): void {
    return this.screens.syncScreen();
  }

  /** Expose the group's earliest allowed request, including after usage requeues or permission changes. */
  selectScreen(task: RuntimeTask): void {
    return this.screens.selectScreen(task);
  }

  /** The step's screen request ends with the step (or a pause, a cancel, a failure): the next request may have the screen. */
  releaseScreen(task: RuntimeTask): void {
    return this.screens.releaseScreen(task);
  }

  /** For an hour turns itself off when it runs out. */
  armScreenTimer(): void {
    return this.screens.armScreenTimer();
  }

  /** The step stops before handing back its result: its to-do item and clock go, and it starts fresh next time. */
  stopStep(task: RuntimeTask): void {
    this.pendingAgentAdmissions.delete(task.id);
    stopTaskActivity(task);
  }

  /** The agent stops working on the step for a while (it waits for the coordinator or for usage): the wait is not working time. */
  pauseStep(task: RuntimeTask, now = Date.now()): void {
    pauseAgentStep(task, now);
  }

  /**
   * One steady member's summary: whoever needs the coordinator while they wait, then one whose own tool is
   * retrying by itself, then one working. A retry names its tool, and says the others continue only when one does.
   */
  showReviewWork(task: RuntimeTask): void {
    showParallelReviewWork(task);
  }

  /** Each completed reviewer or voter leaves its own record; interrupted attempts do not. */
  finishReviewWork(task: RuntimeTask, key: string): void {
    finishParallelReviewWork(this, task, key);
  }

  /** False for a resend of something already received (its confirmation was lost on the way back). */
  firstTime(task: RuntimeTask, clientId: Id | undefined): boolean {
    if (!clientId) return true;
    if (task.received?.includes(clientId)) return false;
    task.received = [...(task.received ?? []), clientId].slice(-50);
    return true;
  }

  toWaiting(task: RuntimeTask): void {
    task.state = "waiting";
    task.statusLine = "Waiting for a free slot";
    task.column = this.columnFor(task);
  }

  unblock(task: RuntimeTask): void {
    resumeAgentAfterReply(task, this.s.inbox.some((item) => item.taskId === task.id && item.blocking), Date.now());
  }

  takeItem(itemId: Id): DeepMutable<InboxItem> | undefined {
    const item = this.s.inbox.find((entry) => entry.id === itemId);
    if (item) this.s.inbox = this.s.inbox.filter((entry) => entry.id !== itemId);
    return item;
  }

  async waitForReply(id: Id, signal: AbortSignal): Promise<string> {
    let waiter!: { resolve: (answer: string) => void; reject: (error: unknown) => void };
    const reply = new Promise<string>((resolve, reject) => {
      waiter = { resolve, reject };
      this.waiting.set(id, waiter);
    });
    try {
      return await abortable(reply, signal);
    } finally {
      if (this.waiting.get(id) === waiter) this.waiting.delete(id);
    }
  }

  dropBlockingItems(taskId: Id): void {
    const task = this.task(taskId);
    const dropped = this.s.inbox.filter(
      (entry) => entry.taskId === taskId && entry.blocking && entry.kind !== "maintenance-settings",
    );
    if (task) withdrawAsks(task, dropped.map((item) => item.id), Date.now());
    for (const item of dropped) {
      this.waiting.get(item.id)?.reject(new Aborted());
      this.waiting.delete(item.id);
    }
    this.s.inbox = this.s.inbox.filter(
      (entry) => !(entry.taskId === taskId && entry.blocking && entry.kind !== "maintenance-settings"),
    );
  }

  stopDriver(taskId: Id): void {
    this.drivers.get(taskId)?.abort();
    this.drivers.delete(taskId);
    const run = this.runs.get(taskId);
    if (run) void this.stopAgent(taskId, run).catch(() => undefined);
    this.runs.delete(taskId);
    this.stopHelpers(taskId);
  }

  /** Stop every agent working beside the task's main one. */
  stopHelpers(taskId: Id): void {
    for (const run of this.helperRuns.get(taskId) ?? []) void this.stopAgent(taskId, run).catch(() => undefined);
    this.helperRuns.delete(taskId);
    this.syncIdleSleep();
  }

  /** Request native cleanup once; removing a running seat never discards this receipt. */
  stopAgent(taskId: Id, run: AgentSession): Promise<void> {
    const stopped = this.agentCleanup.stop(taskId, run);
    this.syncIdleSleep();
    void stopped.then(() => this.syncIdleSleep(), () => this.syncIdleSleep()).catch(() => undefined);
    return stopped;
  }

  undoReadOnly(
    target: RuntimeTask | RepositoryContext,
    roleId: Id,
    worktree?: string,
    knownClean?: boolean,
  ): Promise<void> {
    return this.acceptanceRestorations.undoReadOnly(target, roleId, worktree, knownClean);
  }

  noteRestoredAcceptance(
    scope: RepositoryContext,
    role: Role,
    productId: Id,
    path: string,
    since: string | undefined,
    change: { commits: boolean; edits: boolean },
  ): Promise<void> {
    return this.acceptanceRestorations.noteRestoredAcceptance(scope, role, productId, path, since, change);
  }

  beginAcceptanceCleanup(task: RuntimeTask): string {
    return this.acceptanceRestorations.beginAcceptanceCleanup(task);
  }

  endAcceptanceCleanup(scope: RepositoryContext, cleanup: string): void {
    this.acceptanceRestorations.endAcceptanceCleanup(scope, cleanup);
  }

  /** A product as the coordinator named it. */
  productLabel(productId: Id): string {
    return this.s.products.find((product) => product.id === productId)?.name ?? productId;
  }

  /** Keep an editing role's work before another role's read-only clean-up can undo it. */
  saveRoleEdits(target: RuntimeTask | RepositoryContext, roleId: Id, profileId: Id): Promise<void> {
    return this.acceptanceRestorations.saveRoleEdits(target, roleId, profileId);
  }

  /** Reuse only a version this operation just observed or created, never an earlier saved freshness flag. */
  rememberVersion(scope: RepositoryContext, observed?: { head?: string; tree?: string }): Promise<void> {
    return this.acceptanceRestorations.rememberVersion(scope, observed);
  }

  columnFor(task: RuntimeTask): Column {
    return columnOf(task, this.s.roles);
  }

  empty(): State {
    return {
      now: Date.now(),
      seq: 0,
      products: [],
      roles: BUILT_IN_ROLES,
      tools: [],
      profiles: ENGINE_PROFILES,
      tasks: [],
      inbox: [],
      pool: { limit: 3, paused: false, toolCaps: Object.fromEntries(Object.keys(ADAPTERS).map((id) => [id, 3])) },
    };
  }

  renumberQueue(): void {
    queueOf(this.s.tasks as Task[]).forEach((task, position) => {
      const entry = this.task(task.id);
      if (entry) entry.priority = position;
    });
  }

  task(id: Id): RuntimeTask | undefined {
    return this.projection.task(id);
  }

  repositoryOf(target: RuntimeTask | RepositoryContext) {
    const scope = executionOf(target);
    const { work: repository } = scope;
    const product = this.productOf(scope);
    return product && repository.source ? { ...product, ...repository.source.product, name: product.name } : product;
  }

  productOf(target: RuntimeTask | RepositoryContext) {
    const scope = executionOf(target);
    const { work: repository } = scope;
    return this.s.products.find((product) => product.id === repository.productId);
  }

  role(id: Id, task?: RuntimeTask): Role | undefined {
    return library.roleForTask(this.s.roles, id, task);
  }

  profile(id: Id): AgentProfile | undefined {
    return (
      this.s.profiles.find((profile) => profile.id === id)
      ?? this.s.retiredProfiles?.find((profile) => profile.id === id)
    ) as AgentProfile | undefined;
  }

  /** Only Builders return to an earlier step's conversation; an interrupted Builder keeps its current one. */
  builderConversation(target: RuntimeTask | RepositoryContext, plannedId: Id) {
    return this.usageCoordinator.builderConversation(target, plannedId);
  }

  /**
   * Who works a step planned for this profile right now: the planned one, or a stand-in while its tool or
   * model is out of usage. `room` is whether that tool can take a seat now. A stand-in whose tool is full
   * yields to another tool that has one, so a cap kept for a tool that is out does not idle a pool slot.
   */
  choose(
    plannedId: Id,
    target?: RuntimeTask | RepositoryContext,
    roleId?: Id,
    room?: (toolId: Id, profile: AgentProfile) => boolean,
    reviewerKey?: string,
  ): Selection | undefined {
    return this.usageCoordinator.choose(plannedId, target, roleId, room, reviewerKey);
  }

  /** "Claude Code · Opus 5.5": the tool and model of a profile, for the timeline. */
  named(profileId: Id): string {
    const profile = this.profile(profileId);
    return `${this.toolName(profile?.toolId)} · ${profile?.model}`;
  }

  private toolName(toolId: Id | undefined): string {
    return this.s.tools.find((tool) => tool.id === toolId)?.name ?? ADAPTERS[toolId ?? ""]?.name ?? toolId ?? "the tool";
  }

  recordUsage(info: UsageInfo): void {
    return this.usageCoordinator.recordUsage(info);
  }

  recordAccountUsage(toolId: Id, reports: readonly UsageInfo[]): void {
    this.usageCoordinator.recordAccountUsage(toolId, reports);
  }

  readUsage(toolId?: Id, gap?: number): void {
    return this.usageCoordinator.readUsage(toolId, gap);
  }

  recordLimit(task: RuntimeTask, roleId: Id, profileId: Id, error: UsageLimited): void {
    return this.usageCoordinator.recordLimit(task, roleId, profileId, error);
  }

  recordModelCapacity(task: RuntimeTask, roleId: Id, profileId: Id, error: ModelAtCapacity, waitMs?: number): void {
    return this.usageCoordinator.recordModelCapacity(task, roleId, profileId, error, waitMs);
  }

  expireLimits(): boolean {
    return this.usageCoordinator.expireLimits();
  }

  armLimitTimer(): void {
    return this.usageCoordinator.armLimitTimer();
  }

  /** The task lets go of its slot and waits until a limit ends: the driver stops, and the scheduler starts it again. */
  waitForUsage(task: RuntimeTask, words: string): void {
    waitForAgentUsage(task, words, Date.now(), () => this.columnFor(task));
    this.commitNow();
  }

  describe(roleId: Id, profileId: Id): string {
    const profile = this.profile(profileId);
    const tool = this.s.tools.find((entry) => entry.id === profile?.toolId);
    return `${this.role(roleId)?.name ?? roleId} on ${tool?.name ?? profile?.toolId} · ${profile?.model} · ${profile?.effort}`;
  }

  id(prefix: string): Id {
    this.s.seq += 1;
    return `${prefix}-${this.s.seq}`;
  }

  log(
    target: RuntimeTask | RepositoryContext,
    tone: Task["timeline"][number]["tone"],
    text: string,
    roleId?: Id,
    profileId?: Id,
  ): void {
    const scope = executionOf(target);
    const { task, work: repository } = scope;
    const step = stepTag(task);
    task.timeline.push({
      ...(task.repositories ? { productId: repository.productId } : {}),
      id: this.id(task.id),
      at: Date.now(),
      text,
      tone,
      ...(roleId ? { roleId } : {}),
      ...(profileId ? { profileId } : {}),
      ...(step ? { step } : {}),
    });
    if (task.timeline.length > MAX_TIMELINE) {
      task.timeline.splice(0, task.timeline.length - MAX_TIMELINE);
    }
  }

  say(
    target: RuntimeTask | RepositoryContext,
    from: Task["session"][number]["from"],
    text: string,
    roleId?: Id,
    profileId?: Id,
    toolInvocationId?: Id,
  ): void {
    const scope = executionOf(target);
    const { task, work: repository } = scope;
    saySessionLine(task, repository.productId, from, text, roleId, profileId, toolInvocationId, {
      id: () => this.id(task.id),
      now: () => Date.now(),
      pendingReportIds: this.pendingReportIds,
    });
  }

  /** A participant's words name its start on their step, found as its result and message receipts find theirs, so places sharing a role and profile stay apart. */
  participantSay(
    target: RuntimeTask | RepositoryContext,
    from: "agent" | "activity",
    text: string,
    roleId: Id,
    profileId: Id,
    reviewerKey: string | undefined,
    toolInvocationId?: Id,
  ): void {
    this.say(target, from, text, roleId, profileId, toolInvocationId);
    const { task } = executionOf(target);
    bindParticipantSessionLine(task, from, roleId, profileId, reviewerKey);
  }

  async emptyGhConfig(): Promise<string> {
    const dir = join(this.dataDir, "gh-none");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  async agentLog(taskId: Id, text: string): Promise<void> {
    const dir = join(this.dataDir, "logs");
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, `${taskId}.log`), text).catch(() => undefined);
  }

  commit(target?: RuntimeTask | RepositoryContext): void {
    if (this.stopped) return;
    this.flushStreamChanges();
    this.projection.changed(target);
    this.syncIdleSleep();
    // An activity or other update is about to be shown. The to-do item is written first, so a forced
    // kill once that update is visible still has the item.
    this.savePendingTodo();
    this.s.planner = this.onUsable(PLANNER_PROFILE);
    this.s.now = Date.now();
    for (const listener of this.listeners) listener();
    this.armSave();
  }

  /**
   * The agent's current to-do item changed. Show it now. Writing the whole snapshot waits for a quiet
   * moment, so a run of plan updates does not stall the scheduler on the disk. The next update writes
   * the item first.
   */
  noteTodo(target?: RuntimeTask | RepositoryContext): void {
    if (this.stopped) return;
    this.flushStreamChanges();
    this.projection.changed(target);
    this.todoPending = true;
    this.s.planner = this.onUsable(PLANNER_PROFILE);
    this.s.now = Date.now();
    for (const listener of this.listeners) listener();
    this.armSave();
  }

  /** Commit and save right away: what the coordinator said survives a forced kill a moment later. */
  commitNow(target?: RuntimeTask | RepositoryContext): void {
    if (this.stopped) return;
    this.flushStreamChanges();
    this.projection.changed(target);
    this.syncIdleSleep();
    this.s.planner = this.onUsable(PLANNER_PROFILE);
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.todoPending = false;
    this.save(false);
    for (const listener of this.listeners) listener();
  }

  /** Coalesce token chunks without postponing the first message or a completed turn. */
  noteStream(target: RuntimeTask | RepositoryContext): void {
    if (this.stopped) return;
    this.streamedTasks.add(executionOf(target).task);
    if (this.streamTimer) return;
    this.streamTimer = setTimeout(() => {
      this.flushStreamChanges();
      if (this.stopped) return;
      this.s.now = Date.now();
      for (const listener of this.listeners) listener();
      this.armSave();
    }, 400);
  }

  private flushStreamChanges(): boolean {
    clearTimeout(this.streamTimer);
    this.streamTimer = undefined;
    const pending = this.streamedTasks.size > 0;
    for (const task of this.streamedTasks) if (this.task(task.id) === task) this.projection.changed(task);
    this.streamedTasks.clear();
    return pending;
  }

  /** One ordinary save for a burst of updates. A later update does not reset the wait. */
  private armSave(): void {
    if (this.saveTimer || this.stopped) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      try {
        if (!this.stopped) this.save(false);
      } catch {
        // A full disk, for example: the next change saves again.
      }
    }, 400);
  }

  /** Write a to-do item that listeners have not yet followed with another update. */
  private savePendingTodo(): void {
    if (!this.todoPending || this.stopped) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.todoPending = false;
    this.save(false);
  }

  /**
   * Save now. The saved time and the step clocks belong to the same snapshot: after a forced stop, a step's
   * working time ends at the last save, so the time Petrina was not running is never counted.
   */
  save(all = true): void {
    const streamed = this.flushStreamChanges();
    this.todoPending = false;
    this.s.now = Date.now();
    const historyChanged = this.projection.save(all);
    if (!this.stopped && (streamed || historyChanged)) for (const listener of this.listeners) listener();
  }
}
