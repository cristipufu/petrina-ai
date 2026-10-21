import { StateProjection } from "./state-projection.js";
import { ScreenCoordinator } from "./screen-coordinator.js";
import { UsageCoordinator } from "./usage-coordinator.js";
import { blockingDependencies, clearRunningTools, clearTaskStep, finishTaskStep, stopTaskActivity } from "@petrina/core";
import { executionFor, executionOf, scopesFor, taskView, restoreRepositoryState, type RepositoryContext } from "./repository-context.js";
import * as library from "@petrina/core";
// The engine's shared state and the few operations every part of it uses: lookups, the timeline and
// session, the inbox, and saving. Feature modules get this, never the Engine itself.

import { randomBytes } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { IdleSleepAssertion } from "./awake.js";
import { NO_ROLE_CHANGES, libraryRoles, beginYouStep, BUILT_IN_ROLES, callCheckBody, endOpenStep, JOURNEY_WORDS as W, openStep, queueOf, stepTag, workSummary, type Choice, TAKE_OVER_WORDS, withdrawAsks, type AgentProfile, type Column, type GateKind, type Id, type InboxItem, type InboxKind, type RiskLevel, type Role, type Stage, type State, type StepNote, type Task, type Tone, columnOf, gateStatus, gateTitle, type DeepMutable, CHECK_NAMES, fixFor, wontStartFix, type CheckId, type CheckStatus, type Platform, MAX_STEP_RECORDS, pauseClock, resumeClock, stepRecord, type ActiveAgent } from "@petrina/core";
import { AgentRun } from "./acp-run.js";
import * as git from "./git.js";
import type { Which } from "./setup.js";
import { Store } from "./store.js";
import { stopCheckProgress, type HistoryQuery, type HistoryPage } from "@petrina/core";
import { detectTerminals, type FoundTerminal, thisMachine } from "./terminal.js";
import { restoreProfileCatalog } from "@petrina/core";
import { ADAPTERS, detectTools, ENGINE_PROFILES } from "./tools.js";
import type { ModelAtCapacity, UsageInfo, UsageLimited } from "./usage.js";
import { Tracking } from "./tracking.js";
import { recoverBrowserTemps } from "./browser.js";

/** Repository execution fields cannot be read or written on the runtime task. */
export type MTask = DeepMutable<library.TaskState>;

export type MState = Omit<DeepMutable<State>, "tasks"> & { tasks: MTask[] };

export type MStage = DeepMutable<Stage>;

export const PLANNER_PROFILE = "opus-high";

export const RELEASE_MANAGER_PROFILE = "opus-high";

export const CHECK_FINDER_PROFILE = "opus-high";

export const GUIDE_KEEPER_PROFILE = "opus-high";

/** Role ids that changed: what was saved under the old one keeps working. */
const RENAMED_ROLES: Readonly<Record<string, string>> = { shipper: "release-manager" };

/**
 * State saved before a role was renamed, with every role id it holds moved to the new one, once, as it loads:
 * plan stages, the working agents, conversation and take-over notes, lessons, the timeline, the session and the inbox.
 */
export function renameRoles(state: MState): void {
  const move = (entry: { roleId?: string } | undefined) => {
    const to = entry?.roleId ? RENAMED_ROLES[entry.roleId] : undefined;
    if (to) entry!.roleId = to;
  };
  for (const task of state.tasks) {
    for (const stage of task.plan?.stages ?? []) {
      move(stage);
      const reviewer = stage.reviewerRoleId ? RENAMED_ROLES[stage.reviewerRoleId] : undefined;
      if (reviewer) stage.reviewerRoleId = reviewer;
    }
    move(task.agent);
    for (const helper of task.helpers ?? []) move(helper);
    for (const { work } of scopesFor(task)) {
      move(work.conversation);
      for (const lesson of work.lessons ?? []) move(lesson);
    }
    move(task.driving);
    for (const entry of task.timeline) move(entry);
    for (const line of task.session) move(line);
  }
  for (const item of state.inbox) move(item);
}

export const TONES: readonly Tone[] = ["blue", "green", "orange", "violet", "pink", "teal", "indigo", "purple", "amber", "slate"];

export const MAX_SESSION_LINES = 800;

/** An older line may go once this agent has said something newer. Its latest words stay, so a report is still there when its pictures are saved. */
function newerWords(session: MTask["session"], index: number, line: MTask["session"][number]): boolean {
  if (line.from !== "agent") return true;
  return session.some((other, later) => later > index && other.from === "agent" && other.roleId === line.roleId && other.profileId === line.profileId && other.productId === line.productId);
}

export const MAX_TIMELINE = 400;

export interface EngineOptions {
  /** Record every shared SQLite driver execution, without bindings or results, for local analysis. */
  debugSql?: boolean;
  /** The launcher opens scheduling only once the local connection is ready. */
  admissionsClosed?: boolean;
  /** Tests: run a fake agent instead of the tool's adapter. */
  agentCommand?: (profile: AgentProfile) => readonly string[] | undefined;
  /** Tests: whether eligible conversations get a browser. Real agents always do; fake agents only when this is true. */
  browser?: boolean;
  /** Tests: a fixture's own parent for temporary browser folders, instead of the standard one. Startup recovery uses it too. */
  browserTempRoot?: string;
  /** Tests: a fake GitHub instead of `gh`. */
  gh?: readonly string[];
  /** Tests: native account-reader commands by tool; null disables a reader. Fake agents disable defaults. */
  usageCommands?: Readonly<Record<string, readonly string[] | null>>;
  /** Tests: a folder standing in for every product's copy on GitHub. Never from settings or saved data. */
  remote?: string;
  remotes?: Readonly<Record<string, string>>;
  /** Tests: separate local remotes for fork working repositories. */
  sourceRemotes?: Record<string, string>;
  /** Tests: how long a tool gets to reopen a conversation. */
  reopenTimeoutMs?: number;
  /** Tests: how long a tool gets to start a fresh conversation. */
  startTimeoutMs?: number;
  /** Tests: native profile configuration discovery, without opening a real tool. */
  profileChoices?: (toolId: string, modelId?: string) => Promise<import("@petrina/core").ProfileChoices>;
  /** Tests: the tool's own app that a take-over opens, instead of the one on PATH. */
  toolPath?: (toolId: Id) => string | undefined;
  /** Tests: the terminals on this machine. */
  terminals?: () => FoundTerminal[];
  /** Tests: how long one of a product's checks may run. */
  /** How many tasks' check runs may overlap (default: one full check set at a time). */
  checkRuns?: number;
  checkTimeoutMs?: number;
  /** Tests: where programs are found, instead of the PATH. */
  which?: Which;
  /** Tests: how long one tool check may take. */
  toolCheckTimeoutMs?: number;
  /** Tests: where Apple's developer tools are, instead of asking xcode-select. */
  developerTools?: () => Promise<string | undefined>;
  /** Tests: the home folder: where the clone finder looks, and what ~ means in a pasted path. */
  home?: string;
  /** Tests: how often the once-a-minute checks run (pull requests, removing working copies). */
  checkEveryMs?: number;
  /** Tests: how long "For an hour" lasts. */
  screenHourMs?: number;
  /** Tests: observe when the engine owns work, without starting the macOS sleep assertion. */
  awakeObserver?: (active: boolean) => void;
  /**
   * Tests: answer a follow-up identity check without starting an agent.
   * The prompt lists the reports and the open cards. Return "unavailable" when the check cannot run.
   */
  matchFollowUps?: (prompt: string) => Promise<{ groups: readonly { keys: readonly string[]; cardId?: string }[]; uncertain?: readonly string[] } | "unavailable">;
}

export class Aborted extends Error {}
export class MaintenanceProfileProblem extends Error {}

/** Stop waiting promptly, and remove the abort listener on either outcome. */
export async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(new Aborted());
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([work, interrupted]); }
  finally { signal.removeEventListener("abort", abort); }
}

/** A step's tool is not installed, not logged in, or would not start: the coordinator gets its fix and a Retry. */
export class ToolProblem extends Error {
  constructor(
    readonly toolId: CheckId,
    readonly status: CheckStatus | "wont-start",
    detail?: string,
  ) {
    super(detail || `${CHECK_NAMES[toolId]} is not ready`);
  }
}

/** Not installed or not logged in: a tool Petrina does not start. */
export const notReady = (status: CheckStatus) => status === "not-installed" || status === "logged-out";

/** A conversation belongs to this stage, round and position, including a fix round. */
export function stepKey(task: MTask): string {
  if (task.stageIndex < 0) return "plan";
  const stage = task.plan?.stages[task.stageIndex];
  return `${stage?.id ?? task.stageIndex} round ${stage ? (task.rounds[stage.id] ?? 1) : 1} position ${task.sub}${task.fixing ? " fixing" : ""}`;
}

/** First run's record. An install that already has products or tasks never sees first run. */
function setupOf(loaded: State | undefined): DeepMutable<NonNullable<State["setup"]>> {
  const platform: Platform = process.platform === "darwin" || process.platform === "win32" ? process.platform : "linux";
  const saved = loaded?.setup;
  if (!saved) return { done: !!loaded && (loaded.products.length > 0 || loaded.tasks.length > 0), platform, checks: [] };
  // Nothing is being checked right after a start.
  return { ...(saved as DeepMutable<NonNullable<State["setup"]>>), platform, checks: saved.checks.map(({ checking: _, ...check }) => check) };
}

/** The agent asked for the screen and may not have it yet: its task waits without a slot, keeping its conversation. */
export class ScreenWait extends Error {}

export const RISK_WORD: Record<RiskLevel, string> = { low: "Low", medium: "Medium", high: "High" };

/** What the delivery check says beside the work: its risk, and what Petrina's own run of the checks found. */
function deliveryLines(task: Task): string | undefined {
  const unverified = task.brief?.acceptance.filter((item) => item.verification === "blocked") ?? [];
  const acceptance = unverified.length
    ? `${unverified.length} acceptance ${unverified.length === 1 ? "check could not" : "checks could not"} be verified:\n${unverified.map((item) => `• ${item.text}${item.reason ? ` — ${item.reason}` : ""}`).join("\n")}`
    : "";
  const lines = [task.risk ? `${RISK_WORD[task.risk.level]} risk: ${task.risk.why}` : "", checksLine(task) ?? "", acceptance].filter(Boolean);
  return lines.length ? lines.join("\n") : undefined;
}

/** One plain line for the delivery check: what Petrina's own run of the checks found. */
export function checksLine(task: Task): string | undefined {
  const runs = task.checks?.results;
  if (!runs?.length) return undefined;
  const failed = runs.filter((run) => !run.ok);
  return failed.length
    ? `Automated checks: ${failed.length} of ${runs.length} failed (${failed.map((run) => run.name).join(", ")}).`
    : `Automated checks: all ${runs.length} passed (${runs.map((run) => run.name).join(", ")}).`;
}

export abstract class Kernel {
  private readonly projection = new StateProjection(this, task => renameRoles({ ...this.s, tasks: [task], inbox: [] }));
  readonly screens = new ScreenCoordinator(this);
  readonly usageCoordinator = new UsageCoordinator(this);
  /** Set by the Engine: what starts drivers and fills free slots. */
  abstract schedule(): void;
  abstract startDriver(taskId: Id, resume?: boolean): void;
  /** Set by the Engine: a task may be finished with its working copy; it goes once nothing uses it. */
  abstract tidy(taskId: Id): void;
  /** Set by the Engine: a task has just become done, so a confirmed older bug can become a backlog card. */
  onTaskDone?: (task: MTask) => void;
  /** Set by the Engine: copy follow-up pictures before a done task's captures are removed. */
  beforeCaptureRemoval?: (task: MTask) => Promise<void>;
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

  constructor(
    readonly dataDir: string,
    readonly options: EngineOptions = {},
  ) {
    this.startupReady = recoverBrowserTemps(join(dataDir, "browser-temp"), options.browserTempRoot).then(() => {
      this.startupComplete = true;
      if (this.startupSchedulePending && !this.stopped) this.schedule();
    });
    // Launch awaits startupReady to report recovery failures. Consume an otherwise
    // unobserved rejection for direct Engine users while leaving the original promise rejectable.
    void this.startupReady.catch(() => undefined);
    this.store = new Store(join(dataDir, "petrina.db"), { debugSql: options.debugSql });
    const loaded = this.store.loadActive((state) => { for (const task of state.tasks) restoreRepositoryState(task as MTask); renameRoles(state as MState); });
    this.s = (loaded ?? this.empty()) as MState;
    this.s.backgroundAgents = [];
    // An injected agent command is the engine test seam. Never let fake-agent tests spawn a real
    // system sleep assertion; production launches use the default unless they inject an observer.
    const awakeObserver = options.awakeObserver ?? (options.agentCommand ? () => {} : undefined);
    this.idleSleep = new IdleSleepAssertion(awakeObserver ? { observe: awakeObserver } : {});
    this.draining = options.admissionsClosed ?? false;
    if (loaded) {
      renameRoles(this.s);
      // Nothing worked while Petrina was stopped: a step's working time ends at the last moment it saved.
      for (const task of this.s.tasks) { this.pauseStep(task, this.s.now); stopCheckProgress(task, this.s.now); clearRunningTools(task); }
    }
    this.s.roleChanges = (loaded?.roleChanges ?? structuredClone(NO_ROLE_CHANGES)) as MState["roleChanges"];
    this.s.roles = libraryRoles(this.s.roleChanges) as MState["roles"];
    restoreProfileCatalog(this.s);
    // Tests stand in the tools' own apps: those count as installed.
    this.s.tools = detectTools().map((tool) => (options.toolPath?.(tool.id) ? { ...tool, status: "ready" as const } : tool)) as MState["tools"];
    this.s.setup = setupOf(loaded) as MState["setup"];
    if (this.s.setup && !loaded?.setup && this.store.history.info().total > 0) this.s.setup.done = true;
    this.s.planner = this.onUsable(PLANNER_PROFILE);
    this.found = options.terminals?.() ?? detectTerminals(this.machine);
    this.s.terminals = this.found.map(({ id, name }) => ({ id, name }));
    this.tracking = new Tracking(this);
    this.tracking.start();
    this.usageCoordinator.startReaders(this.dataDir, options);
  }

  waitUntilReady(): Promise<void> { return this.startupReady; }

  readonly s: MState;

  readonly store: Store;

  /** The work log: every agent turn and notable moment, the permanent product list and the tools' limits. */
  readonly tracking: Tracking;

  private readonly idleSleep: IdleSleepAssertion;

  readonly listeners = new Set<() => void>();

  /** Reports whose chosen captures are being checked, by line id. Kept outside saved task state. */
  readonly pendingReportIds = new Set<string>();

  readonly drivers = new Map<Id, AbortController>();
  /** An internal preparation role that still needs ordinary tool and pool admission. */
  readonly pendingAgentAdmissions = new Map<Id, { step: string; roleId: Id; profileId: Id }>();

  readonly runs = new Map<Id, AgentRun>();
  readonly messageTurns = new Map<Id, Map<string, import("./messages.js").MessageTurn>>();

  /** Agents working beside a task's main one on the same step (reviewers hunting at once, voters). */
  readonly helperRuns = new Map<Id, Set<AgentRun>>();

  /** A live review group can reopen its waiting screen member without stopping its peers. */
  get screenGroups() { return this.screens.groups; }

  /** Discarded review copies finish cleaning up before the task can start fresh. */
  get copyCleanups() { return this.screens.copyCleanups; }

  /** Finished-task working copies being removed. */
  readonly cleanupJobs = new Set<Id>();

  readonly waiting = new Map<Id, { resolve: (value: string) => void; reject: (error: Error) => void }>();

  saveTimer: ReturnType<typeof setTimeout> | undefined;

  /** A to-do item is in memory and not in the snapshot on disk yet. */
  private todoPending = false;

  /** Text already updated in memory, awaiting one bounded detail/persistence notification. */
  private readonly streamedTasks = new Set<MTask>();
  private streamTimer: ReturnType<typeof setTimeout> | undefined;

  readonly timers: ReturnType<typeof setInterval>[] = [];

  /** Set by shutdown: work that ends afterwards (a turn cut off by the stop) changes nothing. */
  stopped = false;
  /** Stopping is under way: no new agent starts, and reviewers and voters in flight hand back first. */
  draining = false;
  drainReason: "stop" | "restart" = "restart";
  get drainLine(): string { return this.drainReason === "stop" ? "Waiting: Petrina is stopping" : "Waiting: Petrina is restarting"; }
  /** Cleanup and delivery lookups outside a task driver still belong to a drain. */
  readonly backgroundWork = new Set<Promise<unknown>>();

  trackWork<T>(work: Promise<T>): Promise<T> {
    // Drains wait for completion; the caller owns the result and any failure.
    const tracked = work.finally(() => this.backgroundWork.delete(tracked)).catch(() => undefined);
    this.backgroundWork.add(tracked);
    return work;
  }

  get admissionsClosed(): boolean { return this.draining || this.s.pool.paused || this.stopped; }

  /** Agents whose work is lost by a restart: reviewers and voters working side by side (never reopened) and a Release Manager mid-delivery. */
  inFlight(): number {
    const agents = this.runs.size + [...this.helperRuns.values()].reduce((sum, runs) => sum + runs.size, 0);
    return agents || this.settling.size + this.copyCleanups.size + this.backgroundWork.size + this.s.tasks.filter(task => task.driving).length;
  }

  /** Keep macOS awake only while this engine still owns active work or its cleanup. */
  syncIdleSleep(): void {
    const active = !this.stopped && (
      this.drivers.size > 0 ||
      this.settling.size > 0 ||
      this.runs.size > 0 ||
      [...this.helperRuns.values()].some((runs) => runs.size > 0) ||
      this.screenGroups.size > 0 ||
      this.switching.size > 0 ||
      this.copyCleanups.size > 0 ||
      this.cleanupJobs.size > 0
    );
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
    this.draining = true;
    const started = Date.now();
    let last = -1;
    while (!this.stopped) {
      const left = this.inFlight();
      if (left !== last) {
        onWait?.(left);
        last = left;
      }
      if (left === 0 || Date.now() - started >= limitMs) return left;
      await Bun.sleep(500);
    }
    return 0;
  }

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

  /** Current engine work only. Completed bodies are loaded separately when somebody opens one. */
  activeState = (): State => {
    return this.s as unknown as State;
  };

  getState = (): State => this.projection.getState();
  windowState = (): State => this.projection.windowState();
  historyPage = (request: HistoryQuery): HistoryPage => this.projection.historyPage(request);
  taskDetails = (id: Id): Task | undefined => this.projection.taskDetails(id);
  saveArchivedTask(task: MTask): void { this.projection.saveArchivedTask(task); }
  forgetProductHistory(productId: Id): void { this.projection.forgetProductHistory(productId); }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The tasks this one still waits for. */
  blockers(task: MTask): MTask[] {
    return blockingDependencies(task, (id) => this.task(id));
  }

  /** The step the coordinator drove finished: its review chain runs again from the first reviewer, without using up a round. */
  rerun(task: MTask): boolean {
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

  /** `checks`: a check problem's own title and explanation, raised wherever the failing checks stopped the task. */
  gate(task: MTask, gate: GateKind, problem?: string, checks?: { title: string; body: string }): void {
    delete task.agent;
    task.holdsSlot = false;
    beginYouStep(task, gate, Date.now());
    const work = gate === "plan" ? task.proposedSource ?? executionFor(task).work.source : executionFor(task).work.source;
    const workLine = task.workRows || task.repositories
      ? (gate === "plan" ? task.workRows?.map((row) => [row.source ? workSummary(row.source) : row.choice.productId, row.choice.reason, row.error, row.addition ? `Will be added in ${row.addition.path}` : ""].filter(Boolean).join("\n")) : task.repositories?.map((entry) => [entry.source ? workSummary(entry.source) : entry.productId, entry.report?.summary, entry.checks?.results.length ? entry.checks.results.every((run) => run.ok) ? "Product checks passed" : "Product checks failed" : "Product checks: Not run", entry.releasePreview ? `Release ${entry.releasePreview.tag}: ${entry.releasePreview.notes}\nThis includes everything waiting on the default branch since the previous release.` : ""].filter(Boolean).join("\n")))?.join("\n\n") ?? ""
      : work ? workSummary(work) : "";
    const body = gate === "design" ? callCheckBody(task as unknown as Task) : gate === "delivery" ? [workLine, task.repositories ? library.companionPreview(task.repositories) : deliveryLines(taskView(task)) ?? ""].filter(Boolean).join("\n") : gate === "plan" ? [workLine, task.workError ?? ""].filter(Boolean).join("\n") : undefined;
    const explanation = [problem, checks?.body, body].filter(Boolean).join("\n\n");
    this.raise(task, gate, checks?.title ?? gateTitle(taskView(task), gate), false, explanation ? { body: explanation } : {});
    task.statusLine = problem ? "Delivery preparation needs you" : checks ? library.CHECKS_STILL_FAIL : gateStatus(taskView(task), gate);
    task.column = gate === "plan" ? "planning" : gate === "design" ? "designing" : "ready";
    // On disk before the window shows it: an answer to this check must find it after any restart.
    this.commitNow();
  }

  /** `by`: the agent asking, when it is not the task's main one (a reviewer working beside others). */
  raise(target: MTask | RepositoryContext, kind: InboxKind, title: string, blocking: boolean, extra: { body?: string; options?: string[]; detail?: string; toolId?: CheckId; toolProblem?: InboxItem["toolProblem"]; reviewKey?: string } = {}, by: { roleId: Id; profileId: Id } | undefined = undefined): Id {
    const scope = executionOf(target);
    const { task, work: repository } = scope;
    by ??= task.agent;
    const id = this.id("inbox");
    task.state = "needs-you";
    this.s.inbox.push({
      ...(task.repositories && ["guide", "learnings", "shipping", "stuck"].includes(kind) ? { productId: repository.productId } : {}),
      id,
      taskId: task.id,
      kind,
      title,
      at: Date.now(),
      blocking,
      ...(by ? { roleId: by.roleId, profileId: by.profileId } : {}),
      ...(extra.body ? { body: extra.body } : {}),
      ...(extra.options ? { options: extra.options } : {}),
      ...(extra.detail ? { detail: extra.detail } : {}),
      ...(extra.toolId ? { toolId: extra.toolId } : {}),
      ...(extra.toolProblem ? { toolProblem: extra.toolProblem } : {}),
      ...(extra.reviewKey ? { reviewKey: extra.reviewKey } : {}),
    });
    this.tracking.asked(scope, this.s.inbox.at(-1)!);
    return id;
  }

  fail(taskId: Id, error: unknown): void {
    const task = this.task(taskId);
    const scope = task ? executionFor(task) : undefined;
    if (!task) return;
    this.stopHelpers(taskId);
    delete task.helpers;
    const message = error instanceof Error ? error.message : String(error);
    this.tracking.failed(task, error);
    delete task.agent;
    delete task.capacityResume;
    delete task.capacityRetries;
    delete task.capacityPaused;
    delete scope!.work.conversation;
    this.discardScreenTurns(task);
    this.releaseScreen(task);
    this.stopStep(task);
    task.holdsSlot = false;
    const published = task.repositories?.filter((work) => library.repositoryPublished(work)).length ?? 0;
    task.state = published || error instanceof MaintenanceProfileProblem ? "needs-you" : "failed";
    task.error = message;
    task.statusLine = published ? `Delivery needs you · ${published} of ${task.repositories!.length} delivered` : error instanceof MaintenanceProfileProblem ? "Waiting for confirmed maintenance settings. Check the tool, then try again." : "Stuck. Needs you";
    this.dropBlockingItems(taskId);
    // What went wrong belongs to the step that got stuck (an agent's, or Petrina's own); then the task waits for the coordinator.
    if (openStep(task)?.kind !== "you") endOpenStep(task, { outcome: W.stuck, reason: message, tone: "stuck", end: "failed" }, Date.now());
    if (error instanceof ToolProblem) {
      // Named, with its fix in one sentence; what the tool said stays behind Details.
      const name = CHECK_NAMES[error.toolId];
      const kind = notReady(error.status as CheckStatus) ? (error.status as "not-installed" | "logged-out") : "wont-start";
      const problem = kind === "not-installed" ? `${name} isn't installed` : kind === "logged-out" ? `${name} isn't logged in` : `${name} wouldn't start`;
      const platform = this.s.setup?.platform ?? "linux";
      const fix = kind === "wont-start" ? wontStartFix(error.toolId, platform) : fixFor(error.toolId, kind, platform);
      task.statusLine = `Stuck: ${problem}`;
      this.log(task, "warn", `Stuck: ${problem}`);
      beginYouStep(task, "stuck", Date.now());
      this.raise(task, "stuck", `${problem}, so “${task.title}” is stuck`, false, { ...(fix ? { body: fix.sentence } : {}), ...(kind === "wont-start" ? { detail: message.slice(0, 600) } : {}), toolId: error.toolId, toolProblem: kind });
    } else {
      this.log(task, "warn", `Stuck: ${message.slice(0, 300)}`);
      beginYouStep(task, "stuck", Date.now());
      this.raise(task, "stuck", `“${task.title}” is stuck`, false, { body: message.slice(0, 600) });
    }
    task.state = published || error instanceof MaintenanceProfileProblem ? "needs-you" : "failed";
    this.commit();
  }

  /** The agent tools the squad uses now: Ready ones, or if none is, those Petrina couldn't check. */
  usableTools(): CheckId[] { return this.usageCoordinator.usableTools(); }

  /** The same kind of profile on a tool the squad can use. Unchanged when its tool is usable, or when none is. */
  onUsable(profileId: Id): Id { return this.usageCoordinator.onUsable(profileId); }

  remember(task: MTask, text: string, id?: Id, kind?: InboxKind): void {
    const stage = task.plan?.stages[task.stageIndex];
    const roleId = task.agent?.roleId ?? (stage?.kind === "converge" && task.sub > 0 ? stage.reviewerRoleId : stage?.roleId);
    const roleName = roleId ? this.role(roleId)?.name : undefined;
    const origin = { stageTitle: stage?.title ?? (task.startedAt === undefined ? "Before work started" : "Planning"), ...(stage ? { stageId: stage.id } : {}), ...(roleName ? { roleName } : {}), ...(kind ? { kind } : {}) };
    task.notes = [...(task.notes ?? []), { at: Date.now(), text, origin, ...(id ? { id } : {}) }];
  }

  /** Keep what the coordinator said for the current step, until the step finishes. */
  stepNote(task: MTask, kind: StepNote["kind"], text: string, extra: { id?: Id; about?: string } = {}): void {
    task.stepNotes = [...(task.stepNotes ?? []), { id: extra.id ?? this.id(task.id), at: Date.now(), kind, text, ...(extra.about ? { about: extra.about } : {}) }];
  }

  /**
   * The step handed back its result: a short record of it is kept for estimates, unless it was started again
   * (a restart, a pause, Try again, a stand-in), and the next step starts clean, in a new conversation.
   */
  finishStep(target: MTask | RepositoryContext): void {
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
  clearStep(target: MTask | RepositoryContext): void {
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
  agentWorktree(target: MTask | RepositoryContext): string{ return this.screens.agentWorktree(target); }

  /** Pause, cancel or failure discards saved screen conversations and their separate working copies. */
  discardScreenTurns(task: MTask): void { return this.screens.discardScreenTurns(task); }

  /**
   * The agent asked for the screen. Allowed and free: it has it now, in the same conversation. Otherwise its
   * conversation closes but is kept, its slot frees at once, and the task waits: for the coordinator's OK (with
   * a quiet inbox item), or for its turn.
   */
  askScreen(task: MTask, roleId: Id, profileId: Id, reason: string, member?: string): boolean { return this.screens.askScreen(task, roleId, profileId, reason, member); }

  /** Wait without a slot; a screen attempt that ran out of usage returns to the end of the queue. */
  waitForScreen(task: MTask): void { return this.screens.waitForScreen(task); }

  /** Keep each waiting request's status line and quiet inbox item in step with who may use the screen now. */
  syncScreen(): void { return this.screens.syncScreen(); }

  /** Expose the group's earliest allowed request, including after usage requeues or permission changes. */
  selectScreen(task: MTask): void { return this.screens.selectScreen(task); }

  /** The step's screen request ends with the step (or a pause, a cancel, a failure): the next request may have the screen. */
  releaseScreen(task: MTask): void { return this.screens.releaseScreen(task); }

  /** For an hour turns itself off when it runs out. */
  armScreenTimer(): void { return this.screens.armScreenTimer(); }

  /** The step stops before handing back its result: its to-do item and clock go, and it starts fresh next time. */
  stopStep(task: MTask): void {
    this.pendingAgentAdmissions.delete(task.id);
    stopTaskActivity(task);
  }

  /** The agent stops working on the step for a while (it waits for the coordinator or for usage): the wait is not working time. */
  pauseStep(task: MTask, now = Date.now()): void {
    if (task.stepClock) task.stepClock = pauseClock(task.stepClock, Math.max(now, task.stepClock.since ?? 0));
    for (const work of Object.values(task.hunt?.work ?? {})) {
      if (work.clock) work.clock = pauseClock(work.clock, Math.max(now, work.clock.since ?? 0));
    }
  }

  /** One steady member's summary, switching to whoever needs the coordinator while they wait. */
  showReviewWork(task: MTask): void {
    const agents = [task.agent, ...(task.helpers ?? [])].filter((agent): agent is DeepMutable<ActiveAgent> => agent?.reviewKey !== undefined);
    if (!agents.length) return;
    const working = (agent: (typeof agents)[number]) => task.hunt?.work?.[agent.reviewKey!];
    const agent = agents.find((entry) => working(entry)?.waiting) ?? agents.find((entry) => working(entry)) ?? agents[0]!;
    task.agent = agent;
    const helpers = agents.filter((entry) => entry !== agent);
    if (helpers.length) task.helpers = helpers;
    else delete task.helpers;
    const work = working(agent);
    if (work?.toolActivity) task.toolActivity = work.toolActivity;
    else delete task.toolActivity;
    if (work?.todo) task.todo = work.todo;
    else delete task.todo;
    if (work?.clock) task.stepClock = work.clock;
    else delete task.stepClock;
    if (task.state === "running" && work?.activity) task.statusLine = work.activity;
    else if (task.state === "needs-you" && work?.waiting) task.statusLine = work.waiting;
  }

  /** Each completed reviewer or voter leaves its own record; interrupted attempts do not. */
  finishReviewWork(task: MTask, key: string): void {
    const work = task.hunt?.work?.[key];
    if (work?.clock && work.attempts === 1) task.steps = [...(task.steps ?? []), stepRecord(work.clock, Date.now())].slice(-MAX_STEP_RECORDS);
    if (task.hunt?.work) delete task.hunt.work[key];
    this.showReviewWork(task);
  }

  /** False for a resend of something already received (its confirmation was lost on the way back). */
  firstTime(task: MTask, clientId: Id | undefined): boolean {
    if (!clientId) return true;
    if (task.received?.includes(clientId)) return false;
    task.received = [...(task.received ?? []), clientId].slice(-50);
    return true;
  }

  toWaiting(task: MTask): void {
    task.state = "waiting";
    task.statusLine = "Waiting for a free slot";
    task.column = this.columnFor(task);
  }

  unblock(task: MTask): void {
    if (task.state !== "needs-you") return;
    if (this.s.inbox.some((item) => item.taskId === task.id && item.blocking)) return;
    task.state = task.holdsSlot ? "running" : "waiting";
    task.statusLine = task.holdsSlot ? "Back to work" : "Waiting for a free slot";
    if (task.holdsSlot && task.stepClock && !task.agent?.reviewKey) task.stepClock = resumeClock(task.stepClock, Date.now());
  }

  takeItem(itemId: Id): DeepMutable<InboxItem> | undefined {
    const item = this.s.inbox.find((entry) => entry.id === itemId);
    if (item) this.s.inbox = this.s.inbox.filter((entry) => entry.id !== itemId);
    return item;
  }

  async waitForReply(id: Id, signal: AbortSignal): Promise<string> {
    let waiter!: { resolve: (answer: string) => void; reject: (error: unknown) => void };
    const reply = new Promise<string>((resolve, reject) => { waiter = { resolve, reject }; this.waiting.set(id, waiter); });
    try { return await abortable(reply, signal); }
    finally { if (this.waiting.get(id) === waiter) this.waiting.delete(id); }
  }

  dropBlockingItems(taskId: Id): void {
    const task = this.task(taskId);
    const dropped = this.s.inbox.filter((entry) => entry.taskId === taskId && entry.blocking && entry.kind !== "maintenance-settings");
    if (task) withdrawAsks(task, dropped.map((item) => item.id), Date.now());
    for (const item of dropped) {
      this.waiting.get(item.id)?.reject(new Aborted());
      this.waiting.delete(item.id);
    }
    this.s.inbox = this.s.inbox.filter((entry) => !(entry.taskId === taskId && entry.blocking && entry.kind !== "maintenance-settings"));
  }

  stopDriver(taskId: Id): void {
    this.drivers.get(taskId)?.abort();
    this.drivers.delete(taskId);
    this.runs.get(taskId)?.close();
    this.runs.delete(taskId);
    this.stopHelpers(taskId);
  }

  /** Stop every agent working beside the task's main one. */
  stopHelpers(taskId: Id): void {
    for (const run of this.helperRuns.get(taskId) ?? []) run.close();
    this.helperRuns.delete(taskId);
    this.syncIdleSleep();
  }

  async undoReadOnly(target: MTask | RepositoryContext, roleId: Id, worktree?: string, knownClean?: boolean): Promise<void> {
    const scope = executionOf(target);
    const { work: repository } = scope;
    worktree ??= repository.worktree;
    const conversation = repository.conversation?.roleId === roleId ? repository.conversation : undefined;
    const role = conversation?.role ?? this.role(roleId);
    if (role && !(conversation?.access?.canEdit ?? role.canEdit) && worktree && !(knownClean ?? await git.isClean(worktree))) {
      await git.discardChanges(worktree);
      this.log(scope, "warn", `Undid changes from ${role.name}, which is read-only`);
    }
  }

  /** Keep an editing role's work before another role's read-only clean-up can undo it. */
  async saveRoleEdits(target: MTask | RepositoryContext, roleId: Id, profileId: Id): Promise<void> {
    const scope = executionOf(target);
    const { task, work: repository } = scope;
    const conversation = repository.conversation?.roleId === roleId ? repository.conversation : undefined;
    const role = conversation?.role ?? this.role(roleId);
    if (role && (conversation?.access?.canEdit ?? role.canEdit)) {
      const sha = await git.commitAll(repository.worktree!, `${task.title}: ${role.name}`);
      if (repository.checks && (sha || repository.checks.current !== false)) repository.checks.current = repository.checks.tree === await git.treeOf(repository.worktree!);
      if (sha) this.log(scope, "done", `Saved the changes from the ${role.name} on the task's branch`, roleId, profileId);
    }
  }

  columnFor(task: MTask): Column {
    return columnOf(task as unknown as Task, this.s.roles as Role[]);
  }

  empty(): State {
    return { now: Date.now(), seq: 0, products: [], roles: BUILT_IN_ROLES, tools: [], profiles: ENGINE_PROFILES, tasks: [], inbox: [], pool: { limit: 3, paused: false, toolCaps: Object.fromEntries(Object.keys(ADAPTERS).map(id => [id, 3])) } };
  }

  renumberQueue(): void {
    queueOf(this.s.tasks as Task[]).forEach((task, position) => {
      const entry = this.task(task.id);
      if (entry) entry.priority = position;
    });
  }

  task(id: Id): MTask | undefined { return this.projection.task(id); }

  repositoryOf(target: MTask | RepositoryContext) {
    const scope = executionOf(target);
    const { work: repository } = scope;
    const product = this.productOf(scope);
    return product && repository.source ? { ...product, ...repository.source.product, name: product.name } : product;
  }

  productOf(target: MTask | RepositoryContext) {
    const scope = executionOf(target);
    const { work: repository } = scope;
    return this.s.products.find((product) => product.id === repository.productId);
  }

  role(id: Id, task?: MTask): Role | undefined {
    return library.roleForTask(this.s.roles, id, task);
  }

  profile(id: Id): AgentProfile | undefined {
    return (this.s.profiles.find((profile) => profile.id === id) ?? this.s.retiredProfiles?.find(profile => profile.id === id)) as AgentProfile | undefined;
  }

  /** Only Builders return to an earlier step's conversation; an interrupted Builder keeps its current one. */
  builderConversation(target: MTask | RepositoryContext, plannedId: Id) { return this.usageCoordinator.builderConversation(target, plannedId); }

  /**
   * Who works a step planned for this profile right now: the planned one, or a stand-in while its tool or
   * model is out of usage. `room` is whether that tool can take a seat now. A stand-in whose tool is full
   * yields to another tool that has one, so a cap kept for a tool that is out does not idle a pool slot.
   */
  choose(plannedId: Id, target?: MTask | RepositoryContext, roleId?: Id, room?: (toolId: Id, profile: AgentProfile) => boolean, reviewerKey?: string): Choice | undefined { return this.usageCoordinator.choose(plannedId, target, roleId, room, reviewerKey); }

  /** "Claude Code · Opus 5.5": the tool and model of a profile, for the timeline. */
  named(profileId: Id): string {
    const profile = this.profile(profileId);
    return `${this.toolName(profile?.toolId)} · ${profile?.model}`;
  }

  private toolName(toolId: Id | undefined): string {
    return this.s.tools.find((tool) => tool.id === toolId)?.name ?? ADAPTERS[toolId ?? ""]?.name ?? toolId ?? "the tool";
  }

  /**
   * A tool said how much of a limit is used: kept as the latest for that tool and kind of limit. A report that
   * says the tool is out keeps new agents off it until it resets, whether or not a turn fails on it (Codex's own
   * count comes from outside any turn).
   */
  recordUsage(info: UsageInfo): void { return this.usageCoordinator.recordUsage(info); }
  recordAccountUsage(toolId: Id, reports: readonly UsageInfo[]): void { this.usageCoordinator.recordAccountUsage(toolId, reports); }

  /**
   * An agent on this tool is starting, or the engine is (no tool): refresh the account
   * usage that the installed tool can report. The read runs on its own; nothing waits for it.
   */
  readUsage(toolId?: Id, gap?: number): void { return this.usageCoordinator.readUsage(toolId, gap); }

  /** A turn ended because its tool ran out: who is out and until when is kept, and the task's timeline says so. */
  recordLimit(task: MTask, roleId: Id, profileId: Id, error: UsageLimited): void { return this.usageCoordinator.recordLimit(task, roleId, profileId, error); }

  /** The selected Codex model is full for this task. Usage meters stay as they were, and the timeline says so. */
  recordModelCapacity(task: MTask, roleId: Id, profileId: Id, error: ModelAtCapacity, waitMs?: number): void { return this.usageCoordinator.recordModelCapacity(task, roleId, profileId, error, waitMs); }

  /** Limits whose time has passed are dropped. True when any was. */
  expireLimits(): boolean { return this.usageCoordinator.expireLimits(); }

  /** The scheduler runs again when the first limit in force ends: tasks waiting for usage start by themselves. */
  armLimitTimer(): void { return this.usageCoordinator.armLimitTimer(); }

  /** The task lets go of its slot and waits until a limit ends: the driver stops, and the scheduler starts it again. */
  waitForUsage(task: MTask, words: string): void {
    this.pauseStep(task);
    task.state = "waiting";
    task.holdsSlot = false;
    delete task.agent;
    task.statusLine = words;
    task.column = this.columnFor(task);
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

  log(target: MTask | RepositoryContext, tone: Task["timeline"][number]["tone"], text: string, roleId?: Id, profileId?: Id): void {
    const scope = executionOf(target);
    const { task, work: repository } = scope;
    const step = stepTag(task);
    task.timeline.push({ ...(task.repositories ? { productId: repository.productId } : {}), id: this.id(task.id), at: Date.now(), text, tone, ...(roleId ? { roleId } : {}), ...(profileId ? { profileId } : {}), ...(step ? { step } : {}) });
    if (task.timeline.length > MAX_TIMELINE) task.timeline.splice(0, task.timeline.length - MAX_TIMELINE);
  }

  say(target: MTask | RepositoryContext, from: Task["session"][number]["from"], text: string, roleId?: Id, profileId?: Id, toolInvocationId?: Id): void {
    const scope = executionOf(target);
    const { task, work: repository } = scope;
    const last = task.session.at(-1);
    if (from === "activity" && !toolInvocationId && last?.from === "activity" && last.text === text) return;
    const step = stepTag(task);
    task.session.push({ ...(task.repositories ? { productId: repository.productId } : {}), id: this.id(task.id), at: Date.now(), from, text, ...(toolInvocationId ? { toolInvocationId } : {}), ...(roleId ? { roleId } : {}), ...(profileId ? { profileId } : {}), ...(step ? { step } : {}) });
    while (task.session.length > MAX_SESSION_LINES) {
      // Keep the newest line, saved pictures, a report whose pictures are still being checked,
      // and the latest words from each agent. Another update must not drop a report before its pictures are attached.
      const index = task.session.findIndex((line, index) => index < task.session.length - 1 && !line.images?.length && !this.pendingReportIds.has(line.id) && newerWords(task.session, index, line));
      if (index < 0) break;
      task.session.splice(index, 1);
    }
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

  commit(target?: MTask | RepositoryContext): void {
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
  noteTodo(target?: MTask | RepositoryContext): void {
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
  commitNow(target?: MTask | RepositoryContext): void {
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
  noteStream(target: MTask | RepositoryContext): void {
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
