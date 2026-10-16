// The real engine: the same state the UI renders, driven by real agents over ACP.
// Each task runs as one async driver while it holds a pool slot. Gates and the queue
// live in state; questions and permissions wait on the coordinator in code.

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  BUILT_IN_ROLES,
  deliveryStages,
  pickStarts,
  queueOf,
  slotUses,
  type AgentProfile,
  type Candidate,
  type Column,
  type DeliveryMode,
  type GateKind,
  type Id,
  type InboxItem,
  type InboxKind,
  type Product,
  type Role,
  type Stage,
  type State,
  type Task,
  type TaskKind,
  type Tone,
} from "@petrina/core";
import type { z } from "zod";
import { AgentRun, type PermissionInfo } from "./acp-run.js";
import * as git from "./git.js";
import { agentEnv } from "./env.js";
import {
  BriefResult,
  BuildResult,
  buildPrompt,
  formatFindings,
  formatObjections,
  NotesResult,
  ObjectionsResult,
  parseResult,
  PlanResult,
  proseOf,
  repairPrompt,
  ReviewResult,
  ShipResult,
  TestResult,
} from "./prompts.js";
import { Store } from "./store.js";
import { ADAPTERS, detectTools, ENGINE_PROFILES } from "./tools.js";

type DeepMutable<T> = T extends readonly (infer U)[] ? DeepMutable<U>[] : T extends object ? { -readonly [K in keyof T]: DeepMutable<T[K]> } : T;
type MState = DeepMutable<State>;
type MTask = DeepMutable<Task>;
type MStage = DeepMutable<Stage>;

const PLANNER_PROFILE = "opus-high";
const SHIPPER_PROFILE = "opus-high";
const TONES: readonly Tone[] = ["blue", "green", "orange", "violet", "pink", "teal", "indigo", "purple", "amber", "slate"];
const MAX_SESSION_LINES = 800;
const MAX_TIMELINE = 400;

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

  constructor(
    private readonly dataDir: string,
    private readonly options: { agentCommand?: (profile: AgentProfile) => readonly string[] | undefined } = {},
  ) {
    this.store = new Store(join(dataDir, "petrina.db"));
    const loaded = this.store.load();
    this.s = (loaded ?? this.empty()) as MState;
    this.s.roles = BUILT_IN_ROLES as MState["roles"];
    this.s.profiles = ENGINE_PROFILES as MState["profiles"];
    this.s.tools = detectTools() as MState["tools"];
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

  shutdown(): void {
    for (const timer of this.timers) clearInterval(timer);
    for (const controller of this.drivers.values()) controller.abort();
    for (const run of this.runs.values()) run.close();
    this.store.save(this.getState());
    this.store.close();
  }

  // ── Products ───────────────────────────────────────────────────────────

  async addProduct(path: string): Promise<Id> {
    const info = await git.repoInfo(path);
    const existing = this.s.products.find((product) => product.path === info.root);
    if (existing) return existing.id;
    const base = info.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "product";
    let id = base;
    for (let n = 2; this.s.products.some((product) => product.id === id); n += 1) id = `${base}-${n}`;
    this.s.products.push({
      id,
      name: info.name.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
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
    product.delivery = delivery;
    product.approveDelivery = approveDelivery;
    this.commit();
  }

  removeProduct(productId: Id): void {
    if (this.s.tasks.some((task) => task.productId === productId && !["done", "cancelled"].includes(task.state))) throw new Error("This product still has work in progress");
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

  setHeld(taskId: Id, held: boolean): void {
    const task = this.task(taskId);
    if (!task) return;
    task.held = held;
    this.log(task, "you", held ? "You put it on hold" : "You released the hold");
    this.commit();
    this.schedule();
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

  // ── Task control ───────────────────────────────────────────────────────

  pause(taskId: Id): void {
    const task = this.task(taskId);
    if (!task || !["running", "needs-you", "waiting"].includes(task.state)) return;
    this.stopDriver(taskId);
    task.state = "paused";
    task.holdsSlot = false;
    delete task.agent;
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
    this.stopDriver(taskId);
    task.state = "cancelled";
    task.column = "done";
    task.holdsSlot = false;
    delete task.agent;
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

  sendMessage(taskId: Id, text: string, mode: "queue" | "interrupt" = "queue"): void {
    const task = this.task(taskId);
    const trimmed = text.trim();
    if (!task || !trimmed) return;
    this.remember(task, trimmed);
    const message = { id: this.id(taskId), text: trimmed, at: Date.now() };
    const run = this.runs.get(taskId);
    if (mode === "interrupt" && run) {
      task.queued.unshift(message);
      this.say(task, "system", "You interrupted the current step");
      this.commit();
      void run.cancel();
      return;
    }
    task.queued.push(message);
    this.commit();
  }

  removeQueued(taskId: Id, messageId: Id): void {
    const task = this.task(taskId);
    if (!task) return;
    task.queued = task.queued.filter((message) => message.id !== messageId);
    this.commit();
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

  answer(itemId: Id, answer: string): void {
    const item = this.takeItem(itemId);
    if (!item) return;
    const task = this.task(item.taskId);
    if (task) {
      this.say(task, "you", answer);
      this.log(task, "you", `You answered: ${answer}`);
      this.unblock(task);
    }
    this.waiting.get(itemId)?.resolve(answer);
    this.waiting.delete(itemId);
    this.commit();
  }

  decideForMe(itemId: Id): void {
    const item = this.s.inbox.find((entry) => entry.id === itemId);
    if (!item) return;
    this.answer(itemId, item.options?.[0] ?? "Use your best judgment.");
  }

  allow(itemId: Id, _scope: "once" | "always" = "once"): void {
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

  deny(itemId: Id, note?: string): void {
    const item = this.takeItem(itemId);
    if (!item) return;
    const task = this.task(item.taskId);
    if (task) {
      this.log(task, "you", note ? `You said no: ${note}` : `You said no to: ${item.title}`);
      if (note) this.remember(task, note);
      if (note) task.queued.push({ id: this.id(task.id), text: note, at: Date.now() });
      this.unblock(task);
    }
    this.waiting.get(itemId)?.resolve("deny");
    this.waiting.delete(itemId);
    this.commit();
  }

  approve(itemId: Id): void {
    if (this.s.inbox.find((entry) => entry.id === itemId)?.kind === "stuck") {
      this.retry(itemId);
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
        task.stageIndex += 1;
        break;
      case "disagreement":
        this.log(task, "you", "You sided with the architect");
        for (const objection of task.objections) if (objection.status === "open") objection.status = "rejected";
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

  requestChanges(itemId: Id, note: string): void {
    const item = this.takeItem(itemId);
    const task = item && this.task(item.taskId);
    if (!item || !task) return;
    this.log(task, "you", `You asked for changes: ${note}`);
    this.say(task, "you", note);
    this.remember(task, note);
    task.queued.push({ id: this.id(task.id), text: note, at: Date.now() });
    const stages = task.plan?.stages ?? [];
    if (item.kind === "plan") {
      task.stageIndex = -1;
      delete task.plan;
    } else if (item.kind === "design" || item.kind === "disagreement") {
      const index = stages.findIndex((stage) => stage.kind === "converge");
      if (index >= 0) {
        task.stageIndex = index;
        task.rounds[stages[index]!.id] = (task.rounds[stages[index]!.id] ?? 1) + 1;
      }
    } else if (item.kind === "delivery") {
      const index = lastIndex(stages, (stage) => stage.roleId === "builder" && stage.kind === "do");
      if (index >= 0) {
        task.stageIndex = index;
        task.fixing = true;
      }
    }
    task.sub = 0;
    this.toWaiting(task);
    this.commit();
    this.schedule();
  }

  // ── Scheduling ─────────────────────────────────────────────────────────

  private schedule(): void {
    const candidates: Candidate[] = [];
    const tool = (profileId: Id) => this.profile(profileId)?.toolId ?? "unknown";
    for (const task of this.s.tasks.filter((entry) => entry.state === "waiting").sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))) {
      const next = this.nextAgent(task);
      candidates.push({ taskId: task.id, toolId: next ? tool(next.profileId) : "none" });
    }
    for (const task of queueOf(this.s.tasks as Task[])) if (!task.held) candidates.push({ taskId: task.id, toolId: tool(PLANNER_PROFILE) });

    for (const taskId of pickStarts({ candidates, inUse: slotUses(this.getState()), pool: this.s.pool })) {
      const task = this.task(taskId);
      if (!task || this.drivers.has(taskId)) continue;
      if (task.state === "queued") {
        task.startedAt = Date.now();
        task.stageIndex = -1;
        this.log(task, "milestone", "Started from the queue");
      }
      task.state = "running";
      task.holdsSlot = true;
      task.statusLine = "Getting ready";
      void this.drive(taskId);
    }
    this.commit();
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
      case "review-chain":
        return { roleId: stage.roleId, profileId: stage.profileIds[task.sub] ?? stage.profileIds[0] ?? PLANNER_PROFILE };
      case "gate":
        return undefined;
    }
  }

  // ── The task driver ────────────────────────────────────────────────────

  private async drive(taskId: Id): Promise<void> {
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
        const stage = current.plan?.stages[current.stageIndex];
        if (!stage) throw new Error("The plan ended without a delivery");
        if (stage.kind === "gate") {
          this.gate(current, stage.gate ?? "delivery");
          return;
        }
        const next = stage.kind === "do" ? await this.runDo(current, stage, signal) : stage.kind === "converge" ? await this.runConverge(current, stage, signal) : await this.runReview(current, stage, signal);
        if (next === "stop") return;
      }
    } catch (error) {
      if (signal.aborted || error instanceof Aborted) return;
      this.fail(taskId, error);
    } finally {
      if (this.drivers.get(taskId) === controller) this.drivers.delete(taskId);
      this.schedule();
    }
  }

  private async prepare(task: MTask): Promise<void> {
    const product = this.productOf(task);
    if (!product?.path) throw new Error(`${product?.name ?? "This product"} has no local copy`);
    const branch = task.branch ?? git.branchName(task.title, task.id);
    const worktree = task.worktree ?? join(this.dataDir, "worktrees", product.id, task.id);
    const { base } = await git.ensureWorktree(product.path, worktree, branch, product.defaultBranch ?? "main");
    if (!task.branch) this.log(task, "milestone", "Set up a fresh working copy");
    task.branch = branch;
    task.worktree = worktree;
    task.base = task.base ?? base;
    this.commit();
  }

  private async runPlanner(task: MTask, signal: AbortSignal): Promise<void> {
    const result = await this.turn(task, "planner", PLANNER_PROFILE, [], PlanResult, signal);
    task.plan = this.normalizePlan(task, result);
    const count = task.plan.stages.filter((stage) => stage.kind !== "gate").length;
    this.log(task, "milestone", `Plan ready: ${count} stages. ${result.rationale}`, "planner", PLANNER_PROFILE);
    this.commit();
  }

  private normalizePlan(task: MTask, result: z.infer<typeof PlanResult>): DeepMutable<NonNullable<Task["plan"]>> {
    const roles = new Set(this.s.roles.map((role) => role.id));
    const profile = (id: string | undefined, fallback: string) => (id && this.profile(id) ? id : fallback);
    const stages: MStage[] = [];
    result.stages.forEach((raw, index) => {
      if (!roles.has(raw.roleId) || raw.roleId === "shipper" || raw.roleId === "planner") return;
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
    stages.push(...(deliveryStages(task as unknown as Task, SHIPPER_PROFILE) as MStage[]));
    return { stages, rationale: result.rationale, plannerProfileId: PLANNER_PROFILE };
  }

  private async runDo(task: MTask, stage: MStage, signal: AbortSignal): Promise<"continue" | "stop"> {
    const roleId = stage.roleId;
    const profileId = stage.profileIds[0] ?? "opus-xhigh";
    const role = this.role(roleId);
    const sections = this.sectionsFor(task, roleId);

    if (roleId === "builder") {
      const result = await this.turn(task, roleId, profileId, sections, BuildResult, signal);
      const label = this.describe(roleId, profileId);
      const sha = await git.commitAll(task.worktree!, `${task.title}${task.fixing ? " (review fixes)" : ""}\n\n${result.summary}\n\n${result.changes.map((change) => `- ${change}`).join("\n")}\n\nBuilt by Petrina: ${label}`);
      task.report = { summary: result.summary, changes: result.changes, ...(result.tests ? { tests: result.tests } : {}) };
      if (task.fixing) {
        for (const finding of task.findings) if (finding.status === "open" && finding.severity === "blocking") finding.status = "fixed";
        task.fixing = false;
      }
      this.log(task, "done", sha ? `Build done: ${result.summary}` : "Build done, with no changes to the code", roleId, profileId);
    } else if (roleId === "shipper") {
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
    task.stageIndex += 1;
    task.sub = 0;
    this.commit();
    return "continue";
  }

  private async runConverge(task: MTask, stage: MStage, signal: AbortSignal): Promise<"continue" | "stop"> {
    const round = task.rounds[stage.id] ?? 1;
    if (task.sub === 0) {
      const profileId = stage.profileIds[0] ?? "opus-xhigh";
      const result = await this.turn(task, stage.roleId, profileId, this.sectionsFor(task, stage.roleId), BriefResult, signal);
      task.brief = { summary: result.summary, forUsers: result.forUsers, areas: result.areas, acceptance: result.acceptance.map((text) => ({ text })), risks: result.risks };
      for (const answer of result.answers) {
        const objection = task.objections.find((entry) => entry.id === answer.id);
        if (objection && objection.status === "open") {
          objection.status = answer.status;
          objection.answer = answer.answer;
        }
      }
      for (const objection of task.objections) if (objection.status === "open" && objection.round < round) objection.status = "accepted";
      this.log(task, "done", round === 1 ? "Design brief ready" : "Answered every objection", stage.roleId, profileId);
      await this.undoReadOnly(task, stage.roleId);
      task.sub = 1;
      this.commit();
      return "continue";
    }
    const reviewerRole = stage.reviewerRoleId ?? "design-reviewer";
    const reviewerProfile = stage.reviewerProfileIds?.[0] ?? "sol-xhigh";
    const result = await this.turn(task, reviewerRole, reviewerProfile, this.sectionsFor(task, reviewerRole), ObjectionsResult, signal);
    for (const objection of result.objections) {
      task.objections.push({ id: this.id(`${task.id}-obj`), round, text: objection.text, blocking: objection.blocking, raisedBy: reviewerProfile, status: "open" });
    }
    await this.undoReadOnly(task, reviewerRole);
    const blocking = result.objections.filter((objection) => objection.blocking).length;
    if (blocking === 0) {
      for (const objection of task.objections) if (objection.status === "open" && !objection.blocking) objection.status = "rejected";
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
      this.raise(task, "disagreement", `The architects disagree on “${task.title}”`, false, { body: "Read both sides in the Design tab, then side with the architect or write your call." });
      this.commit();
      return "stop";
    }
    task.rounds[stage.id] = round + 1;
    task.sub = 0;
    this.commit();
    return "continue";
  }

  private async runReview(task: MTask, stage: MStage, signal: AbortSignal): Promise<"continue" | "stop"> {
    const round = task.rounds[stage.id] ?? 1;
    if (task.sub === 0) {
      const problems = await git.tamperCheck(task.worktree!, task.base!);
      for (const problem of problems) {
        if (!task.findings.some((finding) => finding.text === problem && finding.status === "open")) {
          task.findings.push({ id: this.id(task.id), text: problem, severity: "blocking", raisedBy: "petrina", confirmedBy: [], status: "open" });
        }
      }
      this.log(task, problems.length ? "warn" : "done", problems.length ? `Tamper check: ${problems.length} problem${problems.length === 1 ? "" : "s"}` : "Tamper check passed: no tests removed or skipped");
    }
    const profileId = stage.profileIds[task.sub] ?? stage.profileIds[0] ?? "sol-xhigh";
    const result = await this.turn(task, "code-reviewer", profileId, this.sectionsFor(task, "code-reviewer"), ReviewResult, signal);
    for (const id of result.confirms) {
      const finding = task.findings.find((entry) => entry.id === id);
      if (finding && !finding.confirmedBy.includes(profileId)) finding.confirmedBy.push(profileId);
    }
    for (const id of result.disputes) {
      const finding = task.findings.find((entry) => entry.id === id);
      if (finding && finding.status === "open" && finding.raisedBy !== "petrina") finding.status = "dismissed";
    }
    for (const finding of result.findings) {
      task.findings.push({
        id: this.id(task.id),
        text: finding.text,
        ...(finding.where ? { where: finding.where } : {}),
        severity: finding.severity,
        raisedBy: profileId,
        confirmedBy: [],
        status: "open",
      });
    }
    await this.undoReadOnly(task, "code-reviewer");
    const blockingNow = result.findings.filter((finding) => finding.severity === "blocking").length;
    this.log(task, blockingNow ? "warn" : "done", result.verdict === "pass" && !blockingNow ? "Passed" : `Found ${blockingNow} blocking issue${blockingNow === 1 ? "" : "s"}`, "code-reviewer", profileId);

    if (task.sub + 1 < stage.profileIds.length) {
      task.sub += 1;
      this.commit();
      return "continue";
    }
    const open = task.findings.filter((finding) => finding.status === "open" && finding.severity === "blocking");
    const builder = lastIndex(task.plan?.stages ?? [], (entry, index) => index < task.stageIndex && entry.roleId === "builder");
    if (open.length > 0 && builder >= 0 && round < (stage.maxRounds ?? 2)) {
      task.rounds[stage.id] = round + 1;
      task.stageIndex = builder;
      task.sub = 0;
      task.fixing = true;
      this.log(task, "warn", `Sent back to the builder with ${open.length} blocking finding${open.length === 1 ? "" : "s"}`);
      this.commit();
      return "continue";
    }
    task.stageIndex += 1;
    task.sub = 0;
    if (open.length > 0) {
      this.log(task, "warn", `Review rounds used up with ${open.length} blocking finding${open.length === 1 ? "" : "s"} open`);
      // With blocking findings left, the coordinator always looks before anything ships.
      const next = task.plan?.stages[task.stageIndex];
      if (next && next.kind !== "gate") {
        this.gate(task, "delivery");
        return "stop";
      }
    } else {
      this.log(task, "done", "Review passed");
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
      const pr = await git.findPr(task.worktree!, task.branch!);
      if (!pr) throw new Error("The shipper finished, but no pull request exists for this branch");
      task.pr = { number: pr.number, url: pr.url, state: "open", openedAt: Date.now() };
      task.state = "pr-open";
      task.column = "ready";
      task.statusLine = `Pull request #${pr.number} is open. Merge it on GitHub when you are happy`;
      this.log(task, "done", `Opened pull request #${pr.number}`, "shipper", SHIPPER_PROFILE);
    } else if (task.delivery === "release") {
      const release = result.tag ? await git.findRelease(task.worktree!, result.tag) : undefined;
      if (!release) throw new Error("The shipper finished, but the release could not be found on GitHub");
      task.release = release;
      task.state = "done";
      task.column = "done";
      task.finishedAt = Date.now();
      task.statusLine = `Released ${release.tag}`;
      this.log(task, "done", `Published release ${release.tag}`, "shipper", SHIPPER_PROFILE);
    } else {
      const sha = result.sha ?? (await git.head(task.worktree!));
      const branch = product.defaultBranch ?? "main";
      if (!(await git.landedOn(product.path!, branch, sha))) throw new Error(`The shipper finished, but the work is not on ${branch}`);
      task.landed = { branch, sha: sha.slice(0, 7) };
      task.state = "done";
      task.column = "done";
      task.finishedAt = Date.now();
      task.statusLine = `Committed to ${branch}`;
      this.log(task, "done", `Committed to ${branch} (${sha.slice(0, 7)})`, "shipper", SHIPPER_PROFILE);
    }
    this.say(task, "agent", `${result.summary}\n\n${label}`, "shipper", SHIPPER_PROFILE);
    this.commit();
  }

  private sectionsFor(task: MTask, roleId: Id): { title: string; body: string }[] {
    const sections: { title: string; body: string }[] = [];
    const brief = task.brief;
    task.queued.splice(0);
    // Every agent on the task sees all of the coordinator's notes, reviewers included.
    const notes = (task.notes ?? []).map((note) => `- ${note.text}`);
    if (notes.length) sections.push({ title: "The coordinator's notes on this task (follow them; where they conflict with the brief or each other, the latest wins)", body: notes.join("\n\n") });
    if (brief && roleId !== "planner") {
      sections.push({
        title: "Design brief",
        body: [brief.summary, brief.forUsers.length ? `What changes for users:\n${brief.forUsers.map((line) => `- ${line}`).join("\n")}` : "", `Acceptance checklist:\n${brief.acceptance.map((item) => `- ${item.text}`).join("\n")}`, brief.risks.length ? `Risks:\n${brief.risks.map((line) => `- ${line}`).join("\n")}` : ""].filter(Boolean).join("\n\n"),
      });
    }
    if ((roleId === "architect" || roleId === "design-reviewer") && task.objections.length) sections.push({ title: "Objections so far", body: formatObjections(task.objections as Task["objections"]) });
    if (roleId === "builder" && task.fixing) {
      const open = task.findings.filter((finding) => finding.status === "open");
      if (open.length) sections.push({ title: "Review findings to fix", body: formatFindings(open as Task["findings"]) });
    }
    if ((roleId === "code-reviewer" || roleId === "shipper" || roleId === "tester") && task.report) {
      sections.push({ title: "What the builder reports", body: [task.report.summary, ...task.report.changes.map((change) => `- ${change}`), task.report.tests ? `Tests: ${task.report.tests}` : ""].filter(Boolean).join("\n") });
    }
    if (roleId === "code-reviewer" && task.findings.length) sections.push({ title: "Findings so far (confirm or dispute by id)", body: formatFindings(task.findings as Task["findings"]) });
    if (roleId === "shipper") {
      const reviews = task.findings.filter((finding) => finding.status !== "dismissed");
      sections.push({ title: "Review summary", body: reviews.length ? formatFindings(reviews as Task["findings"]) : "Every reviewer passed it." });
    }
    return sections;
  }

  /** One agent, one stage: run turns until it hands back a valid result. */
  private async turn<T>(task: MTask, roleId: Id, profileId: Id, sections: { title: string; body: string }[], schema: z.ZodType<T>, signal: AbortSignal): Promise<T> {
    const role = this.role(roleId);
    const profile = this.profile(profileId);
    const product = this.productOf(task);
    if (!role || !profile || !product) throw new Error(`Unknown role or profile: ${roleId} on ${profileId}`);
    const taskId = task.id;

    task.agent = { roleId, profileId, since: Date.now(), step: 0 };
    task.state = "running";
    task.holdsSlot = true;
    task.column = this.columnFor(task);
    task.statusLine = `${role.name} is starting`;
    this.say(task, "system", `${role.name} joined · ${this.describe(roleId, profileId)}`, roleId, profileId);
    this.log(task, "milestone", `${role.name} started`, roleId, profileId);
    this.commit();

    const live = () => this.task(taskId);
    const command = this.options.agentCommand?.(profile);
    const run = await AgentRun.start({
      profile,
      ...(command ? { command } : {}),
      // GitHub credentials only for a shipper that publishes to GitHub; local delivery needs none.
      ...(roleId === "shipper" && task.delivery !== "local" ? {} : { env: agentEnv(process.env, await this.emptyGhConfig()) }),
      cwd: task.worktree!,
      signal,
      callbacks: {
        onActivity: (line) => {
          const current = live();
          if (!current || current.state !== "running") return;
          current.statusLine = line;
          this.say(current, "activity", line, roleId, profileId);
          this.commit();
        },
        onPlanStep: (line) => {
          const current = live();
          if (!current) return;
          if (current.state === "running") current.statusLine = line;
          if (current.timeline.at(-1)?.text !== line) this.log(current, "status", line, roleId, profileId);
          this.commit();
        },
        onPermission: (info) => this.permission(taskId, info, signal),
        onLog: (text) => void this.agentLog(taskId, text),
      },
    });
    this.runs.set(taskId, run);
    const headBefore = !role.canEdit && task.worktree ? await git.head(task.worktree).catch(() => undefined) : undefined;
    try {
      let reply = await run.prompt(buildPrompt({ task: task as unknown as Task, product: product as Product, role, roles: this.s.roles as Role[], profiles: this.s.profiles as AgentProfile[], worktree: task.worktree!, branch: task.branch!, base: task.base!, defaultBranch: product.defaultBranch ?? "main", sections }));
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
          this.commit();
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
          reply = await run.prompt(`The coordinator answered: ${answer}\n\nContinue. When you are done, end with the result block.`);
          continue;
        }
        if (parsed.ok === true) return parsed.value;
        repairs += 1;
        if (repairs > 2) throw new Error(`${role.name} did not hand back a usable result: ${parsed.error}`);
        reply = await run.prompt(repairPrompt(parsed.error));
      }
    } finally {
      this.runs.delete(taskId);
      run.close();
      // A read-only role runs in its tool's automatic mode, so it could change things: leave the
      // working copy exactly as it found it, commits and uncommitted changes alike.
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
    this.commit();
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
      design: "Design settled. Waiting for your check",
      delivery: "Reviews done. Waiting for your OK to ship",
    };
    this.raise(task, gate, titles[gate], false);
    task.statusLine = status[gate];
    task.column = gate === "plan" ? "planning" : gate === "design" ? "designing" : "ready";
    this.commit();
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

  private remember(task: MTask, text: string): void {
    task.notes = [...(task.notes ?? []), { at: Date.now(), text }];
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
      const state = await git.prState(task.worktree!, task.pr!.number).catch(() => undefined);
      if (state === "merged" || state === "closed") {
        task.pr!.state = state === "merged" ? "merged" : "open";
        task.state = "done";
        task.column = "done";
        task.finishedAt = Date.now();
        task.statusLine = state === "merged" ? `Merged #${task.pr!.number} on GitHub` : `Closed #${task.pr!.number} without merging`;
        this.log(task, "done", task.statusLine);
        this.commit();
      }
    }
  }

  /** After a restart, nothing is running: put interrupted work back in line. */
  private recover(): void {
    this.s.inbox = this.s.inbox.filter((item) => !item.blocking);
    for (const task of this.s.tasks) {
      if (["running", "waiting"].includes(task.state) || (task.state === "needs-you" && !this.s.inbox.some((item) => item.taskId === task.id))) {
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

  private async agentLog(taskId: Id, text: string): Promise<void> {
    const dir = join(this.dataDir, "logs");
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, `${taskId}.log`), text).catch(() => undefined);
  }

  private commit(): void {
    this.s.now = Date.now();
    for (const listener of this.listeners) listener();
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = undefined;
        this.store.save(this.getState());
      }, 400);
    }
  }
}

function lastIndex<T>(items: readonly T[], match: (item: T, index: number) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) if (match(items[index]!, index)) return index;
  return -1;
}
