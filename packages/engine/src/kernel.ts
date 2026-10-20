import { blockingDependencies, clearTaskStep, finishTaskStep, stopTaskActivity } from "@petrina/core";
import { executionFor, executionOf, taskView, restoreRepositoryState, type RepositoryContext } from "./repository-context.js";
import * as library from "@petrina/core";
// The engine's shared state and the few operations every part of it uses: lookups, the timeline and
// session, the inbox, and saving. Feature modules get this, never the Engine itself.

import { randomBytes } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { IdleSleepAssertion } from "./awake.js";
import { NO_ROLE_CHANGES, libraryRoles, beginYouStep, BUILT_IN_ROLES, callCheckBody, chooseWithRoom, headroom, kindWords, limitOf, nearLimit, endOpenStep, JOURNEY_WORDS as W, nextExpiry, onScreen, openStep, queueOf, SCREEN_WORDS, screenAllowed, screenMode, screenQueue, screenWait, UNKNOWN_LIMIT_MS, stepTag, untilWords, withLimit, withReport, workSummary, type Choice, TAKE_OVER_WORDS, withdrawAsks, type AgentProfile, type Column, type GateKind, type Id, type InboxItem, type InboxKind, type RiskLevel, type Role, type Stage, type State, type StepNote, type Task, type Tone, columnOf, gateStatus, gateTitle, type DeepMutable, CHECK_NAMES, fixFor, usableAgentTools, wontStartFix, type CheckId, type CheckStatus, type Platform, MAX_STEP_RECORDS, pauseClock, resumeClock, stepRecord, type ActiveAgent } from "@petrina/core";
import { AgentRun } from "./acp-run.js";
import { CODEX_USAGE_COMMAND, CodexUsage } from "./codex-usage.js";
import { GrokUsage } from "./grok-usage.js";
import { AntigravityUsage } from "./antigravity-usage.js";
import { agentEnv } from "./env.js";
import * as git from "./git.js";
import type { Which } from "./setup.js";
import { Store, settledHistoryTask } from "./store.js";
import { finishedTask, stopCheckProgress, type HistoryQuery, type HistoryPage } from "@petrina/core";
import { detectTerminals, type FoundTerminal, thisMachine } from "./terminal.js";
import { ADAPTERS, detectTools, ENGINE_PROFILES } from "./tools.js";
import type { UsageInfo, UsageLimited } from "./usage.js";
import { Tracking } from "./tracking.js";
import { stepBack } from "./roles.js";
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
    for (const work of task.repositories ?? [task.repository!]) {
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
  /** Tests: a fake GitHub instead of `gh`. */
  gh?: readonly string[];
  /** Tests: a fake Codex app-server instead of `codex app-server` for reading Codex's usage. With fake agents and none given, it is not read. */
  codexCommand?: readonly string[] | null;
  /** Tests: a fake Grok ACP server for account usage. Disabled by default with fake agents. */
  grokCommand?: readonly string[] | null;
  /** Tests: native Antigravity account commands; disabled with fake agents unless supplied. */
  antigravityCommand?: readonly string[] | null;
  /** Tests: a folder standing in for every product's copy on GitHub. Never from settings or saved data. */
  remote?: string;
  remotes?: Readonly<Record<string, string>>;
  /** Tests: separate local remotes for fork working repositories. */
  sourceRemotes?: Record<string, string>;
  /** Tests: how long a tool gets to reopen a conversation. */
  reopenTimeoutMs?: number;
  /** Tests: how long a tool gets to start a fresh conversation. */
  startTimeoutMs?: number;
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
    this.startupReady = recoverBrowserTemps(join(dataDir, "browser-temp")).then(() => {
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
      for (const task of this.s.tasks) { this.pauseStep(task, this.s.now); stopCheckProgress(task, this.s.now); }
    }
    this.s.roleChanges = (loaded?.roleChanges ?? structuredClone(NO_ROLE_CHANGES)) as MState["roleChanges"];
    this.s.roles = libraryRoles(this.s.roleChanges) as MState["roles"];
    this.s.profiles = ENGINE_PROFILES as MState["profiles"];
    // Tests stand in the tools' own apps: those count as installed.
    this.s.tools = detectTools().map((tool) => (options.toolPath?.(tool.id) ? { ...tool, status: "ready" as const } : tool)) as MState["tools"];
    this.s.setup = setupOf(loaded) as MState["setup"];
    if (this.s.setup && !loaded?.setup && this.store.history.info().total > 0) this.s.setup.done = true;
    this.s.planner = this.onUsable(PLANNER_PROFILE);
    this.found = options.terminals?.() ?? detectTerminals(this.machine);
    this.s.terminals = this.found.map(({ id, name }) => ({ id, name }));
    this.tracking = new Tracking(this);
    this.tracking.start();
    // Codex does not pass its usage on over ACP: Petrina reads it from Codex's app-server, with the agents' environment.
    const codexCommand = options.codexCommand === undefined ? (options.agentCommand ? undefined : CODEX_USAGE_COMMAND) : options.codexCommand;
    this.codexUsage = codexCommand
      ? new CodexUsage({
          command: codexCommand,
          env: () => agentEnv(process.env),
          record: (reports) => {
            for (const info of reports) this.recordUsage(info);
            // More or less room on Codex: waiting tasks may start, or hold.
            this.schedule();
          },
          log: (text) => console.warn(`${new Date().toISOString()} ${text}`),
          changed: () => this.commit(),
        })
      : undefined;
    const grokCommand = options.grokCommand === undefined ? (options.agentCommand ? undefined : ADAPTERS.grok!.command) : options.grokCommand;
    this.grokUsage = grokCommand ? new GrokUsage({
      command: grokCommand,
      env: () => agentEnv(process.env),
      record: (reports) => { for (const info of reports) this.recordUsage(info); this.schedule(); },
      log: (text) => console.warn(`${new Date().toISOString()} ${text}`),
      changed: () => this.commit(),
    }) : undefined;
    const antigravityCommand = options.antigravityCommand === undefined ? (options.agentCommand ? undefined : ADAPTERS.antigravity!.command) : options.antigravityCommand;
    this.antigravityUsage = antigravityCommand ? new AntigravityUsage({
      command: antigravityCommand, cwd: join(this.dataDir, "checks"), env: () => agentEnv(process.env),
      record: reports => { for (const info of reports) this.recordUsage(info); this.schedule(); },
      log: text => console.warn(`${new Date().toISOString()} ${text}`), changed: () => this.commit(),
    }) : undefined;
  }

  waitUntilReady(): Promise<void> { return this.startupReady; }

  readonly s: MState;

  readonly store: Store;

  /** The work log: every agent turn and notable moment, the permanent product list and the tools' limits. */
  readonly tracking: Tracking;
  /** Reads Codex's usage, when Codex's usage can be read here. */
  readonly codexUsage: CodexUsage | undefined;
  readonly grokUsage: GrokUsage | undefined;
  readonly antigravityUsage: AntigravityUsage | undefined;

  private readonly idleSleep: IdleSleepAssertion;

  readonly listeners = new Set<() => void>();

  /** Reports whose chosen captures are being checked, by line id. Kept outside saved task state. */
  readonly pendingReportIds = new Set<string>();

  readonly drivers = new Map<Id, AbortController>();
  /** An internal preparation role that still needs ordinary tool and pool admission. */
  readonly pendingAgentAdmissions = new Map<Id, { step: string; roleId: Id; profileId: Id }>();

  readonly runs = new Map<Id, AgentRun>();

  /** Agents working beside a task's main one on the same step (reviewers hunting at once, voters). */
  readonly helperRuns = new Map<Id, Set<AgentRun>>();

  /** A live review group can reopen its waiting screen member without stopping its peers. */
  readonly screenGroups = new Map<Id, { continue: () => void; running: (member: string) => boolean; recipients: () => readonly string[]; finished: (member: string) => void; yield?: (member: string) => void }>();

  /** Discarded review copies finish cleaning up before the task can start fresh. */
  readonly copyCleanups = new Map<Id, Promise<void>>();

  /** Finished-task working copies being removed. */
  readonly cleanupJobs = new Set<Id>();

  readonly waiting = new Map<Id, { resolve: (value: string) => void; reject: (error: Error) => void }>();

  saveTimer: ReturnType<typeof setTimeout> | undefined;

  /** A to-do item is in memory and not in the snapshot on disk yet. */
  private todoPending = false;

  /** Text already updated in memory, awaiting one bounded detail/persistence notification. */
  private readonly streamedTasks = new Set<MTask>();
  private streamTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly legacyReviewerTools = new WeakMap<MTask, { key: string; tools: Id[] }>();

  /** Wakes the scheduler when the first usage limit in force ends. */
  limitTimer: ReturnType<typeof setTimeout> | undefined;

  readonly timers: ReturnType<typeof setInterval>[] = [];

  /** Turns For an hour off when it runs out. */
  screenTimer: ReturnType<typeof setTimeout> | undefined;

  /** Set by shutdown: work that ends afterwards (a turn cut off by the stop) changes nothing. */
  stopped = false;
  /** Stopping is under way: no new agent starts, and reviewers and voters in flight hand back first. */
  draining = false;
  drainReason: "stop" | "restart" = "restart";
  get drainLine(): string { return this.drainReason === "stop" ? "Waiting: Petrina is stopping" : "Waiting: Petrina is restarting"; }
  /** Cleanup and delivery lookups outside a task driver still belong to a drain. */
  readonly backgroundWork = new Set<Promise<unknown>>();

  trackWork<T>(work: Promise<T>): Promise<T> {
    this.backgroundWork.add(work);
    void work.finally(() => this.backgroundWork.delete(work)).catch(() => undefined);
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

  /** Explicit compatibility/debug snapshot. Production never loads all archived conversations. */
  getState = (): State => {
    this.activeState();
    const current = new Map<string, Task>([...this.archiveCache.values(), ...this.s.tasks].map((task) => [task.id, taskView(task) as Task]));
    // Shutdown closes SQLite before detached cleanup finishes. Reads used while waiting for that
    // cleanup keep the last in-memory work; stopping never loads an unbounded history snapshot.
    const tasks = this.stopped ? [] : this.store.history.all().map((task) => { const known = current.get(task.id); if (known) return known; restoreRepositoryState(task as MTask); return taskView(task as MTask); });
    const ids = new Set(tasks.map((task) => task.id));
    tasks.push(...[...current.values()].filter((task) => !ids.has(task.id)));
    const { history: _history, ...state } = this.activeState();
    return { ...state, tasks };
  };

  /** A bounded live update: all completed tasks are represented by archive totals, never bodies. */
  private readonly taskRevisions = new Map<Id, number>();
  private readonly dirtyTasks = new Set<Id>();
  private allTasksDirty = true;
  private nextTaskRevision = 0;

  private changed(target?: MTask | RepositoryContext): void {
    const revision = ++this.nextTaskRevision;
    if (target) {
      const task = executionOf(target).task;
      this.dirtyTasks.add(task.id);
      this.taskRevisions.set(task.id, revision);
    } else {
      this.allTasksDirty = true;
      for (const task of this.s.tasks) this.taskRevisions.set(task.id, revision);
    }
  }

  private detailRevision(id: Id): string { return `${this.boot}:${this.taskRevisions.get(id) ?? 0}`; }

  windowState = (): State => {
    // A terminal result must be in the archive before the window stops seeing its live body.
    if (!this.stopped && this.store.history.needsUpdate(this.s.tasks.filter(finishedTask) as Task[])) this.save();
    const tasks = this.s.tasks.filter((task) => !finishedTask(task)).map((task) => ({ ...taskView(task), detailsOmitted: true, detailsRevision: this.detailRevision(task.id), session: [], timeline: [], journey: undefined, designSessions: undefined, reviewSessions: undefined, handedBack: undefined })) as Task[];
    const usageReads: NonNullable<State["pool"]["usageReads"]> = Object.fromEntries(
      ([["codex", this.codexUsage], ["grok", this.grokUsage], ["antigravity", this.antigravityUsage]] as const).flatMap(([toolId, reader]) => reader?.snapshot() ? [[toolId, reader.snapshot()!]] : []),
    );
    const dependencies = this.stopped ? [] : [...new Set([...this.s.inbox.map((item) => item.taskId), ...this.s.tasks.filter((task) => !finishedTask(task)).flatMap((task) => [...(task.after ?? []), ...(task.journey ?? []).flatMap((step) => step.waitsOn?.map((entry) => entry.id) ?? [])])])].flatMap((id) => {
      const item = this.store.history.item(id);
      return item ? [item] : [];
    });
    return { ...this.activeState(), tasks, ...(Object.keys(usageReads).length ? { pool: { ...this.s.pool, usageReads } } : {}), history: { ...this.store.history.info(), ...(dependencies.length ? { dependencies } : {}) } };
  };

  historyPage = (request: HistoryQuery): HistoryPage => {
    if (this.stopped) throw new Error("The engine has stopped. Reconnect to open task history.");
    if (!this.stopped && this.store.history.needsUpdate(this.s.tasks.filter(finishedTask) as Task[])) this.save();
    return this.store.history.page(request);
  };

  taskDetails = (id: Id): Task | undefined => { const task = this.task(id); return task ? taskView(task) : undefined; };

  private readonly archiveCache = new Map<Id, MTask>();

  /** A cleanup result for an already archived task must survive immediately, even after cache eviction. */
  saveArchivedTask(task: MTask): void {
    if (this.stopped || this.s.tasks.includes(task)) return;

    this.store.save(this.activeState(), this.retiredTasks(), [task as Task]);
  }

  forgetProductHistory(productId: Id): void {
    for (const [id, task] of this.archiveCache) if (library.involvesProduct(task, productId)) this.archiveCache.delete(id);
  }

  private retiredTasks(): Id[] {
    return this.s.tasks.filter((task) => settledHistoryTask(task as Task) && !this.drivers.has(task.id) && !this.settling.has(task.id) && !this.switching.has(task.id) && !this.copyCleanups.has(task.id) && !this.followsUpHeld(task.id)).map((task) => task.id);
  }

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

  gate(task: MTask, gate: GateKind, problem?: string): void {
    delete task.agent;
    task.holdsSlot = false;
    beginYouStep(task, gate, Date.now());
    const work = gate === "plan" ? task.proposedSource ?? executionFor(task).work.source : executionFor(task).work.source;
    const workLine = task.workRows || task.repositories
      ? (gate === "plan" ? task.workRows?.map((row) => [row.source ? workSummary(row.source) : row.choice.productId, row.choice.reason, row.error, row.addition ? `Will be added in ${row.addition.path}` : ""].filter(Boolean).join("\n")) : task.repositories?.map((entry) => [entry.source ? workSummary(entry.source) : entry.productId, entry.report?.summary, entry.checks?.results.length ? entry.checks.results.every((run) => run.ok) ? "Product checks passed" : "Product checks failed" : "Product checks: Not run", entry.releasePreview ? `Release ${entry.releasePreview.tag}: ${entry.releasePreview.notes}\nThis includes everything waiting on the default branch since the previous release.` : ""].filter(Boolean).join("\n")))?.join("\n\n") ?? ""
      : work ? workSummary(work) : "";
    const body = gate === "design" ? callCheckBody(task as unknown as Task) : gate === "delivery" ? [workLine, task.repositories ? library.companionPreview(task.repositories) : deliveryLines(taskView(task)) ?? ""].filter(Boolean).join("\n") : gate === "plan" ? [workLine, task.workError ?? ""].filter(Boolean).join("\n") : undefined;
    const explanation = [problem, body].filter(Boolean).join("\n\n");
    this.raise(task, gate, gateTitle(taskView(task), gate), false, explanation ? { body: explanation } : {});
    task.statusLine = problem ? "Delivery preparation needs you" : gateStatus(taskView(task), gate);
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
    delete scope!.work.conversation;
    this.discardScreenTurns(task);
    this.releaseScreen(task);
    this.stopStep(task);
    task.holdsSlot = false;
    const published = task.repositories?.filter((work) => library.repositoryPublished(work)).length ?? 0;
    task.state = published ? "needs-you" : "failed";
    task.error = message;
    task.statusLine = published ? `Delivery needs you · ${published} of ${task.repositories!.length} delivered` : "Stuck. Needs you";
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
    task.state = published ? "needs-you" : "failed";
    this.commit();
  }

  /** The agent tools the squad uses now: Ready ones, or if none is, those Petrina couldn't check. */
  usableTools(): CheckId[] {
    if (!this.s.setup?.checks.some((check) => ADAPTERS[check.id] !== undefined)) {
      const installed = this.s.tools.filter((tool) => tool.status === "ready").map((tool) => tool.id as CheckId);
      if (installed.length) return installed;
    }
    return usableAgentTools(this.s.setup?.checks);
  }

  /** The same kind of profile on a tool the squad can use. Unchanged when its tool is usable, or when none is. */
  onUsable(profileId: Id): Id {
    const profile = this.profile(profileId);
    const usable = this.usableTools();
    if (!profile || !usable.length || usable.includes(profile.toolId as CheckId)) return profileId;
    const others = this.s.profiles.filter((entry) => entry.toolId === usable[0]);
    return (others.find((entry) => entry.effort === profile.effort) ?? others[0])?.id ?? profileId;
  }

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
    this.pendingAgentAdmissions.delete(task.id);
    this.releaseScreen(task);
  }

  /** The next step starts clean: nothing said in this one, no conversation, no to-do item, no clock. */
  clearStep(target: MTask | RepositoryContext): void {
    const scope = executionOf(target);
    const { task, work: repository } = scope;
    clearTaskStep(task, repository);
    this.releaseScreen(task);
    this.stopStep(task);
  }

  /** A reopened reviewer or voter still works in its own copy, including during terminal take-over. */
  agentWorktree(target: MTask | RepositoryContext): string {
    const scope = executionOf(target);
    const { task, work: repository } = scope;
    const member = task.screen?.member;
    return (member && task.hunt?.screenTurns?.[member]?.copy) || repository.worktree!;
  }

  /** Pause, cancel or failure discards saved screen conversations and their separate working copies. */
  discardScreenTurns(task: MTask): void {
    if (!Object.keys(task.hunt?.screenTurns ?? {}).length) return;
    delete task.hunt!.screenTurns;
    const owners = task.repositories ? [...task.repositories, ...(task.excludedRepositories ?? [])].map((work) => ({ productId: work.productId, root: work.source?.product.path })) : [{ productId: task.productId, root: this.productOf(task)?.path }];
    if (!owners.some((owner) => owner.root)) return;
    const stopped = this.settling.get(task.id);
    const cleanup = Promise.all([stopped, this.copyCleanups.get(task.id)])
      .then(async () => { for (const owner of owners) if (owner.root) await git.removeCopies(owner.root, join(this.dataDir, "worktrees", owner.productId, `${task.id}.copies`)); })
      .catch((error: unknown) => this.log(task, "warn", `Could not remove the reviewers' working copies: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        if (this.copyCleanups.get(task.id) === cleanup) this.copyCleanups.delete(task.id);
        this.syncIdleSleep();
      });
    this.copyCleanups.set(task.id, cleanup);
    this.syncIdleSleep();
  }

  /**
   * The agent asked for the screen. Allowed and free: it has it now, in the same conversation. Otherwise its
   * conversation closes but is kept, its slot frees at once, and the task waits: for the coordinator's OK (with
   * a quiet inbox item), or for its turn.
   */
  askScreen(task: MTask, roleId: Id, profileId: Id, reason: string, member?: string): boolean {
    const now = Date.now();
    task.screen = { reason, at: now, roleId, profileId, ...(member ? { member } : {}) };
    this.log(task, "status", SCREEN_WORDS.asked(reason), roleId, profileId);
    const allowed = screenAllowed(task as Task, this.s.pool as State["pool"], now);
    // First asked, first served: an earlier allowed request still waiting goes first.
    const free = !onScreen(this.s.tasks as Task[]) && !screenQueue(this.s.tasks as Task[]).some((other) => other.id !== task.id && screenAllowed(other, this.s.pool as State["pool"], now));
    if (allowed && free) {
      task.screen.granted = true;
      this.log(task, "milestone", SCREEN_WORDS.using(reason), roleId, profileId);
      return true;
    }
    // Other members of a review group finish their background work before its task waits.
    if (member) return false;
    this.waitForScreen(task);
    return false;
  }

  /** Wait without a slot; a screen attempt that ran out of usage returns to the end of the queue. */
  waitForScreen(task: MTask): void {
    if (task.screen?.granted) {
      task.screen.granted = false;
      task.screen.heard = false;
      task.screen.at = Date.now();
      const pending = task.screen.member ? task.hunt?.screenTurns?.[task.screen.member] : undefined;
      if (pending) pending.at = task.screen.at;
    }
    const group = task.screen?.member && this.screenGroups.get(task.id);
    if (group && group.yield) {
      // Release just this member's admission. A peer may still be starting or using its copy;
      // exposing zero slots here would let other work start before that peer has settled.
      group.yield(task.screen!.member!);
      this.commitNow();
      return;
    }
    task.state = "waiting";
    task.holdsSlot = false;
    delete task.agent;
    task.column = this.columnFor(task);
    this.syncScreen();
    this.commitNow();
  }

  /** Keep each waiting request's status line and quiet inbox item in step with who may use the screen now. */
  syncScreen(): void {
    const now = Date.now();
    // For an hour ran out: it is Off from now on, without anyone touching it.
    if (this.s.pool.screen && this.s.pool.screen.mode !== screenMode(this.s.pool as State["pool"], now)) this.s.pool.screen = { mode: "off" };
    for (const task of this.s.tasks) {
      this.selectScreen(task);
      const wait = screenWait(task as Task, this.activeState(), now);
      const item = this.s.inbox.find((entry) => entry.taskId === task.id && entry.kind === "screen");
      if (wait === "ask" && !item) {
        const request = task.screen!;
        this.s.inbox.push({ id: this.id("inbox"), taskId: task.id, kind: "screen", title: SCREEN_WORDS.needs(request.reason), body: SCREEN_WORDS.body, at: request.at, blocking: false, roleId: request.roleId, profileId: request.profileId });
      } else if (wait !== "ask" && item) {
        this.s.inbox = this.s.inbox.filter((entry) => entry !== item);
      }
      if (wait === "ask") task.statusLine = SCREEN_WORDS.needs(task.screen!.reason);
      else if (wait === "turn") task.statusLine = SCREEN_WORDS.turn;
      // Its turn on the screen: it waits for a slot like any other task (the scheduler says which).
      else if (task.state === "waiting" && task.screen && !task.screen.granted) task.statusLine = "Waiting for a free slot";
    }
  }

  /** Expose the group's earliest allowed request, including after usage requeues or permission changes. */
  selectScreen(task: MTask): void {
    if (task.screen?.granted || !["running", "waiting", "needs-you"].includes(task.state)) return;
    const saved = task.hunt?.screenTurns;
    const current = task.screen?.member && saved?.[task.screen.member];
    if (current && task.screen?.allowed) current.allowed = true;
    const group = this.screenGroups.get(task.id);
    const pending = Object.entries(saved ?? {}).filter(([key]) => !group?.running(key)).sort((a, b) => a[1].at - b[1].at);
    const byTask = screenAllowed({ ...task, screen: undefined } as Task, this.s.pool as State["pool"], Date.now());
    const next = pending.find(([, request]) => byTask || request.allowed) ?? pending[0];
    if (!next || next[0] === task.screen?.member) return;
    const [member, request] = next;
    task.screen = { member, reason: request.reason, at: request.at, roleId: request.conversation.roleId, profileId: request.conversation.profileId, ...(request.allowed ? { allowed: true } : {}) };
    executionFor(task).work.conversation = request.conversation;
  }

  /** The step's screen request ends with the step (or a pause, a cancel, a failure): the next request may have the screen. */
  releaseScreen(task: MTask): void {
    const held = task.screen?.granted;
    delete task.screen;
    this.s.inbox = this.s.inbox.filter((item) => !(item.taskId === task.id && item.kind === "screen"));
    if (!held) return;
    // The next request stops waiting its turn now. It starts after this task's own driver has taken
    // its next step, so a screen request does not jump ahead of it.
    this.syncScreen();
    setTimeout(() => this.schedule(), 0);
  }

  /** For an hour turns itself off when it runs out. */
  armScreenTimer(): void {
    clearTimeout(this.screenTimer);
    const screen = this.s.pool.screen;
    if (screen?.mode !== "hour" || screen.until === undefined) return;
    this.screenTimer = setTimeout(() => this.schedule(), Math.max(0, screen.until - Date.now()) + 20);
  }

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

  dropBlockingItems(taskId: Id): void {
    const task = this.task(taskId);
    const dropped = this.s.inbox.filter((entry) => entry.taskId === taskId && entry.blocking);
    if (task) withdrawAsks(task, dropped.map((item) => item.id), Date.now());
    for (const item of dropped) {
      this.waiting.get(item.id)?.reject(new Aborted());
      this.waiting.delete(item.id);
    }
    this.s.inbox = this.s.inbox.filter((entry) => !(entry.taskId === taskId && entry.blocking));
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
      if (repository.checks) repository.checks.current = repository.checks.tree === await git.treeOf(repository.worktree!);
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

  task(id: Id): MTask | undefined {
    const live = this.s.tasks.find((task) => task.id === id);
    if (live) return live;
    const cached = this.archiveCache.get(id);
    if (cached) {
      this.archiveCache.delete(id);
      this.archiveCache.set(id, cached);
      return cached;
    }
    if (this.stopped) return undefined;
    const saved = this.store.history.get(id) as MTask | undefined;
    if (!saved) return undefined;
    restoreRepositoryState(saved);
    renameRoles({ ...this.s, tasks: [saved], inbox: [] });
    // On-demand reads stay bounded even when walking through years of finished work.
    if (this.archiveCache.size >= 16) {
      this.store.save(this.activeState(), this.retiredTasks(), [...this.archiveCache.values()] as Task[]);
      this.archiveCache.delete(this.archiveCache.keys().next().value!);
    }
    this.archiveCache.set(id, saved);
    return saved;
  }

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

  role(id: Id): Role | undefined {
    return this.s.roles.find((role) => role.id === id) as Role | undefined;
  }

  profile(id: Id): AgentProfile | undefined {
    return this.s.profiles.find((profile) => profile.id === id) as AgentProfile | undefined;
  }

  /** Only Builders return to an earlier step's conversation; an interrupted Builder keeps its current one. */
  builderConversation(target: MTask | RepositoryContext, plannedId: Id) {
    const scope = executionOf(target);
    const { task, work: repository } = scope;
    const stage = task.plan?.stages[task.stageIndex];
    if (stage?.kind !== "do") return undefined;
    const current = repository.conversation;
    const role = current?.roleId === stage.roleId && current.role ? current.role : this.role(stage.roleId);
    if (role?.result !== "build") return undefined;
    const own = repository.builderSession;
    const saved = current
      ? current.roleId === stage.roleId && current.briefed && current.step === stepKey(task) && (!current.plannedProfileId || current.plannedProfileId === plannedId) ? current : undefined
      : (task.fixing || repository.updating) && own?.stageId === stage.id && (own.plannedProfileId ?? own.profileId) === plannedId && !(task.fixing && stepBack(task as Task)) ? own : undefined;
    const planned = this.profile(plannedId);
    if (!saved || !planned) return undefined;
    // The saved tool/model must still be offered. Prefer the planned effort for an earlier
    // step; an active conversation already names the actual fallback profile it ran on.
    const matches = (profile: AgentProfile) => profile.toolId === saved.toolId && (profile.modelId ?? profile.model) === saved.model;
    const exact = current ? this.profile(current.profileId) : undefined;
    const profile = exact && matches(exact) ? exact : this.s.profiles.find((profile) => matches(profile) && profile.effort === planned.effort) ?? this.s.profiles.find(matches);
    return profile ? { sessionId: saved.sessionId, toolId: saved.toolId, model: saved.model, profile } : undefined;
  }

  /**
   * Who works a step planned for this profile right now: the planned one, or a stand-in while its tool or
   * model is out of usage. `room` is whether that tool can take a seat now. A stand-in whose tool is full
   * yields to another tool that has one, so a cap kept for a tool that is out does not idle a pool slot.
   */
  choose(plannedId: Id, target?: MTask | RepositoryContext, roleId?: Id, room?: (toolId: Id) => boolean, reviewerKey?: string): Choice | undefined {
    const scope = target ? executionOf(target) : undefined;
    const task = scope?.task;
    const repository = scope?.work;
    // A saved screen conversation is not swapped just for being near a limit. Other members of the
    // same review group still choose from their own planned profiles.
    const screen = task?.screen?.roleId === roleId && task?.screen?.profileId === plannedId
      && (reviewerKey === undefined || !task.screen.member || task.screen.member === `review-${reviewerKey}`);
    const planned = this.profile(plannedId);
    if (!planned) return undefined;
    const stage = task?.plan?.stages[task.stageIndex];
    const round = task && stage ? task.rounds[stage.id] ?? 1 : 1;
    const findings = roleId !== undefined && this.role(roleId)?.result === "findings";
    // Security and port reviews follow the latest builder, including a replacement that did the port.
    const builder = task?.plan?.stages.find((stage) => stage.roleId === "builder")?.profileIds[0];
    let made: { toolId: Id; modelId?: string } | undefined = roleId === "security-reviewer" || (repository?.portReview && stage?.kind === "review-chain" && findings)
      ? (repository?.builderSession ? { toolId: repository!.builderSession.toolId, modelId: repository!.builderSession.model } : builder ? this.profile(builder) : undefined)
      : undefined;
    if (task && stage?.kind === "converge" && task.sub === 1 && roleId === (stage.reviewerRoleId ?? "design-reviewer")) {
      const saved = task.designSessions?.[JSON.stringify([stage.id, "author", repository!.productId])];
      const author = saved ? undefined : this.tracking.log.turns({ taskId: task.id, stageId: stage.id, round }).filter((turn) => turn.roleId === stage.roleId && turn.end === "finished").at(-1);
      const legacy = task.session.findLast((line) => line.from === "agent" && line.roleId === stage.roleId)?.profileId;
      made = saved ? { toolId: saved.toolId, modelId: saved.model } : author ? { toolId: author.toolId, modelId: author.modelRan ?? author.modelAsked } : this.profile(legacy ?? stage.profileIds[0] ?? "");
    }
    let peers: Id[] = [];
    if (task && stage?.kind === "review-chain" && findings && !repository?.portReview) {
      const hunt = task.hunt?.stageId === stage.id && task.hunt.round === round ? task.hunt : undefined;
      const key = reviewerKey ?? String(stage.profileIds.indexOf(plannedId));
      // Older rounds saved reports without the profiles at their positions. Their latest verdicts
      // name the actual reviewers; replace the reported positions' planned tools with those tools.
      let legacy: Id[] = [];
      if (hunt && Object.keys(hunt.reported).some((key) => !hunt.profiles?.[key])) {
        const stamp = JSON.stringify([stage.id, round, Object.keys(hunt.reported).sort()]);
        const cached = this.legacyReviewerTools.get(task);
        if (cached?.key === stamp) legacy = cached.tools;
        else {
          legacy = this.tracking.log.moments({ taskId: task.id, stageId: stage.id, round, kinds: ["verdict"] })
            .slice(-Object.keys(hunt.reported).length)
            .flatMap((entry) => { const profile = this.profile(entry.profileId ?? ""); return profile ? [profile.toolId] : []; });
          this.legacyReviewerTools.set(task, { key: stamp, tools: legacy });
        }
      }
      peers = stage.profileIds.flatMap((id, index) => {
        if (String(index) === key) return [];
        if (legacy.length && hunt?.reported[String(index)]) return [];
        const peer = this.profile(hunt?.profiles?.[String(index)] ?? id);
        return peer ? [peer.toolId] : [];
      });
      peers.push(...legacy);
    }
    const state = this.activeState();
    const checked = state.setup?.checks.some((check) => ADAPTERS[check.id] !== undefined);
    const usable = this.usableTools() as Id[];
    // Usage stand-ins follow the same login checks as the plan: Ready tools first, otherwise the
    // ones we couldn't check. Before checks have run, keep the existing installed-tool selection.
    let candidates = checked ? {
      ...state,
      profiles: state.profiles.filter((profile) => usable.includes(profile.toolId)),
      tools: state.tools.filter((tool) => usable.includes(tool.id)).map((tool) => ({ ...tool, status: "ready" as const })),
    } : state;
    if (roleId !== undefined && this.role(roleId)?.result === "votes") {
      // A voter owns one actual tool's place, not a nominal profile's place. Other tools have
      // voters of their own: a model fallback stays on this tool; a usage limit drops its place.
      // A full cap still waits, rather than giving a partner another vote.
      const ready = candidates.tools.filter((tool) => tool.status === "ready");
      if ((ready.length && !ready.some((tool) => tool.id === planned.toolId)) || !candidates.profiles.some((profile) => profile.toolId === planned.toolId)) return { kind: "none", waiting: "Waiting for a usable review tool" };
      candidates = { ...candidates, profiles: candidates.profiles.filter((profile) => profile.toolId === planned.toolId) };
    }
    const reviewing = roleId !== undefined && ["findings", "objections", "votes"].includes(this.role(roleId)?.result ?? "");
    const now = Date.now();
    // A saved screen conversation is not swapped just for being near a limit. Reopen it on its tool
    // while that tool is available; a replacement still follows the current independence rules.
    if (screen) {
      if (state.setup?.checks.some((check) => check.id === planned.toolId && notReady(check.status))) return { kind: "planned", profile: planned };
      const saved = chooseWithRoom(candidates, planned, now, { keep: true }, room);
      if (saved.kind === "planned") return saved;
    }
    const own = task && roleId !== undefined && roleId === stage?.roleId ? this.builderConversation(scope!, plannedId) : undefined;
    if (own && !limitOf(state.pool, own.profile, now) && !nearLimit(state.pool, own.profile, now) && headroom(state.pool, own.profile, now) !== 0 && (!room || room(own.toolId))) {
      const check = state.setup?.checks.find((check) => check.id === own.toolId);
      // Recovery checks are bounded by the normal tool-check timeout. Checking is temporary;
      // let it answer before replacing a healthy saved Builder with a permanent fresh start.
      if (check?.checking) return { kind: "none", waiting: `Checking ${this.toolName(own.toolId)} before the Builder returns` };
      if (candidates.profiles.some((profile) => profile.id === own.profile.id) && (!checked || usable.includes(own.toolId))) {
        const ready = candidates.tools.filter((tool) => tool.status === "ready");
        if (!ready.length || ready.some((tool) => tool.id === own.toolId)) return { kind: own.profile.id === plannedId ? "planned" : "substitute", profile: own.profile };
      }
    }
    const rules = { keep: !!screen || reviewing, awayFromTools: peers, ...(made ? { awayFrom: { toolId: made.toolId, ...(made.modelId ? { modelId: made.modelId } : {}) } } : {}) };
    const choice = chooseWithRoom(candidates, planned, now, rules, room);
    if (own && room && choice.kind !== "none" && !room(choice.profile.toolId)) {
      // A returning Builder must not get stuck on a full planned tool that recovered since
      // its last handoff. Try tools with seats; if none can work, keep the normal wait.
      const ready = candidates.tools.filter((tool) => tool.status === "ready");
      const seated = (ready.length ? ready : candidates.tools).filter((tool) => room(tool.id));
      if (seated.length) {
        const available = { ...candidates, tools: seated.map((tool) => ({ ...tool, status: "ready" as const })), profiles: candidates.profiles.filter((profile) => seated.some((tool) => tool.id === profile.toolId)) };
        const next = chooseWithRoom(available, planned, now, rules, room);
        if (next.kind !== "none") return next;
      }
    }
    return choice;
  }

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
  recordUsage(info: UsageInfo): void {
    const now = Date.now();
    const report = { ...info, at: now };
    this.s.pool.usage = withReport(this.s.pool.usage, report) as MState["pool"]["usage"];
    this.tracking.usageReported(report);
    // Not when the tool goes on with usage paid beyond the plan: the window is spent, the usage line says so, and
    // the balancer prefers tools with room, but the agents keep working.
    if (info.status === "rejected" && !info.overage) {
      const until = info.resetsAt && info.resetsAt > now ? info.resetsAt : now + UNKNOWN_LIMIT_MS;
      this.s.pool.limited = withLimit(this.s.pool.limited, { toolId: info.toolId, ...(info.model ? { model: info.model } : {}), until, reason: `${this.toolName(info.toolId)}'s ${kindWords(info.kind, info.windowMinutes, info.name)} limit`, at: now }) as MState["pool"]["limited"];
      this.armLimitTimer();
    }
    this.commit();
  }

  /**
   * An agent on this tool is starting, or the engine is (no tool): refresh the account
   * usage that the installed tool can report. The read runs on its own; nothing waits for it.
   */
  readUsage(toolId?: Id, gap = 5 * 60_000): void {
    if ((toolId === undefined || toolId === "grok") && this.s.tools.some((tool) => tool.id === "grok" && tool.status === "ready")) void this.grokUsage?.refresh(gap);
    if ((toolId === undefined || toolId === "antigravity") && this.s.tools.some((tool) => tool.id === "antigravity" && tool.status === "ready")) void this.antigravityUsage?.refresh(gap);
    if (toolId !== undefined && toolId !== "codex") return;
    if (!this.s.tools.some((tool) => tool.id === "codex" && tool.status === "ready")) return;
    void this.codexUsage?.refresh();
  }

  /** A turn ended because its tool ran out: who is out and until when is kept, and the task's timeline says so. */
  recordLimit(task: MTask, roleId: Id, profileId: Id, error: UsageLimited): void {
    this.tracking.limitHit(task, roleId, profileId, error);
    this.s.pool.limited = withLimit(this.s.pool.limited, { toolId: error.toolId, ...(error.model ? { model: error.model } : {}), ...(error.retry ? { retry: true } : {}), until: error.until, reason: error.reason, at: Date.now() }) as MState["pool"]["limited"];
    const outcome = error.retry ? `could not continue (${error.reason}); retry after ${untilWords(error.until, Date.now())}` : `ran out of usage (${error.reason}), until ${untilWords(error.until, Date.now())}`;
    this.log(task, "warn", `${this.role(roleId)?.name ?? roleId} on ${this.named(profileId)} ${outcome}`, roleId, profileId);
    this.armLimitTimer();
    this.commitNow();
  }

  /** Limits whose time has passed are dropped. True when any was. */
  expireLimits(): boolean {
    const before = this.s.pool.limited?.length ?? 0;
    if (!before) return false;
    const now = Date.now();
    const kept = this.s.pool.limited!.filter((limit) => limit.until > now);
    if (kept.length === before) return false;
    if (kept.length) this.s.pool.limited = kept;
    else delete this.s.pool.limited;
    return true;
  }

  /** The scheduler runs again when the first limit in force ends: tasks waiting for usage start by themselves. */
  armLimitTimer(): void {
    clearTimeout(this.limitTimer);
    this.limitTimer = undefined;
    const at = nextExpiry(this.s.pool, Date.now());
    if (at === undefined || this.stopped) return;
    this.limitTimer = setTimeout(() => {
      this.limitTimer = undefined;
      if (!this.stopped) this.schedule();
    }, Math.min(at - Date.now() + 50, 2 ** 31 - 1));
  }

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

  say(target: MTask | RepositoryContext, from: Task["session"][number]["from"], text: string, roleId?: Id, profileId?: Id): void {
    const scope = executionOf(target);
    const { task, work: repository } = scope;
    const last = task.session.at(-1);
    if (from === "activity" && last?.from === "activity" && last.text === text) return;
    const step = stepTag(task);
    task.session.push({ ...(task.repositories ? { productId: repository.productId } : {}), id: this.id(task.id), at: Date.now(), from, text, ...(roleId ? { roleId } : {}), ...(profileId ? { profileId } : {}), ...(step ? { step } : {}) });
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
    this.changed(target);
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
    this.changed(target);
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
    this.changed(target);
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
    for (const task of this.streamedTasks) if (this.task(task.id) === task) this.changed(task);
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
    const revision = this.store.history.info().revision;
    const retired = this.retiredTasks();
    const complete = all || this.allTasksDirty;
    const changedArchive = [...this.archiveCache.values()].filter((task) => complete || this.dirtyTasks.has(task.id));
    this.store.save(this.activeState(), retired, changedArchive as Task[], complete ? undefined : [...this.dirtyTasks]);
    this.allTasksDirty = false;
    this.dirtyTasks.clear();
    const ids = new Set(retired);
    this.s.tasks = this.s.tasks.filter((task) => !ids.has(task.id));
    for (const id of ids) this.taskRevisions.delete(id);
    if (!this.stopped && (streamed || this.store.history.info().revision !== revision)) for (const listener of this.listeners) listener();
  }
}
