// A deterministic stand-in for real agents. It drives the same state the real engine
// will: tasks move through their plan, agents report status lines, ask questions,
// request permissions, raise objections and findings, and wait at gates.
// The UI uses it today; the tests use it to pin down scheduling and gate rules.

import { answerByCall, CALL_WORDS, callCheckBody, callOn, designStageIndex, dueAnswers, followingCall, startCall, type CallAnswer } from "./call.js";
import { composePlan } from "./library.js";
import type {
  ActiveAgent,
  Column,
  DeliveryMode,
  DesignBrief,
  DesignCall,
  GateKind,
  Id,
  InboxItem,
  InboxKind,
  Stage,
  State,
  Task,
  TaskKind,
} from "./model.js";
import { pickStarts, queueOf, slotUses, slotWait, type Candidate } from "./scheduler.js";
import { productHistory, validateProductSettings, type ProductSettings } from "./products.js";

type DeepMutable<T> = T extends readonly (infer U)[]
  ? DeepMutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
    : T;

type Draft = DeepMutable<State>;
type DraftTask = DeepMutable<Task>;

/** A scripted moment where an agent stops and asks the coordinator something. */
export interface Trigger {
  kind: "question" | "permission";
  title: string;
  body?: string;
  options?: readonly string[];
  detail?: string;
}

/** Keyed by `taskId|roleId|round|step`. */
export type Triggers = Readonly<Record<string, Trigger>>;

export interface SimOptions {
  triggers?: Triggers;
  /** Ticks a pull request stays open before the simulated coordinator merges it on GitHub. */
  prMergeAfter?: number;
  /** Milliseconds of simulated time per tick when no clock value is given. */
  tickMs?: number;
  /** Tasks whose design reviewer keeps objecting every round, so the architects end up disagreeing. */
  disagree?: readonly Id[];
}

export interface NewTask {
  productId: Id;
  title: string;
  description?: string;
  kind?: TaskKind;
  area?: string;
  position?: "top" | "bottom";
  approvePlan?: boolean;
  delivery?: DeliveryMode;
  approveDelivery?: boolean;
}

export type MessageMode = "queue" | "interrupt";

const PLANNER_PROFILE = "sonnet-medium";

const GATE_TITLES: Record<GateKind, (title: string) => string> = {
  plan: (title) => `Approve the plan for “${title}”`,
  design: (title) => `Check the design for “${title}”`,
  delivery: (title) => `Ready to ship “${title}”`,
};

const GATE_STATUS: Record<GateKind, string> = {
  plan: "Plan ready. Waiting for your OK",
  design: "Design settled. Waiting for your check",
  delivery: "Reviews passed. Waiting for your OK to open the pull request",
};

interface ScriptContext {
  area: string;
  product: string;
  round: number;
  fixing: boolean;
  delivery: DeliveryMode;
  /** The architect is following the coordinator's call. */
  following: boolean;
  /** The design reviewer keeps objecting every round. */
  objecting: boolean;
}

/** What each role says while it works, in plain language. */
function scriptFor(roleId: Id, ctx: ScriptContext): string[] {
  const { area, product, round, fixing, delivery, following, objecting } = ctx;
  switch (roleId) {
    case "shipper":
      return delivery === "release"
        ? ["Merging into main", "Bumping the version", "Writing the release notes", "Published the release"]
        : delivery === "local"
          ? ["Merging into main", "Committed on main"]
          : ["Pushing the branch", "Writing the pull request description", "Opened the pull request"];
    case "planner":
      return ["Reading the task", `Looking at how ${product} is organised`, "Choosing who should work on this", "Writing the plan"];
    case "researcher":
      return [`Looking at how other products handle ${area}`, `Collecting what users expect from ${area}`, "Writing research notes"];
    case "architect":
      if (following) return ["Reading your call", `Updating the ${area} flow to follow it`, "Answering each open objection", "Brief follows your call"];
      return round === 1
        ? [`Reading the parts of ${product} this touches`, `Sketching the ${area} flow`, "Writing the acceptance checklist", "Design brief ready for review"]
        : ["Reading the objections", `Reworking the ${area} flow`, "Answering each objection", "Updated brief ready"];
    case "design-reviewer":
      return round === 1
        ? ["Reading the design brief", `Looking for gaps in the ${area} flow`, "Writing objections"]
        : ["Reading the updated brief", "Checking the answer to each objection", objecting ? "Writing objections" : "Nothing blocking left"];
    case "ux-designer":
      return [`Sketching the ${area} screens`, "Checking contrast, spacing and wording", "Writing UI notes"];
    case "builder":
      return fixing
        ? ["Reading the review findings", "Fixing the blocking issue", "Ran the tests: 44 passed", "Fixes ready for review"]
        : ["Setting up a fresh working copy", `Updating the ${area} screens`, `Connecting ${area} to the backend`, `Writing tests for ${area}`, "Ran the tests: 42 passed", "Change ready for review"];
    case "tester":
      return ["Starting the app", `Going through ${area} like a user would`, "Took 4 screenshots", "Every acceptance check passes"];
    case "code-reviewer":
      return round === 1
        ? ["Reading the design and the acceptance checklist", "Trying to prove “done” wrong", "Checking no test was weakened or skipped", "Writing findings"]
        : ["Checking the fixes", "Re-running the acceptance checks", "Passed"];
    default:
      return ["Working"];
  }
}

/** What a design reviewer that keeps objecting raises after the first round. */
function laterObjections(area: string, round: number): { text: string; blocking: boolean }[] {
  return round === 2
    ? [
        { blocking: true, text: `The updated brief still does not say what people see in ${area} when a step fails.` },
        { blocking: false, text: `Show progress in ${area} so people know how much is left.` },
      ]
    : [
        { blocking: true, text: `The answer for existing accounts adds a confirmation step to ${area} that slows everyone down.` },
        { blocking: false, text: "Consider a short note telling existing users what changed." },
      ];
}

function briefFor(task: DraftTask): DeepMutable<DesignBrief> {
  return {
    summary: callOn(task as unknown as Task, task.stageIndex) ? `How ${task.area} should work after this change, following your call.` : `How ${task.area} should work after this change, agreed by both architects.`,
    forUsers: [`${capitalize(task.area)} works the way the task describes`, "Nothing changes for people who do not use it"],
    areas: [capitalize(task.area), "Settings"],
    acceptance: [
      { text: `A user can complete ${task.area} without help` },
      { text: "Existing users see no difference unless they opt in" },
      { text: "Works on phone-sized screens" },
    ],
    risks: ["Edge cases with very old accounts"],
  };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export class Simulator {
  private state: State;
  private readonly listeners = new Set<() => void>();
  private readonly triggers: Triggers;
  private readonly prMergeAfter: number;
  private readonly tickMs: number;
  private readonly disagree: ReadonlySet<Id>;

  constructor(state: State, options: SimOptions = {}) {
    this.state = state;
    this.triggers = options.triggers ?? {};
    this.disagree = new Set(options.disagree ?? []);
    this.prMergeAfter = options.prMergeAfter ?? 12;
    this.tickMs = options.tickMs ?? 40_000;
  }

  getState = (): State => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Advance every running agent by one step, merge old pull requests, and start what fits in the pool. */
  tick(now?: number): void {
    this.update((d) => {
      d.now = now ?? d.now + this.tickMs;
      for (const task of d.tasks) {
        if (task.state === "running") this.step(d, task);
        else if (task.state === "pr-open") this.agePullRequest(d, task);
      }
      this.schedule(d);
    });
  }

  // ── Coordinator actions ────────────────────────────────────────────────────

  answer(itemId: Id, answer: string): void {
    this.resolve(itemId, (d, task, item) => {
      this.say(d, task, "you", answer);
      this.log(d, task, "you", `You answered: ${answer}`);
      this.say(d, task, "agent", `Thanks. Going with: ${answer}.`, item.roleId, item.profileId);
      this.unblock(task);
    });
  }

  /** The agent goes with its own recommendation (the first option). */
  decideForMe(itemId: Id): void {
    const item = this.state.inbox.find((entry) => entry.id === itemId);
    const pick = item?.options?.[0];
    if (!item || !pick) return;
    this.resolve(itemId, (d, task) => {
      this.log(d, task, "you", `You let the agent decide. It chose: ${pick}`);
      this.say(d, task, "agent", `I'll go with: ${pick}.`, item.roleId, item.profileId);
      this.unblock(task);
    });
  }

  allow(itemId: Id, _scope: "once" | "always"): void {
    this.resolve(itemId, (d, task, item) => {
      this.log(d, task, "you", `You allowed: ${item.title}`);
      this.say(d, task, "agent", "Thanks, continuing.", item.roleId, item.profileId);
      this.unblock(task);
    });
  }

  deny(itemId: Id, note?: string): void {
    this.resolve(itemId, (d, task, item) => {
      this.log(d, task, "you", note ? `You said no: ${note}` : `You said no to: ${item.title}`);
      if (note) this.say(d, task, "you", note);
      this.say(d, task, "agent", "Understood. I'll find a way without it.", item.roleId, item.profileId);
      this.unblock(task);
    });
  }

  /** Approve a gate (plan, design, delivery) or settle a disagreement with the architect's position. */
  approve(itemId: Id): void {
    this.resolve(itemId, (d, task, item) => {
      switch (item.kind) {
        case "plan":
          this.log(d, task, "you", "You approved the plan");
          this.continueAfterGate(d, task);
          break;
        case "design":
          this.log(d, task, "you", "You approved the design");
          this.continueAfterGate(d, task);
          break;
        case "disagreement":
          this.log(d, task, "you", "You sided with the architect");
          for (const objection of task.objections) if (objection.status === "open") objection.status = "rejected";
          task.brief = briefFor(task);
          this.advance(d, task);
          break;
        case "delivery":
          this.log(d, task, "you", "You approved the delivery");
          this.continueAfterGate(d, task);
          break;
        default:
          break;
      }
    });
  }

  /**
   * Send a gate back with a note: the design goes back to the architects, a delivery back to the builder,
   * a plan back to the planner. On a disagreement the note is the coordinator's call, which settles the design.
   */
  requestChanges(itemId: Id, note: string): void {
    this.resolve(itemId, (d, task, item) => {
      const stages = task.plan?.stages ?? [];
      const call = item.kind === "disagreement" ? startCall(task as unknown as Task, note, d.now) : undefined;
      this.log(d, task, "you", call ? CALL_WORDS.made(note) : `You asked for changes: ${note}`);
      this.say(d, task, "you", note);
      if (call && task.plan) {
        task.plan.stages = call.stages as DeepMutable<Stage>[];
        task.stageIndex = call.stageIndex;
        task.call = call.call as DraftTask["call"];
      } else if (item.kind === "plan") {
        task.stageIndex = -1;
      } else if (item.kind === "design") {
        const index = designStageIndex(stages, task.stageIndex);
        if (index >= 0) {
          const stage = stages[index]!;
          // On a design the call settled, changes go to the architect alone and come back to the same check.
          if (!callOn(task as unknown as Task, index)) task.rounds[stage.id] = (task.rounds[stage.id] ?? 1) + 1;
          task.stageIndex = index;
        }
      } else if (item.kind === "delivery") {
        const index = lastIndexWhere(stages, (stage) => stage.roleId === "builder" && stage.kind === "do");
        if (index >= 0) {
          task.stageIndex = index;
          task.fixing = true;
        }
      }
      task.sub = 0;
      task.state = "waiting";
      task.statusLine = "Waiting for a free slot";
      task.column = this.columnFor(d, task);
    });
  }

  /** Change what "ready" means for a product, and whether the coordinator checks first. */
  setProductDelivery(productId: Id, delivery: DeliveryMode, approveDelivery: boolean): void {
    const product = this.state.products.find((entry) => entry.id === productId);
    if (product) this.updateProduct(productId, { name: product.name, delivery, approveDelivery });
  }

  updateProduct(productId: Id, settings: ProductSettings): void {
    const validated = validateProductSettings(settings, this.state.products, productId);
    this.update((d) => {
      const product = d.products.find((entry) => entry.id === productId);
      if (!product) throw new Error("This product is no longer in Petrina.");
      Object.assign(product, validated);
    });
  }

  removeProduct(productId: Id): void {
    const { unfinished } = productHistory(this.state.tasks, productId);
    if (unfinished) throw new Error(`${unfinished} task${unfinished === 1 ? " must" : "s must"} finish or be cancelled before this product can be removed.`);
    this.update((d) => {
      const ids = new Set(d.tasks.filter((task) => task.productId === productId).map((task) => task.id));
      d.inbox = d.inbox.filter((item) => !ids.has(item.taskId));
      d.tasks = d.tasks.filter((task) => !ids.has(task.id));
      d.products = d.products.filter((product) => product.id !== productId);
    });
  }

  setToolCap(toolId: Id, cap: number): void {
    this.update((d) => {
      d.pool.toolCaps[toolId] = Math.max(1, Math.min(12, Math.round(cap)));
      this.schedule(d);
    });
  }

  setPoolLimit(limit: number): void {
    this.update((d) => {
      d.pool.limit = Math.max(1, Math.min(12, Math.round(limit)));
      this.schedule(d);
    });
  }

  setPoolPaused(paused: boolean): void {
    this.update((d) => {
      d.pool.paused = paused;
      this.schedule(d);
    });
  }

  /** Put a queued task at `index` in the queue (0 is the top). */
  moveInQueue(taskId: Id, index: number): void {
    this.update((d) => {
      const queue = queueOf(d.tasks as Task[]).map((task) => task.id);
      const from = queue.indexOf(taskId);
      if (from < 0) return;
      queue.splice(from, 1);
      queue.splice(Math.max(0, Math.min(queue.length, index)), 0, taskId);
      queue.forEach((id, position) => {
        const task = d.tasks.find((entry) => entry.id === id);
        if (task) task.priority = position;
      });
      this.schedule(d);
    });
  }

  moveToTop(taskId: Id): void {
    this.moveInQueue(taskId, 0);
  }

  setHeld(taskId: Id, held: boolean): void {
    this.updateTask(taskId, (d, task) => {
      task.held = held;
      this.log(d, task, "you", held ? "You put it on hold" : "You released the hold");
      this.schedule(d);
    });
  }

  pause(taskId: Id): void {
    this.updateTask(taskId, (d, task) => {
      if (!["running", "needs-you", "waiting"].includes(task.state)) return;
      task.state = "paused";
      task.holdsSlot = false;
      task.statusLine = "Paused by you";
      this.log(d, task, "you", "You paused it");
      this.schedule(d);
    });
  }

  resume(taskId: Id): void {
    this.updateTask(taskId, (d, task) => {
      if (task.state !== "paused") return;
      const pendingGate = d.inbox.some((item) => item.taskId === task.id && !item.blocking);
      task.state = pendingGate ? "needs-you" : "waiting";
      task.statusLine = pendingGate ? "Waiting for you" : "Waiting for a free slot";
      this.log(d, task, "you", "You resumed it");
      this.schedule(d);
    });
  }

  cancel(taskId: Id): void {
    this.updateTask(taskId, (d, task) => {
      task.state = "cancelled";
      task.column = "done";
      task.holdsSlot = false;
      delete task.agent;
      task.finishedAt = d.now;
      task.statusLine = "Cancelled";
      d.inbox = d.inbox.filter((item) => item.taskId !== task.id);
      this.log(d, task, "you", "You cancelled it");
      this.schedule(d);
    });
  }

  /**
   * Message the agent working on a task. Queued messages are delivered when the agent
   * finishes its current step; an interrupt is delivered now.
   */
  sendMessage(taskId: Id, text: string, mode: MessageMode = "queue"): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.updateTask(taskId, (d, task) => {
      if (mode === "interrupt" && task.agent && task.state === "running") {
        this.say(d, task, "system", "You interrupted the current step");
        this.deliver(d, task, trimmed);
        return;
      }
      task.queued.push({ id: this.id(d, task.id), text: trimmed, at: d.now });
    });
  }

  removeQueued(taskId: Id, messageId: Id): void {
    this.updateTask(taskId, (_d, task) => {
      task.queued = task.queued.filter((message) => message.id !== messageId);
    });
  }

  /**
   * Swap the profile on a stage that has not started yet. `list` picks the author/doers
   * (`profileIds`) or the reviewers of a converge stage (`reviewerProfileIds`).
   */
  setStageProfile(taskId: Id, stageId: Id, list: "profileIds" | "reviewerProfileIds", index: number, profileId: Id): void {
    this.updateTask(taskId, (d, task) => {
      const at = task.plan?.stages.findIndex((stage) => stage.id === stageId) ?? -1;
      const stage = task.plan?.stages[at];
      if (!stage || at <= task.stageIndex || !d.profiles.some((profile) => profile.id === profileId)) return;
      const profiles = stage[list];
      if (!profiles || index < 0 || index >= profiles.length) return;
      profiles[index] = profileId;
      this.log(d, task, "you", `You changed who works on “${stage.title}”`);
    });
  }

  /** Add one more reviewer to a review chain that has not started yet. */
  addReviewer(taskId: Id, stageId: Id, profileId: Id): void {
    this.updateTask(taskId, (d, task) => {
      const at = task.plan?.stages.findIndex((stage) => stage.id === stageId) ?? -1;
      const stage = task.plan?.stages[at];
      if (!stage || stage.kind !== "review-chain" || at <= task.stageIndex || !d.profiles.some((profile) => profile.id === profileId)) return;
      stage.profileIds.push(profileId);
      this.log(d, task, "you", `You added a reviewer to “${stage.title}”`);
    });
  }

  addTask(input: NewTask): Id {
    let created = "";
    this.update((d) => {
      const queue = queueOf(d.tasks as Task[]);
      const id = this.id(d, "task");
      created = id;
      const top = input.position === "top";
      const product = d.products.find((entry) => entry.id === input.productId);
      d.tasks.push({
        id,
        productId: input.productId,
        title: input.title.trim(),
        description: input.description?.trim() ?? "",
        area: input.area?.trim() || areaFromTitle(input.title),
        kind: input.kind ?? "feature",
        priority: top ? -1 : queue.length,
        held: false,
        state: "queued",
        column: "queue",
        holdsSlot: false,
        approvePlan: input.approvePlan ?? false,
        delivery: input.delivery ?? product?.delivery ?? "pull-request",
        approveDelivery: input.approveDelivery ?? product?.approveDelivery ?? true,
        stageIndex: -1,
        rounds: {},
        sub: 0,
        fixing: false,
        statusLine: "In the queue",
        createdAt: d.now,
        timeline: [{ id: this.id(d, id), at: d.now, text: "You added it to the queue", tone: "you" }],
        session: [],
        queued: [],
        objections: [],
        findings: [],
        prAge: 0,
      });
      if (top) {
        queueOf(d.tasks as Task[]).forEach((task, position) => {
          const entry = d.tasks.find((candidate) => candidate.id === task.id);
          if (entry) entry.priority = position;
        });
      }
      this.schedule(d);
    });
    return created;
  }

  // ── Engine internals ───────────────────────────────────────────────────────

  private update(change: (draft: Draft) => void): void {
    // State is plain JSON, so a JSON round trip is a full, environment-neutral copy.
    const draft = JSON.parse(JSON.stringify(this.state)) as Draft;
    change(draft);
    this.state = draft as unknown as State;
    for (const listener of this.listeners) listener();
  }

  private updateTask(taskId: Id, change: (draft: Draft, task: DraftTask) => void): void {
    this.update((d) => {
      const task = d.tasks.find((entry) => entry.id === taskId);
      if (task) change(d, task);
    });
  }

  private resolve(itemId: Id, change: (draft: Draft, task: DraftTask, item: DeepMutable<InboxItem>) => void): void {
    this.update((d) => {
      const item = d.inbox.find((entry) => entry.id === itemId);
      const task = item && d.tasks.find((entry) => entry.id === item.taskId);
      if (!item || !task) return;
      d.inbox = d.inbox.filter((entry) => entry.id !== itemId);
      change(d, task, item);
      this.schedule(d);
    });
  }

  private id(d: Draft, prefix: string): Id {
    d.seq += 1;
    return `${prefix}-${d.seq}`;
  }

  private log(d: Draft, task: DraftTask, tone: Task["timeline"][number]["tone"], text: string, roleId?: Id, profileId?: Id): void {
    task.timeline.push({ id: this.id(d, task.id), at: d.now, text, tone, ...(roleId ? { roleId } : {}), ...(profileId ? { profileId } : {}) });
  }

  private say(d: Draft, task: DraftTask, from: Task["session"][number]["from"], text: string, roleId?: Id, profileId?: Id): void {
    task.session.push({ id: this.id(d, task.id), at: d.now, from, text, ...(roleId ? { roleId } : {}), ...(profileId ? { profileId } : {}) });
  }

  private stage(task: DraftTask): DeepMutable<Stage> | undefined {
    return task.stageIndex < 0 ? undefined : task.plan?.stages[task.stageIndex];
  }

  private round(task: DraftTask): number {
    const stage = this.stage(task);
    return stage ? (task.rounds[stage.id] ?? 1) : 1;
  }

  /** The call the architect is following, while it works on the design stage the call settled. */
  private following(task: DraftTask): DesignCall | undefined {
    return task.sub === 0 ? followingCall(task as unknown as Task) : undefined;
  }

  private columnFor(d: Draft, task: DraftTask): Column {
    if (task.state === "cancelled" || task.state === "done") return "done";
    if (task.state === "pr-open") return "ready";
    if (task.state === "queued") return "queue";
    if (task.stageIndex < 0) return "planning";
    const stage = this.stage(task);
    if (!stage) return "ready";
    if (stage.kind === "gate") return stage.gate === "plan" ? "planning" : stage.gate === "design" ? "designing" : "ready";
    if (stage.kind === "review-chain") return "reviewing";
    return d.roles.find((role) => role.id === stage.roleId)?.column ?? "building";
  }

  /** Who should be working right now, given the stage and the sub-step. */
  private nextAgent(task: DraftTask): { roleId: Id; profileId: Id } | undefined {
    if (task.stageIndex < 0) return { roleId: "planner", profileId: task.plan?.plannerProfileId ?? PLANNER_PROFILE };
    const stage = this.stage(task);
    if (!stage) return undefined;
    switch (stage.kind) {
      case "do":
        return stage.profileIds[0] ? { roleId: stage.roleId, profileId: stage.profileIds[0] } : undefined;
      case "converge":
        if (task.sub === 0) return stage.profileIds[0] ? { roleId: stage.roleId, profileId: stage.profileIds[0] } : undefined;
        return stage.reviewerRoleId && stage.reviewerProfileIds?.[0]
          ? { roleId: stage.reviewerRoleId, profileId: stage.reviewerProfileIds[0] }
          : undefined;
      case "review-chain": {
        const profileId = stage.profileIds[task.sub];
        return profileId ? { roleId: stage.roleId, profileId } : undefined;
      }
      case "gate":
        return undefined;
    }
  }

  private startAgent(d: Draft, task: DraftTask): void {
    const next = this.nextAgent(task);
    if (!next) return;
    const toolId = d.profiles.find((profile) => profile.id === next.profileId)?.toolId ?? "unknown";
    const waiting = slotWait(d as State, { taskId: task.id, toolId });
    if (waiting) {
      task.state = "waiting";
      task.holdsSlot = false;
      delete task.agent;
      task.column = this.columnFor(d, task);
      task.statusLine = waiting;
      return;
    }
    const agent: ActiveAgent = { ...next, since: d.now, step: 0 };
    task.agent = agent;
    task.state = "running";
    task.holdsSlot = true;
    task.column = this.columnFor(d, task);
    const role = d.roles.find((entry) => entry.id === next.roleId)?.name ?? next.roleId;
    task.statusLine = `${role} is starting`;
    this.say(d, task, "system", `${role} joined`, next.roleId, next.profileId);
    this.log(d, task, "milestone", `${role} started`, next.roleId, next.profileId);
  }

  private step(d: Draft, task: DraftTask): void {
    const agent = task.agent;
    if (!agent) return;

    const message = task.queued.shift();
    if (message) {
      this.deliver(d, task, message.text);
      return;
    }

    const product = d.products.find((entry) => entry.id === task.productId)?.name ?? "the product";
    const round = this.round(task);
    const following = !!this.following(task);
    const lines = scriptFor(agent.roleId, { area: task.area, product, round, fixing: task.fixing, delivery: task.delivery, following, objecting: this.disagree.has(task.id) });
    const line = lines[agent.step];
    if (line === undefined) {
      this.finish(d, task);
      return;
    }

    task.statusLine = following ? CALL_WORDS.following : line;
    this.say(d, task, "activity", line, agent.roleId, agent.profileId);
    this.log(d, task, "status", line, agent.roleId, agent.profileId);
    const trigger = this.triggers[`${task.id}|${agent.roleId}|${round}|${agent.step}`];
    agent.step += 1;
    if (trigger) this.ask(d, task, trigger);
  }

  private deliver(d: Draft, task: DraftTask, text: string): void {
    this.say(d, task, "you", text);
    this.log(d, task, "you", `You said: ${text}`);
    this.say(d, task, "agent", "Got it. I'll take that into account from here.", task.agent?.roleId, task.agent?.profileId);
  }

  private ask(d: Draft, task: DraftTask, trigger: Trigger): void {
    const agent = task.agent;
    this.raise(d, task, trigger.kind, trigger.title, true, trigger);
    task.statusLine = trigger.kind === "question" ? "Waiting for your answer" : "Waiting for your permission";
    this.say(d, task, "agent", trigger.title, agent?.roleId, agent?.profileId);
    this.log(d, task, "warn", trigger.kind === "question" ? `Asked you: ${trigger.title}` : `Asked your permission: ${trigger.title}`, agent?.roleId, agent?.profileId);
  }

  private raise(
    d: Draft,
    task: DraftTask,
    kind: InboxKind,
    title: string,
    blocking: boolean,
    extra: { body?: string; options?: readonly string[]; detail?: string } = {},
  ): void {
    task.state = "needs-you";
    const agent = task.agent;
    d.inbox.push({
      id: this.id(d, "inbox"),
      taskId: task.id,
      kind,
      title,
      at: d.now,
      blocking,
      ...(agent ? { roleId: agent.roleId, profileId: agent.profileId } : {}),
      ...(extra.body ? { body: extra.body } : {}),
      ...(extra.options ? { options: [...extra.options] } : {}),
      ...(extra.detail ? { detail: extra.detail } : {}),
    });
  }

  private unblock(task: DraftTask): void {
    if (task.state !== "needs-you") return;
    task.state = task.holdsSlot ? "running" : "waiting";
    task.statusLine = task.holdsSlot ? "Back to work" : "Waiting for a free slot";
  }

  /** The agent finished its step list: hand the result to the stage. */
  private finish(d: Draft, task: DraftTask): void {
    const agent = task.agent;
    if (!agent) return;

    if (task.stageIndex < 0) {
      task.plan = composePlan(task) as DeepMutable<NonNullable<Task["plan"]>>;
      const count = task.plan.stages.filter((stage) => stage.kind !== "gate").length;
      this.log(d, task, "milestone", `Plan ready: ${count} stages. ${task.plan.rationale}`, agent.roleId, agent.profileId);
      this.say(d, task, "agent", task.plan.rationale, agent.roleId, agent.profileId);
      if (task.approvePlan) this.gate(d, task, "plan");
      else this.advance(d, task);
      return;
    }

    const stage = this.stage(task);
    if (!stage) return;
    const round = this.round(task);

    if (stage.kind === "do" && agent.roleId === "shipper") {
      this.ship(d, task);
      return;
    }

    if (stage.kind === "do") {
      if (agent.roleId === "builder" && task.fixing) {
        for (const finding of task.findings) if (finding.status === "open" && finding.severity === "blocking") finding.status = "fixed";
        task.fixing = false;
        this.log(d, task, "done", "Fixed the blocking findings", agent.roleId, agent.profileId);
      } else {
        this.log(d, task, "done", `${stage.title} done`, agent.roleId, agent.profileId);
      }
      this.advance(d, task);
      return;
    }

    if (stage.kind === "converge") {
      const call = this.following(task);
      if (call) {
        // The call settles the blocking objections; the architect answers the rest itself. None is left open.
        // After changes asked for at the check, it answers them all again, so the notes match the updated brief.
        const revising = !task.objections.some((objection) => objection.status === "open");
        const answers: CallAnswer[] = dueAnswers(task.objections as Task["objections"], call).map((objection) =>
          objection.blocking
            ? { id: objection.id, status: "accepted", byCall: true, answer: revising ? `Changed the ${task.area} flow in the brief to your note, still following your call.` : `Changed the ${task.area} flow in the brief to follow your call.` }
            : { id: objection.id, status: "rejected", byCall: false, answer: revising ? "Still out of scope after your note. Kept in risks." : "Out of scope for this task. Added to risks." },
        );
        task.objections = answerByCall(task.objections as Task["objections"], call, answers) as DraftTask["objections"];
        task.brief = briefFor(task);
        this.log(d, task, "done", revising ? CALL_WORDS.revised : CALL_WORDS.updated, agent.roleId, agent.profileId);
        this.log(d, task, "done", CALL_WORDS.settled);
        this.advance(d, task);
        return;
      }
      if (task.sub === 0) {
        for (const objection of task.objections) {
          if (objection.status !== "open") continue;
          objection.status = objection.blocking ? "accepted" : "rejected";
          objection.answer = objection.blocking ? "Changed the design to cover it." : "Out of scope for this task. Added to risks.";
        }
        this.log(d, task, "done", round === 1 ? "Design brief ready" : "Answered every objection", agent.roleId, agent.profileId);
        task.sub = 1;
        this.startAgent(d, task);
        return;
      }
      if (round === 1 || this.disagree.has(task.id)) {
        const raised =
          round === 1
            ? [
                { blocking: true, text: `What happens to ${task.area} for people who already have an account? The brief does not say.` },
                { blocking: false, text: `Consider remembering the last choice in ${task.area} on this device.` },
              ]
            : laterObjections(task.area, round);
        for (const objection of raised) task.objections.push({ id: this.id(d, task.id), round, raisedBy: agent.profileId, status: "open", ...objection });
        this.log(d, task, "warn", `Raised ${raised.length} objections, ${raised.filter((objection) => objection.blocking).length} blocking`, agent.roleId, agent.profileId);
        if (round >= (stage.maxRounds ?? 3)) {
          this.gateDisagreement(d, task);
          return;
        }
        task.rounds[stage.id] = round + 1;
        task.sub = 0;
        this.startAgent(d, task);
        return;
      }
      task.brief = briefFor(task);
      this.log(d, task, "done", "Design settled: no blocking objections", agent.roleId, agent.profileId);
      this.advance(d, task);
      return;
    }

    if (stage.kind === "review-chain") {
      if (round === 1 && task.sub === 0) {
        task.findings.push({
          id: this.id(d, task.id),
          text: `${capitalize(task.area)} fails when the email address contains a plus sign, and no test covers it.`,
          where: `${capitalize(task.area)} form`,
          severity: "blocking",
          raisedBy: agent.profileId,
          confirmedBy: [],
          status: "open",
        });
        this.log(d, task, "warn", "Found 1 blocking issue", agent.roleId, agent.profileId);
      } else if (round === 1) {
        for (const finding of task.findings) if (finding.status === "open") finding.confirmedBy.push(agent.profileId);
        task.findings.push({
          id: this.id(d, task.id),
          text: "Show a clearer message when the email is not valid.",
          severity: "suggestion",
          raisedBy: agent.profileId,
          confirmedBy: [],
          status: "open",
        });
        this.log(d, task, "warn", "Confirmed the blocking issue and added a suggestion", agent.roleId, agent.profileId);
      } else {
        this.log(d, task, "done", "Passed", agent.roleId, agent.profileId);
      }

      if (task.sub + 1 < stage.profileIds.length) {
        task.sub += 1;
        this.startAgent(d, task);
        return;
      }

      const open = task.findings.filter((finding) => finding.status === "open" && finding.severity === "blocking");
      const builder = lastIndexWhere(task.plan?.stages ?? [], (entry, index) => index < task.stageIndex && entry.roleId === "builder");
      if (open.length > 0 && builder >= 0 && round < (stage.maxRounds ?? 2)) {
        task.rounds[stage.id] = round + 1;
        task.stageIndex = builder;
        task.sub = 0;
        task.fixing = true;
        this.log(d, task, "warn", `Sent back to the builder with ${open.length} blocking finding${open.length === 1 ? "" : "s"}`);
        this.startAgent(d, task);
        return;
      }
      this.log(d, task, "done", "Review passed");
      this.advance(d, task);
    }
  }

  private advance(d: Draft, task: DraftTask): void {
    task.stageIndex += 1;
    task.sub = 0;
    delete task.agent;
    const stage = this.stage(task);
    if (!stage) {
      this.openPullRequest(d, task);
      return;
    }
    if (stage.kind === "gate" && stage.gate) {
      this.gate(d, task, stage.gate);
      return;
    }
    this.startAgent(d, task);
  }

  private gate(d: Draft, task: DraftTask, gate: GateKind): void {
    delete task.agent;
    task.holdsSlot = false;
    task.statusLine = gate === "design" && callOn(task as unknown as Task, task.stageIndex) ? CALL_WORDS.waiting : GATE_STATUS[gate];
    const body = gate === "design" ? callCheckBody(task as unknown as Task) : undefined;
    this.raise(d, task, gate, GATE_TITLES[gate](task.title), false, body ? { body } : {});
    task.column = this.columnFor(d, task);
  }

  private gateDisagreement(d: Draft, task: DraftTask): void {
    delete task.agent;
    task.holdsSlot = false;
    task.statusLine = "The architects disagree. Your call";
    this.raise(d, task, "disagreement", `The architects disagree on “${task.title}”`, false, { body: CALL_WORDS.disagreement });
  }

  private continueAfterGate(d: Draft, task: DraftTask): void {
    task.stageIndex += 1;
    task.sub = 0;
    const stage = this.stage(task);
    if (!stage) {
      this.openPullRequest(d, task);
      return;
    }
    if (stage.kind === "gate" && stage.gate) {
      this.gate(d, task, stage.gate);
      return;
    }
    task.state = "waiting";
    task.statusLine = "Waiting for a free slot";
    task.column = this.columnFor(d, task);
  }

  private openPullRequest(d: Draft, task: DraftTask): void {
    const product = d.products.find((entry) => entry.id === task.productId);
    const number = 100 + (d.seq % 900);
    task.pr = { number, url: `https://github.com/${product?.repo ?? "owner/repo"}/pull/${number}`, state: "open", openedAt: d.now };
    task.state = "pr-open";
    task.holdsSlot = false;
    delete task.agent;
    task.prAge = 0;
    task.statusLine = `Pull request #${number} is open. Merge it on GitHub when you are happy`;
    task.column = "ready";
    this.log(d, task, "done", `Opened pull request #${number}`);
  }

  /** The shipper finished: what that means depends on the task's delivery mode. */
  private ship(d: Draft, task: DraftTask): void {
    if (task.delivery === "pull-request") {
      this.openPullRequest(d, task);
      return;
    }
    const product = d.products.find((entry) => entry.id === task.productId);
    delete task.agent;
    task.holdsSlot = false;
    task.state = "done";
    task.column = "done";
    task.finishedAt = d.now;
    if (task.delivery === "release") {
      const tag = `v1.${(d.seq % 40) + 1}.0`;
      task.release = { tag, url: `https://github.com/${product?.repo ?? "owner/repo"}/releases/tag/${tag}` };
      task.statusLine = `Released ${tag}`;
      this.log(d, task, "done", `Published release ${tag}`);
    } else {
      const sha = (d.seq * 2654435761).toString(16).slice(0, 7);
      task.landed = { branch: product?.defaultBranch ?? "main", sha };
      task.statusLine = `Committed to ${task.landed.branch} (${sha})`;
      this.log(d, task, "done", `Committed to ${task.landed.branch}`);
    }
  }

  private agePullRequest(d: Draft, task: DraftTask): void {
    task.prAge += 1;
    if (!task.pr || task.prAge < this.prMergeAfter) return;
    task.pr.state = "merged";
    task.state = "done";
    task.column = "done";
    task.finishedAt = d.now;
    task.statusLine = `Merged #${task.pr.number} on GitHub`;
    this.log(d, task, "done", `Merged on GitHub (#${task.pr.number})`);
  }

  /** Fill free slots: tasks already in progress first, then the queue, in priority order. */
  private schedule(d: Draft): void {
    const toolOf = new Map(d.profiles.map((profile) => [profile.id, profile.toolId]));
    const candidates: Candidate[] = [];
    const inProgress = d.tasks.filter((task) => task.state === "waiting").sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    for (const task of inProgress) {
      const next = this.nextAgent(task);
      if (next) {
        const candidate = { taskId: task.id, toolId: toolOf.get(next.profileId) ?? "unknown" };
        task.statusLine = slotWait(d as State, candidate) ?? "Waiting for a free slot";
        candidates.push(candidate);
      }
    }
    for (const task of queueOf(d.tasks as Task[])) {
      if (task.held) continue;
      candidates.push({ taskId: task.id, toolId: toolOf.get(PLANNER_PROFILE) ?? "unknown" });
    }

    const starts = pickStarts({ candidates, inUse: slotUses(d as unknown as State), pool: d.pool });
    for (const taskId of starts) {
      const task = d.tasks.find((entry) => entry.id === taskId);
      if (!task) continue;
      if (task.state === "queued") {
        task.startedAt = d.now;
        task.stageIndex = -1;
        this.log(d, task, "milestone", "Started from the queue");
      }
      this.startAgent(d, task);
    }
  }
}

function lastIndexWhere<T>(items: readonly T[], match: (item: T, index: number) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (match(items[index]!, index)) return index;
  }
  return -1;
}

function areaFromTitle(title: string): string {
  const words = title.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return words.slice(-2).join(" ") || "this part";
}
