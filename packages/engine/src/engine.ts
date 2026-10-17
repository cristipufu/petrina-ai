// The real engine: the same state the UI renders, driven by real agents over ACP.
// Each task runs as one async driver while it holds a pool slot. Gates and the queue
// live in state; questions and permissions wait on the coordinator in code.
// Three rules make restarts safe: what the coordinator says during a step is on disk before any
// agent sees it, and kept until the step finishes; each step's conversation is noted the moment it
// opens, so its agent picks it up after a restart; and shipping is never repeated blindly.

import { randomBytes } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  answerByCall,
  BUILT_IN_ROLES,
  CALL_WORDS,
  callCheckBody,
  callOn,
  deliveryStages,
  designStageIndex,
  dueAnswers,
  findingCount,
  followingCall,
  pickStarts,
  productHistory,
  productName,
  queueOf,
  queueNeighbour,
  queuePlacement,
  slotWait,
  slotUses,
  startCall,
  suggestProductName,
  TAKE_OVER_TOOLS,
  TAKE_OVER_WORDS,
  takeOverBlock,
  toolName,
  unanswered,
  validateProductSettings,
  type AgentProfile,
  type CallAnswer,
  type Candidate,
  type Column,
  type DeliveryMode,
  type DesignCall,
  type Finding,
  type GateKind,
  type HandBackPreview,
  type Id,
  type InboxItem,
  type InboxKind,
  type Launched,
  type Product,
  type GuideLine,
  type ProductCheck,
  type RiskLevel,
  type ProductSettings,
  type Role,
  type Stage,
  type State,
  type StepNote,
  type Task,
  type TaskKind,
  type Tone,
} from "@petrina/core";
import type { z } from "zod";
import { AgentRun, ReopenFailed, type PermissionInfo } from "./acp-run.js";
import * as git from "./git.js";
import { agentEnv } from "./env.js";
import {
  BriefResult,
  BuildResult,
  CheckFinderResult,
  GuideResult,
  VerifyResult,
  buildPrompt,
  EARLIER_ATTEMPT,
  formatFindings,
  formatObjections,
  formatHandBack,
  formatStepNotes,
  formatWhereYouWere,
  HANDED_BACK,
  handBackNote,
  handBackPrompt,
  MAX_DONE,
  NotesResult,
  ObjectionsResult,
  parseResult,
  PlanResult,
  proseOf,
  repairPrompt,
  restartPrompt,
  ReviewResult,
  ShipResult,
  TestResult,
  WHERE_YOU_WERE,
  type WhereYouWere,
} from "./prompts.js";
import { Store } from "./store.js";
import { askMode, clearEnded, detectTerminals, type FoundTerminal, launchPlan, type LaunchInput, openTerminal, pickTerminal, removeLauncher, sessionState, thisMachine, writeLauncher } from "./terminal.js";
import { ADAPTERS, detectTools, ENGINE_PROFILES } from "./tools.js";
import { checksFingerprint, commandText, detectChecks, parseCommand, runChecks } from "./checks.js";
import { appendToGuide, cleanPoint, GUIDE_FILE, guideText, inGuide, localGuide } from "./guide.js";

type DeepMutable<T> = T extends readonly (infer U)[] ? DeepMutable<U>[] : T extends object ? { -readonly [K in keyof T]: DeepMutable<T[K]> } : T;
type MState = DeepMutable<State>;
type MTask = DeepMutable<Task>;
type MStage = DeepMutable<Stage>;

const PLANNER_PROFILE = "opus-high";
const SHIPPER_PROFILE = "opus-high";
const CHECK_FINDER_PROFILE = "opus-high";
const GUIDE_KEEPER_PROFILE = "opus-high";
const TONES: readonly Tone[] = ["blue", "green", "orange", "violet", "pink", "teal", "indigo", "purple", "amber", "slate"];
const MAX_SESSION_LINES = 800;
const MAX_TIMELINE = 400;
/** How far before shipping started a release still counts, for clocks that disagree. */
const CLOCK_SLACK_MS = 10 * 60_000;

export interface NewTaskInput {
  productId: Id;
  title: string;
  description?: string;
  kind?: TaskKind;
  position?: "top" | "bottom";
  approvePlan?: boolean;
  delivery?: DeliveryMode;
  approveDelivery?: boolean;
}

export interface EngineOptions {
  /** Tests: run a fake agent instead of the tool's adapter. */
  agentCommand?: (profile: AgentProfile) => readonly string[] | undefined;
  /** Tests: a fake GitHub instead of `gh`. */
  gh?: readonly string[];
  /** Tests: how long a tool gets to reopen a conversation. */
  reopenTimeoutMs?: number;
  /** Tests: the tool's own app that a take-over opens, instead of the one on PATH. */
  toolPath?: (toolId: Id) => string | undefined;
  /** Tests: the terminals on this machine. */
  terminals?: () => FoundTerminal[];
  /** Tests: how long one of a product's checks may run. */
  checkTimeoutMs?: number;
}

/** What the window adds to an answer, so it still counts when the question is gone (a restart dropped it). */
export interface SaidContext {
  taskId?: Id;
  /** The question, or what a "No" refused. */
  about?: string;
  /** The window's id for what it sent: a resend after a lost confirmation counts once. */
  clientId?: Id;
}

type Delivery = { found: true; text: string; record: () => void } | { found: false; text: string };

class Aborted extends Error {}

export class Engine {
  private readonly s: MState;
  private readonly store: Store;
  private readonly listeners = new Set<() => void>();
  private readonly drivers = new Map<Id, AbortController>();
  private readonly runs = new Map<Id, AgentRun>();
  private readonly waiting = new Map<Id, { resolve: (value: string) => void; reject: (error: Error) => void }>();
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private stopped = false;
  /** This run of the engine, to tell a restart from a pause. */
  private readonly boot = randomBytes(6).toString("hex");
  /** Each driver until it has fully stopped, clean-up included. */
  private readonly settling = new Map<Id, Promise<void>>();
  /** Tasks Petrina is taking over, opening a terminal for again, or handing back right now. */
  private readonly switching = new Map<Id, keyof typeof TAKE_OVER_WORDS.busy>();
  private readonly machine = thisMachine();
  /** The terminals on this machine, the usual one first. */
  private readonly found: FoundTerminal[];

  constructor(
    private readonly dataDir: string,
    private readonly options: EngineOptions = {},
  ) {
    this.store = new Store(join(dataDir, "petrina.db"));
    const loaded = this.store.load();
    this.s = (loaded ?? this.empty()) as MState;
    this.s.roles = BUILT_IN_ROLES as MState["roles"];
    this.s.profiles = ENGINE_PROFILES as MState["profiles"];
    // Tests stand in the tools' own apps: those count as installed.
    this.s.tools = detectTools().map((tool) => (options.toolPath?.(tool.id) ? { ...tool, status: "ready" as const } : tool)) as MState["tools"];
    this.found = options.terminals?.() ?? detectTerminals(this.machine);
    this.s.terminals = this.found.map(({ id, name }) => ({ id, name }));
    this.recover();
    this.timers.push(setInterval(() => void this.pollPullRequests(), 60_000));
    this.schedule();
  }

  getState = (): State => this.s as unknown as State;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Stop every agent the way pausing does, save, and close. Their tasks continue on the next start. */
  shutdown(): void {
    if (this.stopped) return;
    // Stopped first: stopping agents still changes state, and nothing may save after the store closes.
    this.stopped = true;
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    for (const timer of this.timers) clearInterval(timer);
    for (const controller of this.drivers.values()) controller.abort();
    for (const run of this.runs.values()) run.close();
    this.store.save(this.getState());
    this.store.close();
  }

  // ── Products ───────────────────────────────────────────────────────────

  async addProduct(path: string, name?: string): Promise<Id> {
    const info = await git.repoInfo(path);
    const existing = this.s.products.find((product) => product.path === info.root);
    if (existing) return existing.id;
    const displayName = productName(name ?? suggestProductName(info.root), this.s.products);
    const base = info.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "product";
    let id = base;
    for (let n = 2; this.s.products.some((product) => product.id === id); n += 1) id = `${base}-${n}`;
    this.s.products.push({
      id,
      name: displayName,
      repo: `${info.owner}/${info.name}`,
      tone: TONES[this.s.products.length % TONES.length]!,
      path: info.root,
      defaultBranch: info.defaultBranch,
      delivery: "pull-request",
      approveDelivery: true,
    });
    this.commit();
    return id;
  }

  setProductDelivery(productId: Id, delivery: DeliveryMode, approveDelivery: boolean): void {
    const product = this.s.products.find((entry) => entry.id === productId);
    if (!product) return;
    this.updateProduct(productId, { name: product.name, delivery, approveDelivery });
  }

  /**
   * The coordinator sets a product's checks by hand (never replaced on its own), or clears them so
   * the Check finder looks again at the next review.
   */
  setProductChecks(productId: Id, checks: readonly { name: string; command: string }[] | null): void {
    const product = this.s.products.find((entry) => entry.id === productId);
    if (!product) throw new Error("This product is no longer in Petrina.");
    if (checks === null) {
      delete product.checks;
      delete product.checksBy;
      delete product.checksFingerprint;
    } else {
      const parsed = checks.map((check) => ({ name: check.name.trim(), argv: parseCommand(check.command) })).filter((check) => check.name && check.argv.length);
      if (!parsed.length) throw new Error("Give at least one check, as a name and a command.");
      product.checks = parsed;
      product.checksBy = "coordinator";
      delete product.checksFingerprint;
    }
    this.commit();
  }

  updateProduct(productId: Id, settings: ProductSettings): void {
    const product = this.s.products.find((entry) => entry.id === productId);
    if (!product) throw new Error("This product is no longer in Petrina.");
    const validated = validateProductSettings(settings, this.s.products, productId);
    Object.assign(product, validated);
    this.commit();
  }

  removeProduct(productId: Id): void {
    const { unfinished } = productHistory(this.s.tasks, productId);
    if (unfinished) throw new Error(`${unfinished} task${unfinished === 1 ? " must" : "s must"} finish or be cancelled before this product can be removed.`);
    const ids = new Set(this.s.tasks.filter((task) => task.productId === productId).map((task) => task.id));
    this.s.inbox = this.s.inbox.filter((item) => !ids.has(item.taskId));
    this.s.tasks = this.s.tasks.filter((task) => !ids.has(task.id));
    this.s.products = this.s.products.filter((product) => product.id !== productId);
    this.commit();
  }

  // ── Queue and pool ─────────────────────────────────────────────────────

  addTask(input: NewTaskInput): Id {
    const product = this.s.products.find((entry) => entry.id === input.productId);
    if (!product) throw new Error("Unknown product");
    const title = input.title.trim();
    if (!title) throw new Error("A task needs a title");
    const id = this.id("task");
    const queue = queueOf(this.s.tasks as Task[]);
    this.s.tasks.push({
      id,
      productId: product.id,
      title,
      description: input.description?.trim() ?? "",
      area: title.toLowerCase(),
      kind: input.kind ?? "feature",
      priority: input.position === "top" ? -1 : queue.length,
      held: false,
      state: "queued",
      column: "queue",
      holdsSlot: false,
      approvePlan: input.approvePlan ?? false,
      delivery: input.delivery ?? product.delivery ?? "pull-request",
      approveDelivery: input.approveDelivery ?? product.approveDelivery ?? true,
      stageIndex: -1,
      rounds: {},
      sub: 0,
      fixing: false,
      statusLine: "In the queue",
      createdAt: Date.now(),
      timeline: [{ id: this.id(id), at: Date.now(), text: "You added it to the queue", tone: "you" }],
      session: [],
      queued: [],
      objections: [],
      findings: [],
      prAge: 0,
    });
    this.renumberQueue();
    this.commit();
    this.schedule();
    return id;
  }

  moveInQueue(taskId: Id, index: number): void {
    const queue = queueOf(this.s.tasks as Task[]).map((task) => task.id);
    const from = queue.indexOf(taskId);
    if (from < 0) return;
    queue.splice(from, 1);
    queue.splice(Math.max(0, Math.min(queue.length, index)), 0, taskId);
    queue.forEach((id, position) => {
      const task = this.task(id);
      if (task) task.priority = position;
    });
    this.commit();
    this.schedule();
  }

  moveToTop(taskId: Id): void {
    this.moveInQueue(taskId, 0);
  }

  placeInQueue(taskId: Id, anchorId: Id, side: "before" | "after"): number {
    const queue = queueOf(this.s.tasks).map((task) => task.id);
    const index = queuePlacement(queue, taskId, anchorId, side);
    if (index === undefined) return -1;
    const hidden = Math.max(0, Math.abs(queue.indexOf(taskId) - queue.indexOf(anchorId)) - 1);
    this.moveInQueue(taskId, index);
    return hidden;
  }

  moveVisibleInQueue(taskId: Id, visibleIds: Id[], direction: -1 | 1): number {
    const queue = queueOf(this.s.tasks).map((task) => task.id);
    const anchor = queueNeighbour(queue, visibleIds, taskId, direction);
    return anchor ? this.placeInQueue(taskId, anchor, direction < 0 ? "before" : "after") : -1;
  }

  setHeld(taskId: Id, held: boolean): void {
    const task = this.task(taskId);
    if (!task) return;
    task.held = held;
    this.log(task, "you", held ? "You put it on hold" : "You released the hold");
    this.commit();
    this.schedule();
  }

  /** Start this task only after the given tasks have landed. An empty list removes the wait. */
  setAfter(taskId: Id, after: readonly Id[]): void {
    const task = this.task(taskId);
    if (!task) throw new Error("Unknown task");
    const ids = [...new Set(after)];
    for (const id of ids) {
      if (id === taskId) throw new Error("A task cannot wait for itself");
      if (!this.task(id)) throw new Error(`Unknown task: ${id}`);
    }
    // No loops: none of the tasks it waits for may (indirectly) wait for it.
    const reaches = (from: Id, seen = new Set<Id>()): boolean => {
      if (from === taskId) return true;
      if (seen.has(from)) return false;
      seen.add(from);
      return (this.task(from)?.after ?? []).some((next) => reaches(next, seen));
    };
    if (ids.some((id) => reaches(id))) throw new Error("That would make tasks wait for each other");
    task.after = ids;
    const names = ids.map((id) => `“${this.task(id)!.title}”`).join(" and ");
    this.log(task, "you", ids.length ? `It starts after ${names} land${ids.length === 1 ? "s" : ""}` : "It no longer waits for other tasks");
    this.commit();
    this.schedule();
  }

  /** The tasks this one still waits for. */
  private blockers(task: MTask): MTask[] {
    return (task.after ?? []).map((id) => this.task(id)).filter((other): other is MTask => !!other && other.state !== "done" && other.state !== "cancelled");
  }

  setPoolLimit(limit: number): void {
    this.s.pool.limit = Math.max(1, Math.min(12, Math.round(limit)));
    this.commit();
    this.schedule();
  }

  /** How many agents of one tool may run at once (keeps one subscription from being exhausted). */
  setToolCap(toolId: Id, cap: number): void {
    if (!this.s.tools.some((tool) => tool.id === toolId)) throw new Error("Unknown tool");
    this.s.pool.toolCaps = { ...this.s.pool.toolCaps, [toolId]: Math.max(1, Math.min(12, Math.round(cap))) };
    this.commit();
    this.schedule();
  }

  setPoolPaused(paused: boolean): void {
    this.s.pool.paused = paused;
    this.commit();
    this.schedule();
  }

  /** The terminal take-overs open in. Empty: the usual one on this machine. */
  setTerminal(terminalId: Id): void {
    if (!terminalId) delete this.s.terminal;
    else if (this.found.some((terminal) => terminal.id === terminalId)) this.s.terminal = terminalId;
    else throw new Error("That terminal is not on this machine");
    this.commit();
  }

  // ── Task control ───────────────────────────────────────────────────────

  pause(taskId: Id): void {
    const task = this.task(taskId);
    this.notDriving(task);
    if (!task || !["running", "needs-you", "waiting"].includes(task.state)) return;
    this.stopDriver(taskId);
    task.state = "paused";
    task.holdsSlot = false;
    delete task.agent;
    // Resuming starts the step fresh, with everything said in it so far.
    delete task.conversation;
    task.statusLine = "Paused by you";
    this.dropBlockingItems(taskId);
    this.log(task, "you", "You paused it");
    this.commit();
    this.schedule();
  }

  resume(taskId: Id): void {
    const task = this.task(taskId);
    if (!task || task.state !== "paused") return;
    const gate = this.s.inbox.some((item) => item.taskId === taskId && !item.blocking);
    task.state = gate ? "needs-you" : "waiting";
    task.statusLine = gate ? "Waiting for you" : "Waiting for a free slot";
    this.log(task, "you", "You resumed it");
    this.commit();
    this.schedule();
  }

  cancel(taskId: Id): void {
    const task = this.task(taskId);
    if (!task) return;
    this.notDriving(task);
    this.stopDriver(taskId);
    task.state = "cancelled";
    task.column = "done";
    task.holdsSlot = false;
    delete task.agent;
    delete task.conversation;
    task.finishedAt = Date.now();
    task.statusLine = "Cancelled";
    this.dropBlockingItems(taskId);
    this.s.inbox = this.s.inbox.filter((item) => item.taskId !== taskId);
    this.log(task, "you", "You cancelled it");
    this.commit();
    this.schedule();
  }

  /** Start a failed task again from the stage it failed in. */
  retry(itemId: Id): void {
    this.notDrivingItem(itemId);
    const item = this.s.inbox.find((entry) => entry.id === itemId);
    const task = item && this.task(item.taskId);
    if (!item || !task) return;
    this.s.inbox = this.s.inbox.filter((entry) => entry.id !== itemId);
    delete task.error;
    task.state = "waiting";
    task.statusLine = "Waiting for a free slot";
    this.log(task, "you", "You asked to try again");
    this.commit();
    this.schedule();
  }

  sendMessage(taskId: Id, text: string, mode: "queue" | "interrupt" = "queue", clientId?: Id): void {
    const task = this.task(taskId);
    const trimmed = text.trim();
    if (!task || !trimmed || !this.firstTime(task, clientId)) return;
    const message = { id: this.id(taskId), text: trimmed, at: Date.now() };
    this.remember(task, trimmed, message.id);
    const run = this.runs.get(taskId);
    const interrupt = mode === "interrupt" && run !== undefined;
    this.stepNote(task, interrupt ? "interrupt" : "message", trimmed, { id: message.id });
    if (interrupt) {
      task.queued.unshift(message);
      this.say(task, "system", "You interrupted the current step");
    } else {
      task.queued.push(message);
    }
    this.commitNow();
    if (interrupt) void run.cancel();
  }

  /** Take back a message before any agent got it. */
  removeQueued(taskId: Id, messageId: Id): void {
    const task = this.task(taskId);
    if (!task || !task.queued.some((message) => message.id === messageId)) return;
    task.queued = task.queued.filter((message) => message.id !== messageId);
    task.stepNotes = task.stepNotes?.filter((note) => note.id !== messageId);
    task.notes = task.notes?.filter((note) => note.id !== messageId);
    this.commitNow();
  }

  setStageProfile(taskId: Id, stageId: Id, list: "profileIds" | "reviewerProfileIds", index: number, profileId: Id): void {
    const task = this.task(taskId);
    const at = task?.plan?.stages.findIndex((stage) => stage.id === stageId) ?? -1;
    const stage = task?.plan?.stages[at];
    if (!task || !stage || at <= task.stageIndex || !this.profile(profileId)) return;
    const profiles = stage[list];
    if (!profiles || index < 0 || index >= profiles.length) return;
    profiles[index] = profileId;
    this.log(task, "you", `You changed who works on “${stage.title}”`);
    this.commit();
  }

  addReviewer(taskId: Id, stageId: Id, profileId: Id): void {
    const task = this.task(taskId);
    const at = task?.plan?.stages.findIndex((stage) => stage.id === stageId) ?? -1;
    const stage = task?.plan?.stages[at];
    if (!task || !stage || stage.kind !== "review-chain" || at <= task.stageIndex || !this.profile(profileId)) return;
    stage.profileIds.push(profileId);
    this.log(task, "you", `You added a reviewer to “${stage.title}”`);
    this.commit();
  }

  // ── Inbox ──────────────────────────────────────────────────────────────

  /**
   * Answer an agent's question. On disk before the agent gets it. A question asked before a restart
   * is answered the same way: its conversation hears the answer when it picks up. When the question
   * is gone (a pause dropped it before the answer arrived, or a restart did on a step with no
   * conversation to pick up), the answer still reaches the step.
   */
  answer(itemId: Id, answer: string, context: SaidContext = {}): void {
    this.notDrivingItem(itemId);
    const item = this.s.inbox.find((entry) => entry.id === itemId);
    const task = this.task(item?.taskId ?? context.taskId ?? "");
    const about = item?.title ?? context.about;
    if (!task || !this.firstTime(task, context.clientId)) return;
    if (!item && (!about || ["done", "cancelled"].includes(task.state))) return;
    this.takeItem(itemId);
    this.stepNote(task, "answer", answer, { ...(about ? { about } : {}) });
    this.say(task, "you", answer);
    this.log(task, "you", `You answered: ${answer}`);
    const asked = task.conversation?.asked;
    if (item && asked?.itemId === itemId) asked.answer = answer;
    if (item) this.unblock(task);
    else task.queued.push({ id: this.id(task.id), text: `About your question “${about}”: ${answer}`, at: Date.now() });
    this.commitNow();
    const waiter = this.waiting.get(itemId);
    this.waiting.delete(itemId);
    waiter?.resolve(answer);
    // Asked before a restart: no agent holds a slot for it, so the step waits for one.
    if (item && !waiter) this.schedule();
  }

  decideForMe(itemId: Id): void {
    const item = this.s.inbox.find((entry) => entry.id === itemId);
    if (!item) return;
    this.answer(itemId, item.options?.[0] ?? "Use your best judgment.");
  }

  allow(itemId: Id, _scope: "once" | "always" = "once"): void {
    this.notDrivingItem(itemId);
    const item = this.takeItem(itemId);
    if (!item) return;
    const task = this.task(item.taskId);
    if (task) {
      this.log(task, "you", `You allowed: ${item.title}`);
      this.unblock(task);
    }
    this.waiting.get(itemId)?.resolve("allow");
    this.waiting.delete(itemId);
    this.commit();
  }

  /** Say no to a permission. The note with it is on disk before the agent hears the "No". */
  deny(itemId: Id, note?: string, context: SaidContext = {}): void {
    this.notDrivingItem(itemId);
    const item = this.s.inbox.find((entry) => entry.id === itemId);
    const task = this.task(item?.taskId ?? context.taskId ?? "");
    const said = note?.trim();
    const about = item?.title ?? context.about;
    if (!task || !this.firstTime(task, context.clientId)) return;
    // A plain "No" to a request a restart already dropped changes nothing.
    if (!item && (!said || ["done", "cancelled"].includes(task.state))) return;
    this.takeItem(itemId);
    this.log(task, "you", said ? `You said no: ${said}` : `You said no to: ${about}`);
    if (said) {
      const id = this.id(task.id);
      this.remember(task, said, id);
      this.stepNote(task, "denied", said, { id, ...(about ? { about } : {}) });
      task.queued.push({ id, text: said, at: Date.now() });
    }
    if (item) this.unblock(task);
    this.commitNow();
    this.waiting.get(itemId)?.resolve("deny");
    this.waiting.delete(itemId);
  }

  approve(itemId: Id): void {
    this.notDrivingItem(itemId);
    const kind = this.s.inbox.find((entry) => entry.id === itemId)?.kind;
    if (kind === "stuck") {
      this.retry(itemId);
      return;
    }
    if (kind === "shipping") {
      this.checkShipping(itemId);
      return;
    }
    if (kind === "guide") {
      this.acceptGuideLine(itemId);
      return;
    }
    const item = this.takeItem(itemId);
    const task = item && this.task(item.taskId);
    if (!item || !task) return;
    switch (item.kind) {
      case "plan":
        this.log(task, "you", "You approved the plan");
        task.stageIndex = 0;
        break;
      case "design":
        this.log(task, "you", "You approved the design");
        task.stageIndex += 1;
        break;
      case "delivery":
        this.log(task, "you", "You approved the delivery");
        if (task.checkedSha) task.approvedSha = task.checkedSha;
        task.stageIndex += 1;
        break;
      case "disagreement":
        this.log(task, "you", "You sided with the architect");
        for (const objection of task.objections) {
          if (objection.status !== "open") continue;
          objection.status = "rejected";
          objection.decidedBy = "coordinator";
        }
        task.stageIndex += 1;
        break;
      default:
        return;
    }
    task.sub = 0;
    this.toWaiting(task);
    this.commit();
    this.schedule();
  }

  /** "Add it": the proposed point joins the product's review guide. Reviewers see it from their next turn. */
  private acceptGuideLine(itemId: Id): void {
    const item = this.takeItem(itemId);
    const task = item && this.task(item.taskId);
    const product = task && this.productOf(task);
    const point = cleanPoint(item?.body ?? "");
    if (!point || !task || !product) return;
    if (!product.reviewGuide?.some((line) => line.text === point)) product.reviewGuide = [...(product.reviewGuide ?? []), { text: point, at: Date.now(), fromTask: task.id }];
    this.log(task, "you", `You added to the review guide: ${point}`);
    this.commit();
  }

  /** "Not this time": the review guide stays as it is. */
  declineGuide(itemId: Id): void {
    const item = this.s.inbox.find((entry) => entry.id === itemId && entry.kind === "guide");
    if (!item) return;
    this.takeItem(itemId);
    const task = this.task(item.taskId);
    if (task) this.log(task, "you", "You left the review guide as it is");
    this.commit();
  }

  requestChanges(itemId: Id, note: string): void {
    // Refused, not dropped: the window keeps the note to send again.
    if (!this.s.inbox.some((entry) => entry.id === itemId)) throw new Error("That check isn't waiting any more, so your note wasn't applied. Send it again on the task.");
    this.notDrivingItem(itemId);
    const item = this.takeItem(itemId);
    const task = item && this.task(item.taskId);
    if (!item || !task) return;
    const stages = task.plan?.stages ?? [];
    const call = item.kind === "disagreement" ? startCall(task as unknown as Task, note, Date.now()) : undefined;
    this.log(task, "you", call ? CALL_WORDS.made(note) : `You asked for changes: ${note}`);
    this.say(task, "you", note);
    const id = this.id(task.id);
    this.remember(task, note, id);
    // The call reaches the architect in a section of its own; any other note goes to the next agent.
    if (!call) task.queued.push({ id, text: note, at: Date.now() });
    // The change request starts the next step: it is the first thing that step keeps (a call is kept on the task).
    this.finishStep(task);
    if (!call) this.stepNote(task, "changes", note, { id });
    if (call && task.plan) {
      // The call is final: the architect follows it once, then the coordinator checks the brief. No review round.
      task.plan.stages = call.stages as MStage[];
      task.stageIndex = call.stageIndex;
      task.call = call.call as MTask["call"];
    } else if (item.kind === "plan") {
      task.stageIndex = -1;
      delete task.plan;
    } else if (item.kind === "design" || item.kind === "disagreement") {
      // Back to this very check afterwards, not to an earlier one the coordinator already approved.
      if (item.kind === "design") task.returnToCheck = task.stageIndex;
      const index = designStageIndex(stages, task.stageIndex);
      if (index >= 0) {
        // On a design the call settled, changes go to the architect alone and come back to the same check.
        if (!callOn(task as unknown as Task, index)) task.rounds[stages[index]!.id] = (task.rounds[stages[index]!.id] ?? 1) + 1;
        task.stageIndex = index;
      }
    } else if (item.kind === "delivery") {
      // Every reviewer passed what the coordinator sent back: the Guide keeper looks for what they missed.
      task.miss = { note, at: Date.now() };
      const index = lastIndex(stages, (stage) => stage.roleId === "builder" && stage.kind === "do");
      if (index >= 0) {
        task.stageIndex = index;
        task.fixing = true;
      }
    }
    task.sub = 0;
    this.toWaiting(task);
    this.commitNow();
    this.schedule();
  }

  /** "Check again": look for the interrupted delivery once more. */
  checkShipping(itemId: Id): void {
    const task = this.takeShippingItem(itemId);
    if (!task) return;
    this.log(task, "you", "You asked Petrina to check again");
    this.toWaiting(task);
    this.commit();
    this.schedule();
  }

  /** "Ship it again": the shipper finishes the interrupted attempt, told what Petrina found. */
  shipAgain(itemId: Id): void {
    const task = this.takeShippingItem(itemId);
    if (!task) return;
    if (task.shipping) task.shipping.again = true;
    this.log(task, "you", "You asked to ship it again");
    this.toWaiting(task);
    this.commitNow();
    this.schedule();
  }

  /** "Mark as done": it went out another way. */
  markDone(itemId: Id): void {
    const task = this.takeShippingItem(itemId);
    if (!task) return;
    delete task.shipping;
    this.finishStep(task);
    task.state = "done";
    task.column = "done";
    task.finishedAt = Date.now();
    task.statusLine = "Marked as done by you";
    this.log(task, "you", "You marked it as done");
    this.commitNow();
    this.schedule();
  }

  // ── Take over in the coordinator's terminal ────────────────────────────

  /**
   * The coordinator drives the current step in their own terminal: the agent's own tool, on the same
   * conversation and model, in the task's working copy, in its normal mode. Petrina first checks it can
   * open a terminal (or that every value fits in a launcher), then stops the agent and waits until its
   * process has exited, clears what it had open in the inbox, saves an editing role's unfinished work as
   * that agent's commit (a read-only role's is undone, as always), and only then opens the terminal.
   * The step keeps its seat in the pool until the coordinator hands back.
   */
  async takeOver(taskId: Id, how: "open" | "copy" = "open"): Promise<Launched> {
    const task = this.task(taskId);
    if (!task) throw new Error("Unknown task");
    this.notSwitching(taskId);
    const blocked = takeOverBlock(task as unknown as Task, this.getState());
    if (blocked) throw new Error(blocked);
    const agent = { ...task.agent! };
    const conversation = task.conversation!;
    const profile = this.profile(agent.profileId)!;
    const role = this.role(agent.roleId)!;
    const terminal = how === "open" ? pickTerminal(this.found, this.s.terminal) : undefined;
    if (how === "open" && !terminal) throw new Error(TAKE_OVER_WORDS.noTerminal);

    this.switching.set(taskId, "taking over");
    try {
      const tool = await this.takeOverTool(profile.toolId);
      // Every value goes through its pattern before the agent stops, so a launcher that cannot be written never strands the step.
      launchPlan(this.launchInput(task, tool, conversation.sessionId, conversation.model, profile.effort));
      task.statusLine = "Stopping the agent so you can take over";
      this.commitNow();
      const run = this.runs.get(taskId);
      const settled = this.settling.get(taskId);
      this.stopDriver(taskId);
      // What it asked is moot now: the coordinator is in the conversation themselves.
      this.dropBlockingItems(taskId);
      await Promise.all([settled, run?.stop()]);

      const current = this.task(taskId);
      if (!current) throw new Error("The task is gone");
      if (current.conversation?.step !== conversation.step || current.conversation.sessionId !== conversation.sessionId) {
        // The step handed back its result just as the coordinator took over: the next one starts as usual.
        this.backToWork(current);
        throw new Error("The agent finished its step just as you took over. Take over again on its next step if you want to.");
      }
      const worktree = current.worktree!;
      let saved: { sha: string; files: string[] } | undefined;
      try {
        if (role.canEdit) {
          const files = (await git.changedSince(worktree, await git.head(worktree))).map((entry) => entry.file);
          const sha = files.length
            ? await git.commitAll(worktree, `${current.title} (unfinished work)\n\nThe ${role.name}'s unfinished work, saved by Petrina before the coordinator took over in their terminal. The ${role.name} finishes it after the hand back.\n\nSaved by Petrina: ${this.describe(role.id, profile.id)}`)
            : undefined;
          if (sha) saved = { sha, files };
        } else {
          await this.undoReadOnly(current, role.id);
        }
        current.driving = { since: Date.now(), roleId: role.id, profileId: profile.id, toolId: profile.toolId, head: await git.head(worktree), ...(saved ? { saved } : {}) };
      } catch (error) {
        // The agent has stopped, but the working copy is not ready for the coordinator: the agent carries on instead.
        this.log(current, "warn", `Could not get the working copy ready for you, so the ${role.name} carries on: ${error instanceof Error ? error.message : String(error)}`, role.id, profile.id);
        this.backToWork(current);
        throw new Error(`Petrina couldn't save the ${role.name}'s work before you took over, so the ${role.name} carries on. ${error instanceof Error ? error.message : String(error)}`);
      }
      delete current.conversation.asked;
      current.agent = agent as MTask["agent"];
      current.holdsSlot = true;
      current.statusLine = TAKE_OVER_WORDS.status;
      this.raise(current, "driving", `Hand back “${current.title}” when you're done`, false, {
        body: `${tool.name} is open in your terminal on the ${role.name}'s conversation. Close it there, then hand back: the ${role.name} carries on from what you did.`,
      });
      if (saved) this.log(current, "milestone", `Saved the ${role.name}'s unfinished work as one commit (${saved.files.length} file${saved.files.length === 1 ? "" : "s"})`, role.id, profile.id);
      this.log(current, "you", `You took over the ${role.name} in your terminal`, role.id, profile.id);
      this.say(current, "system", `You took over in your terminal · ${tool.name} on the ${role.name}'s conversation`, role.id, profile.id);
      this.commitNow();
      return await this.launch(current, terminal, true, tool);
    } finally {
      this.switching.delete(taskId);
    }
  }

  /** The agent stopped for a take-over that did not happen: the step starts again as usual, picking its conversation back up. */
  private backToWork(task: MTask): void {
    delete task.agent;
    task.holdsSlot = false;
    this.toWaiting(task);
    this.commitNow();
    this.schedule();
  }

  /**
   * Open the terminal again, or get the command again. Never a second copy: refused while one runs, and
   * while Petrina is still opening one or handing back.
   */
  async reopenTerminal(taskId: Id, how: "open" | "copy" = "open"): Promise<Launched> {
    const task = this.task(taskId);
    if (!task?.driving) throw new Error("You're not driving this task");
    this.notSwitching(taskId);
    const terminal = how === "open" ? pickTerminal(this.found, this.s.terminal) : undefined;
    if (how === "open" && !terminal) throw new Error(TAKE_OVER_WORDS.noTerminal);
    this.switching.set(taskId, "reopening");
    try {
      const tool = toolName(task.driving.toolId);
      if ((await sessionState(this.takeOverDir(taskId), this.machine.platform)) === "running") throw new Error(TAKE_OVER_WORDS.alreadyOpen(tool));
      if (!task.driving) throw new Error("You're not driving this task");
      return await this.launch(task, terminal, false);
    } finally {
      this.switching.delete(taskId);
    }
  }

  /** What hand back would find: whether the tool is still open, the branch, and what changed since the take-over. */
  async handBackPreview(taskId: Id): Promise<HandBackPreview> {
    const task = this.task(taskId);
    if (!task?.driving) throw new Error("You're not driving this task");
    const driving = task.driving;
    const worktree = task.worktree!;
    const [open, where, files, commits, clean] = await Promise.all([
      sessionState(this.takeOverDir(taskId), this.machine.platform),
      git.workingState(worktree),
      git.changedSince(worktree, driving.head),
      git.commitsSince(worktree, driving.head),
      git.isClean(worktree),
    ]);
    const problem = this.branchProblem(task, where);
    return {
      open,
      tool: toolName(driving.toolId),
      ...(problem ? { problem } : {}),
      commits,
      files: files.length,
      names: files.slice(0, 5).map((entry) => entry.file),
      unsaved: !clean,
      ...(driving.saved ? { saved: { files: driving.saved.files.length, names: driving.saved.files.slice(0, 3) } } : {}),
    };
  }

  /**
   * The coordinator closed the tool and hands the step back. Refused while Petrina can see the tool
   * running ("anyway" only counts when it cannot tell), or when the working copy left the task's branch.
   * What they left unsaved becomes one commit marked as theirs, never undone. The note of what changed
   * goes into the session, the timeline and the task's notes. If files changed, the tests check runs at
   * once and nothing ships before a review chain has looked at them. Then the same agent carries on with
   * the same step, on the same conversation when its tool can reopen it.
   */
  async handBack(taskId: Id, note = "", anyway = false): Promise<void> {
    const task = this.task(taskId);
    if (!task?.driving) throw new Error("You're not driving this task");
    this.notSwitching(taskId);
    this.switching.set(taskId, "handing back");
    try {
      const driving = task.driving;
      const tool = toolName(driving.toolId);
      const dir = this.takeOverDir(taskId);
      const open = await sessionState(dir, this.machine.platform);
      if (open === "running") throw new Error(TAKE_OVER_WORDS.stillOpen(tool));
      if (open === "unknown" && !anyway) throw new Error(TAKE_OVER_WORDS.cannotTell(tool));
      const worktree = task.worktree!;
      const problem = this.branchProblem(task, await git.workingState(worktree));
      if (problem) throw new Error(problem);
      const role = this.role(driving.roleId)!;
      const [commits, files, clean] = await Promise.all([git.commitsSince(worktree, driving.head), git.changedSince(worktree, driving.head), git.isClean(worktree)]);
      const leftovers = clean
        ? undefined
        : await git.commitAll(worktree, `${task.title} (changes made by hand)\n\nMade by the coordinator in their own terminal while driving the ${role.name}, and saved by Petrina at the hand back.\n\nDriven by hand: ${this.describe(role.id, driving.profileId)}`);
      const text = handBackNote({ role: role.name, tool, took: Date.now() - driving.since, ...(driving.saved ? { saved: driving.saved.files } : {}), commits, files, leftovers: leftovers !== undefined, note });
      const head = await git.head(worktree);

      this.say(task, "system", `You handed back to the ${role.name}`, role.id, driving.profileId);
      this.say(task, "you", text);
      const changed = files.length ? `${files.length} file${files.length === 1 ? "" : "s"} changed in ${commits + (leftovers ? 1 : 0)} commit${commits + (leftovers ? 1 : 0) === 1 ? "" : "s"}` : "nothing changed";
      this.log(task, "you", `You handed back to the ${role.name}: ${changed}${note.trim() ? `. Your note: ${note.trim()}` : ""}`, role.id, driving.profileId);
      this.remember(task, text);
      // The conversation carries on from here, and a read-only role's clean-up keeps everything done by hand.
      if (task.conversation) {
        task.conversation.head = head;
        task.conversation.handback = text;
      }
      if (files.length) await this.reviewHandChanges(task);
      delete task.driving;
      this.s.inbox = this.s.inbox.filter((item) => !(item.taskId === taskId && item.kind === "driving"));
      await removeLauncher(dir);
      task.state = "running";
      task.holdsSlot = true;
      task.statusLine = `${role.name} is getting back to work`;
      this.commitNow();
      // It still has its seat: the same agent carries on right away, whatever the pool is doing.
      this.startDriver(taskId, true);
    } finally {
      this.switching.delete(taskId);
    }
  }

  /**
   * Files changed by hand: the tests check on the whole branch right away, and nothing ships until a
   * review chain has looked at them from its first reviewer. A chain still ahead does that as planned.
   * Otherwise the chain the coordinator drove in, or the last one behind, runs again once the step
   * they drove finishes, without using up a review round.
   */
  private async reviewHandChanges(task: MTask): Promise<void> {
    const problems = await git.tamperCheck(task.worktree!, task.base!);
    for (const problem of problems) {
      if (!task.findings.some((finding) => finding.text === problem && finding.status === "open")) {
        task.findings.push({ id: this.id(task.id), text: problem, severity: "blocking", raisedBy: "petrina", confirmedBy: [], status: "open" });
      }
    }
    this.log(task, problems.length ? "warn" : "done", problems.length ? `Tests check on your changes: ${problems.length} problem${problems.length === 1 ? "" : "s"}` : "Tests check on your changes passed: no tests removed or skipped");
    task.handChanges = true;
    const stages = task.plan?.stages ?? [];
    if (stages.some((stage, index) => index > task.stageIndex && stage.kind === "review-chain")) return;
    const chain = stages[task.stageIndex]?.kind === "review-chain" ? task.stageIndex : lastIndex(stages, (stage, index) => index < task.stageIndex && stage.kind === "review-chain");
    if (chain >= 0) task.rereview = stages[chain]!.id;
  }

  /** The step the coordinator drove finished: its review chain runs again from the first reviewer, without using up a round. */
  private rerun(task: MTask): boolean {
    const id = task.rereview;
    if (!id) return false;
    delete task.rereview;
    const index = task.plan?.stages.findIndex((stage) => stage.id === id) ?? -1;
    if (index < 0) return false;
    task.stageIndex = index;
    task.sub = 0;
    task.fixing = false;
    this.log(task, "milestone", "Reviewing your changes: the review starts again from the first reviewer");
    this.commit();
    return true;
  }

  /** One take-over step at a time per task: taking over, opening the terminal again, or handing back. */
  private notSwitching(taskId: Id): void {
    const busy = this.switching.get(taskId);
    if (busy) throw new Error(TAKE_OVER_WORDS.busy[busy]);
  }

  /** "You're driving" in the inbox only goes with a hand back. */
  private notDrivingItem(itemId: Id): void {
    if (this.s.inbox.some((entry) => entry.id === itemId && entry.kind === "driving")) throw new Error(TAKE_OVER_WORDS.handBackFirst);
  }

  private notDriving(task: MTask | undefined): void {
    if (task && (task.driving || this.switching.has(task.id))) throw new Error(TAKE_OVER_WORDS.handBackFirst);
  }

  /** The tool's own app, as found on this machine, and for Claude Code the name its installed copy gives its ask-before-acting mode. */
  private async takeOverTool(toolId: Id): Promise<LaunchInput["tool"]> {
    const adapter = ADAPTERS[toolId];
    const path = adapter && TAKE_OVER_TOOLS[toolId] ? (this.options.toolPath?.(toolId) ?? Bun.which(adapter.cli)) : undefined;
    if (!adapter || !path) throw new Error(TAKE_OVER_WORDS.missing(toolName(toolId)));
    const id = toolId as LaunchInput["tool"]["id"];
    return { id, name: adapter.name, path, ...(id === "claude-code" ? { mode: await askMode(path) } : {}) };
  }

  /** The launcher's folder: only the coordinator can read it, and it goes at hand back. */
  private takeOverDir(taskId: Id): string {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(taskId)) throw new Error("Unknown task");
    return join(this.dataDir, "takeover", taskId);
  }

  private launchInput(task: MTask, tool: LaunchInput["tool"], sessionId: string, model: string, effort: string): LaunchInput {
    return { platform: this.machine.platform, dir: this.takeOverDir(task.id), worktree: task.worktree!, tool, sessionId, model, effort };
  }

  /** Write the launcher and open it in the terminal, or only write it for the coordinator to run. */
  private async launch(task: MTask, terminal: FoundTerminal | undefined, fresh: boolean, tool?: LaunchInput["tool"]): Promise<Launched> {
    const driving = task.driving!;
    const conversation = task.conversation!;
    const effort = this.profile(driving.profileId)?.effort ?? "high";
    const dir = this.takeOverDir(task.id);
    const plan = launchPlan(this.launchInput(task, tool ?? (await this.takeOverTool(driving.toolId)), conversation.sessionId, conversation.model, effort));
    // Opening again: until the new copy reports, Petrina can't tell, so an old "it has closed" never lets a hand back through.
    if (!fresh) await clearEnded(dir, this.machine.platform);
    await writeLauncher(plan, dir, fresh);
    if (!terminal) {
      delete driving.terminal;
      delete driving.problem;
      this.commit();
      return { command: plan.copy };
    }
    const problem = await openTerminal(terminal, plan.file);
    driving.terminal = terminal.name;
    if (problem) {
      driving.problem = problem;
      this.log(task, "warn", `${problem}. Reopen the terminal, or copy the command and run it yourself`);
    } else {
      delete driving.problem;
    }
    this.commit();
    return { command: plan.copy, terminal: terminal.name, ...(problem ? { problem } : {}) };
  }

  /** Why hand back cannot go on with the working copy as it is, in plain words. */
  private branchProblem(task: MTask, where: { branch?: string; busy?: string }): string | undefined {
    if (where.busy) return `The working copy is in the middle of ${where.busy}. Finish it or abort it in your terminal, then hand back.`;
    if (where.branch !== task.branch) return "The working copy is no longer on the task's branch. Switch back to it in your terminal, then hand back.";
    return undefined;
  }

  // ── Scheduling ─────────────────────────────────────────────────────────

  private schedule(): void {
    if (this.stopped) return;
    const candidates: Candidate[] = [];
    const tool = (profileId: Id) => this.profile(profileId)?.toolId ?? "unknown";
    // A task waiting for others to land stays out of the running and says what it waits for.
    const blocked = (task: MTask): boolean => {
      const waitingFor = this.blockers(task);
      if (!waitingFor.length) return false;
      const line = `Waiting for “${waitingFor[0]!.title}”${waitingFor.length > 1 ? ` and ${waitingFor.length - 1} more` : ""} to land`;
      if (task.statusLine !== line) task.statusLine = line;
      return true;
    };
    for (const task of this.s.tasks.filter((entry) => entry.state === "waiting").sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))) {
      if (blocked(task)) continue;
      if (task.statusLine.startsWith("Waiting for “")) task.statusLine = "Waiting for a free slot";
      const next = this.nextAgent(task);
      const candidate = { taskId: task.id, toolId: next ? tool(next.profileId) : "none" };
      task.statusLine = slotWait(this.getState(), candidate) ?? "Waiting for a free slot";
      candidates.push(candidate);
    }
    for (const task of queueOf(this.s.tasks as Task[])) if (!task.held && !blocked(task as MTask)) candidates.push({ taskId: task.id, toolId: tool(PLANNER_PROFILE) });

    for (const taskId of pickStarts({ candidates, inUse: slotUses(this.getState()), pool: this.s.pool })) {
      const task = this.task(taskId);
      if (!task || this.drivers.has(taskId)) continue;
      if (task.state === "queued") {
        task.startedAt = Date.now();
        task.stageIndex = -1;
        this.log(task, "milestone", "Started from the queue");
      }
      if (this.reserveAgent(task)) this.startDriver(taskId);
    }
    this.commit();
  }

  /** Take the slot and name its agent together, before any working-copy or tool I/O. */
  private reserveAgent(task: MTask): boolean {
    const next = this.nextAgent(task);
    const waiting = slotWait(this.getState(), { taskId: task.id, toolId: next ? this.profile(next.profileId)?.toolId ?? "unknown" : "none" });
    if (waiting) {
      task.state = "waiting";
      task.holdsSlot = false;
      delete task.agent;
      task.column = this.columnFor(task);
      task.statusLine = waiting;
      return false;
    }
    task.state = "running";
    task.holdsSlot = !!next;
    if (next) task.agent = { ...next, since: Date.now(), step: 0 };
    else delete task.agent;
    task.column = this.columnFor(task);
    task.statusLine = next ? `${this.role(next.roleId)?.name ?? next.roleId} is starting` : "Getting ready";
    return true;
  }

  private nextAgent(task: MTask): { roleId: Id; profileId: Id } | undefined {
    if (task.stageIndex < 0) return { roleId: "planner", profileId: PLANNER_PROFILE };
    const stage = task.plan?.stages[task.stageIndex];
    if (!stage) return undefined;
    switch (stage.kind) {
      case "do":
        return { roleId: stage.roleId, profileId: stage.profileIds[0] ?? PLANNER_PROFILE };
      case "converge":
        return task.sub === 0
          ? { roleId: stage.roleId, profileId: stage.profileIds[0] ?? PLANNER_PROFILE }
          : { roleId: stage.reviewerRoleId ?? "design-reviewer", profileId: stage.reviewerProfileIds?.[0] ?? "sol-xhigh" };
      case "review-chain": {
        if (task.sub < stage.profileIds.length) return { roleId: stage.roleId, profileId: stage.profileIds[task.sub] ?? stage.profileIds[0] ?? PLANNER_PROFILE };
        const verify = this.nextVerification(task, stage);
        return verify ? { roleId: "verifier", profileId: verify.profileId } : undefined;
      }
      case "gate":
        return undefined;
    }
  }

  // ── The task driver ────────────────────────────────────────────────────

  /** `resume`: the agent already has its seat (a hand back), so its step carries on whatever the pool is doing. */
  private startDriver(taskId: Id, resume = false): void {
    const done = this.drive(taskId, resume);
    this.settling.set(taskId, done);
    void done.finally(() => {
      if (this.settling.get(taskId) === done) this.settling.delete(taskId);
    });
  }

  private async drive(taskId: Id, resume = false): Promise<void> {
    const controller = new AbortController();
    this.drivers.set(taskId, controller);
    const { signal } = controller;
    const task = () => {
      const found = this.task(taskId);
      if (!found) throw new Aborted();
      return found;
    };
    try {
      await this.prepare(task());
      for (;;) {
        if (signal.aborted) throw new Aborted();
        const current = task();
        const stage = current.stageIndex < 0 ? undefined : current.plan?.stages[current.stageIndex];
        // Nothing ships while changes made by hand wait for review: the last review chain looks at them first.
        if (stage && current.handChanges && (stage.gate === "delivery" || stage.roleId === "shipper")) {
          const chain = lastIndex(current.plan!.stages, (entry) => entry.kind === "review-chain");
          if (chain >= 0) {
            current.stageIndex = chain;
            current.sub = 0;
            current.fixing = false;
            this.log(current, "milestone", "Reviewing your changes before anything ships: the review starts again from the first reviewer");
            this.commit();
            continue;
          }
          delete current.handChanges;
        }
        // What ships is what the coordinator approved: a change since then asks them again.
        if (stage?.roleId === "shipper" && stage.kind !== "gate" && current.approvedSha && !current.shipping && current.worktree) {
          const head = await git.head(current.worktree).catch(() => undefined);
          const check = lastIndex(current.plan!.stages, (entry, index) => index < current.stageIndex && entry.gate === "delivery");
          if (head && head !== current.approvedSha && check >= 0) {
            delete current.approvedSha;
            current.stageIndex = check;
            current.sub = 0;
            this.log(current, "warn", "The work changed after you approved the delivery, so Petrina asks you again");
            this.commit();
            continue;
          }
        }
        // Checkpoints need no new agent, so a paused or full pool must not hold them back.
        if (stage?.kind === "gate") {
          // On the way back to the check where changes were asked, earlier design checks are not asked again.
          if (stage.gate === "design" && current.returnToCheck !== undefined && current.stageIndex < current.returnToCheck) {
            this.log(current, "milestone", "Went past the earlier design check you already approved, back to the one where you asked for changes");
            current.stageIndex += 1;
            current.sub = 0;
            this.commit();
            continue;
          }
          delete current.returnToCheck;
          if (stage.gate === "delivery") await this.writeGuide(current);
          // Right before the coordinator is asked to ship, the checks run again on what would ship.
          if (stage.gate === "delivery" && (await this.checksBeforeDelivery(current, signal))) continue;
          if (stage.gate === "delivery") {
            const head = await git.head(current.worktree!).catch(() => undefined);
            if (head) current.checkedSha = head;
            if (this.shipsUnasked(current)) {
              if (head) current.approvedSha = head;
              this.log(current, "milestone", "Low risk, checks passed and nothing left to fix: shipping without asking you, as this product's settings allow");
              current.stageIndex += 1;
              current.sub = 0;
              this.commit();
              continue;
            }
          }
          this.gate(current, stage.gate ?? "delivery");
          return;
        }
        // Running agents finish; every following agent must qualify again, even on the same tool.
        if (resume) resume = false;
        else if (!this.reserveAgent(current)) {
          this.commit();
          return;
        }
        this.commit();
        if (current.stageIndex < 0) {
          await this.runPlanner(current, signal);
          if (current.approvePlan) {
            this.gate(current, "plan");
            return;
          }
          current.stageIndex = 0;
          current.sub = 0;
          this.commit();
          continue;
        }
        if (!stage) throw new Error("The plan ended without a delivery");
        const next = stage.kind === "do" ? await this.runDo(current, stage, signal) : stage.kind === "converge" ? await this.runConverge(current, stage, signal) : await this.runReview(current, stage, signal);
        if (next === "stop") return;
      }
    } catch (error) {
      if (signal.aborted || error instanceof Aborted) return;
      this.fail(taskId, error);
    } finally {
      if (this.drivers.get(taskId) === controller) this.drivers.delete(taskId);
      if (!this.stopped) this.schedule();
    }
  }

  private async prepare(task: MTask): Promise<void> {
    const product = this.productOf(task);
    if (!product?.path) throw new Error(`${product?.name ?? "This product"} has no local copy`);
    const branch = task.branch ?? git.branchName(task.title, task.id);
    const worktree = task.worktree ?? join(this.dataDir, "worktrees", product.id, task.id);
    const { base, skippedFetch, fetchTimedOut } = await git.ensureWorktree(product.path, worktree, branch, product.defaultBranch ?? "main");
    if (fetchTimedOut) this.log(task, "warn", "GitHub did not answer in time, so this task starts from the local copy");
    if (skippedFetch) this.log(task, "warn", `Did not update from GitHub: the repository's git settings include ${skippedFetch.slice(0, 3).join(", ")}, which could misuse your GitHub login. Working from the local copy.`);
    if (!task.branch) this.log(task, "milestone", "Set up a fresh working copy");
    task.branch = branch;
    task.worktree = worktree;
    task.base = task.base ?? base;
    this.commit();
  }

  private async runPlanner(task: MTask, signal: AbortSignal): Promise<void> {
    const result = await this.turn(task, "planner", PLANNER_PROFILE, () => [], PlanResult, signal);
    // Unrated work is treated as medium: never shipped unasked, never short of reviewers.
    task.risk = result.risk ?? { level: "medium", why: "The planner did not rate it." };
    task.plan = this.normalizePlan(task, result);
    const count = task.plan.stages.filter((stage) => stage.kind !== "gate").length;
    this.log(task, "milestone", `Plan ready: ${count} stages. ${result.rationale}`, "planner", PLANNER_PROFILE);
    this.log(task, "milestone", `${RISK_WORD[task.risk.level]} risk: ${task.risk.why}`, "planner", PLANNER_PROFILE);
    this.finishStep(task);
    this.commit();
  }

  private normalizePlan(task: MTask, result: z.infer<typeof PlanResult>): DeepMutable<NonNullable<Task["plan"]>> {
    // Only roles the planner was told about can be planned.
    const roles = new Set(this.s.roles.filter((role) => !role.internal).map((role) => role.id));
    const profile = (id: string | undefined, fallback: string) => (id && this.profile(id) ? id : fallback);
    const stages: MStage[] = [];
    result.stages.forEach((raw, index) => {
      if (!roles.has(raw.roleId)) return;
      const id = `${task.id}:s${index}`;
      if (raw.kind === "gate") {
        stages.push({ id, kind: "gate", title: raw.title, roleId: raw.roleId, profileIds: [], gate: raw.gate === "plan" ? "plan" : "design" });
      } else if (raw.kind === "converge") {
        stages.push({
          id,
          kind: "converge",
          title: raw.title,
          roleId: raw.roleId,
          profileIds: [profile(raw.profileIds[0], "opus-xhigh")],
          reviewerRoleId: raw.reviewerRoleId && roles.has(raw.reviewerRoleId) ? raw.reviewerRoleId : "design-reviewer",
          reviewerProfileIds: [profile(raw.reviewerProfileIds?.[0], "sol-xhigh")],
          maxRounds: raw.maxRounds ?? 3,
        });
      } else if (raw.kind === "review-chain") {
        const reviewers = raw.profileIds.map((id) => profile(id, "sol-xhigh"));
        stages.push({ id, kind: "review-chain", title: raw.title, roleId: "code-reviewer", profileIds: reviewers.length ? reviewers : ["sol-xhigh", "opus-xhigh"], maxRounds: raw.maxRounds ?? 2 });
      } else {
        stages.push({ id, kind: "do", title: raw.title, roleId: raw.roleId, profileIds: [profile(raw.profileIds[0], "opus-xhigh")] });
      }
    });
    if (!stages.some((stage) => stage.roleId === "builder")) {
      const at = stages.findIndex((stage) => stage.kind === "review-chain");
      const builder: MStage = { id: `${task.id}:build`, kind: "do", title: "Build", roleId: "builder", profileIds: ["opus-xhigh"] };
      if (at >= 0) stages.splice(at, 0, builder);
      else stages.push(builder);
    }
    if (!stages.some((stage) => stage.kind === "review-chain")) {
      stages.push({ id: `${task.id}:review`, kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["sol-xhigh", "opus-xhigh"], maxRounds: 2 });
    }
    if (task.risk?.level === "high") {
      // High-risk work gets a security review after the others, on a tool other than the builder's.
      const builderTool = this.profile(stages.find((stage) => stage.roleId === "builder")?.profileIds[0] ?? "")?.toolId;
      const other = this.s.profiles.filter((entry) => entry.toolId !== builderTool);
      const reviewer = (other.find((entry) => entry.effort === "xhigh") ?? other[0])?.id ?? "opus-xhigh";
      stages.splice(lastIndex(stages, (stage) => stage.kind === "review-chain") + 1, 0, { id: `${task.id}:security`, kind: "review-chain", title: "Security review", roleId: "security-reviewer", profileIds: [reviewer], maxRounds: 2 });
    }
    stages.push(...(deliveryStages(task as unknown as Task, SHIPPER_PROFILE) as MStage[]));
    return { stages, rationale: result.rationale, plannerProfileId: PLANNER_PROFILE };
  }

  private async runDo(task: MTask, stage: MStage, signal: AbortSignal): Promise<"continue" | "stop"> {
    const roleId = stage.roleId;
    const profileId = stage.profileIds[0] ?? "opus-xhigh";
    const role = this.role(roleId);
    const sections = () => this.sectionsFor(task, roleId);

    if (roleId === "builder") {
      if (task.miss) await this.proposeGuideLine(task, signal);
      // In a fix round the builder answers every finding it was given, by id.
      const given = task.fixing ? task.findings.filter((finding) => finding.status === "open" && finding.severity !== "pre-existing") : [];
      const result = await this.turn(task, roleId, profileId, sections, BuildResult, signal, {
        check: (value) => {
          const missing = given.filter((finding) => !value.answers.some((answer) => answer.id === finding.id));
          return missing.length ? `answer every finding by id in "answers" (fixed, or not fixed and why), and these have none:\n${formatFindings(missing as Task["findings"])}` : undefined;
        },
      });
      const label = this.describe(roleId, profileId);
      const sha = await git.commitAll(task.worktree!, `${task.title}${task.fixing ? " (review fixes)" : ""}\n\n${result.summary}\n\n${result.changes.map((change) => `- ${change}`).join("\n")}\n\nBuilt by Petrina: ${label}`);
      task.report = { summary: result.summary, changes: result.changes, ...(result.tests ? { tests: result.tests } : {}) };
      if (task.fixing) {
        const at = Date.now();
        for (const answer of result.answers) {
          const finding = given.find((entry) => entry.id === answer.id && entry.status === "open");
          if (!finding) continue;
          finding.answer = { fixed: answer.fixed, text: answer.text, at };
          if (answer.fixed) finding.status = "fixed";
        }
        task.fixing = false;
      }
      this.log(task, "done", sha ? `Build done: ${result.summary}` : "Build done, with no changes to the code", roleId, profileId);
    } else if (roleId === "shipper") {
      // Shipping is never repeated blindly: after an interruption, look for the delivery first.
      if (task.shipping && !task.shipping.again) return this.checkDelivery(task, signal);
      await this.startShipping(task, signal);
      const result = await this.turn(task, roleId, profileId, sections, ShipResult, signal);
      await this.verifyDelivery(task, result);
      return "stop";
    } else if (roleId === "tester") {
      const result = await this.turn(task, roleId, profileId, sections, TestResult, signal);
      if (task.brief) task.brief.acceptance = task.brief.acceptance.map((item) => ({ ...item, met: result.checks.find((check) => check.text === item.text)?.pass ?? item.met }));
      const failed = result.checks.filter((check) => !check.pass);
      for (const check of failed) task.findings.push({ id: this.id(task.id), text: `Failed acceptance check: ${check.text}`, severity: "blocking", raisedBy: profileId, confirmedBy: [], status: "open" });
      this.log(task, failed.length ? "warn" : "done", failed.length ? `${failed.length} acceptance check${failed.length === 1 ? "" : "s"} failed` : result.summary, roleId, profileId);
    } else {
      const result = await this.turn(task, roleId, profileId, sections, NotesResult, signal);
      this.say(task, "agent", [result.summary, ...result.notes.map((note) => `• ${note}`)].join("\n"), roleId, profileId);
      this.log(task, "done", `${role?.name ?? roleId} done: ${result.summary}`, roleId, profileId);
    }
    if (role && !role.canEdit && task.worktree && !(await git.isClean(task.worktree))) {
      await git.discardChanges(task.worktree);
      this.log(task, "warn", `Undid changes from ${role.name}, which is read-only`);
    }
    this.finishStep(task);
    if (this.rerun(task)) return "continue";
    task.stageIndex += 1;
    task.sub = 0;
    this.commit();
    return "continue";
  }

  private async runConverge(task: MTask, stage: MStage, signal: AbortSignal): Promise<"continue" | "stop"> {
    if (followingCall(task as unknown as Task)) return this.followCall(task, stage, signal);
    const round = task.rounds[stage.id] ?? 1;
    if (task.sub === 0) {
      const profileId = stage.profileIds[0] ?? "opus-xhigh";
      // Every objection the architect is shown gets its answer: none is accepted or rejected by default.
      const due = task.objections.filter((objection) => objection.status === "open").map((objection) => objection.id);
      // Answers add up across repairs, so the architect can hand back just the ones it left out.
      const given = new Map<string, { id: string; status: "accepted" | "rejected"; answer: string }>();
      const result = await this.turn(task, stage.roleId, profileId, () => this.sectionsFor(task, stage.roleId), BriefResult, signal, {
        check: (value) => {
          for (const answer of value.answers) given.set(answer.id, answer);
          const missing = task.objections.filter((objection) => due.includes(objection.id) && !given.has(objection.id));
          return missing.length ? `every objection you were shown needs an answer by id, accepted or rejected with your reason, and these have none:\n${formatObjections(missing as Task["objections"])}` : undefined;
        },
      });
      task.brief = { summary: result.summary, forUsers: result.forUsers, areas: result.areas, acceptance: result.acceptance.map((text) => ({ text })), risks: result.risks };
      for (const answer of given.size ? given.values() : result.answers) {
        const objection = task.objections.find((entry) => entry.id === answer.id);
        if (objection && objection.status === "open") {
          objection.status = answer.status;
          objection.answer = answer.answer;
        }
      }
      this.log(task, "done", round === 1 ? "Design brief ready" : "Answered every objection", stage.roleId, profileId);
      await this.undoReadOnly(task, stage.roleId);
      this.finishStep(task);
      if (this.rerun(task)) return "continue";
      task.sub = 1;
      this.commit();
      return "continue";
    }
    const reviewerRole = stage.reviewerRoleId ?? "design-reviewer";
    const reviewerProfile = stage.reviewerProfileIds?.[0] ?? "sol-xhigh";
    const result = await this.turn(task, reviewerRole, reviewerProfile, () => this.sectionsFor(task, reviewerRole), ObjectionsResult, signal);
    for (const objection of result.objections) {
      task.objections.push({ id: this.id(`${task.id}-obj`), round, text: objection.text, blocking: objection.blocking, raisedBy: reviewerProfile, status: "open" });
    }
    await this.undoReadOnly(task, reviewerRole);
    this.finishStep(task);
    if (this.rerun(task)) return "continue";
    const blocking = result.objections.filter((objection) => objection.blocking).length;
    if (blocking === 0) {
      // Nobody decides on non-blocking points raised in the last round: they stay as follow-ups, never "rejected".
      for (const objection of task.objections) if (objection.status === "open" && !objection.blocking) objection.status = "noted";
      this.log(task, "done", "Design settled: no blocking objections", reviewerRole, reviewerProfile);
      task.stageIndex += 1;
      task.sub = 0;
      this.commit();
      return "continue";
    }
    this.log(task, "warn", `Raised ${result.objections.length} objection${result.objections.length === 1 ? "" : "s"}, ${blocking} blocking`, reviewerRole, reviewerProfile);
    if (round >= (stage.maxRounds ?? 3)) {
      delete task.agent;
      task.holdsSlot = false;
      task.statusLine = "The architects disagree. Your call";
      this.raise(task, "disagreement", `The architects disagree on “${task.title}”`, false, { body: CALL_WORDS.disagreement });
      this.commitNow();
      return "stop";
    }
    task.rounds[stage.id] = round + 1;
    task.sub = 0;
    this.commit();
    return "continue";
  }

  /** The coordinator made the call: the architect updates the brief to follow it, then the design goes to the coordinator's check. */
  private async followCall(task: MTask, stage: MStage, signal: AbortSignal): Promise<"continue"> {
    const call = task.call!;
    const profileId = stage.profileIds[0] ?? "opus-xhigh";
    const revising = !task.objections.some((objection) => objection.status === "open");
    // Answers add up across repairs, so the architect can hand back just the ones it left out.
    const answers = new Map<Id, CallAnswer>();
    const result = await this.turn(task, stage.roleId, profileId, () => this.sectionsFor(task, stage.roleId), BriefResult, signal, {
      status: CALL_WORDS.following,
      check: (value) => {
        for (const answer of value.answers) answers.set(answer.id, answer);
        const missing = unanswered(task.objections as Task["objections"], call as DesignCall, [...answers.values()]);
        return missing.length ? `every objection listed for an answer needs one by id, and these have none:\n${formatObjections(missing)}` : undefined;
      },
    });
    task.brief = { summary: result.summary, forUsers: result.forUsers, areas: result.areas, acceptance: result.acceptance.map((text) => ({ text })), risks: result.risks };
    task.objections = answerByCall(task.objections as Task["objections"], call as DesignCall, [...answers.values()]) as MTask["objections"];
    this.log(task, "done", revising ? CALL_WORDS.revised : CALL_WORDS.updated, stage.roleId, profileId);
    await this.undoReadOnly(task, stage.roleId);
    this.finishStep(task);
    this.log(task, "done", CALL_WORDS.settled);
    if (this.rerun(task)) return "continue";
    // The design check comes next, maybe after steps such as Screens: the call made sure there is one.
    task.stageIndex += 1;
    task.sub = 0;
    this.commit();
    return "continue";
  }

  private async runReview(task: MTask, stage: MStage, signal: AbortSignal): Promise<"continue" | "stop"> {
    const round = task.rounds[stage.id] ?? 1;
    // After the last reviewer, Important findings are checked on the other tool before the round closes.
    if (task.sub >= stage.profileIds.length) return this.runVerify(task, stage, round, signal);
    if (task.sub === 0) {
      // The chain starts again from its first reviewer: changes made by hand are in what it reviews.
      delete task.handChanges;
      const problems = await git.tamperCheck(task.worktree!, task.base!);
      // Petrina's own findings settle on what it sees now, whatever anyone answered.
      for (const finding of task.findings) {
        if (finding.raisedBy === "petrina" && finding.status === "open" && !finding.text.startsWith("Check failed") && !problems.includes(finding.text)) finding.status = "fixed";
      }
      for (const problem of problems) {
        if (!task.findings.some((finding) => finding.text === problem && finding.status === "open")) {
          task.findings.push({ id: this.id(task.id), text: problem, severity: "blocking", raisedBy: "petrina", confirmedBy: [], status: "open" });
        }
      }
      this.log(task, problems.length ? "warn" : "done", problems.length ? `Tamper check: ${problems.length} problem${problems.length === 1 ? "" : "s"}` : "Tamper check passed: no tests removed or skipped");
      // The product's checks run before any reviewer spends time: an agent's word never counts as passing.
      // A later chain on the same commit (a security review) goes by the run that just passed.
      const head = await git.head(task.worktree!).catch(() => undefined);
      const passed = !!head && task.checks?.sha === head && task.checks.results.every((run) => run.ok);
      const checks = passed ? [] : await this.ensureChecks(task, signal);
      if ((await this.runProductChecks(task, checks, signal)) > 0) {
        this.log(task, "warn", "Reviewers wait until the checks pass");
        return this.closeReviewRound(task, stage, round, false);
      }
    }
    const profileId = stage.profileIds[task.sub] ?? stage.profileIds[0] ?? "sol-xhigh";
    const result = await this.turn(task, stage.roleId, profileId, () => this.sectionsFor(task, stage.roleId), ReviewResult, signal);
    for (const id of result.confirms) {
      const finding = task.findings.find((entry) => entry.id === id);
      if (finding && !finding.confirmedBy.includes(profileId)) finding.confirmedBy.push(profileId);
    }
    recordDisputes(task.findings, result.disputes, profileId, Date.now());
    // A finding is raised once: a repeat of any earlier one, open or settled, is dropped.
    const known = new Set(task.findings.map((finding) => sameFinding(finding.text)));
    const raised = result.findings.filter((finding) => !known.has(sameFinding(finding.text)) && known.add(sameFinding(finding.text)));
    for (const finding of raised) {
      task.findings.push({
        id: this.id(task.id),
        text: finding.text,
        ...(finding.where ? { where: finding.where } : {}),
        ...(finding.evidence ? { evidence: finding.evidence } : {}),
        severity: SEVERITY[finding.severity],
        raisedBy: profileId,
        confirmedBy: [],
        status: "open",
      });
    }
    await this.undoReadOnly(task, stage.roleId);
    this.finishStep(task);
    const important = raised.some((finding) => finding.severity === "important");
    const also = [result.confirms.length ? `confirmed ${result.confirms.length}` : "", result.disputes.length ? `disputed ${result.disputes.length}` : ""].filter(Boolean).join(", ");
    this.log(task, important ? "warn" : "done", `${findingCount(raised.map((finding) => ({ severity: SEVERITY[finding.severity] })))}${also ? `; ${also}` : ""}`, stage.roleId, profileId);
    if (this.rerun(task)) return "continue";

    if (task.sub + 1 < stage.profileIds.length) {
      task.sub += 1;
      this.commit();
      return "continue";
    }
    // Every reviewer has looked: on to checking Important findings, or the round closes.
    task.sub = stage.profileIds.length;
    this.commit();
    return "continue";
  }

  /**
   * An Important finding sends work back only once a fresh agent on another tool agrees. One turn
   * checks the findings raised on one tool; the step repeats until none is left unchecked.
   */
  private async runVerify(task: MTask, stage: MStage, round: number, signal: AbortSignal): Promise<"continue" | "stop"> {
    const next = this.nextVerification(task, stage);
    if (!next) return this.closeReviewRound(task, stage, round, true);
    const ids = new Set(next.findings.map((finding) => finding.id));
    const result = await this.turn(
      task,
      "verifier",
      next.profileId,
      () => [...this.sectionsFor(task, "verifier"), { title: "Important findings to check (a verdict on every one, by id)", body: formatFindings(next.findings) }],
      VerifyResult,
      signal,
      {
        status: `Checking ${next.findings.length} important finding${next.findings.length === 1 ? "" : "s"} with fresh eyes`,
        check: (value) => {
          const missing = next.findings.filter((finding) => !value.verdicts.some((verdict) => verdict.id === finding.id));
          return missing.length ? `give a verdict on every finding by id, and these have none:\n${formatFindings(missing)}` : undefined;
        },
      },
    );
    const at = Date.now();
    for (const verdict of result.verdicts) {
      const finding = task.findings.find((entry) => entry.id === verdict.id && ids.has(entry.id));
      if (!finding) continue;
      finding.verification = { by: next.profileId, verdict: verdict.verdict, reason: verdict.reason, at };
      if (verdict.verdict === "not-a-bug") finding.status = "dismissed";
      else if (verdict.verdict === "nit") finding.severity = "suggestion";
      else if (verdict.verdict === "pre-existing") finding.severity = "pre-existing";
    }
    await this.undoReadOnly(task, "verifier");
    this.finishStep(task);
    const verdicts = result.verdicts.filter((verdict) => ids.has(verdict.id));
    const real = verdicts.filter((verdict) => verdict.verdict === "real").length;
    this.log(task, real ? "warn" : "done", `${verdicts.length} checked: ${real} real${verdicts.length > real ? `, ${verdicts.length - real} not holding the work back` : ""}`, "verifier", next.profileId);
    if (this.rerun(task)) return "continue";
    this.commit();
    return "continue";
  }

  /**
   * The next Important findings to check: those raised on one tool that nobody on another tool has
   * confirmed or checked yet. Petrina's own findings (checks, tamper check) are evidence already.
   */
  private nextVerification(task: MTask, stage: MStage): { profileId: Id; findings: Task["findings"] } | undefined {
    const toolOf = (profileId: Id) => this.profile(profileId)?.toolId;
    const pending = task.findings.filter(
      (finding) =>
        finding.status === "open" &&
        finding.severity === "blocking" &&
        finding.raisedBy !== "petrina" &&
        !finding.verification &&
        !finding.confirmedBy.some((by) => toolOf(by) !== toolOf(finding.raisedBy)),
    );
    if (!pending.length) return undefined;
    const tool = toolOf(pending[0]!.raisedBy);
    const ready = (profile: AgentProfile) => this.s.tools.some((entry) => entry.id === profile.toolId && entry.status === "ready");
    const other = this.s.profiles.filter((profile) => profile.toolId !== tool && ready(profile as AgentProfile));
    // The stage's own reviewers on another tool first; with only one tool working, a fresh agent on the same tool.
    const profileId = stage.profileIds.find((id) => other.some((profile) => profile.id === id)) ?? other[0]?.id ?? stage.profileIds[0] ?? PLANNER_PROFILE;
    return { profileId, findings: pending.filter((finding) => toolOf(finding.raisedBy) === tool) as Task["findings"] };
  }

  /** The end of a review round: back to the builder with what is Important, or on towards delivery. */
  private async closeReviewRound(task: MTask, stage: MStage, round: number, reviewed: boolean): Promise<"continue" | "stop"> {
    const open = task.findings.filter((finding) => finding.status === "open" && finding.severity === "blocking");
    const builder = lastIndex(task.plan?.stages ?? [], (entry, index) => index < task.stageIndex && entry.roleId === "builder");
    if (open.length > 0 && builder >= 0 && round < (stage.maxRounds ?? 2)) {
      // The next round reviews only what changed since what the reviewers looked at in this one.
      const sha = reviewed ? await git.head(task.worktree!).catch(() => undefined) : undefined;
      if (sha) task.reviewedSha = sha;
      task.rounds[stage.id] = round + 1;
      task.stageIndex = builder;
      task.sub = 0;
      task.fixing = true;
      this.log(task, "warn", `Sent back to the builder: ${findingCount(open)}`);
      this.commit();
      return "continue";
    }
    task.stageIndex += 1;
    task.sub = 0;
    if (open.length > 0) {
      this.log(task, "warn", `Review rounds used up: ${findingCount(open)} still open`);
      // With blocking findings left, the coordinator always looks before anything ships.
      const next = task.plan?.stages[task.stageIndex];
      if (next && next.kind !== "gate") {
        this.gate(task, "delivery");
        return "stop";
      }
    } else {
      this.log(task, "done", `Review passed: ${findingCount(task.findings.filter((finding) => finding.status === "open"))}`);
    }
    this.commit();
    return "continue";
  }

  private async verifyDelivery(task: MTask, result: z.infer<typeof ShipResult>): Promise<void> {
    const product = this.productOf(task)!;
    const label = this.describe("shipper", SHIPPER_PROFILE);
    delete task.agent;
    task.holdsSlot = false;
    if (task.delivery === "pull-request") {
      const pr = await git.findPr(product.repo, task.branch!, this.options.gh);
      if (!pr) throw new Error("The shipper finished, but no pull request exists for this branch");
      this.recordPr(task, { ...pr, state: "open" });
      this.log(task, "done", `Opened pull request #${pr.number}`, "shipper", SHIPPER_PROFILE);
    } else if (task.delivery === "release") {
      const release = result.tag ? await git.findRelease(product.repo, result.tag, this.options.gh) : undefined;
      if (!release) throw new Error("The shipper finished, but the release could not be found on GitHub");
      this.recordRelease(task, release);
      this.log(task, "done", `Published release ${release.tag}`, "shipper", SHIPPER_PROFILE);
    } else {
      const sha = result.sha ?? (await git.head(task.worktree!));
      const branch = product.defaultBranch ?? "main";
      if (!(await git.landedOn(product.path!, branch, sha))) throw new Error(`The shipper finished, but the work is not on ${branch}`);
      this.recordLanded(task, branch, sha);
      this.log(task, "done", `Committed to ${branch} (${sha.slice(0, 7)})`, "shipper", SHIPPER_PROFILE);
    }
    delete task.shipping;
    this.finishStep(task);
    this.say(task, "agent", `${result.summary}\n\n${label}`, "shipper", SHIPPER_PROFILE);
    this.commitNow();
  }

  private recordPr(task: MTask, pr: { number: number; url: string; state: "open" | "merged" | "closed" }): void {
    task.pr = { number: pr.number, url: pr.url, state: pr.state === "merged" ? "merged" : "open", openedAt: Date.now() };
    if (pr.state === "open") {
      task.state = "pr-open";
      task.column = "ready";
      task.statusLine = `Pull request #${pr.number} is open. Merge it on GitHub when you are happy`;
    } else {
      this.finished(task, pr.state === "merged" ? `Merged #${pr.number} on GitHub` : `Closed #${pr.number} without merging`);
    }
  }

  private recordRelease(task: MTask, release: { tag: string; url: string }): void {
    task.release = release;
    this.finished(task, `Released ${release.tag}`);
  }

  private recordLanded(task: MTask, branch: string, sha: string): void {
    task.landed = { branch, sha: sha.slice(0, 7) };
    this.finished(task, `Committed to ${branch}`);
  }

  private finished(task: MTask, statusLine: string): void {
    task.state = "done";
    task.column = "done";
    task.finishedAt = Date.now();
    task.statusLine = statusLine;
  }

  // ── Shipping is never repeated blindly ─────────────────────────────────

  /** On disk before the shipper gets any work: when it started, the latest release, and where main was. */
  private async startShipping(task: MTask, signal: AbortSignal): Promise<void> {
    const product = this.productOf(task)!;
    const branch = product.defaultBranch ?? "main";
    const earlier = task.shipping;
    // A second attempt keeps what the first one found: the check covers everything since then.
    const [head, mainSha, originSha, latestRelease] = earlier
      ? [earlier.head, earlier.mainSha, earlier.originSha, earlier.latestRelease]
      : await Promise.all([
          git.head(task.worktree!).catch(() => undefined),
          git.revParse(product.path!, `refs/heads/${branch}`),
          git.revParse(task.worktree!, `refs/remotes/origin/${branch}`),
          task.delivery === "release" ? git.latestRelease(product.repo, this.options.gh) : undefined,
        ]);
    // Paused or stopped while Petrina looked: the shipper never got any work, so nothing was interrupted.
    if (signal.aborted) throw new Aborted();
    task.shipping = {
      startedAt: earlier?.startedAt ?? Date.now(),
      attempts: (earlier?.attempts ?? 0) + 1,
      boot: this.boot,
      ...(head ? { head } : {}),
      ...(mainSha ? { mainSha } : {}),
      ...(originSha ? { originSha } : {}),
      ...(latestRelease ? { latestRelease } : {}),
      ...(earlier?.found ? { found: earlier.found } : {}),
    };
    this.log(task, "status", earlier ? "Shipping again, finishing the interrupted attempt" : "Shipping started");
    this.commitNow();
  }

  /** After an interruption: record the delivery if it went out, or ask the coordinator. Never ship again on its own. */
  private async checkDelivery(task: MTask, signal: AbortSignal): Promise<"stop"> {
    const shipping = task.shipping!;
    task.statusLine = "Checking whether it already went out";
    this.commit();
    const delivery = await this.lookForDelivery(task, shipping);
    if (signal.aborted) throw new Aborted();
    delete task.agent;
    task.holdsSlot = false;
    const when = shipping.boot === this.boot ? "" : " after a restart";
    if (delivery.found) {
      delivery.record();
      delete task.shipping;
      this.finishStep(task);
      this.log(task, "done", `Found${when} that it had already gone out: ${delivery.text}`, "shipper", SHIPPER_PROFILE);
      this.commitNow();
      return "stop";
    }
    shipping.found = delivery.text;
    task.statusLine = "Shipping was interrupted. Your call";
    this.raise(task, "shipping", `Shipping “${task.title}” was interrupted`, false, {
      body: `${delivery.text} Petrina will not ship it again on its own: check again, ship it again (the shipper finishes the interrupted attempt), or mark it as done if it went out another way.`,
    });
    this.log(task, "warn", `Shipping was interrupted${when}. ${delivery.text}`);
    this.commitNow();
    return "stop";
  }

  private async lookForDelivery(task: MTask, shipping: NonNullable<MTask["shipping"]>): Promise<Delivery> {
    const product = this.productOf(task)!;
    const branch = product.defaultBranch ?? "main";
    const worktree = task.worktree!;
    const head = shipping.head ?? (await git.head(worktree).catch(() => undefined));
    const unreachable: Delivery = { found: false, text: "Petrina could not reach GitHub to check whether it went out." };
    if (!head) return { found: false, text: "Petrina could not tell which work was being shipped." };
    // Asked of GitHub for the product's own repository, never through the working copy's remote.
    const { repo } = product;
    const gh = this.options.gh;

    if (task.delivery === "pull-request") {
      const pr = await git.prForBranch(repo, task.branch!, gh);
      if (!pr.ok) return unreachable;
      const found = pr.value;
      if (found) return { found: true, text: `pull request #${found.number}`, record: () => this.recordPr(task, found) };
      const pushed = await git.branchOnGitHub(repo, task.branch!, gh);
      if (!pushed.ok) return unreachable;
      return { found: false, text: pushed.value ? "The branch was pushed to GitHub, but no pull request was opened for it." : "No pull request was opened for this task's branch." };
    }

    if (task.delivery === "local") {
      // The shipper may have merged main into the branch first: its newer head counts too.
      const now = await git.head(worktree).catch(() => undefined);
      for (const sha of new Set([now ?? head, head])) {
        if (await git.landedOn(product.path!, branch, sha)) return { found: true, text: `the work is on ${branch} (${sha.slice(0, 7)})`, record: () => this.recordLanded(task, branch, sha) };
      }
      return { found: false, text: `The work is not on ${branch} yet.` };
    }

    const releases = await git.releasesSince(repo, shipping.startedAt - CLOCK_SLACK_MS, gh);
    if (!releases.ok) return unreachable;
    for (const tag of releases.value) {
      const contains = await git.onGitHub(repo, tag, head, gh);
      if (!contains.ok) return unreachable;
      if (!contains.value) continue;
      const release = await git.findRelease(repo, tag, gh);
      if (!release) return unreachable;
      return { found: true, text: `release ${tag}`, record: () => this.recordRelease(task, release) };
    }
    const pushed = await git.onGitHub(repo, branch, head, gh);
    if (!pushed.ok) return unreachable;
    return {
      found: false,
      text: pushed.value ? `The work (with any version change) was pushed to ${branch} on GitHub, but no release containing it was published.` : "No release containing this work was published since shipping started.",
    };
  }

  private takeShippingItem(itemId: Id): MTask | undefined {
    if (this.s.inbox.find((entry) => entry.id === itemId)?.kind !== "shipping") return undefined;
    const item = this.takeItem(itemId);
    return item && this.task(item.taskId);
  }

  private sectionsFor(task: MTask, roleId: Id): { title: string; body: string }[] {
    const sections: { title: string; body: string }[] = [];
    const brief = task.brief;
    // The opening instructions hold every note, so nothing waits in line behind them.
    task.queued.splice(0);
    // Every agent on the task sees all of the coordinator's notes, reviewers included.
    // A step started again hears what was said in its earlier attempt in that section of its own,
    // so those notes are left out here: nothing is heard twice.
    const fromEarlier = (task.stepAttempts ?? 0) > 1 ? ((task.stepNotes ?? []) as StepNote[]) : [];
    const notes = (task.notes ?? []).filter((note) => !fromEarlier.some((said) => (note.id !== undefined && note.id === said.id) || note.text === said.text)).map((note) => `- ${note.text}`);
    if (notes.length) sections.push({ title: "The coordinator's notes on this task (follow them; where they conflict with the brief or each other, the latest wins)", body: notes.join("\n\n") });
    if (brief && roleId !== "planner") {
      sections.push({
        title: "Design brief",
        body: [brief.summary, brief.forUsers.length ? `What changes for users:\n${brief.forUsers.map((line) => `- ${line}`).join("\n")}` : "", `Acceptance checklist:\n${brief.acceptance.map((item) => `- ${item.text}`).join("\n")}`, brief.risks.length ? `Risks:\n${brief.risks.map((line) => `- ${line}`).join("\n")}` : ""].filter(Boolean).join("\n\n"),
      });
    }
    const call = roleId === "architect" ? followingCall(task as unknown as Task) : undefined;
    if (call) {
      const due = dueAnswers(task.objections as Task["objections"], call);
      const open = due.filter((objection) => objection.status === "open");
      const settled = due.filter((objection) => objection.status !== "open");
      const earlier = task.objections.filter((objection) => !due.some((entry) => entry.id === objection.id));
      sections.push({ title: "The coordinator's call (final, exact words)", body: call.text });
      if (open.length || !settled.length) sections.push({ title: "Objections still open (answer every one by id)", body: open.length ? formatObjections(open) : "None. Every objection already has an answer." });
      // After changes asked for at the check, the architect answers these again, so it can correct a decision or a note.
      if (settled.length) sections.push({ title: "Objections answered after the call (answer every one again by id)", body: formatObjections(settled) });
      if (earlier.length) sections.push({ title: "Objections answered before the call", body: formatObjections(earlier as Task["objections"]) });
    } else if ((roleId === "architect" || roleId === "design-reviewer") && task.objections.length) {
      sections.push({ title: "Objections so far", body: formatObjections(task.objections as Task["objections"]) });
    }
    const checks = this.productOf(task)?.checks;
    if (roleId === "builder" && checks?.length) {
      sections.push({ title: "The product's checks (run every one in full before you finish)", body: checks.map((check) => `- ${check.name}: ${commandText(check.argv)}`).join("\n") });
    }
    if (roleId === "builder" && task.fixing) {
      const open = task.findings.filter((finding) => finding.status === "open" && finding.severity !== "pre-existing");
      if (open.length) sections.push({ title: "Review findings (answer every one by id; fix every Important one)", body: formatFindings(open as Task["findings"]) });
    }
    const reviewer = roleId === "code-reviewer" || roleId === "security-reviewer";
    const guide = reviewer || roleId === "verifier" || roleId === "builder" ? this.reviewGuide(task) : "";
    if (guide) {
      const how = roleId === "builder" ? "reviewers check every point" : "check the change against every point. It never excuses a problem, and a change to it in this branch is part of what you review";
      sections.push({ title: `The product's review guide (${GUIDE_FILE} on ${task.base ?? "the base branch"}, and points the coordinator accepted): ${how}`, body: guide });
    }
    if ((reviewer || roleId === "verifier" || roleId === "shipper" || roleId === "tester") && task.report) {
      sections.push({ title: "What the builder reports", body: [task.report.summary, ...task.report.changes.map((change) => `- ${change}`), task.report.tests ? `Tests: ${task.report.tests}` : ""].filter(Boolean).join("\n") });
    }
    if ((reviewer || roleId === "verifier" || roleId === "tester" || roleId === "shipper") && task.checks?.results.length) {
      const lines = task.checks.results.map((run) => `- ${run.name}: ${run.ok ? "passed" : run.timedOut ? "did not finish" : "failed"} in ${Math.max(1, Math.round(run.ms / 1000))}s (${run.command})`);
      sections.push({ title: "The product's checks, run by Petrina itself on this commit (evidence, not an agent's word)", body: lines.join("\n") });
    }
    if (reviewer && task.findings.length) sections.push({ title: "Findings so far (confirm or dispute by id)", body: formatFindings(task.findings as Task["findings"]) });
    if (roleId === "shipper") {
      const reviews = task.findings.filter((finding) => finding.status !== "dismissed");
      sections.push({ title: "Review summary (list pre-existing findings as follow-ups in what you deliver)", body: reviews.length ? formatFindings(reviews as Task["findings"]) : "Nothing to fix: every reviewer passed it." });
      if (task.shipping?.found) {
        sections.push({
          title: "An earlier attempt to ship this was interrupted",
          body: `What Petrina found: ${task.shipping.found}\nFinish that attempt instead of starting over. Reuse what it already did (a pushed branch, a version change, a tag). Do not choose a new version if one is already pushed, and never open a second pull request or publish a second release for this work.`,
        });
      }
    }
    return sections;
  }

  /**
   * One agent, one stage: run turns until it hands back a valid result. `status` keeps the task's
   * status line fixed while the agent works; `check` turns a valid but incomplete result into a repair.
   * `given` builds the opening instructions' sections, only when a fresh conversation gets them.
   * After a restart, the step's agent picks up its own conversation when the tool can reopen it.
   */
  private async turn<T>(
    task: MTask,
    roleId: Id,
    profileId: Id,
    given: () => { title: string; body: string }[],
    schema: z.ZodType<T>,
    signal: AbortSignal,
    options: { status?: string; check?: (value: T) => string | undefined } = {},
  ): Promise<T> {
    const role = this.role(roleId);
    const profile = this.profile(profileId);
    const product = this.productOf(task);
    if (!role || !profile || !product) throw new Error(`Unknown role or profile: ${roleId} on ${profileId}`);
    const taskId = task.id;
    // Paused, cancelled or stopped while getting here: no agent starts, and the task stays as the coordinator left it.
    if (signal.aborted) throw new Aborted();

    // A conversation noted before a restart: the same step and role carry on from where it was. Only the
    // same tool and model reopen it, and never the shipper: interrupted shipping is checked first.
    const step = this.stepKey(task);
    const model = profile.modelId ?? profile.model;
    const saved = task.conversation;
    const same = saved && saved.step === step && saved.roleId === roleId ? saved : undefined;
    // A conversation that never showed it got its instructions (Petrina stopped in between) starts again instead.
    const reopen = same && same.briefed && roleId !== "shipper" && same.toolId === profile.toolId && same.model === model ? same : undefined;
    let again = saved && !reopen ? (same ? (same.briefed || roleId === "shipper" ? "it now runs on a different tool or model" : "it had not received its instructions yet") : "the saved conversation was for another step") : undefined;
    const startedAt = same?.startedAt ?? Date.now();
    // Handed back by the coordinator: the note of what changed, until the agent hears it.
    const handback = same?.handback;
    task.stepAttempts = (task.stepAttempts ?? 0) + 1;

    task.agent = { roleId, profileId, since: Date.now(), step: 0 };
    task.state = "running";
    task.holdsSlot = true;
    task.column = this.columnFor(task);
    if (saved) {
      task.statusLine = options.status ?? `${role.name} is getting back to work`;
    } else {
      task.statusLine = options.status ?? `${role.name} is starting`;
      this.say(task, "system", `${role.name} joined · ${this.describe(roleId, profileId)}`, roleId, profileId);
      this.log(task, "milestone", `${role.name} started`, roleId, profileId);
    }
    this.commitNow();

    const live = () => this.task(taskId);
    const command = this.options.agentCommand?.(profile);
    // GitHub credentials only for a shipper that publishes to GitHub; local delivery needs none.
    const base = roleId === "shipper" && task.delivery !== "local" ? process.env : agentEnv(process.env, await this.emptyGhConfig());
    // Agents work in the background: tools that would pop a browser tab stay quiet, and Petrina's own `open` refuses.
    const env = { ...base, BROWSER: "none", PETRINA_AGENT: "1" };
    // The working copy as the step first found it: what the summary compares with, and what a read-only role leaves.
    const head = same?.head ?? (task.worktree ? await git.head(task.worktree).catch(() => undefined) : undefined);
    const start = (sessionId?: string) =>
      AgentRun.start({
        profile,
        ...(command ? { command } : {}),
        ...(env ? { env } : {}),
        cwd: task.worktree!,
        signal,
        ...(sessionId ? { reopen: sessionId, ...(this.options.reopenTimeoutMs ? { reopenTimeoutMs: this.options.reopenTimeoutMs } : {}) } : {}),
        callbacks: {
          onActivity: (line) => {
            const current = live();
            if (current) this.briefed(current);
            if (!current || current.state !== "running") return;
            current.statusLine = options.status ?? line;
            this.say(current, "activity", line, roleId, profileId);
            this.commit();
          },
          onPlanStep: (line) => {
            const current = live();
            if (!current) return;
            this.briefed(current);
            if (current.state === "running") current.statusLine = options.status ?? line;
            if (current.timeline.at(-1)?.text !== line) this.log(current, "status", line, roleId, profileId);
            this.commit();
          },
          onPermission: (info) => this.permission(taskId, info, signal),
          onLog: (text) => void this.agentLog(taskId, text),
        },
      });
    let run: AgentRun | undefined;
    if (reopen) {
      try {
        run = await start(reopen.sessionId);
      } catch (error) {
        if (signal.aborted || !(error instanceof ReopenFailed)) throw error;
        again = error.message;
      }
    }
    run ??= await start();
    this.runs.set(taskId, run);
    const picked = run.reopened !== undefined;
    const where = saved ? this.whereYouWere(task, role, startedAt) : undefined;
    if (picked && handback) {
      this.say(task, "system", `${role.name} took the step back on the same conversation · ${this.describe(roleId, profileId)}`, roleId, profileId);
      this.log(task, "milestone", "Took the step back on the same conversation", roleId, profileId);
    } else if (handback) {
      this.say(task, "system", `${role.name} carried on in a fresh conversation, with your note, because the one you drove could not be reopened · ${this.describe(roleId, profileId)}`, roleId, profileId);
      this.log(task, "milestone", `Carried on in a fresh conversation: ${again}`, roleId, profileId);
    } else if (picked) {
      this.say(task, "system", `${role.name} picked up where it left off · ${this.describe(roleId, profileId)}`, roleId, profileId);
      this.log(task, "milestone", "Picked up where it left off", roleId, profileId);
    } else if (saved) {
      this.say(task, "system", `${role.name} started this step again · ${this.describe(roleId, profileId)}`, roleId, profileId);
      this.log(task, "milestone", `Started this step again: ${again}`, roleId, profileId);
    }
    // On disk before the agent gets any work, so a restart from here on can reopen it. A fresh one replaces
    // the old note; a reopened one keeps the open question until the conversation hears the answer.
    const asked = picked ? reopen?.asked : undefined;
    if (roleId !== "shipper") task.conversation = { step, roleId, profileId, toolId: profile.toolId, model, sessionId: run.sessionId, ...(head ? { head } : {}), startedAt, ...(asked ? { asked } : {}), ...(picked ? { briefed: true } : {}), ...(picked && handback ? { handback } : {}) };
    this.commitNow();
    const headBefore = !role.canEdit ? head : undefined;
    try {
      // The last moment to notice a pause before the agent gets any work.
      if (signal.aborted || !live()) throw new Aborted();
      let opening: string;
      if (picked) {
        // One line about the restart (or the hand back), then only what the conversation has not heard: the answer to its open question, and messages still in line.
        const answer = asked?.answer !== undefined ? { question: asked.question, text: asked.answer } : undefined;
        if (task.conversation) {
          delete task.conversation.asked;
          delete task.conversation.handback;
        }
        const messages = task.queued.splice(0);
        for (const message of messages) {
          this.say(task, "you", message.text);
          this.log(task, "you", `You said: ${message.text}`);
        }
        const texts = messages.map((message) => message.text);
        opening = handback ? handBackPrompt(handback, texts) : restartPrompt(where!, { ...(answer ? { answer } : {}), messages: texts });
      } else {
        // Starting the step again: everything the coordinator said in it so far, in order, and after a restart, where it was.
        const files = where && !handback && head && task.worktree ? await git.changedSince(task.worktree, head) : [];
        if (signal.aborted || !live()) throw new Aborted();
        const earlier = task.stepAttempts > 1 ? ((task.stepNotes ?? []) as StepNote[]) : [];
        if (earlier.length) this.log(task, "you", `Handed on ${earlier.length} thing${earlier.length === 1 ? "" : "s"} you said in an earlier attempt at this step`, roleId, profileId);
        const sections = [...given()];
        if (earlier.length) sections.push({ title: EARLIER_ATTEMPT, body: formatStepNotes(earlier) });
        if (handback) sections.push({ title: HANDED_BACK, body: formatHandBack(handback, again ?? "") });
        else if (where) sections.push({ title: WHERE_YOU_WERE, body: formatWhereYouWere({ ...where, files }, again ?? "") });
        opening = buildPrompt({ task: task as unknown as Task, product: product as Product, role, roles: this.s.roles as Role[], profiles: this.s.profiles as AgentProfile[], worktree: task.worktree!, branch: task.branch!, base: task.base!, defaultBranch: product.defaultBranch ?? "main", sections });
      }
      // What it is about to hear is on disk first: a restart after this does not hand it over again.
      this.commitNow();
      let reply = await run.prompt(opening);
      this.briefed(task);
      for (let repairs = 0; ; ) {
        if (signal.aborted) throw new Aborted();
        const current = live();
        if (!current) throw new Aborted();
        const prose = proseOf(reply.text);
        if (prose) this.say(current, "agent", prose.length > 2400 ? `${prose.slice(0, 2400)}…` : prose, roleId, profileId);
        const message = current.queued.shift();
        if (message) {
          this.say(current, "you", message.text);
          this.log(current, "you", `You said: ${message.text}`);
          this.commitNow();
          reply = await run.prompt(`Message from the coordinator: ${message.text}\n\nTake it into account. When you are done, end with the result block again.`);
          continue;
        }
        if (reply.stopReason === "cancelled") {
          reply = await run.prompt("Continue where you left off. When you are done, end with the result block.");
          continue;
        }
        const parsed = parseResult(reply.text, schema);
        if (parsed.ok === "input") {
          const answer = await this.ask(current, role, profileId, parsed.question, parsed.options, signal);
          // Heard from here on: a restart does not hand the answer over again.
          if (current.conversation) delete current.conversation.asked;
          this.commitNow();
          reply = await run.prompt(`The coordinator answered: ${answer}\n\nContinue. When you are done, end with the result block.`);
          continue;
        }
        const error = parsed.ok === true ? options.check?.(parsed.value) : parsed.error;
        if (parsed.ok === true && !error) return parsed.value;
        repairs += 1;
        if (repairs > 2) throw new Error(`${role.name} did not hand back a usable result: ${error}`);
        reply = await run.prompt(repairPrompt(error ?? ""));
      }
    } finally {
      this.runs.delete(taskId);
      run.close();
      // A read-only role runs in its tool's automatic mode, so it could change things: leave the
      // working copy exactly as the step first found it, commits and uncommitted changes alike.
      if (headBefore && task.worktree && (await git.head(task.worktree).catch(() => headBefore)) !== headBefore) {
        await git.resetTo(task.worktree, headBefore);
        this.log(task, "warn", `Undid commits from ${role.name}, which is read-only`);
      }
      if (!role.canEdit && task.worktree && !(await git.isClean(task.worktree).catch(() => true))) {
        await git.discardChanges(task.worktree);
        this.log(task, "warn", `Undid changes from ${role.name}, which is read-only`);
      }
    }
  }

  /** The tool's own safety check flagged something: the coordinator decides. Petrina adds no rules of its own. */
  private async permission(taskId: Id, info: PermissionInfo, signal: AbortSignal): Promise<"allow" | "deny"> {
    const task = this.task(taskId);
    if (!task) return "deny";
    const tool = ADAPTERS[this.s.profiles.find((profile) => profile.id === task.agent?.profileId)?.toolId ?? ""]?.name ?? "The agent's tool";
    const detail = info.command ?? info.paths.join("\n");
    const answer = await this.wait(task, "permission", info.title, true, { body: `${tool}'s own safety check wants your OK before this.`, ...(detail ? { detail } : {}) }, signal, "Waiting for your permission");
    return answer === "allow" ? "allow" : "deny";
  }

  private ask(task: MTask, role: Role, _profileId: Id, question: string, options: string[], signal: AbortSignal): Promise<string> {
    this.say(task, "agent", question, role.id, task.agent?.profileId);
    this.log(task, "warn", `Asked you: ${question}`, role.id, task.agent?.profileId);
    return this.wait(task, "question", question, true, { options }, signal, "Waiting for your answer");
  }

  private wait(task: MTask, kind: InboxKind, title: string, blocking: boolean, extra: { body?: string; options?: string[]; detail?: string }, signal: AbortSignal, status: string): Promise<string> {
    const id = this.raise(task, kind, title, blocking, extra);
    task.statusLine = status;
    if (kind === "question" && task.conversation) {
      // A question survives a restart for the conversation that asked it.
      task.conversation.asked = { itemId: id, question: title };
      this.commitNow();
    } else {
      this.commit();
    }
    return new Promise<string>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      signal.addEventListener("abort", () => reject(new Aborted()), { once: true });
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private gate(task: MTask, gate: GateKind): void {
    delete task.agent;
    task.holdsSlot = false;
    const titles: Record<GateKind, string> = {
      plan: `Approve the plan for “${task.title}”`,
      design: `Check the design for “${task.title}”`,
      delivery: `Ready to ship “${task.title}”`,
    };
    const status: Record<GateKind, string> = {
      plan: "Plan ready. Waiting for your OK",
      design: callOn(task as unknown as Task, task.stageIndex) ? CALL_WORDS.waiting : "Design settled. Waiting for your check",
      delivery: "Reviews done. Waiting for your OK to ship",
    };
    const body = gate === "design" ? callCheckBody(task as unknown as Task) : gate === "delivery" ? deliveryLines(task as unknown as Task) : undefined;
    this.raise(task, gate, titles[gate], false, body ? { body } : {});
    task.statusLine = status[gate];
    task.column = gate === "plan" ? "planning" : gate === "design" ? "designing" : "ready";
    // On disk before the window shows it: an answer to this check must find it after any restart.
    this.commitNow();
  }

  private raise(task: MTask, kind: InboxKind, title: string, blocking: boolean, extra: { body?: string; options?: string[]; detail?: string } = {}): Id {
    const id = this.id("inbox");
    task.state = "needs-you";
    this.s.inbox.push({
      id,
      taskId: task.id,
      kind,
      title,
      at: Date.now(),
      blocking,
      ...(task.agent ? { roleId: task.agent.roleId, profileId: task.agent.profileId } : {}),
      ...(extra.body ? { body: extra.body } : {}),
      ...(extra.options ? { options: extra.options } : {}),
      ...(extra.detail ? { detail: extra.detail } : {}),
    });
    return id;
  }

  private fail(taskId: Id, error: unknown): void {
    const task = this.task(taskId);
    if (!task) return;
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

  private remember(task: MTask, text: string, id?: Id): void {
    task.notes = [...(task.notes ?? []), { at: Date.now(), text, ...(id ? { id } : {}) }];
  }

  /** Keep what the coordinator said for the current step, until the step finishes. */
  private stepNote(task: MTask, kind: StepNote["kind"], text: string, extra: { id?: Id; about?: string } = {}): void {
    task.stepNotes = [...(task.stepNotes ?? []), { id: extra.id ?? this.id(task.id), at: Date.now(), kind, text, ...(extra.about ? { about: extra.about } : {}) }];
  }

  /**
   * The product's checks. The Check finder works them out once per product, and again only when the
   * CI or build files it read have changed or a check could not even start. Checks the coordinator set
   * by hand are never replaced. Runs inside a step that already holds an agent slot.
   */
  private async ensureChecks(task: MTask, signal: AbortSignal): Promise<readonly ProductCheck[]> {
    const product = this.productOf(task);
    if (!product || !task.worktree) return [];
    if (product.checksBy === "coordinator") return product.checks ?? [];
    const fingerprint = checksFingerprint(task.worktree);
    const unstartable = task.checks?.results.some((run) => run.output.startsWith("Could not start")) ?? false;
    if (product.checks && product.checksFingerprint === fingerprint && !unstartable) return product.checks;
    const declared = detectChecks(task.worktree);
    // A side errand inside the step: it leaves the step's own restart bookkeeping as it found it.
    const attempts = task.stepAttempts;
    const conversation = task.conversation;
    const restore = () => {
      if (attempts === undefined) delete task.stepAttempts;
      else task.stepAttempts = attempts;
      if (conversation === undefined) delete task.conversation;
      else task.conversation = conversation;
    };
    const why = !product.checks ? "first time" : unstartable ? "a check could not start" : "the CI or build files changed";
    try {
      const result = await this.turn(
        task,
        "check-finder",
        CHECK_FINDER_PROFILE,
        () => [
          ...this.sectionsFor(task, "check-finder"),
          ...(product.checks ? [{ title: "The checks used until now", body: product.checks.map((check) => `- ${check.name}: ${commandText(check.argv)}`).join("\n") }] : []),
          ...(declared.length ? [{ title: "Commands the repository declares (a starting point, not the answer)", body: declared.map((check) => `- ${check.name}: ${commandText(check.argv)}`).join("\n") }] : []),
        ],
        CheckFinderResult,
        signal,
        { status: "Working out how to check this product" },
      );
      restore();
      product.checks = result.checks.map((check) => ({ name: check.name, argv: check.argv, why: check.why }));
      this.log(task, "done", `Found how to check ${product.name} (${why}): ${product.checks.map((check) => check.name).join(", ")}`, "check-finder", CHECK_FINDER_PROFILE);
    } catch (error) {
      if (signal.aborted || error instanceof Aborted) throw error;
      restore();
      const fallback: ProductCheck[] = product.checks ? [...product.checks] : declared;
      product.checks = fallback.map((check) => ({ name: check.name, argv: [...check.argv], ...(check.why ? { why: check.why } : {}) }));
      this.log(task, "warn", `The Check finder could not finish, so Petrina uses ${fallback.length ? "the checks it had" : "no checks"} for now`);
    }
    product.checksBy = "finder";
    product.checksFingerprint = fingerprint;
    this.commit();
    return product.checks ?? [];
  }

  /** Petrina runs the product's checks itself, without credentials. Failures become blocking findings, with the output as evidence. */
  private async runProductChecks(task: MTask, checks: readonly ProductCheck[], signal: AbortSignal): Promise<number> {
    if (!checks.length || !task.worktree) return 0;
    task.statusLine = "Running the product's checks";
    this.commit();
    const env = { ...agentEnv(process.env, await this.emptyGhConfig()), CI: "1", BROWSER: "none", PETRINA_AGENT: "1" };
    const results = await runChecks(task.worktree, checks, env, this.options.checkTimeoutMs, signal);
    if (signal.aborted) throw new Aborted();
    const sha = await git.head(task.worktree).catch(() => undefined);
    task.checks = { at: Date.now(), ...(sha ? { sha } : {}), results };
    const failed = results.filter((run) => !run.ok);
    // An earlier failure settles on this run, whatever anyone answered about it.
    for (const finding of task.findings) {
      if (finding.raisedBy === "petrina" && finding.status === "open" && finding.text.startsWith("Check failed") && !failed.some((run) => finding.text === `Check failed: ${run.name} (${run.command})`)) finding.status = "fixed";
    }
    for (const run of failed) {
      const text = `Check failed: ${run.name} (${run.command})`;
      if (task.findings.some((finding) => finding.text === text && finding.status === "open")) continue;
      task.findings.push({ id: this.id(task.id), text, evidence: run.output.slice(-1500), severity: "blocking", raisedBy: "petrina", confirmedBy: [], status: "open" });
    }
    this.log(task, failed.length ? "warn" : "done", failed.length ? `Checks: ${failed.length} of ${results.length} failed (${failed.map((run) => run.name).join(", ")})` : `Checks passed: ${results.map((run) => run.name).join(", ")}`);
    this.commit();
    return failed.length;
  }

  /**
   * Right before the delivery check: the checks run again when the code changed since they last ran.
   * A failure sends the work back to the builder, twice at most; after that the coordinator sees it.
   */
  private async checksBeforeDelivery(task: MTask, signal: AbortSignal): Promise<boolean> {
    const product = this.productOf(task);
    if (!task.worktree || !product?.checks?.length) return false;
    const sha = await git.head(task.worktree).catch(() => undefined);
    if (sha && task.checks?.sha === sha && task.checks.results.every((run) => run.ok)) return false;
    if ((await this.runProductChecks(task, product.checks, signal)) === 0) return false;
    const builder = lastIndex(task.plan?.stages ?? [], (entry, index) => index < task.stageIndex && entry.roleId === "builder");
    if (builder < 0 || (task.checkReturns ?? 0) >= 2) return false;
    task.checkReturns = (task.checkReturns ?? 0) + 1;
    task.stageIndex = builder;
    task.sub = 0;
    task.fixing = true;
    this.log(task, "warn", "Sent back to the builder: the checks failed right before your delivery check");
    this.commit();
    return true;
  }

  /**
   * The coordinator sent back a delivery every reviewer passed: the Guide keeper proposes one point for
   * the product's review guide, offered in the inbox without holding the task up. A side errand inside
   * the builder's step: it leaves the step's own restart bookkeeping as it found it.
   */
  private async proposeGuideLine(task: MTask, signal: AbortSignal): Promise<void> {
    const product = this.productOf(task);
    const miss = task.miss;
    if (!product || !miss || !task.worktree) return;
    const attempts = task.stepAttempts;
    const conversation = task.conversation;
    const restore = () => {
      if (attempts === undefined) delete task.stepAttempts;
      else task.stepAttempts = attempts;
      if (conversation === undefined) delete task.conversation;
      else task.conversation = conversation;
    };
    try {
      const guide = this.reviewGuide(task);
      const result = await this.turn(
        task,
        "guide-keeper",
        GUIDE_KEEPER_PROFILE,
        () => [
          { title: "The coordinator's note when sending the delivery back", body: miss.note },
          { title: `The review guide now (${GUIDE_FILE})`, body: guide || "There is none yet." },
          ...(task.findings.length ? [{ title: "What the reviewers did raise", body: formatFindings(task.findings as Task["findings"]) }] : []),
        ],
        GuideResult,
        signal,
        { status: "Looking for what the reviewers missed" },
      );
      restore();
      if (!result.missed || !result.line) this.log(task, "done", `Nothing for the review guide: ${result.why}`, "guide-keeper", GUIDE_KEEPER_PROFILE);
      else if (inGuide(guide, result.line)) this.log(task, "done", "The review guide already has that point", "guide-keeper", GUIDE_KEEPER_PROFILE);
      else {
        // An offer, not a stop: the task carries on while the coordinator decides.
        const state = task.state;
        this.raise(task, "guide", `Add a point to ${product.name}'s review guide?`, false, { body: result.line, detail: result.why });
        task.state = state;
        this.log(task, "done", `Proposed a point for the review guide: ${result.line}`, "guide-keeper", GUIDE_KEEPER_PROFILE);
      }
    } catch (error) {
      if (signal.aborted || error instanceof Aborted) throw error;
      restore();
      this.log(task, "warn", "The Guide keeper could not finish, so nothing was proposed for the review guide");
    }
    delete task.miss;
    this.commit();
  }

  /**
   * Accepted points reach REVIEW.md on a branch that ships: the task they came from, or else the next
   * one to reach its delivery check. Nothing is running in the working copy at this point.
   */
  private async writeGuide(task: MTask): Promise<void> {
    const product = this.productOf(task);
    if (!product?.reviewGuide?.length || !task.worktree) return;
    const free = (line: { writtenOn?: Id }) => !line.writtenOn || line.writtenOn === task.id || ["cancelled", "failed"].includes(this.task(line.writtenOn)?.state ?? "cancelled");
    let due: DeepMutable<GuideLine>[];
    try {
      const file = localGuide(task.worktree);
      due = product.reviewGuide.filter((line) => !inGuide(file, line.text) && free(line));
      if (!due.length) return;
      appendToGuide(task.worktree, due.map((line) => line.text));
    } catch (error) {
      this.log(task, "warn", `The review guide was not updated: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    await git.commitAll(task.worktree, `Review guide: ${due.length === 1 ? "one more point" : `${due.length} more points`}\n\n${due.map((line) => `- ${line.text}`).join("\n")}\n\nAdded by Petrina: the coordinator accepted ${due.length === 1 ? "it" : "them"} after reviewers missed something.`);
    for (const line of due) line.writtenOn = task.id;
    this.log(task, "done", `Added to ${GUIDE_FILE}: ${due.map((line) => line.text).join("; ")}`);
    this.commit();
  }

  /** The guide as the base branch has it, never as the change under review has it, plus the points the coordinator accepted. */
  private reviewGuide(task: MTask): string {
    const base = task.worktree && task.base ? (git.fileAt(task.worktree, task.base, GUIDE_FILE) ?? "") : "";
    return guideText(base, this.productOf(task)?.reviewGuide ?? []);
  }

  /** Low-risk work skips the delivery check only where the coordinator opted in, with nothing left that needs them. */
  private shipsUnasked(task: MTask): boolean {
    if (task.risk?.level !== "low" || !this.productOf(task)?.shipLowRisk) return false;
    if (task.findings.some((finding) => finding.status === "open" && finding.severity === "blocking")) return false;
    return task.checks?.results.every((run) => run.ok) ?? true;
  }

  /** The step handed back its result: the next step starts clean, in a new conversation. */
  private finishStep(task: MTask): void {
    delete task.stepNotes;
    delete task.stepAttempts;
    delete task.conversation;
  }

  /** Which step a task is on: its stage (or the plan), the design round and the reviewer position. */
  private stepKey(task: MTask): string {
    if (task.stageIndex < 0) return "plan";
    const stage = task.plan?.stages[task.stageIndex];
    return `${stage?.id ?? task.stageIndex} round ${stage ? (task.rounds[stage.id] ?? 1) : 1} position ${task.sub}${task.fixing ? " fixing" : ""}`;
  }

  /** The step in the coordinator's words, for an agent coming back to it. */
  private stepTitle(task: MTask): string {
    if (task.stageIndex < 0) return "Planning";
    const stage = task.plan?.stages[task.stageIndex];
    if (!stage) return "this step";
    if (stage.kind === "converge") return `${stage.title}, round ${task.rounds[stage.id] ?? 1}`;
    if (stage.kind === "review-chain") return `${stage.title}, reviewer ${task.sub + 1} of ${stage.profileIds.length}`;
    return task.fixing ? `${stage.title}, fixing review findings` : stage.title;
  }

  /** Where an agent was in its step: the stage, its role, and its last activity and plan steps since the step started. */
  private whereYouWere(task: MTask, role: Role, since: number): WhereYouWere {
    const done = [
      ...task.session.filter((line) => line.from === "activity" && line.roleId === role.id && line.at >= since),
      ...task.timeline.filter((entry) => entry.tone === "status" && entry.roleId === role.id && entry.at >= since),
    ]
      .sort((a, b) => a.at - b.at)
      .map((entry) => entry.text)
      .filter((text, index, all) => text !== all[index - 1]);
    return { stage: this.stepTitle(task), role: role.name, done: done.slice(-MAX_DONE) };
  }

  /** False for a resend of something already received (its confirmation was lost on the way back). */
  private firstTime(task: MTask, clientId: Id | undefined): boolean {
    if (!clientId) return true;
    if (task.received?.includes(clientId)) return false;
    task.received = [...(task.received ?? []), clientId].slice(-50);
    return true;
  }

  private toWaiting(task: MTask): void {
    task.state = "waiting";
    task.statusLine = "Waiting for a free slot";
    task.column = this.columnFor(task);
  }

  private unblock(task: MTask): void {
    if (task.state !== "needs-you") return;
    task.state = task.holdsSlot ? "running" : "waiting";
    task.statusLine = task.holdsSlot ? "Back to work" : "Waiting for a free slot";
  }

  private takeItem(itemId: Id): DeepMutable<InboxItem> | undefined {
    const item = this.s.inbox.find((entry) => entry.id === itemId);
    if (item) this.s.inbox = this.s.inbox.filter((entry) => entry.id !== itemId);
    return item;
  }

  private dropBlockingItems(taskId: Id): void {
    for (const item of this.s.inbox.filter((entry) => entry.taskId === taskId && entry.blocking)) {
      this.waiting.get(item.id)?.reject(new Aborted());
      this.waiting.delete(item.id);
    }
    this.s.inbox = this.s.inbox.filter((entry) => !(entry.taskId === taskId && entry.blocking));
  }

  private stopDriver(taskId: Id): void {
    this.drivers.get(taskId)?.abort();
    this.drivers.delete(taskId);
    this.runs.get(taskId)?.close();
    this.runs.delete(taskId);
  }

  private async undoReadOnly(task: MTask, roleId: Id): Promise<void> {
    const role = this.role(roleId);
    if (role && !role.canEdit && task.worktree && !(await git.isClean(task.worktree))) {
      await git.discardChanges(task.worktree);
      this.log(task, "warn", `Undid changes from ${role.name}, which is read-only`);
    }
  }

  private columnFor(task: MTask): Column {
    if (task.state === "cancelled" || task.state === "done") return "done";
    if (task.state === "pr-open") return "ready";
    if (task.state === "queued") return "queue";
    if (task.stageIndex < 0) return "planning";
    const stage = task.plan?.stages[task.stageIndex];
    if (!stage) return "ready";
    if (stage.kind === "gate") return stage.gate === "plan" ? "planning" : stage.gate === "design" ? "designing" : "ready";
    if (stage.kind === "review-chain") return "reviewing";
    return this.role(stage.roleId)?.column ?? "building";
  }

  private async pollPullRequests(): Promise<void> {
    for (const task of this.s.tasks.filter((entry) => entry.state === "pr-open" && entry.pr && entry.worktree)) {
      const repo = this.productOf(task)?.repo;
      const state = repo ? await git.prState(repo, task.pr!.number, this.options.gh).catch(() => undefined) : undefined;
      if (state === "merged" || state === "closed") {
        task.pr!.state = state === "merged" ? "merged" : "open";
        task.state = "done";
        task.column = "done";
        task.finishedAt = Date.now();
        task.statusLine = state === "merged" ? `Merged #${task.pr!.number} on GitHub` : `Closed #${task.pr!.number} without merging`;
        this.log(task, "done", task.statusLine);
        this.commit();
        // Tasks waiting for this one to land can start now.
        this.schedule();
      }
    }
  }

  /**
   * After a restart, nothing is running: put interrupted work back in line. A question stays in the
   * inbox for the conversation that asked it, without a slot; an open permission request goes.
   */
  private recover(): void {
    const keep = (item: InboxItem) => {
      if (!item.blocking) return true;
      const task = this.task(item.taskId);
      return item.kind === "question" && task?.state === "needs-you" && task.conversation?.asked?.itemId === item.id;
    };
    for (const item of this.s.inbox.filter((entry) => entry.kind === "permission" && !keep(entry))) {
      const task = this.task(item.taskId);
      if (task) this.log(task, "warn", `Petrina restarted before you answered “${item.title}”, so it left your inbox. The agent will ask again if it still needs to`, item.roleId, item.profileId);
    }
    this.s.inbox = this.s.inbox.filter(keep);
    for (const task of this.s.tasks) {
      if (task.driving) {
        // Still in the coordinator's hands: the step keeps its seat, and Hand back works as before.
        task.state = "needs-you";
        task.holdsSlot = true;
        continue;
      }
      if (this.s.inbox.some((item) => item.taskId === task.id && item.blocking)) {
        task.statusLine = "Waiting for your answer";
        delete task.agent;
      } else if (["running", "waiting"].includes(task.state) || (task.state === "needs-you" && !this.s.inbox.some((item) => item.taskId === task.id))) {
        task.state = "waiting";
        task.statusLine = "Waiting for a free slot";
        delete task.agent;
      }
      task.holdsSlot = false;
    }
  }

  private empty(): State {
    return { now: Date.now(), seq: 0, products: [], roles: BUILT_IN_ROLES, tools: [], profiles: ENGINE_PROFILES, tasks: [], inbox: [], pool: { limit: 3, paused: false, toolCaps: { "claude-code": 3, codex: 3 } } };
  }

  private renumberQueue(): void {
    queueOf(this.s.tasks as Task[]).forEach((task, position) => {
      const entry = this.task(task.id);
      if (entry) entry.priority = position;
    });
  }

  private task(id: Id): MTask | undefined {
    return this.s.tasks.find((task) => task.id === id);
  }

  private productOf(task: MTask) {
    return this.s.products.find((product) => product.id === task.productId);
  }

  private role(id: Id): Role | undefined {
    return this.s.roles.find((role) => role.id === id) as Role | undefined;
  }

  private profile(id: Id): AgentProfile | undefined {
    return this.s.profiles.find((profile) => profile.id === id) as AgentProfile | undefined;
  }

  private describe(roleId: Id, profileId: Id): string {
    const profile = this.profile(profileId);
    const tool = this.s.tools.find((entry) => entry.id === profile?.toolId);
    return `${this.role(roleId)?.name ?? roleId} on ${tool?.name ?? profile?.toolId} · ${profile?.model} · ${profile?.effort}`;
  }

  private id(prefix: string): Id {
    this.s.seq += 1;
    return `${prefix}-${this.s.seq}`;
  }

  private log(task: MTask, tone: Task["timeline"][number]["tone"], text: string, roleId?: Id, profileId?: Id): void {
    task.timeline.push({ id: this.id(task.id), at: Date.now(), text, tone, ...(roleId ? { roleId } : {}), ...(profileId ? { profileId } : {}) });
    if (task.timeline.length > MAX_TIMELINE) task.timeline.splice(0, task.timeline.length - MAX_TIMELINE);
  }

  private say(task: MTask, from: Task["session"][number]["from"], text: string, roleId?: Id, profileId?: Id): void {
    const last = task.session.at(-1);
    if (from === "activity" && last?.from === "activity" && last.text === text) return;
    task.session.push({ id: this.id(task.id), at: Date.now(), from, text, ...(roleId ? { roleId } : {}), ...(profileId ? { profileId } : {}) });
    if (task.session.length > MAX_SESSION_LINES) task.session.splice(0, task.session.length - MAX_SESSION_LINES);
  }

  private async emptyGhConfig(): Promise<string> {
    const dir = join(this.dataDir, "gh-none");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /** The agent showed it has its instructions: from now on a restart may reopen its conversation. */
  private briefed(task: MTask): void {
    if (!task.conversation || task.conversation.briefed) return;
    task.conversation.briefed = true;
    this.commitNow();
  }

  private async agentLog(taskId: Id, text: string): Promise<void> {
    const dir = join(this.dataDir, "logs");
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, `${taskId}.log`), text).catch(() => undefined);
  }

  private commit(): void {
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
  private commitNow(): void {
    if (this.stopped) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.store.save(this.getState());
    this.s.now = Date.now();
    for (const listener of this.listeners) listener();
  }
}

/**
 * A later reviewer thinks findings are wrong: each dispute is kept with who and why. One reviewer's
 * dispute dismisses a finding nobody else backed; Petrina's own checks and confirmed findings stay open.
 */
export function recordDisputes(findings: DeepMutable<Finding>[], disputes: readonly { id: string; reason: string }[], by: Id, at: number): void {
  for (const dispute of disputes) {
    const finding = findings.find((entry) => entry.id === dispute.id);
    if (!finding || finding.status !== "open") continue;
    finding.disputes = [...(finding.disputes ?? []), { by, reason: dispute.reason, at }];
    if (finding.raisedBy !== "petrina" && finding.confirmedBy.length === 0) finding.status = "dismissed";
  }
}

/** What a reviewer's tag means for the finding. */
const SEVERITY = { important: "blocking", nit: "suggestion", "pre-existing": "pre-existing" } as const;

/** The same finding, however it is spaced or capitalised. */
function sameFinding(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const RISK_WORD: Record<RiskLevel, string> = { low: "Low", medium: "Medium", high: "High" };

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

function lastIndex<T>(items: readonly T[], match: (item: T, index: number) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) if (match(items[index]!, index)) return index;
  return -1;
}
