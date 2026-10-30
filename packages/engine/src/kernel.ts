// The engine's shared state and the few operations every part of it uses: lookups, the timeline and
// session, the inbox, and saving. Feature modules get this, never the Engine itself.

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { recoverBrowserTemps } from "@petrina/agent-runtime/browser";
import { thisMachine, type FoundTerminal } from "@petrina/agent-runtime/terminal";
import type { ModelAtCapacity, UsageInfo, UsageLimited } from "@petrina/agent-runtime/usage";
import * as library from "@petrina/core";
import {
  blockingDependencies, columnOf, runtimeWaitHolds, runtimeWaitView, runtimeWaitWords, stopTaskActivity, TAKE_OVER_WORDS,
  type AgentProfile, type CheckId, type Column, type DeepMutable, type GateKind, type HistoryPage, type HistoryQuery,
  type Id, type InboxItem, type InboxKind, type Role, type State, type StepNote, type Task,
} from "@petrina/core";
import {
  executionOf, pauseAgentStep, resumeAgentAfterReply, StepOwnership, waitForAgentUsage,
  type AgentAdmissionDependencies, type AgentSession, type GitHubService, type ParticipantAdmission, type RepositoryContext,
} from "@petrina/orchestrator";
import { localFiles, type FileOperations } from "@petrina/platform/file-operations";
import { githubService } from "@petrina/repositories/github-service";
import { Store } from "@petrina/storage/store";
import { AcceptanceRestorations } from "./acceptance-restorations.js";
import { AgentCleanup } from "./agent-cleanup.js";
import { IdleSleepAssertion } from "./awake.js";
import { CheckQueue } from "./check-queue.js";
import { PLANNER_PROFILE, renameRoles, type EngineOptions, type RuntimeState, type RuntimeTask } from "./engine-options.js";
import {
  checkStageOf, failTask, finishParallelReviewWork, raiseGate, raiseInboxItem, rememberCoordinatorNote, showParallelReviewWork,
  type RaiseExtra,
} from "./kernel-gates.js";
import {
  appendAgentLog, appendParticipantLine, appendSessionLine, appendTimelineLog, clearKernelStep, closeFailedKernelResources,
  describeKernelParticipant, drainKernel, dropKernelBlockingItems, emptyKernelState, ensureEmptyGhConfig, finishKernelStep,
  holdKernelFollowUp, initializeKernelState, isPausedKernelCheck, KernelCommits, kernelInFlight, kernelTaskInvolves,
  markFirstClientReceipt, namedKernelProfile, recordKernelStepNote, renumberKernelQueue, rerunReviewedChanges,
  saveExtraValidationKernelTask, stopKernelAgent, stopKernelDriver, stopKernelHelpers, syncKernelIdleSleep,
  takeKernelInboxItem, waitForKernelReply,
} from "./kernel-operations.js";
import type { MessageTurn } from "./messages.js";
import type { Readiness } from "./readiness.js";
import { ScreenCoordinator } from "./screen-coordinator.js";
import { StateProjection } from "./state-projection.js";
import { Tracking } from "./tracking.js";
import { UsageCoordinator, type Selection } from "./usage-coordinator.js";
import { WorkflowEvents } from "./workflow-events.js";

export * from "./engine-options.js";

export abstract class Kernel {
  /** One actual scheduler/participant/group boundary, composed by the Engine before agents can run. */
  abstract readonly agentAdmission: AgentAdmissionDependencies & { participant: ParticipantAdmission };
  readonly projection = new StateProjection(this, (task) => renameRoles({ ...this.s, tasks: [task], inbox: [] }));
  private readonly acceptanceRestorations = new AcceptanceRestorations(this);
  private readonly commits = new KernelCommits(this);
  readonly screens = new ScreenCoordinator(this);
  readonly usageCoordinator = new UsageCoordinator({
    state: () => this.s,
    activeState: () => this.activeState(),
    stopped: () => this.stopped,
    toolCheckTimeoutMs: () => this.options.toolCheckTimeoutMs,
    profile: (id) => this.profile(id),
    role: (id, task) => this.role(id, task),
    profileName: (id) => this.named(id),
    completedDesignAuthor: (taskId, stageId, round, roleId) =>
      this.tracking.log
        .turns({ taskId, stageId, round })
        .filter((turn) => turn.roleId === roleId && turn.end === "finished")
        .at(-1),
    reportedReviewerTools: (taskId, stageId, round, reportedCount) =>
      this.tracking.log
        .moments({ taskId, stageId, round, kinds: ["verdict"] })
        .slice(-reportedCount)
        .flatMap((entry) => {
          const profile = this.profile(entry.profileId ?? "");
          return profile ? [profile.toolId] : [];
        }),
    recordUsageReport: (report) => this.tracking.usageReported(report),
    recordLimitHit: (task, roleId, profileId, error) => this.tracking.limitHit(task, roleId, profileId, error),
    note: (task, tone, text, roleId, profileId) => this.log(task, tone, text, roleId, profileId),
    schedule: () => this.schedule(),
    changed: () => this.commit(),
    checkpoint: () => this.commitNow(),
  });
  /** Bounded readiness rechecks for saved participants; the engine supplies them with its tool checks. */
  abstract readonly readiness: Readiness;
  abstract schedule(): void;
  abstract startDriver(taskId: Id, resume?: boolean): void;
  abstract tidy(taskId: Id): void;
  onTaskDone?: (task: RuntimeTask) => void;
  beforeCaptureRemoval?: (task: RuntimeTask) => Promise<void>;
  onCoordinatorWait?: (task: RuntimeTask) => void;
  private readonly followUpHolds = new Map<Id, number>();

  /** Keep a just-finished task in memory until its follow-up card has copied what it needs. */
  holdFollowUp(id: Id): () => void {
    return holdKernelFollowUp(this.followUpHolds, id);
  }

  followsUpHeld(id: Id): boolean {
    return (this.followUpHolds.get(id) ?? 0) > 0;
  }

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
  readonly tracking: Tracking;
  readonly events: WorkflowEvents;
  private readonly idleSleep: IdleSleepAssertion;
  readonly listeners = new Set<() => void>();
  readonly pendingReportIds = new Set<string>();
  readonly drivers = new Map<Id, AbortController>();
  readonly pendingAgentAdmissions = new Map<Id, { step: string; roleId: Id; profileId: Id }>();
  readonly runs = new Map<Id, AgentSession>();
  readonly agentCleanup = new AgentCleanup();
  readonly messageTurns = new Map<Id, Map<string, MessageTurn>>();
  readonly helperRuns = new Map<Id, Set<AgentSession>>();
  readonly cleanupJobs = new Set<Id>();
  readonly waiting = new Map<Id, { resolve: (value: string) => void; reject: (error: Error) => void }>();
  saveTimer: ReturnType<typeof setTimeout> | undefined;
  readonly timers: ReturnType<typeof setInterval>[] = [];
  stopped = false;
  readonly stopRequested = new AbortController();
  draining = false;
  drainReason: "stop" | "restart" = "restart";
  readonly backgroundWork = new Set<Promise<unknown>>();
  readonly checkQueue = new CheckQueue(
    () => this.options.checkRuns ?? 1,
    () => (this.admissionsClosed ? (this.draining ? this.drainLine : "Waiting for the pool to resume") : undefined),
    () => this.draining || this.stopped,
  );
  readonly waitingChecks = new Map<Id, number>();
  extraRecovery = false;
  extraCheckBlocker?: () => string | undefined;
  extraChecksActive?: () => boolean;
  readonly boot = randomBytes(6).toString("hex");
  readonly settling = new Map<Id, Promise<void>>();
  readonly switching = new Map<Id, keyof typeof TAKE_OVER_WORDS.busy>();
  readonly machine = thisMachine();
  sandboxOff: string | undefined;
  readonly found: FoundTerminal[];

  constructor(
    readonly dataDir: string,
    readonly options: EngineOptions = {},
  ) {
    this.files = options.files ?? localFiles;
    this.github = options.github ?? githubService(options.gh);
    this.store = new Store(join(dataDir, "petrina.db"), { debugSql: options.debugSql });
    try {
      const awakeObserver = options.awakeObserver ?? (options.agentCommand ? () => {} : undefined);
      this.idleSleep = new IdleSleepAssertion(awakeObserver ? { observe: awakeObserver } : {});
      this.draining = options.admissionsClosed ?? false;
      const initialized = initializeKernelState(this.store, options, this.machine);
      this.s = initialized.state;
      this.found = initialized.found;
      this.s.planner = this.onUsable(PLANNER_PROFILE);
      this.tracking = new Tracking(this);
      this.tracking.start();
      this.events = new WorkflowEvents(this, options.eventRetention);
      this.events.baseline(this.s.tasks);
      this.usageCoordinator.startReaders(this.dataDir, options);
      this.acceptanceRestorations.recoverStoppedRestorations();
    } catch (error) {
      this.stopped = true;
      closeFailedKernelResources(error, [
        () => this.usageCoordinator.stop(),
        () => this.idleSleep?.shutdown(),
        () => this.tracking?.close(),
        () => this.store.close(),
      ]);
    }
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
    void this.startupReady.catch(() => undefined);
  }

  waitUntilReady(): Promise<void> {
    return this.startupReady;
  }

  readonly taskInvolves = (taskId: Id, productId: Id): boolean => kernelTaskInvolves(this, taskId, productId);
  readonly taskKnown = (taskId: Id): boolean =>
    this.s.tasks.some((entry) => entry.id === taskId) || this.store.history.has(taskId);

  get screenGroups() { return this.screens.groups; }
  get copyCleanups() { return this.screens.copyCleanups; }
  get drainLine(): string {
    return this.drainReason === "stop" ? "Waiting: Petrina is stopping" : "Waiting: Petrina is restarting";
  }
  get admissionsClosed(): boolean {
    return this.extraRecovery || this.draining || this.s.pool.paused || this.stopped;
  }

  trackWork<T>(work: Promise<T>): Promise<T> {
    const tracked = work.finally(() => this.backgroundWork.delete(tracked)).catch(() => undefined);
    this.backgroundWork.add(tracked);
    return work;
  }

  isPausedCheck(taskId: Id): boolean {
    return isPausedKernelCheck(this, taskId);
  }

  taskAdmissionsClosed(task: RuntimeTask | Id): boolean {
    const current = typeof task === "string" ? this.task(task) : task;
    return this.admissionsClosed || Boolean(current && runtimeWaitHolds(current));
  }

  taskAdmissionWait(task: RuntimeTask): string {
    if (runtimeWaitHolds(task)) return runtimeWaitWords(runtimeWaitView(task, (id) => this.taskDetails(id))!);
    return this.draining ? this.drainLine : "Waiting for the pool to resume";
  }

  taskStepStarted(task: RuntimeTask): boolean { return this.stepOwnership.started(task); }
  taskSourceRefreshDue(task: RuntimeTask): boolean { return this.stepOwnership.refreshDue(task); }
  inFlight(): number { return kernelInFlight(this, this.agentCleanup.size); }

  drainObservation() {
    const cleanup = this.agentCleanup.snapshot();
    return { pending: kernelInFlight(this, cleanup.waiting), cleanup };
  }

  syncIdleSleep(): void { syncKernelIdleSleep(this, this.idleSleep); }
  stopIdleSleep(): void { this.idleSleep.shutdown(); }
  drain(limitMs: number, onWait?: (left: number) => void): Promise<number> { return drainKernel(this, limitMs, onWait); }

  activeState = (): State => this.s;
  getState = (): State => this.projection.getState();
  windowState = (): State => this.projection.windowState();
  historyPage = (request: HistoryQuery): HistoryPage => this.projection.historyPage(request);
  taskDetails = (id: Id): Task | undefined => this.projection.taskDetails(id);
  taskDetailsDelta = (id: Id, sinceRevision: string): import("@petrina/core").TaskDetailsUpdate | undefined =>
    this.projection.taskDetailsDelta(id, sinceRevision);

  saveArchivedTask(task: RuntimeTask): void { this.projection.saveArchivedTask(task); }
  forgetProductHistory(productId: Id): void { this.projection.forgetProductHistory(productId); }

  extraValidationTask(id: Id): RuntimeTask | undefined {
    const record = this.s.extraValidations?.find((entry) => entry.id === id);
    return record ? this.projection.task(record.taskId, true) : undefined;
  }

  saveExtraValidationTask(id: Id, task: RuntimeTask, line: Task["timeline"][number]): void {
    saveExtraValidationKernelTask(this, id, task, line);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  blockers(task: RuntimeTask): RuntimeTask[] { return blockingDependencies(task, (id) => this.task(id)); }
  rerun(task: RuntimeTask): boolean { return rerunReviewedChanges(this, task); }

  gate(
    task: RuntimeTask,
    gate: GateKind,
    problem?: string,
    checks?: { title: string; body: string },
    decides?: Id | null,
  ): void {
    raiseGate(this, task, gate, problem, checks, decides);
  }

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

  fail(taskId: Id, error: unknown): void { failTask(this, taskId, error); }
  usableTools(): CheckId[] { return this.usageCoordinator.usableTools(); }
  onUsable(profileId: Id): Id { return this.usageCoordinator.onUsable(profileId); }
  checkStage(task: RuntimeTask, item: InboxItem): Id | null | undefined { return checkStageOf(task, item); }

  remember(task: RuntimeTask, text: string, id?: Id, kind?: InboxKind, stageId?: Id | null): void {
    rememberCoordinatorNote(this, task, text, id, kind, stageId);
  }

  stepNote(task: RuntimeTask, kind: StepNote["kind"], text: string, extra: { id?: Id; about?: string } = {}): void {
    recordKernelStepNote(this, task, kind, text, extra);
  }

  finishStep(target: RuntimeTask | RepositoryContext): void { finishKernelStep(this, target); }
  clearStep(target: RuntimeTask | RepositoryContext): void { clearKernelStep(this, target); }
  agentWorktree(target: RuntimeTask | RepositoryContext): string { return this.screens.agentWorktree(target); }
  discardScreenTurns(task: RuntimeTask): void { this.screens.discardScreenTurns(task); }
  askScreen(task: RuntimeTask, roleId: Id, profileId: Id, reason: string, member?: string): boolean {
    return this.screens.askScreen(task, roleId, profileId, reason, member);
  }
  waitForScreen(task: RuntimeTask): void { this.screens.waitForScreen(task); }
  syncScreen(): void { this.screens.syncScreen(); }
  selectScreen(task: RuntimeTask): void { this.screens.selectScreen(task); }
  releaseScreen(task: RuntimeTask): void { this.screens.releaseScreen(task); }
  armScreenTimer(): void { this.screens.armScreenTimer(); }

  stopStep(task: RuntimeTask): void {
    this.pendingAgentAdmissions.delete(task.id);
    stopTaskActivity(task);
  }

  pauseStep(task: RuntimeTask, now = Date.now()): void { pauseAgentStep(task, now); }
  showReviewWork(task: RuntimeTask): void { showParallelReviewWork(task); }
  finishReviewWork(task: RuntimeTask, key: string): void { finishParallelReviewWork(this, task, key); }
  firstTime(task: RuntimeTask, clientId: Id | undefined): boolean { return markFirstClientReceipt(task, clientId); }

  toWaiting(task: RuntimeTask): void {
    task.state = "waiting";
    task.statusLine = "Waiting for a free slot";
    task.column = this.columnFor(task);
  }

  unblock(task: RuntimeTask): void {
    resumeAgentAfterReply(task, this.s.inbox.some((item) => item.taskId === task.id && item.blocking), Date.now());
  }

  takeItem(itemId: Id): DeepMutable<InboxItem> | undefined { return takeKernelInboxItem(this, itemId); }
  waitForReply(id: Id, signal: AbortSignal): Promise<string> { return waitForKernelReply(this, id, signal); }
  dropBlockingItems(taskId: Id): void { dropKernelBlockingItems(this, taskId); }
  stopDriver(taskId: Id): void { stopKernelDriver(this, taskId); }
  stopHelpers(taskId: Id): void { stopKernelHelpers(this, taskId); }
  stopAgent(taskId: Id, run: AgentSession): Promise<void> { return stopKernelAgent(this, taskId, run); }

  undoReadOnly(target: RuntimeTask | RepositoryContext, roleId: Id, worktree?: string, knownClean?: boolean): Promise<void> {
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

  beginAcceptanceCleanup(task: RuntimeTask): string { return this.acceptanceRestorations.beginAcceptanceCleanup(task); }
  endAcceptanceCleanup(scope: RepositoryContext, cleanup: string): void {
    this.acceptanceRestorations.endAcceptanceCleanup(scope, cleanup);
  }
  productLabel(productId: Id): string {
    return this.s.products.find((product) => product.id === productId)?.name ?? productId;
  }
  saveRoleEdits(target: RuntimeTask | RepositoryContext, roleId: Id, profileId: Id): Promise<void> {
    return this.acceptanceRestorations.saveRoleEdits(target, roleId, profileId);
  }
  rememberVersion(scope: RepositoryContext, observed?: { head?: string; tree?: string }): Promise<void> {
    return this.acceptanceRestorations.rememberVersion(scope, observed);
  }

  columnFor(task: RuntimeTask): Column { return columnOf(task, this.s.roles); }
  empty(): State { return emptyKernelState(); }
  renumberQueue(): void { renumberKernelQueue(this); }
  task(id: Id): RuntimeTask | undefined { return this.projection.task(id); }

  repositoryOf(target: RuntimeTask | RepositoryContext) {
    const scope = executionOf(target);
    const { work: repository } = scope;
    const product = this.productOf(scope);
    return product && repository.source ? { ...product, ...repository.source.product, name: product.name } : product;
  }

  productOf(target: RuntimeTask | RepositoryContext) {
    const scope = executionOf(target);
    return this.s.products.find((product) => product.id === scope.work.productId);
  }

  role(id: Id, task?: RuntimeTask): Role | undefined { return library.roleForTask(this.s.roles, id, task); }

  profile(id: Id): AgentProfile | undefined {
    return (
      this.s.profiles.find((profile) => profile.id === id)
      ?? this.s.retiredProfiles?.find((profile) => profile.id === id)
    ) as AgentProfile | undefined;
  }

  builderConversation(target: RuntimeTask | RepositoryContext, plannedId: Id) {
    return this.usageCoordinator.builderConversation(target, plannedId);
  }

  choose(
    plannedId: Id,
    target?: RuntimeTask | RepositoryContext,
    roleId?: Id,
    room?: (toolId: Id, profile: AgentProfile) => boolean,
    reviewerKey?: string,
  ): Selection | undefined {
    return this.usageCoordinator.choose(plannedId, target, roleId, room, reviewerKey);
  }

  named(profileId: Id): string { return namedKernelProfile(this, profileId); }
  recordUsage(info: UsageInfo): void { this.usageCoordinator.recordUsage(info); }
  recordAccountUsage(toolId: Id, reports: readonly UsageInfo[]): void {
    this.usageCoordinator.recordAccountUsage(toolId, reports);
  }
  readUsage(toolId?: Id, gap?: number): void { this.usageCoordinator.readUsage(toolId, gap); }
  recordLimit(task: RuntimeTask, roleId: Id, profileId: Id, error: UsageLimited): void {
    this.usageCoordinator.recordLimit(task, roleId, profileId, error);
  }
  recordModelCapacity(task: RuntimeTask, roleId: Id, profileId: Id, error: ModelAtCapacity, waitMs?: number): void {
    this.usageCoordinator.recordModelCapacity(task, roleId, profileId, error, waitMs);
  }
  expireLimits(): boolean { return this.usageCoordinator.expireLimits(); }
  armLimitTimer(): void { this.usageCoordinator.armLimitTimer(); }

  waitForUsage(task: RuntimeTask, words: string): void {
    waitForAgentUsage(task, words, Date.now(), () => this.columnFor(task));
    this.commitNow();
  }

  describe(roleId: Id, profileId: Id): string { return describeKernelParticipant(this, roleId, profileId); }

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
    appendTimelineLog(this, target, tone, text, roleId, profileId);
  }

  say(
    target: RuntimeTask | RepositoryContext,
    from: Task["session"][number]["from"],
    text: string,
    roleId?: Id,
    profileId?: Id,
    toolInvocationId?: Id,
  ): void {
    appendSessionLine(this, target, from, text, roleId, profileId, toolInvocationId);
  }

  participantSay(
    target: RuntimeTask | RepositoryContext,
    from: "agent" | "activity",
    text: string,
    roleId: Id,
    profileId: Id,
    reviewerKey: string | undefined,
    toolInvocationId?: Id,
  ): void {
    appendParticipantLine(this, target, from, text, roleId, profileId, reviewerKey, toolInvocationId);
  }

  emptyGhConfig(): Promise<string> { return ensureEmptyGhConfig(this.dataDir); }
  agentLog(taskId: Id, text: string): Promise<void> { return appendAgentLog(this.dataDir, taskId, text); }
  commit(target?: RuntimeTask | RepositoryContext): void { this.commits.commit(target); }
  noteTodo(target?: RuntimeTask | RepositoryContext): void { this.commits.noteTodo(target); }
  commitNow(target?: RuntimeTask | RepositoryContext): void { this.commits.commitNow(target); }
  noteStream(target?: RuntimeTask | RepositoryContext): void { if (target) this.commits.noteStream(target); }
  save(all = true): void { this.commits.save(all); }
}
