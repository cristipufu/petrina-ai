import { demoProfileChoices, saveProfile, removeProfile, type ProfileDraft } from "./profiles.js";
import { messageRemovable } from "./message-delivery.js";
import { saveRoutine, admitRoutines, prepareMaintenanceTask, type RoutineDraft } from "./routines.js";
import { DEMO_RISK, DEMO_CHECKS, scriptFor, laterObjections, callAnswers, briefFor, capitalize, areaFromTitle, simReport, demoSource, simVersions, simAcceptance } from "./sim-script.js";
import type { Trigger, Triggers, SimQuirk, SimOpenWork, SimOptions, NewTask, MessageMode } from "./sim-types.js";
export { readCall } from "./sim-script.js";
export type { Trigger, Triggers, SimQuirk, SimOpenWork, SimOptions, NewTask, MessageMode } from "./sim-types.js";
import { createTaskState, queueBacklogTask, returnQueuedTaskToBacklog, editBacklogRequest, combineBacklogTasks, assertTaskDependenciesEditable, validateTaskDependencies, blockingDependencies, assignFutureProfile, appendFutureReviewer, pauseTaskState, resumeTaskState, cancelTaskState, finishTaskStep } from "./task-transitions.js";
import { combinedBacklogInput } from "./combine-backlog.js";
import { companionPreview, involvesProduct, repositoryPublished, taskProductIds, withoutProduct } from "./repositories.js";
import { deliveryLabel, workSummary, type WorkChoice } from "./source.js";
import { builderReturnWords, decisionEvidence } from "./check-evidence.js";
// A deterministic stand-in for real agents. It drives the same state the real engine
// will: tasks move through their plan, agents report status lines, ask questions,
// request permissions, raise objections and findings, and wait at gates.
// The UI uses it today; the tests use it to pin down scheduling and gate rules.

import { answerByCall, CALL_WORDS, callCheckBody, dueAnswers, followingCall } from "./call.js";
import {
  addAsk,
  AFTER_WORDS,
  beginAgentStep,
  beginPetrinaStep,
  beginYouStep,
  endAgentStep,
  endPetrinaStep,
  endYouStep,
  JOURNEY_WORDS as W,
  recordStepResult,
  openStep,
  settleAsk,
  stepTag,
  syncWait,
  withdrawAsks,
} from "./journey.js";
import { CLEANUP_WORDS, copyNoLongerNeeded } from "./cleanup.js";
import { composePlan } from "./library.js";
import { queueNeighbour, queuePlacement } from "./navigation.js";
import type {
  ActiveAgent,
  Column,
  DeliveryMode,
  DesignCall,
  GateKind,
  Id,
  InboxItem,
  InboxKind,
  Product,
  Role,
  RoleChanges,
  ScreenMode,
  Stage,
  State,
  Task,
} from "./model.js";
import { balanced, extraSlot, pickStarts, queueOf, slotUses, slotWait, type Candidate } from "./scheduler.js";
import { afterChangesAsked, columnOf, designRoundEnd, gateStatus, gateTitle, noteRoundEnd, reviewRoundEnd, type DeepMutable } from "./flow.js";
import { findingCount } from "./findings.js";
import * as library from "./roles.js";
import type { RoleDraft } from "./roles.js";
import { onScreen, SCREEN_HOUR_MS, SCREEN_WORDS, screenAllowed, screenMode, screenQueue, screenReady, screenReason, screenWait } from "./screen.js";
import { productHistory, validateProductSettings, type ProductSettings } from "./products.js";
import { usageView, type UsageRequest, type UsageViewFor } from "./analytics.js";
import { continuingAgentTurn, askMomentId, MemoryWorkLog, turnTokens, type AskAnswer, type MomentOutcome, type TurnEnd, type TurnReason, type WorkMoment, type WorkStageKind } from "./worklog.js";
import { SETUP_STEPS, type SetupStep } from "./setup.js";
import { pauseClock, plainTodo, resumeClock, startClock } from "./summary.js";
import { demoHistoryPage, historyPageUsage, type HistoryQuery } from "./history.js";

type Draft = DeepMutable<State>;
type DraftTask = DeepMutable<Task>;

const PLANNER_PROFILE = "sonnet-medium";
/** Requests are logged when raised and completed by an answer, as the engine does. */
const ASKS: ReadonlySet<string> = new Set(["question", "permission", "plan", "design", "delivery", "disagreement"]);
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
  private readonly pullRequestAges = new Map<Id, number>();
  private readonly disagree: ReadonlySet<Id>;
  private readonly lockedCopies: ReadonlySet<Id>;

  constructor(state: State, options: SimOptions = {}) {
    this.state = state;
    this.triggers = options.triggers ?? {};
    this.disagree = new Set(options.disagree ?? []);
    this.lockedCopies = new Set(options.lockedCopies ?? []);
    this.prMergeAfter = options.prMergeAfter ?? 12;
    this.tickMs = options.tickMs ?? 40_000;
    this.work = options.log ?? new MemoryWorkLog(state.work?.since ?? state.now);
    this.quirks = options.quirks ?? {};
    this.serial = this.work.size();
    for (const [taskId, turn] of options.open?.turns ?? []) this.openTurns.set(taskId, { ...turn });
    for (const [taskId, stage] of options.open?.stages ?? []) this.openStages.set(taskId, { ...stage });
    for (const [stageId, runs] of options.open?.runs ?? []) this.stageRuns.set(stageId, runs);
    for (const [taskId, age] of options.open?.pullRequests ?? []) this.pullRequestAges.set(taskId, age);
    if (!state.work) this.state = { ...state, work: { version: 0, since: this.work.since() } };
  }

  async profileChoices({ toolId, modelId }: import("./profiles.js").ProfileChoiceRequest) { return demoProfileChoices(toolId, modelId); }
  async saveProfile(draft: ProfileDraft, clientId: Id, profileId?: Id): Promise<Id> {
    let id = clientId;
    this.update(state => { id = saveProfile(state, draft, demoProfileChoices(draft.toolId, draft.modelId), clientId, profileId); state.planner = this.planner(state); });
    return id;
  }
  removeProfile(profileId: Id): void { this.update(state => { removeProfile(state, profileId); state.planner = this.planner(state); }); }
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
      pullRequests: [...this.pullRequestAges.entries()],
    };
  }

  /** The numbers for one view, the same way the engine works them out. */
  usage<R extends UsageRequest>(request: R): UsageViewFor<R> {
    return usageView(this.work, request, { now: this.state.now, state: this.state });
  }

  historyPage(query: HistoryQuery) {
    const page = demoHistoryPage(this.state, query);
    return query.includeUsage ? historyPageUsage(page, this.work) : page;
  }
  taskDetails(taskId: Id): Task | undefined { return this.state.tasks.find((task) => task.id === taskId); }
  async previewImage(_taskId: Id, _path: string): Promise<{ mime: string; data: string }> {
    throw new Error("This image is unavailable in the demo.");
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Advance every running agent by one step, merge old pull requests, retry removing working copies, and start what fits in the pool. */
  tick(now?: number): void {
    this.update((d) => {
      d.now = now ?? d.now + this.tickMs;
      for (const task of d.tasks) {
        if (task.state === "running") this.step(d, task);
        else if (task.state === "pr-open" || (task.state === "cancelled" && task.pr?.state === "open")) this.agePullRequest(d, task);
        else if (task.cleanup?.error) this.removeCopy(d, task);
      }
      this.schedule(d);
    });
  }

  // ── Coordinator actions ────────────────────────────────────────────────────

  answer(itemId: Id, answer: string): void {
    this.resolve(itemId, (d, task, item) => {
      settleAsk(task, item.id, "answered", d.now, answer);
      this.say(d, task, "you", answer);
      this.log(d, task, "you", `You answered: ${answer}`);
      this.say(d, task, "agent", `Thanks. Going with: ${answer}.`, item.roleId, item.profileId);
      this.unblock(d, task);
    }, "answered");
  }

  /** The agent goes with its own recommendation (the first option). */
  decideForMe(itemId: Id): void {
    const item = this.state.inbox.find((entry) => entry.id === itemId);
    const pick = item?.options?.[0];
    if (!item || !pick) return;
    this.resolve(itemId, (d, task) => {
      settleAsk(task, itemId, "decided", d.now, pick);
      this.log(d, task, "you", `You let the agent decide. It chose: ${pick}`);
      this.say(d, task, "agent", `I'll go with: ${pick}.`, item.roleId, item.profileId);
      this.unblock(d, task);
    }, "decided");
  }

  allow(itemId: Id, _scope: "once" | "always" = "once"): void {
    this.resolve(itemId, (d, task, item) => {
      settleAsk(task, item.id, "allowed", d.now);
      this.log(d, task, "you", `You allowed: ${item.title}`);
      this.say(d, task, "agent", "Thanks, continuing.", item.roleId, item.profileId);
      this.unblock(d, task);
    }, "allowed");
  }

  deny(itemId: Id, note?: string): void {
    this.resolve(itemId, (d, task, item) => {
      settleAsk(task, item.id, "denied", d.now, note);
      this.log(d, task, "you", note ? `You said no: ${note}` : `You said no to: ${item.title}`);
      if (note) this.say(d, task, "you", note);
      this.say(d, task, "agent", "Understood. I'll find a way without it.", item.roleId, item.profileId);
      this.unblock(d, task);
    }, "denied");
  }

  /** Approve a gate (plan, design, delivery) or settle a disagreement with the architect's position. */
  approve(itemId: Id): void {
    this.resolve(itemId, (d, task, item) => {
      switch (item.kind) {
        case "plan":
          if (task.workRows && (!task.workRows.length || task.workRows.some((row) => row.error || !row.source))) throw new Error("Correct every product choice first.");
          if (task.workRows) {
            task.repositories = task.workRows.map((row) => ({ productId: row.choice.productId, workChoice: row.choice, delivery: row.choice.delivery, source: { ...row.source!, confirmed: true }, completedStages: [], preparation: "ready" }));
            task.leadProductId = task.workRows.find((row) => row.choice.lead)?.choice.productId ?? task.repositories[0]!.productId;
            const first = task.repositories[0]!;
            task.productId = first.productId;
            task.workChoice = first.workChoice;
            task.source = first.source;
            task.delivery = first.delivery;
            for (const stage of task.plan?.stages ?? []) if (stage.kind === "do" && d.roles.find(role => role.id === stage.roleId)?.result === "delivery") stage.title = task.repositories.length > 1 ? `Deliver across ${task.repositories.length} products` : deliveryLabel(task);
          }
          task.confirmWork = false;
          if (task.source) task.source.confirmed = true;
          this.log(d, task, "you", "You approved the plan");
          endYouStep(task, { outcome: W.approved, reason: W.youApproved }, d.now);
          this.continueAfterGate(d, task);
          break;
        case "design":
          this.log(d, task, "you", "You approved the design");
          endYouStep(task, { outcome: W.approved, reason: W.youApproved }, d.now);
          this.continueAfterGate(d, task);
          break;
        case "disagreement":
          this.log(d, task, "you", "You sided with the architect");
          endYouStep(task, { outcome: W.sided, reason: W.youSided }, d.now);
          for (const objection of task.objections) {
            if (objection.status !== "open") continue;
            objection.status = "rejected";
            objection.decidedBy = "coordinator";
          }
          task.brief = briefFor(task);
          this.advance(d, task);
          break;
        case "delivery":
          if (task.reviewDecision?.accepted === false) {
            task.reviewDecision.accepted = true;
            this.log(d, task, "you", "You accepted the unresolved review for final verification; delivery is not approved");
            endYouStep(task, { outcome: "Continue to final checks", reason: "unresolved review accepted; delivery is not approved" }, d.now);
            this.continueAfterGate(d, task, false);
            break;
          }
          this.log(d, task, "you", "You approved the delivery");
          endYouStep(task, { outcome: W.approved, reason: W.youApproved }, d.now);
          // After review rounds ran out, the check was raised on the delivery stage itself.
          this.continueAfterGate(d, task, this.stage(task)?.kind === "gate");
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
          this.log(d, task, "you", `You added ${lessons.length === 1 ? "a lesson" : `${lessons.length} lessons`} to AGENTS.md`);
          break;
        }
        case "screen":
          if (task.screen && !task.screen.granted) {
            task.screen.allowed = true;
            this.log(d, task, "you", SCREEN_WORDS.allowedNow);
          }
          break;
        default:
          break;
      }
    }, "approved");
  }

  rerunChecks(itemId: Id): void {
    this.resolve(itemId, (d, task, item) => {
      if (item.kind !== "delivery") return;
      endYouStep(task, { outcome: "Run checks again", reason: W.checkAgain }, d.now);
      this.log(d, task, "you", "You asked to run checks again; delivery is not approved");
      this.runChecks(d, task);
      for (const finding of task.findings) if (finding.raisedBy === "petrina" && finding.text.startsWith("Check failed")) finding.status = "fixed";
      delete task.checkReturns;
      this.unblock(d, task);
    }, "answered");
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
    this.resolve(itemId, (d, task, item) => this.log(d, task, "you", item.kind === "learnings" ? "You left AGENTS.md as it is" : "You left the review guide as it is"));
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
      endYouStep(task, call ? { outcome: W.madeCall, reason: W.yourCall, tone: "back" } : { outcome: W.changes, reason: W.changesAsked, tone: "back" }, d.now);
      task.notes = [...(task.notes ?? []), { at: d.now, text: note }];
      afterChangesAsked(task, item.kind, note, d.now, d.roles);
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
      const ids = new Set(d.tasks.filter((task) => involvesProduct(task, productId) && taskProductIds(task).length === 1).map((task) => task.id));
      for (const id of ids) this.pullRequestAges.delete(id);
      d.inbox = d.inbox.filter((item) => !ids.has(item.taskId));
      d.tasks = d.tasks.flatMap((task) => {
        const retained = withoutProduct(task, productId);
        return retained ? [retained as DraftTask] : [];
      });
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

  /** "Agents may use the screen". Off never stops the agent on the screen; nobody new gets it. */
  setScreenUse(mode: ScreenMode): void {
    this.update((d) => {
      d.pool.screen = mode === "hour" ? { mode, until: d.now + SCREEN_HOUR_MS } : { mode };
      this.schedule(d);
    });
  }

  /** Allow now: this request may use the screen, one agent at a time. */
  allowScreen(taskId: Id): void {
    this.updateTask(taskId, (d, task) => {
      if (!task.screen || task.screen.granted || task.screen.allowed) return;
      task.screen.allowed = true;
      this.log(d, task, "you", SCREEN_WORDS.allowedNow);
      this.schedule(d);
    });
  }

  /** "Allow the screen for this task", even while the switch is off. */
  setTaskScreen(taskId: Id, allowed: boolean): void {
    this.updateTask(taskId, (d, task) => {
      if (task.state === "done" || task.state === "cancelled" || (task.screenAllowed === true) === allowed) return;
      if (allowed) task.screenAllowed = true;
      else delete task.screenAllowed;
      this.log(d, task, "you", allowed ? SCREEN_WORDS.taskOn : SCREEN_WORDS.taskOff);
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

  /** Start this task only after the given tasks have landed. An empty list removes the wait. */
  setAfter(taskId: Id, after: readonly Id[]): void {
    assertTaskDependenciesEditable(this.state.tasks.find((task) => task.id === taskId));
    const ids = validateTaskDependencies(taskId, after, (id) => this.state.tasks.find((task) => task.id === id));
    this.updateTask(taskId, (d, task) => {
      task.after = ids;
      const find = (id: Id) => d.tasks.find((entry) => entry.id === id);
      if (task.state === "queued") syncWait(task, blockingDependencies(task, find), find, d.now);
      this.log(d, task, "you", ids.length ? AFTER_WORDS.starts(ids.map((id) => find(id)!.title)) : AFTER_WORDS.none);
      this.schedule(d);
    });
  }

  pause(taskId: Id): void {
    this.updateTask(taskId, (d, task) => {
      if (!["running", "needs-you", "waiting"].includes(task.state)) return;
      this.endTurn(d, task, "stopped");
      pauseTaskState(task, task, d.now);
      withdrawAsks(task, d.inbox.filter((item) => item.taskId === taskId && item.blocking).map((item) => item.id), d.now);
      this.releaseScreen(d, task);
      d.inbox = d.inbox.filter((item) => item.taskId !== taskId || !item.blocking);
      this.log(d, task, "you", "You paused it");
      this.schedule(d);
    });
  }

  resume(taskId: Id): void {
    this.updateTask(taskId, (d, task) => {
      if (!resumeTaskState(task, d.inbox.some((item) => item.taskId === taskId && !item.blocking))) return;
      this.log(d, task, "you", "You resumed it");
      this.schedule(d);
    });
  }

  cancel(taskId: Id): void {
    this.updateTask(taskId, (d, task) => {
      this.endTurn(d, task, "stopped");
      this.endStage(d, task, "cancelled");
      this.moment(d, task, { kind: "task-end", outcome: "cancelled" });
      cancelTaskState(task, task, d.now);
      this.releaseScreen(d, task);

      d.inbox = d.inbox.filter((item) => item.taskId !== task.id);
      this.log(d, task, "you", "You cancelled it");
      // Only started tasks have a working copy to remove.
      if (task.startedAt !== undefined) this.removeCopy(d, task);
      this.schedule(d);
    });
  }

  /**
   * Live guidance stays in the current turn; explicit waiting and stopping use a new prompt.
   */
  sendMessage(taskId: Id, text: string, mode: MessageMode = "now"): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.updateTask(taskId, (d, task) => {
      if (mode === "interrupt" && task.agent && task.state === "running") {
        this.say(d, task, "system", "You interrupted the current step");
        this.deliver(d, task, trimmed, true);
        return;
      }
      const message = { id: this.id(d, task.id), text: trimmed, at: d.now, mode };
      const tool = d.profiles.find(profile => profile.id === task.agent?.profileId)?.toolId;
      if (mode === "now" && task.agent && task.state === "running" && tool !== "antigravity") {
        this.say(d, task, "you", trimmed);
        task.session.at(-1)!.coordinatorMessageId = message.id;
        this.log(d, task, "you", "You sent a message");
        const step = task.journey?.at(-1);
        const agent = task.agent;
        if (step?.kind === "agent" && agent) {
          if (!step.agentInputs?.length) step.agentInputs = [{ at: d.now, roleId: agent.roleId, profileId: agent.profileId, taskTitle: task.title, sections: [], mode: "fresh" }];
          const input = step.agentInputs.at(-1)!;
          input.updates = [...(input.updates ?? []), { at: d.now, reason: "message", text: trimmed, messageId: message.id, delivery: "accepted" }];
        }
        // Accepted, not heard, until this turn finishes. The next beat must not drop it.
        task.queued.push({ ...message, recipients: { main: false }, deliveries: { main: { state: "accepted", via: "live", ...(tool ? { toolId: tool } : {}) } } });
        return;
      }
      task.queued.push({ ...message, ...(mode === "now" && tool === "antigravity" ? { deliveries: { main: { state: "waiting" as const, reason: "unsupported" as const, toolId: tool } } } : {}) });
    });
  }

  removeQueued(taskId: Id, messageId: Id): void {
    this.updateTask(taskId, (_d, task) => {
      if (task.queued.some((message) => message.id === messageId && !messageRemovable(message))) return;
      task.queued = task.queued.filter((message) => message.id !== messageId);
    });
  }

  /**
   * Swap the profile on a stage that has not started yet. `list` picks the author/doers
   * (`profileIds`) or the reviewers of a converge stage (`reviewerProfileIds`).
   */
  setStageProfile(taskId: Id, stageId: Id, list: "profileIds" | "reviewerProfileIds", index: number, profileId: Id): void {
    this.updateTask(taskId, (d, task) => {
      const title = assignFutureProfile(task, d.profiles, stageId, list, index, profileId);
      if (title !== undefined) this.log(d, task, "you", `You changed who works on “${title}”`);
    });
  }

  /** Add one more reviewer to a review chain that has not started yet. */
  addReviewer(taskId: Id, stageId: Id, profileId: Id): void {
    this.updateTask(taskId, (d, task) => {
      const title = appendFutureReviewer(task, d.profiles, stageId, profileId);
      if (title !== undefined) this.log(d, task, "you", `You added a reviewer to “${title}”`);
    });
  }

  // ── The role library ───────────────────────────────────────────────────────

  /** Change a role for this session of the demo. Like the engine, it refuses what the squad does not allow, in plain words. */
  saveRole(roleId: Id, draft: RoleDraft): void {
    this.changeRoles((changes) => library.editRole(changes, roleId, draft));
  }

  /** Add a role: the demo planner uses it from the next task it plans. */
  addRole(draft: RoleDraft): Id {
    let created = "";
    this.changeRoles((changes) => {
      const added = library.addRole(changes, draft);
      created = added.roleId;
      return added.changes;
    });
    return created;
  }

  saveRoutine(draft: RoutineDraft, routineId?: Id): Id {
    let id = routineId ?? "";
    this.update(d => {
      const previous = d.routines?.find(r => r.id === routineId);
      if (routineId && !previous) throw new Error("That routine was removed.");
      id ||= this.id(d, "routine");
      const next = saveRoutine(draft, d, id, d.now, previous);
      d.routines = [...(d.routines ?? []).filter(r => r.id !== id), next] as Draft["routines"];
    });
    return id;
  }
  setRoutineEnabled(routineId: Id, enabled: boolean): void {
    const routine = this.state.routines?.find(r => r.id === routineId);
    if (!routine) throw new Error("That routine was removed.");
    if (enabled) this.saveRoutine({ ...routine, enabled }, routineId);
    else this.update(d => { d.routines!.find(r => r.id === routineId)!.enabled = false; });
  }
  removeRoutine(routineId: Id): void { this.update(d => { d.routines = d.routines?.filter(r => r.id !== routineId); }); }
  resolveMaintenanceSettings(taskId: Id, choice: "keep" | "stop"): void {
    if (choice === "stop") { this.cancel(taskId); return; }
    this.updateTask(taskId, (d, task) => {
      if (task.maintenance?.settingsDecision) task.maintenance.settingsDecision.choice = choice;
      d.inbox = d.inbox.filter(i => !(i.taskId === taskId && i.kind === "maintenance-settings"));
      task.state = "waiting"; this.schedule(d);
    });
  }

  resetRole(roleId: Id): void {
    this.changeRoles((changes) => library.resetRole(changes, roleId));
  }

  removeRole(roleId: Id): void {
    this.changeRoles((changes) => library.removeRole(changes, roleId, this.state.tasks.some((task) => library.planUses(task, roleId))));
  }

  private changeRoles(change: (changes: RoleChanges) => RoleChanges): void {
    // Checked before anything changes: a refused change leaves the roles as they were.
    const next = change(this.state.roleChanges ?? library.NO_ROLE_CHANGES);
    this.update((d) => {
      d.roleChanges = next as Draft["roleChanges"];
      d.roles = library.libraryRoles(next) as Draft["roles"];
    });
  }

  async setTaskStart(taskId: Id, choice: WorkChoice): Promise<void> {
    const task = this.state.tasks.find((entry) => entry.id === taskId);
    if (task?.workRows) return this.setTaskProducts(taskId, task.workRows.map((row) => row.choice.productId === choice.productId ? choice : choice.lead ? { ...row.choice, lead: false } : row.choice));
    this.updateTask(taskId, (d, task) => {
      const product = d.products.find((entry) => entry.id === choice.productId);
      if (!product) throw new Error("Add the product first.");
      task.workChoice = choice;
      task.productId = choice.productId;
      task.delivery = choice.delivery;
      task.source = demoSource(product, choice);
      for (const stage of task.plan?.stages ?? []) if (stage.kind === "do" && d.roles.find(role => role.id === stage.roleId)?.result === "delivery") stage.title = deliveryLabel(task);
      delete task.workError;
    });
  }

  async setTaskProducts(taskId: Id, choices: readonly WorkChoice[]): Promise<void> {
    this.updateTask(taskId, (d, task) => {
      task.selectedProducts = [...choices];
      task.workRows = choices.map((choice) => {
        const earlier = task.workRows?.find((row) => row.choice.productId === choice.productId);
        const product = d.products.find((entry) => entry.id === choice.productId);
        return { ...earlier, choice: { ...choice, reason: choice.reason ?? earlier?.choice.reason }, error: undefined, ...(product ? { source: demoSource(product, choice) } : { error: "Needs adding" }) };
      });
      task.confirmWork = true;
      task.approvePlan = true;
    });
  }

  async setTaskAddition(_taskId: Id, _repository: string, _name: string, _path: string): Promise<void> {
    throw new Error("The demo does not clone repositories. Choose an existing demo product.");
  }

  setTaskApproval(taskId: Id, ask: boolean): void {
    this.updateTask(taskId, (_d, task) => { task.approveDelivery = ask; });
  }

  addTask(input: NewTask): Id {
    const known = input.clientId ? this.state.tasks.find((task) => task.clientId === input.clientId)?.id : undefined;
    if (known) return known;
    let created = "";
    this.update((d) => {
      const id = this.id(d, "task"); created = id;
      const task = createTaskState(input, d.products, { id, timelineId: this.id(d, id), now: d.now, priority: queueOf(d.tasks).length, area: input.area?.trim() || areaFromTitle(input.title) }, (id) => d.tasks.find((task) => task.id === id));
      // Only source resolution is scripted; task defaults and validation are shared with the engine.
      const product = d.products.find((entry) => entry.id === task.productId) ?? d.products[0];
      if (product) {
        if (!task.productId) {
          task.productId = product.id;
          task.workChoice = { ...task.workChoice!, productId: product.id };
          task.approveDelivery = input.approveDelivery ?? product.approveDelivery ?? true;
        }
        Object.assign(task, { source: demoSource(product, task.workChoice!) });
      }
      if (input.worksOn) task.workRows = input.worksOn.map((choice) => ({ choice: { ...choice, startFrom: { ...choice.startFrom } }, source: demoSource(d.products.find((product) => product.id === choice.productId)!, choice) }));
      task.confirmWork = (input.worksOn ? input.worksOn.length !== 1 : !input.productId) || task.workChoice?.startFrom.kind === "pull-request";
      d.tasks.push(task);
      if (task.after?.length) {
        const find = (id: Id) => d.tasks.find((entry) => entry.id === id);
        if (task.state === "queued") syncWait(task, blockingDependencies(task, find), find, d.now);
        this.log(d, task, "you", AFTER_WORDS.starts(task.after.map((id) => find(id)!.title)));
      }
      if (input.position === "top") queueOf(d.tasks).forEach((task, priority) => { d.tasks.find((entry) => entry.id === task.id)!.priority = priority; });
      this.schedule(d);
    });
    return created;
  }

  queueTask(taskId: Id): void {
    this.updateTask(taskId, (d, task) => {
      if (!queueBacklogTask(task, queueOf(d.tasks).length)) return;
      this.log(d, task, "you", "You reviewed the request and queued it for work");
      this.schedule(d);
    });
  }

  async combineBacklog(taskIds: Id[], title: string, clientId: Id): Promise<Id> {
    const known = this.state.tasks.find((task) => task.clientId === clientId);
    if (known) {
      if (JSON.stringify(known.combinedFrom?.map((entry) => entry.id)) !== JSON.stringify(taskIds)) throw new Error("This request reference was already used for a different selection.");
      return known.id;
    }
    const input = combinedBacklogInput(this.state.tasks, taskIds, title);
    const id = this.addTask(input);
    this.update((d) => {
      const combined = d.tasks.find((task) => task.id === id)!;
      combined.clientId = clientId;
      combineBacklogTasks(combined, taskIds.map((id) => d.tasks.find((task) => task.id === id)!), d.now, queueOf(d.tasks).length);
      this.log(d, combined, "you", `You combined ${taskIds.length} backlog requests and queued them as one task`);
      this.schedule(d);
    });
    return id;
  }

  moveToBacklog(taskId: Id): void {
    this.updateTask(taskId, (d, task) => {
      if (!returnQueuedTaskToBacklog(task)) return;
      syncWait(task, [], () => undefined, d.now);
      this.log(d, task, "you", "You moved it to the backlog for review");
    });
  }

  updateBacklog(taskId: Id, changes: { title: string; description: string }): void {
    if (!this.state.tasks.some((task) => task.id === taskId)) throw new Error("Only backlog requests can be edited before work starts.");
    this.updateTask(taskId, (d, task) => {
      editBacklogRequest(task, changes);
      task.area = areaFromTitle(task.title);
      this.log(d, task, "you", "You updated the backlog request");
    });
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

  /** `answer`: how the coordinator answered an agent or a checkpoint, for the work log. An offer (the review guide, AGENTS.md) has none. */
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
    const step = stepTag(task);
    task.timeline.push({ id: this.id(d, task.id), at: d.now, text, tone, ...(roleId ? { roleId } : {}), ...(profileId ? { profileId } : {}), ...(step ? { step } : {}) });
  }

  private say(d: Draft, task: DraftTask, from: Task["session"][number]["from"], text: string, roleId?: Id, profileId?: Id): void {
    const step = stepTag(task);
    task.session.push({ id: this.id(d, task.id), at: d.now, from, text, ...(roleId ? { roleId } : {}), ...(profileId ? { profileId } : {}), ...(step ? { step } : {}) });
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

  /** The profile the planner runs on, kept in the state so a queued task's journey can name it. */
  private planner(d: Draft): Id {
    const id = d.planner ?? PLANNER_PROFILE;
    return d.profiles.find(profile => profile.id === id && !profile.standby)?.id ?? d.profiles.find(profile => !profile.standby)?.id ?? id;
  }

  /** Who should be working right now, given the stage and the sub-step. */
  private nextAgent(task: DraftTask): { roleId: Id; profileId: Id } | undefined {
    if (task.stageIndex < 0) return { roleId: "planner", profileId: task.plan?.plannerProfileId ?? this.state.planner ?? PLANNER_PROFILE };
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
        return profileId ? { roleId: library.reviewerAt(stage, task.sub), profileId } : undefined;
      }
      case "gate":
        return undefined;
    }
  }

  private startAgent(d: Draft, task: DraftTask): void {
    const next = this.nextAgent(task);
    if (!next) return;
    const profile = d.profiles.find((profile) => profile.id === next.profileId);
    const toolId = profile?.toolId ?? "unknown";
    const waiting = slotWait(d as State, { ...profile, taskId: task.id, toolId });
    if (waiting) {
      task.state = "waiting";
      task.holdsSlot = false;
      delete task.agent;
      delete task.helpers;
      task.column = this.columnFor(d, task);
      task.statusLine = waiting;
      return;
    }
    const current = this.stage(task);
    // A review round starts with Petrina's own run of the product's checks, as the engine's does.
    const round = this.round(task);
    if (current?.kind === "review-chain" && (task.hunt?.stageId !== current.id || task.hunt.round !== round)) {
      this.runChecks(d, task);
      task.hunt = { stageId: current.id, round, reported: {}, findings: task.findings.length };
    }
    if (current?.kind === "do" && d.roles.find((role) => role.id === current.roleId)?.result === "checks"
      && (task.repositories ?? [task]).some((work) => !work.checks?.current)) this.runChecks(d, task);
    // Back from waiting for the screen: the same agent picks up where it left off, on the screen.
    const screen = task.screen?.granted && !task.screen.heard && task.screen.roleId === next.roleId ? task.screen : undefined;
    // A review round's reviewers share its step on the journey; each joins it as it starts.
    beginAgentStep(task, current?.kind === "review-chain" ? current.roleId : next.roleId, next.profileId, d.now, d.roles, current?.kind === "review-chain" ? current.profileIds : undefined);
    // Claude Code and Codex have known sandbox states; other tools keep their own setup.
    const agent: ActiveAgent = { ...next, since: d.now, step: screen?.step ?? 0, ...(["claude-code", "codex"].includes(toolId) ? { sandbox: { on: true as const } } : {}) };
    task.agent = agent;
    // Reviewers look at the change together, as the engine's do: the ones still to report work beside this
    // one, each in a slot of its own while the pool and its tool allow.
    delete task.helpers;
    for (const [index, profileId] of (current?.kind === "review-chain" ? current.profileIds.slice(task.sub + 1) : []).entries()) {
      const helper = d.profiles.find((profile) => profile.id === profileId);
      const tool = helper?.toolId ?? "unknown";
      if (!extraSlot(d as State, tool, helper)) break;
      task.helpers = [...(task.helpers ?? []), { roleId: library.reviewerAt(current!, task.sub + 1 + index), profileId, since: d.now, step: 0 }];
    }
    // Each start is a fresh one: a step started again after a pause leaves no record.
    delete task.todo;
    task.stepAttempts = (task.stepAttempts ?? 0) + 1;
    task.stepClock = startClock(task as unknown as Task, next.roleId, d.now);
    task.state = "running";
    task.holdsSlot = true;
    task.column = this.columnFor(d, task);
    const role = d.roles.find((entry) => entry.id === next.roleId)?.name ?? next.roleId;
    if (screen) {
      screen.heard = true;
      task.statusLine = SCREEN_WORDS.using(screen.reason);
      this.say(d, task, "system", `${role} picked up where it left off`, next.roleId, next.profileId);
      this.log(d, task, "milestone", SCREEN_WORDS.pickedUp, next.roleId, next.profileId);
      this.openTurn(d, task, "continue");
      return;
    }
    task.statusLine = `${role} is starting`;
    this.say(d, task, "system", `${role} joined`, next.roleId, next.profileId);
    this.log(d, task, "milestone", `${role} started`, next.roleId, next.profileId);
    this.beginStage(d, task);
    this.openTurn(d, task, "first");
  }

  private step(d: Draft, task: DraftTask): void {
    const agent = task.agent;
    if (!agent) return;

    const next = task.queued[0];
    // Live guidance the tool already accepted stays until the turn finishes. A later note waits behind it.
    if (next && next.deliveries?.main?.state !== "accepted") {
      task.queued.shift();
      this.deliver(d, task, next.text);
      return;
    }

    const product = d.products.find((entry) => entry.id === task.productId)?.name ?? "the product";
    const round = this.round(task);
    const following = !!this.following(task);
    const moments = scriptFor(d.roles.find((role) => role.id === agent.roleId), { area: task.area, product, round, fixing: task.fixing, following, objecting: this.disagree.has(task.id) });
    const moment = moments[agent.step];
    if (moment === undefined) {
      this.finish(d, task);
      return;
    }

    // As with real agents: the to-do item goes on the timeline, actions are the status line and the session's activity.
    agent.step += 1;
    if ("action" in moment) {
      task.statusLine = moment.action;
      this.say(d, task, "activity", moment.action, agent.roleId, agent.profileId);
      return;
    }
    const todo = plainTodo(moment.todo);
    if (todo) task.todo = todo;
    this.log(d, task, "status", todo ?? moment.todo, agent.roleId, agent.profileId);
    const item = moments.slice(0, agent.step).filter((entry) => "todo" in entry).length - 1;
    const trigger = this.triggers[`${task.id}|${agent.roleId}|${round}|${item}`] ?? this.triggers[`${task.id}|${agent.roleId}|${round}|${agent.step - 1}`];
    if (trigger?.kind === "screen") this.askScreen(d, task, trigger.title);
    else if (trigger) this.ask(d, task, trigger);
  }

  /** The agent did what it could in the background and needs the screen. */
  private askScreen(d: Draft, task: DraftTask, text: string): void {
    const agent = task.agent;
    if (!agent) return;
    const reason = screenReason(text);
    this.endTurn(d, task, "finished");
    task.screen = { reason, at: d.now, roleId: agent.roleId, profileId: agent.profileId, step: agent.step };
    this.log(d, task, "status", SCREEN_WORDS.asked(reason), agent.roleId, agent.profileId);
    const free = !onScreen(d.tasks as Task[]) && !screenQueue(d.tasks as Task[]).some((other) => screenAllowed(other, d.pool, d.now));
    if (screenAllowed(task as Task, d.pool, d.now) && free) {
      task.screen.granted = true;
      task.screen.heard = true;
      task.statusLine = SCREEN_WORDS.using(reason);
      this.log(d, task, "milestone", SCREEN_WORDS.using(reason), agent.roleId, agent.profileId);
      this.openTurn(d, task, "continue");
      return;
    }
    task.state = "waiting";
    task.holdsSlot = false;
    delete task.agent;
    delete task.helpers;
    this.syncScreen(d);
  }

  /** Screen requests and their quiet inbox items follow the active request. */
  private syncScreen(d: Draft): void {
    if (d.pool.screen && d.pool.screen.mode !== screenMode(d.pool, d.now)) d.pool.screen = { mode: "off" };
    for (const task of d.tasks) {
      const wait = screenWait(task as Task, d as State, d.now);
      const item = d.inbox.find((entry) => entry.taskId === task.id && entry.kind === "screen");
      if (wait === "ask" && !item) {
        const request = task.screen!;
        d.inbox.push({ id: this.id(d, "inbox"), taskId: task.id, kind: "screen", title: SCREEN_WORDS.needs(request.reason), body: SCREEN_WORDS.body, at: request.at, blocking: false, roleId: request.roleId, profileId: request.profileId });
      } else if (wait !== "ask" && item) d.inbox = d.inbox.filter((entry) => entry !== item);
      if (wait === "ask") task.statusLine = SCREEN_WORDS.needs(task.screen!.reason);
      else if (wait === "turn") task.statusLine = SCREEN_WORDS.turn;
      else if (task.state === "waiting" && task.screen && !task.screen.granted) task.statusLine = "Waiting for a free slot";
    }
  }

  /** The step ended, was paused or cancelled: free the screen. */
  private releaseScreen(d: Draft, task: DraftTask): void {
    delete task.screen;
    d.inbox = d.inbox.filter((item) => !(item.taskId === task.id && item.kind === "screen"));
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

  /** Petrina's own run of the product's checks, before a review round's reviewers. In the demo they pass. */
  private runChecks(d: Draft, task: DraftTask): void {
    beginPetrinaStep(task, "checks", d.now);
    const step = openStep(task)!;
    for (const work of (task.repositories ?? [task]).filter((work) => !repositoryPublished(work))) {
      const results = DEMO_CHECKS.map((run, index) => ({ ...run, startedAt: d.now, endedAt: d.now, source: { stepId: step.id, attemptId: "run-0", checkId: `${task.repositories ? `${work.productId}:` : ""}check-${index}` } }));
      step.productChecks = [...(step.productChecks ?? []), ...results.map((run) => ({ id: run.source.checkId, attemptId: "run-0", productId: work.productId, name: run.name, result: "pass" as const, startedAt: run.startedAt, endedAt: run.endedAt, run }))];
      work.checks = { at: d.now, tree: simVersions(task)[work.productId], current: true, results };
    }
    this.log(d, task, "done", `Checks passed: ${DEMO_CHECKS.map((run) => run.name).join(", ")}`);
    endPetrinaStep(task, { outcome: W.checks(0, DEMO_CHECKS.length), reason: W.checksPassed }, d.now);
  }

  private ask(d: Draft, task: DraftTask, trigger: Trigger): void {
    if (trigger.kind === "screen") return;
    const agent = task.agent;
    // A question ends the agent's turn; a permission is answered inside it, and the wait is not work.
    if (trigger.kind === "question") this.endTurn(d, task, "finished");
    else {
      const open = this.openTurns.get(task.id);
      if (open) open.waitingSince = d.now;
    }
    const id = this.raise(d, task, trigger.kind, trigger.title, true, trigger);
    addAsk(task, { id, kind: trigger.kind, title: trigger.title, at: d.now });
    task.statusLine = trigger.kind === "question" ? "Waiting for your answer" : "Waiting for your permission";
    if (task.stepClock) task.stepClock = pauseClock(task.stepClock, d.now);
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
  ): Id {
    task.state = "needs-you";
    const agent = task.agent;
    const id = this.id(d, "inbox");
    d.inbox.push({
      id,
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
    return id;
  }

  private unblock(d: Draft, task: DraftTask): void {
    if (task.state !== "needs-you") return;
    task.state = task.holdsSlot ? "running" : "waiting";
    task.statusLine = task.holdsSlot ? "Back to work" : "Waiting for a free slot";
    if (task.holdsSlot && task.stepClock) task.stepClock = resumeClock(task.stepClock, d.now);
  }

  /** The agent finished its step list: hand the result to the stage. */
  private finish(d: Draft, task: DraftTask): void {
    const agent = task.agent;
    if (!agent) return;
    this.endTurn(d, task, "finished");
    this.releaseScreen(d, task);
    this.finishStep(d, task);

    if (task.stageIndex < 0) {
      // With no coordinator selection, the demo planner proposes its saved demo product.
      if (task.workRows?.length === 0 && task.workChoice && task.source) task.workRows = [{ choice: { ...task.workChoice, reason: "The demo planner proposes this product for the change." }, source: task.source, change: "added" }];
      task.plan = composePlan(task, library.activeRoles(d.roles)) as DeepMutable<NonNullable<Task["plan"]>>;
      task.risk = DEMO_RISK[task.kind];
      const count = task.plan.stages.filter((stage) => stage.kind !== "gate").length;
      this.log(d, task, "milestone", `Plan ready: ${count} stages. ${task.plan.rationale}`, agent.roleId, agent.profileId);
      this.say(d, task, "agent", task.plan.rationale, agent.roleId, agent.profileId);
      this.endStage(d, task, "done");
      endAgentStep(task, { outcome: W.planned(count), reason: W.planReady }, d.now);
      if (task.approvePlan || task.confirmWork) this.gate(d, task, "plan");
      else this.advance(d, task);
      return;
    }

    const stage = this.stage(task);
    if (!stage) return;
    const round = this.round(task);
    const result = d.roles.find(role => role.id === agent.roleId)?.result;

    if (stage.kind === "do" && result === "delivery") {
      this.endStage(d, task, "delivered");
      this.ship(d, task);
      return;
    }

    if (stage.kind === "do" && task.maintenance?.role.id === agent.roleId) {
      const summary = "Investigated the selected area. Nothing actionable found in this demo run.";
      task.handedBack = [...(task.handedBack ?? []), { at: d.now, roleId: agent.roleId, profileId: agent.profileId, stageId: stage.id, roleName: task.maintenance.role.name, title: stage.title, summary, notes: ["Completed without product changes."] }];
      task.maintenance.noProductChanges = true;
      this.log(d, task, "done", summary, agent.roleId, agent.profileId);
      endAgentStep(task, { outcome: W.wroteNotes, reason: W.notesReady }, d.now);
      this.endStage(d, task, "done");
      task.state = "done"; task.column = "done"; task.finishedAt = d.now;
      task.statusLine = "Completed · No product changes"; task.holdsSlot = false;
      delete task.agent;
      return;
    }
    if (stage.kind === "do") {
      const recorded = openStep(task);
      if (result === "build" && recorded) {
        recorded.buildVersions = simVersions(task, recorded.id);
        for (const work of task.repositories ?? [task]) if (work.checks) work.checks.current = false;
      }
      if (result === "checks" && recorded) {
        const checks = simAcceptance(task);
        const versions = simVersions(task);
        recorded.acceptanceChecks = checks.map(({ text, result, evidence }) => ({ text, result, evidence }));
        recorded.agentResults = [{ roleId: agent.roleId, profileId: agent.profileId, at: d.now, value: { checks }, versions }];
        if (task.brief) task.brief.acceptance = task.brief.acceptance.map((item) => {
          const check = checks.find((check) => check.text === item.text)!;
          return { ...item, met: true, verification: "passed", productIds: [...check.productIds],
            versions: Object.fromEntries(check.productIds.map((id) => [id, versions[id]!])),
          };
        });
        task.acceptancePassed = true;
      }
      if (result === "build" && task.fixing) {
        let count = 0;
        for (const finding of task.findings) {
          if (finding.status !== "open" || finding.severity === "pre-existing") continue;
          const fixed = finding.severity === "blocking";
          finding.answer = { fixed, text: fixed ? "Fixed, with a test for addresses with a plus sign." : "Kept as is: the current message matches the rest of the product.", at: d.now };
          if (fixed && !(finding.raisedBy === "petrina" && finding.text.startsWith("Check failed"))) finding.status = "fixed";
          if (fixed) count += 1;
        }
        task.fixing = false;
        this.log(d, task, "done", "Fixed the blocking findings", agent.roleId, agent.profileId);
        const outcome = builderReturnWords(true, undefined, count);
        const returned = openStep(task);
        if (returned) returned.builderReturn = { productId: task.productId, changed: true, claimedFixes: count, outcome };
        endAgentStep(task, { outcome, reason: outcome }, d.now);
      } else {
        this.log(d, task, "done", `${stage.title} done`, agent.roleId, agent.profileId);
        endAgentStep(
          task,
          result === "build" ? { outcome: W.built, reason: W.readyForReview } : result === "checks" ? { outcome: W.checks(0, task.brief?.acceptance.length ?? 0), reason: W.checksPassed } : { outcome: W.wroteNotes, reason: W.notesReady },
          d.now,
        );
      }
      if (task.repositories && d.roles.find((role) => role.id === agent.roleId)?.canEdit) for (const work of task.repositories) {
        work.report = { summary: `Updated ${d.products.find((product) => product.id === work.productId)?.name ?? "the product"} for ${task.area}.`, changes: [`People can use ${task.area} across products.`] };
        work.completedStages = [...new Set([...work.completedStages, stage.id])];
      }
      this.endStage(d, task, "done");
      this.advance(d, task);
      return;
    }

    if (stage.kind === "converge") {
      const call = this.following(task);
      if (call) {
        // The call's words decide the objections they speak to; the architect answers the rest itself. None is left open.
        // After changes asked for at the check, it answers them all again: the note can correct a decision, and the notes match the updated brief.
        const revising = !task.objections.some((objection) => objection.status === "open");
        const note = revising ? task.notes?.at(-1)?.text : undefined;
        const answers = callAnswers(task.area, dueAnswers(task.objections as Task["objections"], call), call.text, note);
        task.objections = answerByCall(task.objections as Task["objections"], call, answers) as DraftTask["objections"];
        recordStepResult(task, { objections: task.objections.filter((objection) => answers.some((answer) => answer.id === objection.id) || call.open.includes(objection.id)) });
        task.brief = briefFor(task);
        this.log(d, task, "done", revising ? CALL_WORDS.revised : CALL_WORDS.updated, agent.roleId, agent.profileId);
        this.log(d, task, "done", CALL_WORDS.settled);
        this.endStage(d, task, "settled");
        endAgentStep(task, { outcome: W.followed, reason: W.followsCall }, d.now);
        this.advance(d, task);
        return;
      }
      if (task.sub === 0) {
        const due = task.objections.filter((objection) => objection.status === "open").map((objection) => objection.id);
        for (const objection of task.objections) {
          if (objection.status !== "open") continue;
          objection.status = objection.blocking ? "accepted" : "rejected";
          objection.answer = objection.blocking ? "Changed the design to cover it." : "Out of scope for this task. Added to risks.";
        }
        this.log(d, task, "done", round === 1 ? "Design brief ready" : "Answered every objection", agent.roleId, agent.profileId);
        recordStepResult(task, { objections: task.objections.filter((objection) => due.includes(objection.id)) });
        endAgentStep(task, round === 1 ? { outcome: W.wroteBrief, reason: W.briefReady } : { outcome: W.answeredAll, reason: W.objectionsAnswered }, d.now);
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
        const before = task.objections.length;
        for (const objection of raised) task.objections.push({ id: this.id(d, task.id), round, raisedBy: agent.profileId, status: "open", ...objection });
        recordStepResult(task, { objections: task.objections.slice(before) });
        const blocking = raised.filter((objection) => objection.blocking).length;
        this.log(d, task, "warn", `Raised ${raised.length} objections, ${blocking} blocking`, agent.roleId, agent.profileId);
        this.designRound(d, task, stage, round, raised.length, blocking);
        logged = true;
        endAgentStep(task, blocking ? { outcome: W.objections(raised.length, blocking), reason: W.blocking(blocking), tone: "back" } : { outcome: W.objections(raised.length, 0), reason: W.noBlocking }, d.now);
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
      if (!logged) recordStepResult(task, { objections: [] });
      endAgentStep(task, { outcome: W.objections(0, 0), reason: W.noBlocking }, d.now);
      if (!logged) this.designRound(d, task, stage, round, 0, 0);
      this.moment(d, task, { kind: "design-end", outcome: "settled", rounds: round, roleId: stage.roleId, ...(stage.profileIds[0] ? { profileId: stage.profileIds[0] } : {}) });
      this.endStage(d, task, "settled");
      this.advance(d, task);
      return;
    }

    if (stage.kind === "review-chain") {
      const added = d.roles.find((role) => role.id === agent.roleId)?.added;
      if (added) {
        if (round === 1) task.findings.push({ id: this.id(d, task.id), text: `Check ${task.area} with real data before the next release.`, severity: "suggestion", roleId: agent.roleId, raisedBy: agent.profileId, confirmedBy: [], status: "open" });
        this.log(d, task, "done", "Nothing blocking", agent.roleId, agent.profileId);
      } else if (round === 1 && task.sub === 0) {
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
      const end = reviewRoundEnd(task as unknown as Task, stage as Stage, round, d.roles);
      noteRoundEnd(task, stage.id, open.length);
      // The round's step says what its reviewers raised, and where the work goes.
      const raised = task.findings.slice(task.hunt?.findings ?? 0);
      recordStepResult(task, { findings: raised });
      delete task.hunt;
      endAgentStep(
        task,
        { outcome: findingCount(raised), ...(end.kind === "send back" ? { reason: W.sentBack(end.open), tone: "back" } : end.kind === "used up" ? { reason: W.stillOpen(end.open), tone: "back" } : { reason: W.reviewPassed }) },
        d.now,
      );
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
      // With blocking findings left, the coordinator always looks before anything ships, as in the engine.
      if (end.kind === "used up") {
        delete task.helpers;
        task.stageIndex += 1;
        task.sub = 0;
        task.reviewDecision = { stageId: stage.id, round, accepted: false };
        this.gate(d, task, "delivery");
        return;
      }
      this.advance(d, task);
    }
  }

  /** The step handed back its result: a short record of it, unless it was started again, and a clean start for the next one. */
  private finishStep(d: Draft, task: DraftTask): void {
    finishTaskStep(task, task, d.now);
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
    if (this.petrinaDelivers(d, task)) {
      this.ship(d, task);
      return;
    }
    this.startAgent(d, task);
  }

  /** Pull requests and commits to main need no agent: Petrina publishes them itself, as the engine does. A release's notes come from the Release Manager first. */
  private petrinaDelivers(d: Draft, task: DraftTask): boolean {
    const stage = this.stage(task);
    return task.delivery !== "release" && stage?.kind === "do" && d.roles.find(role => role.id === stage.roleId)?.result === "delivery";
  }

  private gate(d: Draft, task: DraftTask, gate: GateKind): void {
    delete task.agent;
    delete task.helpers;
    const decision = beginYouStep(task, gate, d.now);
    if (gate === "delivery" && task.reviewDecision?.accepted === false) decision.work = "review-decision";
    if (gate === "delivery") decision.productChecks = decisionEvidence(task);
    task.holdsSlot = false;
    task.statusLine = gateStatus(task as unknown as Task, gate);
    let body = gate === "design" ? callCheckBody(task as unknown as Task) : task.source && (gate === "plan" || gate === "delivery") ? workSummary(task.source) : undefined;
    if (gate === "delivery" && task.repositories) body = [...task.repositories.map((work) => work.source ? workSummary(work.source) : work.productId), companionPreview(task.repositories)].filter(Boolean).join("\n\n");
    this.raise(d, task, gate, gateTitle(task as unknown as Task, gate), false, body ? { body } : {});
    task.column = this.columnFor(d, task);
  }

  private gateDisagreement(d: Draft, task: DraftTask): void {
    delete task.agent;
    beginYouStep(task, "call", d.now);
    task.holdsSlot = false;
    task.statusLine = "The architects disagree. Your call";
    this.raise(d, task, "disagreement", `The architects disagree on “${task.title}”`, false, { body: CALL_WORDS.disagreement });
  }

  private continueAfterGate(d: Draft, task: DraftTask, advance = true): void {
    if (advance) task.stageIndex += 1;
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
    if (this.petrinaDelivers(d, task)) {
      this.ship(d, task);
      return;
    }
    task.state = "waiting";
    task.statusLine = "Waiting for a free slot";
    task.column = this.columnFor(d, task);
  }

  private openPullRequest(d: Draft, task: DraftTask): void {
    beginPetrinaStep(task, "delivery", d.now);
    const product = d.products.find((entry) => entry.id === task.productId);
    const number = 100 + (d.seq % 900);
    task.pr = { number, url: `https://github.com/${product?.repo ?? "owner/repo"}/pull/${number}`, state: "open", openedAt: d.now };
    task.state = "pr-open";
    task.holdsSlot = false;
    delete task.agent;
    this.pullRequestAges.set(task.id, 0);
    task.statusLine = `Pull request #${number} is open. Merge it on GitHub when you are happy`;
    task.column = "ready";
    this.log(d, task, "status", "Petrina pushed the branch");
    this.log(d, task, "done", `Petrina opened pull request #${number}, and checked it on GitHub`);
    this.moment(d, task, { kind: "task-end", outcome: "delivered" });
    endPetrinaStep(task, { outcome: W.openedPr(number) }, d.now);
  }

  /** Petrina publishes it, the way the task asks: with the builder's text, or the Release Manager's notes. */
  private ship(d: Draft, task: DraftTask): void {
    if (task.repositories) {
      for (const [index, work] of task.repositories.entries()) {
        const product = d.products.find((entry) => entry.id === work.productId)!;
        if (work.delivery === "pull-request" || work.source?.start.kind === "pull-request") {
          const number = work.source?.start.kind === "pull-request" ? work.source.start.number : 100 + d.seq + index;
          work.pr = { number, url: `https://github.com/${product.repo}/pull/${number}`, state: "open", openedAt: d.now };
        } else if (work.delivery === "release") work.release = { tag: "v1.2.0", url: `https://github.com/${product.repo}/releases/tag/v1.2.0` };
        else work.landed = { branch: work.source?.destination.branch ?? "main", sha: "1234567" };
        work.companion = { text: "Companion links confirmed", state: "done" };
      }
      task.pr = task.repositories.find((work) => work.pr)?.pr;
      task.state = task.pr ? "pr-open" : "done";
      task.column = task.pr ? "ready" : "done";
      task.statusLine = task.pr ? "Waiting for every pull request to merge" : "All products have landed";
      task.holdsSlot = false;
      delete task.agent;
      if (task.pr) this.pullRequestAges.set(task.id, 0);
      if (!task.pr) task.finishedAt = d.now;
      this.moment(d, task, { kind: "task-end", outcome: "delivered" });
      return;
    }
    if (task.agent) {
      this.log(d, task, "done", "Ready to publish", "release-manager", task.agent.profileId);
      endAgentStep(task, { outcome: W.notes, reason: W.releaseNotesReady }, d.now);
    }
    if (task.source?.start.kind === "pull-request") {
      const start = task.source.start;
      beginPetrinaStep(task, "delivery", d.now);
      task.pr = { number: start.number, url: start.url, state: "open", openedAt: d.now };
      delete task.agent;
      task.holdsSlot = false;
      task.state = "pr-open";
      task.column = "ready";
      this.pullRequestAges.set(task.id, 0);
      task.statusLine = `Updated PR #${start.number}. Merge it on GitHub when you are happy`;
      this.log(d, task, "done", `Updated PR #${start.number} in ${start.headRepo} · ${start.branch}`);
      this.moment(d, task, { kind: "task-end", outcome: "delivered" });
      endPetrinaStep(task, { outcome: `Updated pull request #${start.number}` }, d.now);
      return;
    }
    if (task.delivery === "pull-request") {
      this.openPullRequest(d, task);
      return;
    }
    const product = d.products.find((entry) => entry.id === task.productId);
    beginPetrinaStep(task, "delivery", d.now);
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
      endPetrinaStep(task, { outcome: W.released(tag) }, d.now);
    } else {
      const sha = (d.seq * 2654435761).toString(16).slice(0, 7);
      task.landed = { branch: task.source?.destination.branch ?? product?.defaultBranch ?? "main", sha };
      task.statusLine = `Committed to ${task.landed.branch} (${sha})`;
      this.log(d, task, "done", `Petrina moved ${task.landed.branch} forward to it (${sha}), and checked the main copy`);
      endPetrinaStep(task, { outcome: W.movedMain(task.landed.branch) }, d.now);
    }
    this.removeCopy(d, task);
  }

  private agePullRequest(d: Draft, task: DraftTask): void {
    const age = (this.pullRequestAges.get(task.id) ?? 0) + 1;
    this.pullRequestAges.set(task.id, age);
    if (!task.pr || age < this.prMergeAfter) return;
    this.pullRequestAges.delete(task.id);
    task.pr.state = "merged";
    if (task.repositories) for (const work of task.repositories) if (work.pr) work.pr.state = "merged";
    if (task.state !== "cancelled") {
      task.state = "done";
      task.column = "done";
      task.finishedAt = d.now;
      task.statusLine = `Merged #${task.pr.number} on GitHub`;
    }
    this.log(d, task, "done", `Merged on GitHub (#${task.pr.number})`);
    this.moment(d, task, { kind: "task-end", outcome: "merged" });
    this.removeCopy(d, task);
  }

  /** A finished task's working copy goes, to free disk space. One with an open pull request stays. */
  private removeCopy(d: Draft, task: DraftTask): void {
    if (!copyNoLongerNeeded(task as unknown as Task) || task.cleanup?.removedAt !== undefined) return;
    if (this.lockedCopies.has(task.id) && !task.cleanup?.error) {
      task.cleanup = { error: CLEANUP_WORDS.locked };
      this.log(d, task, "warn", CLEANUP_WORDS.failed(CLEANUP_WORDS.locked));
      return;
    }
    task.cleanup = { removedAt: d.now };
    this.log(d, task, "done", CLEANUP_WORDS.removed);
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
    const journeyId = openStep(task)?.id;
    const agentSeat = this.stage(task)?.kind === "review-chain" ? String(task.sub) : agent.roleId;
    // Demo clocks can move; saved identities stay stable when the same work continues.
    const previous = reason !== "first" ? continuingAgentTurn(this.work.turns({ taskId: task.id }), {
      taskId: task.id, journeyId, agentSeat, roleId: agent.roleId, toolId, profileId: agent.profileId,
    }) : undefined;
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
      sessionId: previous?.sessionId ?? `${task.id}-agent-${agent.since}`,
      ...(journeyId ? { journeyId } : {}),
      agentRunId: previous?.agentRunId ?? id,
      agentSeat,
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

  /** The practice turn finished, so guidance the tool had accepted now counts as heard. */
  private hearLive(task: DraftTask): void {
    let heard = false;
    for (const message of task.queued) {
      const receipt = message.deliveries?.main;
      if (receipt?.state !== "accepted") continue;
      receipt.state = "applied";
      (message.recipients ??= {}).main = true;
      for (const step of task.journey ?? []) for (const input of step.agentInputs ?? []) for (const update of input.updates ?? []) {
        if (update.messageId === message.id) update.delivery = "applied";
      }
      heard = true;
    }
    if (heard) task.queued = task.queued.filter(message => !message.recipients || !Object.values(message.recipients).every(Boolean));
  }

  private endTurn(d: Draft, task: DraftTask, end: TurnEnd): void {
    const open = this.openTurns.get(task.id);
    if ((end === "finished" || end === "interrupted") && open) this.hearLive(task);
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
    admitRoutines(d, d.now, (routine, scheduledAt) => {
      const id = this.id(d, "task");
      const task = createTaskState({ productId: routine.productId, title: routine.name, kind: "chore" }, d.products, { id, timelineId: this.id(d, id), now: d.now, priority: queueOf(d.tasks).length });
      prepareMaintenanceTask(task, routine, d as State, scheduledAt, d.now);
      d.tasks.push(task as DraftTask);
      return id;
    });
    this.syncScreen(d);
    const profiles = new Map(d.profiles.map((profile) => [profile.id, profile]));
    const find = (id: Id) => d.tasks.find((entry) => entry.id === id);
    // A task waiting for others to land stays out of the running and says what it waits for.
    const blocked = (task: DraftTask): boolean => {
      const waitingFor = blockingDependencies(task, find);
      syncWait(task, waitingFor, find, d.now);
      if (!waitingFor.length) {
        if (task.state === "queued" && task.statusLine.startsWith("Waiting for “")) task.statusLine = task.held ? "On hold" : "In the queue";
        return false;
      }
      task.statusLine = AFTER_WORDS.waiting(waitingFor.map((other) => other.title));
      return true;
    };
    const inProgress = d.tasks.filter((task) => task.state === "waiting").sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    const continuing: Candidate[] = [];
    for (const task of inProgress) {
      if (blocked(task)) continue;
      // Waiting for the screen: for the coordinator's OK, or its turn. Its status line says which.
      if (!screenReady(task as Task, d as State, d.now)) continue;
      const next = this.nextAgent(task);
      if (next) {
        const profile = profiles.get(next.profileId);
        const candidate = { ...profile, taskId: task.id, toolId: profile?.toolId ?? "unknown" };
        task.statusLine = slotWait(d as State, candidate) ?? "Waiting for a free slot";
        continuing.push(candidate);
      }
    }
    const candidates = balanced(continuing, d.pool, d.now);
    for (const queued of queueOf(d.tasks as Task[])) {
      const task = find(queued.id)!;
      // On hold too, a task stops waiting the moment the tasks it waits for land; it just does not start.
      if (blocked(task) || task.held) continue;
      const profile = profiles.get(task.maintenance?.profile.id ?? this.planner(d));
      candidates.push({ ...profile, taskId: task.id, toolId: profile?.toolId ?? "unknown" });
    }

    const starts = pickStarts({ candidates, inUse: slotUses(d as unknown as State), pool: d.pool, now: d.now });
    for (const taskId of starts) {
      const task = d.tasks.find((entry) => entry.id === taskId);
      if (!task) continue;
      if (task.state === "queued") {
        task.startedAt = d.now;
        task.stageIndex = task.maintenance ? 0 : -1;
        this.log(d, task, "milestone", "Started from the queue");
      }
      // The screen is this agent's from now until its step ends.
      const asked = task.screen && !task.screen.granted ? task.screen : undefined;
      if (asked) asked.granted = true;
      this.startAgent(d, task);
      if (asked && task.state !== "running") delete asked.granted;
    }
  }
}
