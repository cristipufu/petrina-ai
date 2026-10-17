// The engine's shared state and the few operations every part of it uses: lookups, the timeline and
// session, the inbox, and saving. Feature modules get this, never the Engine itself.

import { randomBytes } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BUILT_IN_ROLES, callCheckBody, chooseProfile, nextExpiry, queueOf, untilWords, withLimit, withReport, type Choice, TAKE_OVER_WORDS, type AgentProfile, type Column, type GateKind, type Id, type InboxItem, type InboxKind, type RiskLevel, type Role, type Stage, type State, type StepNote, type Task, type Tone, columnOf, gateStatus, gateTitle, type DeepMutable } from "@petrina/core";
import { AgentRun } from "./acp-run.js";
import * as git from "./git.js";
import { Store } from "./store.js";
import { detectTerminals, type FoundTerminal, thisMachine } from "./terminal.js";
import { ADAPTERS, detectTools, ENGINE_PROFILES } from "./tools.js";
import type { UsageInfo, UsageLimited } from "./usage.js";

export type MState = DeepMutable<State>;

export type MTask = DeepMutable<Task>;

export type MStage = DeepMutable<Stage>;

/** Roles that judge others' work: their tools were chosen for independence, so near a limit they are not swapped. */
const REVIEWING = new Set(["code-reviewer", "security-reviewer", "verifier", "design-reviewer"]);

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
    move(task.conversation);
    move(task.driving);
    for (const lesson of task.lessons ?? []) move(lesson);
    for (const entry of task.timeline) move(entry);
    for (const line of task.session) move(line);
  }
  for (const item of state.inbox) move(item);
}

export const TONES: readonly Tone[] = ["blue", "green", "orange", "violet", "pink", "teal", "indigo", "purple", "amber", "slate"];

export const MAX_SESSION_LINES = 800;

export const MAX_TIMELINE = 400;

export interface EngineOptions {
  /** Tests: run a fake agent instead of the tool's adapter. */
  agentCommand?: (profile: AgentProfile) => readonly string[] | undefined;
  /** Tests: a fake GitHub instead of `gh`. */
  gh?: readonly string[];
  /** Tests: a folder standing in for every product's copy on GitHub. Never from settings or saved data. */
  remote?: string;
  /** Tests: how long a tool gets to reopen a conversation. */
  reopenTimeoutMs?: number;
  /** Tests: how long a tool gets to start a fresh conversation. */
  startTimeoutMs?: number;
  /** Tests: the tool's own app that a take-over opens, instead of the one on PATH. */
  toolPath?: (toolId: Id) => string | undefined;
  /** Tests: the terminals on this machine. */
  terminals?: () => FoundTerminal[];
  /** Tests: how long one of a product's checks may run. */
  /** How many tasks' checks run at the same time on this machine (default: one per six cores, at least one). */
  checkRuns?: number;
  checkTimeoutMs?: number;
}

export class Aborted extends Error {}

export const RISK_WORD: Record<RiskLevel, string> = { low: "Low", medium: "Medium", high: "High" };

/** What the delivery check says beside the work: its risk, and what Petrina's own run of the checks found. */
function deliveryLines(task: Task): string | undefined {
  const lines = [task.risk ? `${RISK_WORD[task.risk.level]} risk: ${task.risk.why}` : "", checksLine(task) ?? ""].filter(Boolean);
  return lines.length ? lines.join("\n") : undefined;
}

/** One plain line for the delivery check: what Petrina's own run of the checks found. */
export function checksLine(task: Task): string | undefined {
  const runs = task.checks?.results;
  if (!runs?.length) return undefined;
  const failed = runs.filter((run) => !run.ok);
  return failed.length
    ? `Petrina's checks: ${failed.length} of ${runs.length} failed (${failed.map((run) => run.name).join(", ")}).`
    : `Petrina's checks: all ${runs.length} passed (${runs.map((run) => run.name).join(", ")}).`;
}

export abstract class Kernel {
  /** Set by the Engine: what starts drivers and fills free slots. */
  abstract schedule(): void;
  abstract startDriver(taskId: Id, resume?: boolean): void;

  constructor(
    readonly dataDir: string,
    readonly options: EngineOptions = {},
  ) {
    this.store = new Store(join(dataDir, "petrina.db"));
    const loaded = this.store.load();
    this.s = (loaded ?? this.empty()) as MState;
    if (loaded) renameRoles(this.s);
    this.s.roles = BUILT_IN_ROLES as MState["roles"];
    this.s.profiles = ENGINE_PROFILES as MState["profiles"];
    // Tests stand in the tools' own apps: those count as installed.
    this.s.tools = detectTools().map((tool) => (options.toolPath?.(tool.id) ? { ...tool, status: "ready" as const } : tool)) as MState["tools"];
    this.found = options.terminals?.() ?? detectTerminals(this.machine);
    this.s.terminals = this.found.map(({ id, name }) => ({ id, name }));
  }

  readonly s: MState;

  readonly store: Store;

  readonly listeners = new Set<() => void>();

  readonly drivers = new Map<Id, AbortController>();

  readonly runs = new Map<Id, AgentRun>();

  /** Agents working beside a task's main one on the same step (reviewers hunting at once, voters). */
  readonly helperRuns = new Map<Id, Set<AgentRun>>();

  readonly waiting = new Map<Id, { resolve: (value: string) => void; reject: (error: Error) => void }>();

  saveTimer: ReturnType<typeof setTimeout> | undefined;

  /** Wakes the scheduler when the first usage limit in force ends. */
  limitTimer: ReturnType<typeof setTimeout> | undefined;

  readonly timers: ReturnType<typeof setInterval>[] = [];

  stopped = false;

  /** This run of the engine, to tell a restart from a pause. */
  readonly boot = randomBytes(6).toString("hex");

  /** Each driver until it has fully stopped, clean-up included. */
  readonly settling = new Map<Id, Promise<void>>();

  /** Tasks Petrina is taking over, opening a terminal for again, or handing back right now. */
  readonly switching = new Map<Id, keyof typeof TAKE_OVER_WORDS.busy>();

  readonly machine = thisMachine();

  /** The terminals on this machine, the usual one first. */
  readonly found: FoundTerminal[];

  getState = (): State => this.s as unknown as State;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The tasks this one still waits for. */
  blockers(task: MTask): MTask[] {
    return (task.after ?? []).map((id) => this.task(id)).filter((other): other is MTask => !!other && other.state !== "done" && other.state !== "cancelled");
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

  gate(task: MTask, gate: GateKind): void {
    delete task.agent;
    task.holdsSlot = false;
    const body = gate === "design" ? callCheckBody(task as unknown as Task) : gate === "delivery" ? deliveryLines(task as unknown as Task) : undefined;
    this.raise(task, gate, gateTitle(task as unknown as Task, gate), false, body ? { body } : {});
    task.statusLine = gateStatus(task as unknown as Task, gate);
    task.column = gate === "plan" ? "planning" : gate === "design" ? "designing" : "ready";
    // On disk before the window shows it: an answer to this check must find it after any restart.
    this.commitNow();
  }

  /** `by`: the agent asking, when it is not the task's main one (a reviewer working beside others). */
  raise(task: MTask, kind: InboxKind, title: string, blocking: boolean, extra: { body?: string; options?: string[]; detail?: string } = {}, by: { roleId: Id; profileId: Id } | undefined = task.agent): Id {
    const id = this.id("inbox");
    task.state = "needs-you";
    this.s.inbox.push({
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
    });
    return id;
  }

  fail(taskId: Id, error: unknown): void {
    const task = this.task(taskId);
    if (!task) return;
    this.stopHelpers(taskId);
    delete task.helpers;
    const message = error instanceof Error ? error.message : String(error);
    delete task.agent;
    delete task.conversation;
    task.holdsSlot = false;
    task.state = "failed";
    task.error = message;
    task.statusLine = "Stuck. Needs you";
    this.dropBlockingItems(taskId);
    this.raise(task, "stuck", `“${task.title}” is stuck`, false, { body: message.slice(0, 600) });
    task.state = "failed";
    this.log(task, "warn", `Stuck: ${message.slice(0, 300)}`);
    this.commit();
  }

  remember(task: MTask, text: string, id?: Id): void {
    task.notes = [...(task.notes ?? []), { at: Date.now(), text, ...(id ? { id } : {}) }];
  }

  /** Keep what the coordinator said for the current step, until the step finishes. */
  stepNote(task: MTask, kind: StepNote["kind"], text: string, extra: { id?: Id; about?: string } = {}): void {
    task.stepNotes = [...(task.stepNotes ?? []), { id: extra.id ?? this.id(task.id), at: Date.now(), kind, text, ...(extra.about ? { about: extra.about } : {}) }];
  }

  /** The step handed back its result: the next step starts clean, in a new conversation. */
  finishStep(task: MTask): void {
    delete task.stepNotes;
    delete task.stepAttempts;
    delete task.conversation;
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
    task.state = task.holdsSlot ? "running" : "waiting";
    task.statusLine = task.holdsSlot ? "Back to work" : "Waiting for a free slot";
  }

  takeItem(itemId: Id): DeepMutable<InboxItem> | undefined {
    const item = this.s.inbox.find((entry) => entry.id === itemId);
    if (item) this.s.inbox = this.s.inbox.filter((entry) => entry.id !== itemId);
    return item;
  }

  dropBlockingItems(taskId: Id): void {
    for (const item of this.s.inbox.filter((entry) => entry.taskId === taskId && entry.blocking)) {
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
  }

  async undoReadOnly(task: MTask, roleId: Id): Promise<void> {
    const role = this.role(roleId);
    if (role && !role.canEdit && task.worktree && !(await git.isClean(task.worktree))) {
      await git.discardChanges(task.worktree);
      this.log(task, "warn", `Undid changes from ${role.name}, which is read-only`);
    }
  }

  columnFor(task: MTask): Column {
    return columnOf(task as unknown as Task, this.s.roles as Role[]);
  }

  empty(): State {
    return { now: Date.now(), seq: 0, products: [], roles: BUILT_IN_ROLES, tools: [], profiles: ENGINE_PROFILES, tasks: [], inbox: [], pool: { limit: 3, paused: false, toolCaps: { "claude-code": 3, codex: 3 } } };
  }

  renumberQueue(): void {
    queueOf(this.s.tasks as Task[]).forEach((task, position) => {
      const entry = this.task(task.id);
      if (entry) entry.priority = position;
    });
  }

  task(id: Id): MTask | undefined {
    return this.s.tasks.find((task) => task.id === id);
  }

  productOf(task: MTask) {
    return this.s.products.find((product) => product.id === task.productId);
  }

  role(id: Id): Role | undefined {
    return this.s.roles.find((role) => role.id === id) as Role | undefined;
  }

  profile(id: Id): AgentProfile | undefined {
    return this.s.profiles.find((profile) => profile.id === id) as AgentProfile | undefined;
  }

  /** Who works a step planned for this profile right now: the planned one, or a stand-in while its tool or model is out of usage. */
  choose(plannedId: Id, task?: MTask, roleId?: Id): Choice | undefined {
    const planned = this.profile(plannedId);
    if (!planned) return undefined;
    // Reviews keep the tools they were planned on, and a security review's stand-in stays as far from the builder as it can.
    const builder = task?.plan?.stages.find((stage) => stage.roleId === "builder")?.profileIds[0];
    const made = roleId === "security-reviewer" && builder ? this.profile(builder) : undefined;
    return chooseProfile(this.getState(), planned, Date.now(), { keep: roleId !== undefined && REVIEWING.has(roleId), ...(made ? { awayFrom: { toolId: made.toolId, ...(made.modelId ? { modelId: made.modelId } : {}) } } : {}) });
  }

  /** "Claude Code · Opus 5.5": the tool and model of a profile, for the timeline. */
  named(profileId: Id): string {
    const profile = this.profile(profileId);
    return `${this.toolName(profile?.toolId)} · ${profile?.model}`;
  }

  private toolName(toolId: Id | undefined): string {
    return this.s.tools.find((tool) => tool.id === toolId)?.name ?? ADAPTERS[toolId ?? ""]?.name ?? toolId ?? "the tool";
  }

  /** A tool said how much of a limit is used: kept as the latest for that tool and kind of limit. */
  recordUsage(info: UsageInfo): void {
    this.s.pool.usage = withReport(this.s.pool.usage, { ...info, at: Date.now() }) as MState["pool"]["usage"];
    this.commit();
  }

  /** A turn ended because its tool ran out: who is out and until when is kept, and the task's timeline says so. */
  recordLimit(task: MTask, roleId: Id, profileId: Id, error: UsageLimited): void {
    this.s.pool.limited = withLimit(this.s.pool.limited, { toolId: error.toolId, ...(error.model ? { model: error.model } : {}), until: error.until, reason: error.reason }) as MState["pool"]["limited"];
    this.log(task, "warn", `${this.role(roleId)?.name ?? roleId} on ${this.named(profileId)} ran out of usage (${error.reason}), until ${untilWords(error.until, Date.now())}`, roleId, profileId);
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

  log(task: MTask, tone: Task["timeline"][number]["tone"], text: string, roleId?: Id, profileId?: Id): void {
    task.timeline.push({ id: this.id(task.id), at: Date.now(), text, tone, ...(roleId ? { roleId } : {}), ...(profileId ? { profileId } : {}) });
    if (task.timeline.length > MAX_TIMELINE) task.timeline.splice(0, task.timeline.length - MAX_TIMELINE);
  }

  say(task: MTask, from: Task["session"][number]["from"], text: string, roleId?: Id, profileId?: Id): void {
    const last = task.session.at(-1);
    if (from === "activity" && last?.from === "activity" && last.text === text) return;
    task.session.push({ id: this.id(task.id), at: Date.now(), from, text, ...(roleId ? { roleId } : {}), ...(profileId ? { profileId } : {}) });
    if (task.session.length > MAX_SESSION_LINES) task.session.splice(0, task.session.length - MAX_SESSION_LINES);
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

  commit(): void {
    if (this.stopped) return;
    this.s.now = Date.now();
    for (const listener of this.listeners) listener();
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = undefined;
        if (!this.stopped) this.store.save(this.getState());
      }, 400);
    }
  }

  /** Commit and save right away: what the coordinator said survives a forced kill a moment later. */
  commitNow(): void {
    if (this.stopped) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.store.save(this.getState());
    this.s.now = Date.now();
    for (const listener of this.listeners) listener();
  }
}
