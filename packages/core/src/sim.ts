// A deterministic stand-in for real agents. It drives the same state the real engine
// will: tasks move through their plan, agents report status lines, ask questions,
// request permissions, raise objections and findings, and wait at gates.
// The UI uses it today; the tests use it to pin down scheduling and gate rules.

import { answerByCall, CALL_WORDS, callCheckBody, callOn, dueAnswers, followingCall, type CallAnswer } from "./call.js";
import { composePlan } from "./library.js";
import { queueNeighbour, queuePlacement } from "./navigation.js";
import type {
  ActiveAgent,
  CheckRun,
  Column,
  DeliveryMode,
  DesignBrief,
  DesignCall,
  GateKind,
  Id,
  InboxItem,
  InboxKind,
  Product,
  Role,
  Stage,
  State,
  Task,
  TaskKind,
} from "./model.js";
import { balanced, extraSlot, pickStarts, queueOf, slotUses, slotWait, type Candidate } from "./scheduler.js";
import { afterChangesAsked, columnOf, designRoundEnd, gateStatus, gateTitle, noteRoundEnd, reviewRoundEnd, type DeepMutable } from "./flow.js";
import { findingCount } from "./findings.js";
import type { NewTaskInput } from "./commands.js";
import { productHistory, validateProductSettings, type ProductSettings } from "./products.js";
import { usageView, type UsageRequest, type UsageViewFor } from "./analytics.js";
import { askMomentId, MemoryWorkLog, turnTokens, type AskAnswer, type MomentOutcome, type TurnEnd, type TurnReason, type TurnReport, type WorkMoment, type WorkStageKind } from "./worklog.js";
import { SETUP_STEPS, type SetupStep } from "./setup.js";

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

/** How the simulated tools behave for one agent (keyed by `taskId|roleId`), so the demos show every case. */
export interface SimQuirk {
  /** Only for agents on this tool. */
  toolId?: Id;
  /** What the tool actually ran, when it differs from the profile. */
  ran?: { model: string; name: string; effort: string };
  /** The tool changed model or effort during the agent's first turn. */
  changedTo?: { model?: string; effort?: string };
  /** The tool never said what the session ran on. */
  notConfirmed?: boolean;
  /** Codex: helper agents started in the first turn, whose use Codex doesn't report. */
  helpers?: number;
  /** The first turn ends without a token report. */
  noTokens?: boolean;
  /** Claude Code sent only its main figure, without the per-model breakdown. */
  noBreakdown?: boolean;
  /** Claude Code: a second model in the breakdown (a helper agent or compaction). */
  extraModel?: string;
}

/** Turns and stages still open when a simulator stops, so another one can pick them up. */
export interface SimOpenWork {
  turns: readonly [Id, { id: Id; startedAt: number; waitedMs: number; waitingSince?: number; first: boolean }][];
  stages: readonly [Id, { stageId: Id; title: string; kind: WorkStageKind; roleId: Id; round: number; startedAt: number }][];
  runs: readonly [Id, number][];
}

export interface SimOptions {
  triggers?: Triggers;
  /** Work another simulator left open (the demos fast-forward tasks one by one). */
  open?: SimOpenWork;
  /** The work log the simulator writes. A fresh one by default. */
  log?: MemoryWorkLog;
  quirks?: Readonly<Record<string, SimQuirk>>;
  /** Ticks a pull request stays open before the simulated coordinator merges it on GitHub. */
  prMergeAfter?: number;
  /** Milliseconds of simulated time per tick when no clock value is given. */
  tickMs?: number;
  /** Tasks whose design reviewer keeps objecting every round, so the architects end up disagreeing. */
  disagree?: readonly Id[];
}

/** A new task for the demo: the window's, plus the area its scripted agents talk about. */
export interface NewTask extends NewTaskInput {
  area?: string;
}

export type MessageMode = "queue" | "interrupt";

const PLANNER_PROFILE = "sonnet-medium";
/** Requests are logged when raised and completed by an answer, as the engine does. */
const ASKS: ReadonlySet<string> = new Set(["question", "permission", "plan", "design", "delivery", "disagreement"]);
const DEMO_RISK: Record<TaskKind, { level: "low" | "medium" | "high"; why: string }> = {
  new: { level: "high", why: "A new product: everything it touches is new, sign-in included." },
  feature: { level: "medium", why: "New behaviour in one part of the product." },
  bug: { level: "medium", why: "A fix to how people sign in and pay, in one place." },
  chore: { level: "low", why: "Only words and styles change: nothing can be lost or opened up." },
};
const DEMO_CHECKS: CheckRun[] = [
  { name: "Type check", command: "bun run typecheck", ok: true, ms: 9_000, output: "No errors." },
  { name: "Tests", command: "bun run test", ok: true, ms: 41_000, output: "212 pass\n0 fail\nRan 212 tests across 31 files." },
  { name: "Build", command: "bun run build", ok: true, ms: 23_000, output: "Built in 22.4s." },
];

interface ScriptContext {
  area: string;
  product: string;
  round: number;
  fixing: boolean;
  /** The architect is following the coordinator's call. */
  following: boolean;
  /** The design reviewer keeps objecting every round. */
  objecting: boolean;
}

/** What each role says while it works, in plain language. */
function scriptFor(roleId: Id, ctx: ScriptContext): string[] {
  const { area, product, round, fixing, following, objecting } = ctx;
  switch (roleId) {
    // Only a release has one: Petrina sets the version and publishes it (see `ship`).
    case "release-manager":
      return ["Reading every commit since the previous release", "Grouping the changes: new, improved, fixed", "Writing the release notes"];
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
  private readonly work: MemoryWorkLog;
  private readonly quirks: Readonly<Record<string, SimQuirk>>;
  private readonly openTurns = new Map<Id, { id: Id; startedAt: number; waitedMs: number; waitingSince?: number; first: boolean }>();
  private readonly openStages = new Map<Id, { stageId: Id; title: string; kind: WorkStageKind; roleId: Id; round: number; startedAt: number }>();
  private readonly stageRuns = new Map<Id, number>();
  private serial = 0;
  private readonly disagree: ReadonlySet<Id>;

  constructor(state: State, options: SimOptions = {}) {
    this.state = state;
    this.triggers = options.triggers ?? {};
    this.disagree = new Set(options.disagree ?? []);
    this.prMergeAfter = options.prMergeAfter ?? 12;
    this.tickMs = options.tickMs ?? 40_000;
    this.work = options.log ?? new MemoryWorkLog(state.work?.since ?? state.now);
    this.quirks = options.quirks ?? {};
    this.serial = this.work.size();
    for (const [taskId, turn] of options.open?.turns ?? []) this.openTurns.set(taskId, { ...turn });
    for (const [taskId, stage] of options.open?.stages ?? []) this.openStages.set(taskId, { ...stage });
    for (const [stageId, runs] of options.open?.runs ?? []) this.stageRuns.set(stageId, runs);
    if (!state.work) this.state = { ...state, work: { version: 0, since: this.work.since() } };
  }

  getState = (): State => this.state;

  /** The simulator's work log (the demos read and shape it). */
  get workLog(): MemoryWorkLog {
    return this.work;
  }

  /** What is still open, moved `delta` milliseconds in time. */
  openWork(delta = 0): SimOpenWork {
    return {
      turns: [...this.openTurns.entries()].map(([taskId, turn]) => [taskId, { ...turn, startedAt: turn.startedAt + delta, ...(turn.waitingSince !== undefined ? { waitingSince: turn.waitingSince + delta } : {}) }]),
      stages: [...this.openStages.entries()].map(([taskId, stage]) => [taskId, { ...stage, startedAt: stage.startedAt + delta }]),
      runs: [...this.stageRuns.entries()],
    };
  }

  /** The numbers for one view, the same way the engine works them out. */
  usage<R extends UsageRequest>(request: R): UsageViewFor<R> {
    return usageView(this.work, request, { now: this.state.now, state: this.state });
  }

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
    }, "answered");
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
    }, "decided");
  }

  allow(itemId: Id, _scope: "once" | "always" = "once"): void {
    this.resolve(itemId, (d, task, item) => {
      this.log(d, task, "you", `You allowed: ${item.title}`);
      this.say(d, task, "agent", "Thanks, continuing.", item.roleId, item.profileId);
      this.unblock(task);
    }, "allowed");
  }

  deny(itemId: Id, note?: string): void {
    this.resolve(itemId, (d, task, item) => {
      this.log(d, task, "you", note ? `You said no: ${note}` : `You said no to: ${item.title}`);
      if (note) this.say(d, task, "you", note);
      this.say(d, task, "agent", "Understood. I'll find a way without it.", item.roleId, item.profileId);
      this.unblock(task);
    }, "denied");
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
          for (const objection of task.objections) {
            if (objection.status !== "open") continue;
            objection.status = "rejected";
            objection.decidedBy = "coordinator";
          }
          task.brief = briefFor(task);
          this.advance(d, task);
          break;
        case "delivery":
          this.log(d, task, "you", "You approved the delivery");
          this.continueAfterGate(d, task);
          break;
        case "guide": {
          const product = d.products.find((entry) => entry.id === task.productId);
          if (product && item.body) product.reviewGuide = [...(product.reviewGuide ?? []), { text: item.body, at: d.now, fromTask: task.id }];
          this.log(d, task, "you", `You added to the review guide: ${item.body ?? ""}`);
          break;
        }
        case "learnings": {
          const product = d.products.find((entry) => entry.id === task.productId);
          const lessons = (item.body ?? "").split("\n").map((line) => line.replace(/^- /, "").trim()).filter(Boolean);
          if (product) product.learnings = [...(product.learnings ?? []), ...lessons.map((text) => ({ text, at: d.now, fromTask: task.id }))];
          this.log(d, task, "you", `You added ${lessons.length === 1 ? "a lesson" : `${lessons.length} lessons`} to LEARNINGS.md`);
          break;
        }
        default:
          break;
      }
    }, "approved");
  }

  /** "Add the ticked ones": the lessons of an offer the coordinator keeps, by their place in it. */
  addLessons(itemId: Id, keep: number[]): void {
    this.resolve(itemId, (d, task, item) => {
      const product = d.products.find((entry) => entry.id === task.productId);
      const lessons = (item.body ?? "")
        .split("\n")
        .map((line) => line.replace(/^- /, "").trim())
        .filter(Boolean)
        .filter((_, index) => keep.includes(index));
      if (product) product.learnings = [...(product.learnings ?? []), ...lessons.map((text) => ({ text, at: d.now, fromTask: task.id }))];
      this.log(d, task, "you", lessons.length ? `You added ${lessons.length === 1 ? "a lesson" : `${lessons.length} lessons`} to AGENTS.md` : "You left AGENTS.md as it is");
    });
  }

  /** "Not this time" on an offer: the review guide, or AGENTS.md, stays as it is. */
  decline(itemId: Id): void {
    this.resolve(itemId, (d, task, item) => this.log(d, task, "you", item.kind === "learnings" ? "You left LEARNINGS.md as it is" : "You left the review guide as it is"));
  }

  /**
   * Send a gate back with a note: the design goes back to the architects, a delivery back to the builder,
   * a plan back to the planner. On a disagreement the note is the coordinator's call, which settles the design.
   */
  requestChanges(itemId: Id, note: string): void {
    this.resolve(itemId, (d, task, item) => {
      const call = item.kind === "disagreement";
      this.log(d, task, "you", call ? CALL_WORDS.made(note) : `You asked for changes: ${note}`);
      this.say(d, task, "you", note);
      afterChangesAsked(task, item.kind, note, d.now);
      task.state = "waiting";
      task.statusLine = "Waiting for a free slot";
      task.column = this.columnFor(d, task);
    }, "changes");
  }

  /** First run's demo: a product picked from the made-up clones. */
  addProduct(product: Product): void {
    this.update((d) => {
      if (d.products.some((entry) => entry.id === product.id)) return;
      d.products.push(JSON.parse(JSON.stringify(product)) as Draft["products"][number]);
      this.work.recordProduct({ id: product.id, name: product.name, repo: product.repo, addedAt: d.now });
      this.wrote(d);
    });
  }

  /** First run's demo: the furthest screen reached. */
  setSetupStep(step: SetupStep): void {
    const order = (value: SetupStep | undefined) => SETUP_STEPS.findIndex((entry) => entry.id === (value ?? "welcome"));
    this.update((d) => {
      if (d.setup && !d.setup.done && order(step) > order(d.setup.step)) d.setup.step = step;
    });
  }

  /** First run's demo: "Skip setup". */
  skipSetup(): void {
    this.update((d) => {
      if (d.setup) d.setup.done = true;
    });
  }

  /** First run's demo: Start adds the task and finishes setup. Sent again, it finds the same task. */
  startFirstTask(input: NewTask & { clientId: Id }): Id {
    const known = this.state.tasks.find((task) => task.clientId === input.clientId);
    if (known) return known.id;
    const id = this.addTask(input);
    this.update((d) => {
      const task = d.tasks.find((entry) => entry.id === id);
      if (task) task.clientId = input.clientId;
      if (d.setup) {
        d.setup.done = true;
        d.setup.firstTaskId ??= id;
      }
    });
    return id;
  }

  /** First run's demo: the board's one-time tip. */
  dismissTip(): void {
    this.update((d) => {
      if (d.setup) d.setup.tipDismissed = true;
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
      // The permanent list keeps the latest name, so a removed product shows under the name it last had.
      this.work.recordProduct({ id: product.id, name: product.name, repo: product.repo });
    });
  }

  removeProduct(productId: Id): void {
    const { unfinished } = productHistory(this.state.tasks, productId);
    if (unfinished) throw new Error(`${unfinished} task${unfinished === 1 ? " must" : "s must"} finish or be cancelled before this product can be removed.`);
    this.update((d) => {
      const product = d.products.find((entry) => entry.id === productId);
      // Its entry stays, marked removed, so its history keeps its name and its id is never reused.
      if (product) this.work.recordProduct({ id: product.id, name: product.name, repo: product.repo, removedAt: d.now });
      const ids = new Set(d.tasks.filter((task) => task.productId === productId).map((task) => task.id));
      d.inbox = d.inbox.filter((item) => !ids.has(item.taskId));
      d.tasks = d.tasks.filter((task) => !ids.has(task.id));
      d.products = d.products.filter((entry) => entry.id !== productId);
      this.wrote(d);
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

  placeInQueue(taskId: Id, anchorId: Id, side: "before" | "after"): number {
    const queue = queueOf(this.getState().tasks).map((task) => task.id);
    const index = queuePlacement(queue, taskId, anchorId, side);
    if (index === undefined) return -1;
    const hidden = Math.max(0, Math.abs(queue.indexOf(taskId) - queue.indexOf(anchorId)) - 1);
    this.moveInQueue(taskId, index);
    return hidden;
  }

  moveVisibleInQueue(taskId: Id, visibleIds: Id[], direction: -1 | 1): number {
    const queue = queueOf(this.getState().tasks).map((task) => task.id);
    const anchor = queueNeighbour(queue, visibleIds, taskId, direction);
    return anchor ? this.placeInQueue(taskId, anchor, direction < 0 ? "before" : "after") : -1;
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
      this.endTurn(d, task, "stopped");
      task.state = "paused";
      task.holdsSlot = false;
      task.statusLine = "Paused by you";
      d.inbox = d.inbox.filter((item) => item.taskId !== taskId || !item.blocking);
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
      this.endTurn(d, task, "stopped");
      this.endStage(d, task, "cancelled");
      this.moment(d, task, { kind: "task-end", outcome: "cancelled" });
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
        this.deliver(d, task, trimmed, true);
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

  /** `answer`: how the coordinator answered an agent or a checkpoint, for the work log. An offer (the review guide, LEARNINGS.md) has none. */
  private resolve(itemId: Id, change: (draft: Draft, task: DraftTask, item: DeepMutable<InboxItem>) => void, answer?: AskAnswer): void {
    this.update((d) => {
      const item = d.inbox.find((entry) => entry.id === itemId);
      const task = item && d.tasks.find((entry) => entry.id === item.taskId);
      if (!item || !task) return;
      d.inbox = d.inbox.filter((entry) => entry.id !== itemId);
      if (answer && ASKS.has(item.kind)) this.answered(d, task, item, answer);
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
    return columnOf(task as unknown as Task, d.roles as Role[]);
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
      delete task.helpers;
      task.column = this.columnFor(d, task);
      task.statusLine = waiting;
      return;
    }
    const agent: ActiveAgent = { ...next, since: d.now, step: 0 };
    task.agent = agent;
    // Reviewers look at the change together, as the engine's do: the ones still to report work beside this
    // one, each in a slot of its own while the pool and its tool allow.
    delete task.helpers;
    const current = this.stage(task);
    for (const profileId of current?.kind === "review-chain" ? current.profileIds.slice(task.sub + 1) : []) {
      const tool = d.profiles.find((profile) => profile.id === profileId)?.toolId ?? "unknown";
      if (!extraSlot(d as State, tool)) break;
      task.helpers = [...(task.helpers ?? []), { roleId: current!.roleId, profileId, since: d.now, step: 0 }];
    }
    task.state = "running";
    task.holdsSlot = true;
    task.column = this.columnFor(d, task);
    const role = d.roles.find((entry) => entry.id === next.roleId)?.name ?? next.roleId;
    task.statusLine = `${role} is starting`;
    this.say(d, task, "system", `${role} joined`, next.roleId, next.profileId);
    this.log(d, task, "milestone", `${role} started`, next.roleId, next.profileId);
    this.beginStage(d, task);
    this.openTurn(d, task, "first");
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
    const lines = scriptFor(agent.roleId, { area: task.area, product, round, fixing: task.fixing, following, objecting: this.disagree.has(task.id) });
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

  private deliver(d: Draft, task: DraftTask, text: string, interrupt = false): void {
    if (this.openTurns.has(task.id)) {
      this.endTurn(d, task, interrupt ? "interrupted" : "finished");
      this.openTurn(d, task, "message");
    }
    this.say(d, task, "you", text);
    this.log(d, task, "you", `You said: ${text}`);
    this.say(d, task, "agent", "Got it. I'll take that into account from here.", task.agent?.roleId, task.agent?.profileId);
  }

  private ask(d: Draft, task: DraftTask, trigger: Trigger): void {
    const agent = task.agent;
    // A question ends the agent's turn; a permission is answered inside it, and the wait is not work.
    if (trigger.kind === "question") this.endTurn(d, task, "finished");
    else {
      const open = this.openTurns.get(task.id);
      if (open) open.waitingSince = d.now;
    }
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
    if (ASKS.has(kind)) this.askMoment(d, task, d.inbox.at(-1)!);
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
    this.endTurn(d, task, "finished");

    if (task.stageIndex < 0) {
      task.plan = composePlan(task) as DeepMutable<NonNullable<Task["plan"]>>;
      task.risk = DEMO_RISK[task.kind];
      const count = task.plan.stages.filter((stage) => stage.kind !== "gate").length;
      this.log(d, task, "milestone", `Plan ready: ${count} stages. ${task.plan.rationale}`, agent.roleId, agent.profileId);
      this.say(d, task, "agent", task.plan.rationale, agent.roleId, agent.profileId);
      this.endStage(d, task, "done");
      if (task.approvePlan) this.gate(d, task, "plan");
      else this.advance(d, task);
      return;
    }

    const stage = this.stage(task);
    if (!stage) return;
    const round = this.round(task);

    if (stage.kind === "do" && agent.roleId === "release-manager") {
      this.endStage(d, task, "delivered");
      this.ship(d, task);
      return;
    }

    if (stage.kind === "do") {
      if (agent.roleId === "builder" && task.fixing) {
        for (const finding of task.findings) {
          if (finding.status !== "open" || finding.severity === "pre-existing") continue;
          const fixed = finding.severity === "blocking";
          finding.answer = { fixed, text: fixed ? "Fixed, with a test for addresses with a plus sign." : "Kept as is: the current message matches the rest of the product.", at: d.now };
          if (fixed) finding.status = "fixed";
        }
        task.fixing = false;
        this.log(d, task, "done", "Fixed the blocking findings", agent.roleId, agent.profileId);
      } else {
        this.log(d, task, "done", `${stage.title} done`, agent.roleId, agent.profileId);
      }
      this.endStage(d, task, "done");
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
        this.endStage(d, task, "settled");
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
      // A round that raised objections is logged once, even when it settles.
      let logged = false;
      if (round === 1 || this.disagree.has(task.id)) {
        const raised =
          round === 1
            ? [
                { blocking: true, text: `What happens to ${task.area} for people who already have an account? The brief does not say.` },
                { blocking: false, text: `Consider remembering the last choice in ${task.area} on this device.` },
              ]
            : laterObjections(task.area, round);
        for (const objection of raised) task.objections.push({ id: this.id(d, task.id), round, raisedBy: agent.profileId, status: "open", ...objection });
        const blocking = raised.filter((objection) => objection.blocking).length;
        this.log(d, task, "warn", `Raised ${raised.length} objections, ${blocking} blocking`, agent.roleId, agent.profileId);
        this.designRound(d, task, stage, round, raised.length, blocking);
        logged = true;
        const end = designRoundEnd(blocking, round, stage as Stage);
        if (end === "disagreement") {
          this.moment(d, task, { kind: "design-end", outcome: "to-you", rounds: round, roleId: stage.roleId, ...(stage.profileIds[0] ? { profileId: stage.profileIds[0] } : {}) });
          this.endStage(d, task, "to-you");
          this.gateDisagreement(d, task);
          return;
        }
        if (end === "next round") {
          task.rounds[stage.id] = round + 1;
          task.sub = 0;
          this.startAgent(d, task);
          return;
        }
      }
      task.brief = briefFor(task);
      this.log(d, task, "done", "Design settled: no blocking objections", agent.roleId, agent.profileId);
      if (!logged) this.designRound(d, task, stage, round, 0, 0);
      this.moment(d, task, { kind: "design-end", outcome: "settled", rounds: round, roleId: stage.roleId, ...(stage.profileIds[0] ? { profileId: stage.profileIds[0] } : {}) });
      this.endStage(d, task, "settled");
      this.advance(d, task);
      return;
    }

    if (stage.kind === "review-chain") {
      // Petrina runs the product's checks itself before the first reviewer of each round.
      if (task.sub === 0) task.checks = { at: d.now, results: DEMO_CHECKS };
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
        this.log(d, task, "warn", "1 important", agent.roleId, agent.profileId);
        this.moment(d, task, { kind: "verdict", verdict: "fail", roleId: agent.roleId, profileId: agent.profileId, count: 1, blocking: 1 });
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
        task.findings.push({
          id: this.id(d, task.id),
          text: "The sign-in page has no limit on attempts. It was like this before the change.",
          severity: "pre-existing",
          raisedBy: agent.profileId,
          confirmedBy: [],
          status: "open",
        });
        this.log(d, task, "warn", "1 nit, 1 follow-up; confirmed 1", agent.roleId, agent.profileId);
        const blocking = task.findings.filter((finding) => finding.status === "open" && finding.severity === "blocking" && finding.confirmedBy.includes(agent.profileId)).length;
        this.moment(d, task, { kind: "verdict", verdict: blocking ? "fail" : "pass", roleId: agent.roleId, profileId: agent.profileId, count: 2 + blocking, blocking });
      } else {
        this.log(d, task, "done", "Nothing to fix", agent.roleId, agent.profileId);
        this.moment(d, task, { kind: "verdict", verdict: "pass", roleId: agent.roleId, profileId: agent.profileId, count: 0, blocking: 0 });
      }

      if (task.sub + 1 < stage.profileIds.length) {
        task.sub += 1;
        this.startAgent(d, task);
        return;
      }

      const open = task.findings.filter((finding) => finding.status === "open" && finding.severity === "blocking");
      const end = reviewRoundEnd(task as unknown as Task, stage as Stage, round);
      noteRoundEnd(task, stage.id, open.length);
      if (end.kind === "send back") {
        task.rounds[stage.id] = round + 1;
        task.stageIndex = end.builder;
        task.sub = 0;
        task.fixing = true;
        this.log(d, task, "warn", `Sent back to the builder: ${findingCount(open)}`);
        this.moment(d, task, { kind: "review-end", outcome: "sent-back", stageId: stage.id, stageTitle: stage.title, stageKind: stage.kind, round });
        this.endStage(d, task, "sent-back", stage.id);
        this.startAgent(d, task);
        return;
      }
      this.log(d, task, end.kind === "used up" ? "warn" : "done", end.kind === "used up" ? `Review rounds used up: ${findingCount(open)} still open` : `Review passed: ${findingCount(task.findings.filter((finding) => finding.status === "open"))}`);
      this.moment(d, task, { kind: "review-end", outcome: end.kind === "used up" ? "rounds-used" : "passed" });
      this.endStage(d, task, end.kind === "used up" ? "rounds-used" : "passed");
      this.advance(d, task);
    }
  }

  private advance(d: Draft, task: DraftTask): void {
    delete task.helpers;
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
    if (this.petrinaDelivers(task)) {
      this.ship(d, task);
      return;
    }
    this.startAgent(d, task);
  }

  /** Pull requests and commits to main need no agent: Petrina publishes them itself, as the engine does. A release's notes come from the Release Manager first. */
  private petrinaDelivers(task: DraftTask): boolean {
    const stage = this.stage(task);
    return task.delivery !== "release" && stage?.kind === "do" && stage.roleId === "release-manager";
  }

  private gate(d: Draft, task: DraftTask, gate: GateKind): void {
    delete task.agent;
    delete task.helpers;
    task.holdsSlot = false;
    task.statusLine = gateStatus(task as unknown as Task, gate);
    const body = gate === "design" ? callCheckBody(task as unknown as Task) : undefined;
    this.raise(d, task, gate, gateTitle(task as unknown as Task, gate), false, body ? { body } : {});
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
    if (this.petrinaDelivers(task)) {
      this.ship(d, task);
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
    this.log(d, task, "status", "Petrina pushed the branch");
    this.log(d, task, "done", `Petrina opened pull request #${number}, and checked it on GitHub`);
    this.moment(d, task, { kind: "task-end", outcome: "delivered" });
  }

  /** Petrina publishes it, the way the task asks: with the builder's text, or the Release Manager's notes. */
  private ship(d: Draft, task: DraftTask): void {
    if (task.agent) this.log(d, task, "done", "Ready to publish", "release-manager", task.agent.profileId);
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
    this.moment(d, task, { kind: "task-end", outcome: "delivered" });
    if (task.delivery === "release") {
      const tag = `v1.${(d.seq % 40) + 1}.0`;
      task.release = { tag, url: `https://github.com/${product?.repo ?? "owner/repo"}/releases/tag/${tag}` };
      task.statusLine = `Released ${tag}`;
      this.log(d, task, "status", `Petrina pushed main and the tag ${tag}`);
      this.log(d, task, "done", `Petrina published release ${tag}, and checked it on GitHub`);
    } else {
      const sha = (d.seq * 2654435761).toString(16).slice(0, 7);
      task.landed = { branch: product?.defaultBranch ?? "main", sha };
      task.statusLine = `Committed to ${task.landed.branch} (${sha})`;
      this.log(d, task, "done", `Petrina moved ${task.landed.branch} forward to it (${sha}), and checked the main copy`);
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
    this.moment(d, task, { kind: "task-end", outcome: "merged" });
  }

  // ── The work log ─────────────────────────────────────────────────────────

  private wrote(d: Draft): void {
    d.work = { version: (d.work?.version ?? 0) + 1, since: d.work?.since ?? this.work.since() };
  }

  private entryId(prefix: string): Id {
    this.serial += 1;
    return `${prefix}-${this.serial}`;
  }

  private stageContext(task: DraftTask): { stageId: Id; title: string; kind: WorkStageKind; roleId: Id } {
    const stage = this.stage(task);
    if (!stage) return { stageId: `${task.id}:plan`, title: "Planning", kind: "plan", roleId: "planner" };
    return { stageId: stage.id, title: stage.title, kind: stage.kind, roleId: stage.roleId };
  }

  private moment(d: Draft, task: DraftTask, moment: Omit<WorkMoment, "id" | "at" | "taskId" | "productId">, when: { id?: Id; at?: number } = {}): void {
    const open = this.openStages.get(task.id);
    const context = open ?? this.stageContext(task);
    this.work.addMoment({
      id: when.id ?? this.entryId(`${task.id}-m`),
      at: when.at ?? d.now,
      taskId: task.id,
      productId: task.productId,
      ...(moment.kind === "task-end" ? {} : { stageId: context.stageId, stageTitle: context.title, stageKind: context.kind, round: context.kind === "converge" || context.kind === "review-chain" ? this.round(task) : (open?.round ?? this.round(task)) }),
      ...moment,
    });
    this.wrote(d);
  }

  private beginStage(d: Draft, task: DraftTask): void {
    const context = this.stageContext(task);
    const open = this.openStages.get(task.id);
    if (open?.stageId === context.stageId) return;
    if (open) this.endStage(d, task, "done");
    const runs = (this.stageRuns.get(context.stageId) ?? 0) + 1;
    this.stageRuns.set(context.stageId, runs);
    const stage = this.stage(task);
    const round = stage && (stage.kind === "converge" || stage.kind === "review-chain") ? (task.rounds[stage.id] ?? 1) : runs;
    this.openStages.set(task.id, { ...context, round, startedAt: d.now });
    this.moment(d, task, { kind: "stage-start", roleId: context.roleId });
  }

  private endStage(d: Draft, task: DraftTask, outcome: MomentOutcome, stageId?: Id): void {
    const open = this.openStages.get(task.id);
    if (!open || (stageId && open.stageId !== stageId)) return;
    const workMs = this.work
      .turns({ taskId: task.id })
      .filter((turn) => turn.stageId === open.stageId && turn.startedAt >= open.startedAt)
      .reduce((sum, turn) => sum + (turn.workMs ?? 0), 0);
    this.moment(d, task, { kind: "stage-end", outcome, roleId: open.roleId, durationMs: d.now - open.startedAt, workMs });
    this.openStages.delete(task.id);
  }

  private designRound(d: Draft, task: DraftTask, stage: DeepMutable<Stage>, round: number, objections: number, blocking: number): void {
    this.moment(d, task, {
      kind: "design-round",
      roleId: stage.roleId,
      ...(stage.profileIds[0] ? { profileId: stage.profileIds[0] } : {}),
      ...(stage.reviewerRoleId ? { peerRoleId: stage.reviewerRoleId } : {}),
      ...(stage.reviewerProfileIds?.[0] ? { peerProfileId: stage.reviewerProfileIds[0] } : {}),
      round,
      count: objections,
      blocking,
    });
  }

  /** The coordinator answered something: how long it took and what it was. */
  private answered(d: Draft, task: DraftTask, item: DeepMutable<InboxItem>, answer: AskAnswer): void {
    this.askMoment(d, task, item, answer);
    if (item.kind === "question" && task.agent) this.openTurn(d, task, "answer");
    const open = this.openTurns.get(task.id);
    if (item.kind === "permission" && open?.waitingSince !== undefined) {
      open.waitedMs += d.now - open.waitingSince;
      delete open.waitingSince;
    }
  }

  private askMoment(d: Draft, task: DraftTask, item: DeepMutable<InboxItem>, answer?: AskAnswer): void {
    const ask = item.kind === "question" ? "question" : item.kind === "permission" ? "permission" : "checkpoint";
    this.moment(d, task, { kind: "ask", ask, ...(answer ? { answer, durationMs: Math.max(0, d.now - item.at) } : {}), ...(item.roleId ? { roleId: item.roleId } : {}), ...(item.profileId ? { profileId: item.profileId } : {}) }, { id: askMomentId(task.id, item.id), at: item.at });
  }

  private openTurn(d: Draft, task: DraftTask, reason: TurnReason): void {
    const agent = task.agent;
    if (!agent) return;
    this.endTurn(d, task, "finished");
    const profile = d.profiles.find((entry) => entry.id === agent.profileId);
    const toolId = profile?.toolId ?? "unknown";
    const quirk = this.quirkFor(task.id, agent.roleId, toolId);
    const open = this.openStages.get(task.id);
    const context = open ?? { ...this.stageContext(task), round: this.round(task) };
    // Design and review rounds come from the stage; a do stage's round is which run of it this is.
    const round = context.kind === "converge" || context.kind === "review-chain" ? this.round(task) : context.round;
    const asked = profile?.modelId ?? profile?.model;
    const ran = quirk.notConfirmed ? undefined : (quirk.ran ?? (asked ? { model: asked, name: toolId === "codex" ? asked : (profile?.model ?? asked), effort: profile?.effort ?? "high" } : undefined));
    const id = this.entryId(`${task.id}-turn`);
    const first = !this.work.turns({ taskId: task.id }).some((turn) => turn.roleId === agent.roleId);
    this.work.addTurn({
      id,
      taskId: task.id,
      productId: task.productId,
      stageId: context.stageId,
      stageTitle: context.title,
      stageKind: context.kind,
      round,
      fixing: task.fixing,
      roleId: agent.roleId,
      toolId,
      profileId: agent.profileId,
      ...(asked ? { modelAsked: asked } : {}),
      ...(profile?.model ? { modelAskedName: profile.model } : {}),
      ...(profile?.effort ? { effortAsked: profile.effort } : {}),
      ...(ran ? { modelRan: ran.model, modelRanName: ran.name, effortRan: ran.effort } : {}),
      ...(first && quirk.changedTo?.model ? { modelChangedTo: quirk.changedTo.model } : {}),
      ...(first && quirk.changedTo?.effort ? { effortChangedTo: quirk.changedTo.effort } : {}),
      sessionId: `${task.id}-agent-${agent.since}`,
      reason,
      startedAt: d.now,
      mainOnly: false,
      helpers: 0,
    });
    this.openTurns.set(task.id, { id, startedAt: d.now, waitedMs: 0, first });
    this.wrote(d);
  }

  private quirkFor(taskId: Id, roleId: Id, toolId: Id): SimQuirk {
    const quirk = this.quirks[`${taskId}|${roleId}`];
    return quirk && (!quirk.toolId || quirk.toolId === toolId) ? quirk : {};
  }

  private endTurn(d: Draft, task: DraftTask, end: TurnEnd): void {
    const open = this.openTurns.get(task.id);
    if (!open) return;
    this.openTurns.delete(task.id);
    const turn = this.work.turn(open.id);
    if (!turn) return;
    const waited = open.waitedMs + (open.waitingSince !== undefined ? d.now - open.waitingSince : 0);
    const workMs = Math.max(0, d.now - open.startedAt - waited);
    const quirk = this.quirkFor(task.id, turn.roleId, turn.toolId);
    const reported = end === "finished" || end === "interrupted";
    const silent = !reported || (open.first && quirk.noTokens);
    const helpers = open.first ? (quirk.helpers ?? 0) : 0;
    const report = silent ? undefined : simReport(`${open.id}|${turn.profileId}`, turn.toolId, turn.modelChangedTo ?? turn.modelRan ?? turn.modelAsked ?? "", turn.roleId, workMs, open.first ? quirk : {});
    const counted = turnTokens({ toolId: turn.toolId, ...(report ? { report } : {}), ...(turn.modelRanName ? { model: turn.modelRanName } : {}), rerouted: turn.toolId === "codex" && turn.modelChangedTo !== undefined, helpers });
    this.work.endTurn(open.id, { end, endedAt: d.now, workMs, mainOnly: counted.mainOnly, helpers, ...(counted.tokens ? { tokens: counted.tokens } : {}) }, counted.lines);
    this.wrote(d);
  }

  /** Fill free slots: tasks already in progress first (the tool with more of its limit left first), then the queue, in priority order. */
  private schedule(d: Draft): void {
    const toolOf = new Map(d.profiles.map((profile) => [profile.id, profile.toolId]));
    const inProgress = d.tasks.filter((task) => task.state === "waiting").sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    const continuing: Candidate[] = [];
    for (const task of inProgress) {
      const next = this.nextAgent(task);
      if (next) {
        const candidate = { taskId: task.id, toolId: toolOf.get(next.profileId) ?? "unknown" };
        task.statusLine = slotWait(d as State, candidate) ?? "Waiting for a free slot";
        continuing.push(candidate);
      }
    }
    const candidates = balanced(continuing, d.pool, d.now);
    for (const task of queueOf(d.tasks as Task[])) {
      if (task.held) continue;
      candidates.push({ taskId: task.id, toolId: toolOf.get(PLANNER_PROFILE) ?? "unknown" });
    }

    const starts = pickStarts({ candidates, inUse: slotUses(d as unknown as State), pool: d.pool, now: d.now });
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


function areaFromTitle(title: string): string {
  const words = title.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return words.slice(-2).join(" ") || "this part";
}

function hash(text: string): number {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

const FULL_MODEL: Record<string, string> = { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5", fable: "claude-fable-5-1" };

/** Believable token figures for a simulated turn: mostly input reused from the cache, as with the real tools. */
function simReport(seed: string, toolId: Id, model: string, roleId: Id, workMs: number, quirk: SimQuirk): TurnReport {
  const minutes = Math.max(0.3, workMs / 60_000);
  const jitter = (salt: string) => 0.6 + (hash(`${seed}|${salt}`) % 800) / 1000;
  const heavy = roleId === "builder" ? 1.6 : roleId === "code-reviewer" ? 1.1 : roleId === "planner" ? 0.5 : 0.8;
  const scale = minutes * heavy;
  if (toolId === "codex") {
    const output = Math.round(1000 * scale * jitter("out"));
    const counts = { input: Math.round(2800 * scale * jitter("in")), cacheRead: Math.round(30_000 * scale * jitter("cache")), cacheWrite: 0, output, reasoning: Math.round(output * 0.4 * jitter("reason")) };
    return { main: counts, models: [{ model, counts }] };
  }
  const counts = { input: Math.round(900 * scale * jitter("in")), cacheRead: Math.round(38_000 * scale * jitter("cache")), cacheWrite: Math.round(3400 * scale * jitter("write")), output: Math.round(800 * scale * jitter("out")) };
  if (quirk.noBreakdown) return { main: counts };
  const main = FULL_MODEL[model] ?? model;
  const helper = quirk.extraModel ?? (roleId === "builder" && hash(seed) % 3 === 0 ? "claude-haiku-5-5" : undefined);
  const models = [{ model: main, counts }];
  if (helper) {
    const share = 0.08 + (hash(`${seed}|helper`) % 100) / 1000;
    models.push({ model: helper, counts: { input: Math.round(counts.input * share), cacheRead: Math.round(counts.cacheRead * share), cacheWrite: Math.round(counts.cacheWrite * share), output: Math.round(counts.output * share * 1.5) } });
  }
  // The main figure counts the main agent loop only, so it is smaller than the breakdown. Petrina never adds the two.
  return { main: { ...counts, output: Math.round(counts.output * 0.9) }, models };
}
