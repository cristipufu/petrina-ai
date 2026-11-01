// A deterministic stand-in for real agents. It drives the same state the real engine
// will: tasks move through their plan, agents report status lines, ask questions,
// request permissions, raise objections and findings, and wait at gates.
// The UI uses it today; the tests use it to pin down scheduling and gate rules.

import { usageView, type UsageRequest, type UsageViewFor } from "./analytics.js";
import { combinedBacklogInput } from "./combine-backlog.js";
import type { DeepMutable } from "./flow.js";
import { demoHistoryPage, historyPageUsage, type HistoryQuery } from "./history.js";
import { AFTER_WORDS, settleAsk, syncWait } from "./journey.js";
import { messageRemovable } from "./message-delivery.js";
import { messagePage, previewRecord } from "./public-messages.js";
import type { CheckPrerequisite, DeliveryMode, Id, InboxItem, Product, RoleChanges, ScreenMode, State, Task } from "./model.js";
import { queueNeighbour, queuePlacement } from "./navigation.js";
import { applyProductSettings, productHistory, validateProductSettings, type ProductSettings } from "./products.js";
import { demoProfileChoices, removeProfile, saveProfile, type ProfileChoiceRequest, type ProfileDraft } from "./profiles.js";
import * as library from "./roles.js";
import type { RoleDraft } from "./roles.js";
import { saveRoutine, type RoutineDraft } from "./routines.js";
import { queueOf } from "./scheduler.js";
import { SCREEN_HOUR_MS, SCREEN_WORDS } from "./screen.js";
import { SETUP_STEPS, type SetupStep } from "./setup.js";
import {
  simAddLessons, simAddTask, simApproveItem, simCancelTask, simFinalizeCombineBacklog, simMoveInQueue,
  simPauseTask, simRemoveProduct, simRerunChecks, simRequestChanges, simRetryItem, simSendMessage, simSetProductChecks,
  simSetProductCheckSetup, simSetProductRemoteChecks, simSetTaskProducts, simSetTaskStartSingle,
} from "./sim-actions.js";
import { simAgePullRequest } from "./sim-delivery.js";
import { simSchedule, simStep } from "./sim-engine.js";
import {
  ASKS, simAnswered, simId, simLog, simPlanner, simRemoveCopy, simSay, simUnblock, simWrote,
  type Draft, type DraftTask, type SimRuntime,
} from "./sim-runtime.js";
import { areaFromTitle } from "./sim-script.js";
import type { MessageMode, NewTask, SimOpenWork, SimOptions } from "./sim-types.js";
import type { WorkChoice } from "./source.js";
import {
  appendFutureReviewer, assertTaskDependenciesEditable, assignFutureProfile, blockingDependencies,
  editBacklogRequest, queueBacklogTask, resumeTaskState, returnQueuedTaskToBacklog, validateTaskDependencies,
} from "./task-transitions.js";
import { MemoryWorkLog, type AskAnswer } from "./worklog.js";

export { readCall } from "./sim-script.js";
export type { MessageMode, NewTask, SimOpenWork, SimOptions, SimQuirk, Trigger, Triggers } from "./sim-types.js";

export class Simulator {
  private state: State;
  private readonly listeners = new Set<() => void>();
  private readonly rt: SimRuntime;

  constructor(state: State, options: SimOptions = {}) {
    this.state = state;
    const work = options.log ?? new MemoryWorkLog(state.work?.since ?? state.now);
    this.rt = {
      triggers: options.triggers ?? {},
      disagree: new Set(options.disagree ?? []),
      lockedCopies: new Set(options.lockedCopies ?? []),
      prMergeAfter: options.prMergeAfter ?? 12,
      tickMs: options.tickMs ?? 40_000,
      work,
      quirks: options.quirks ?? {},
      serial: work.size(),
      openTurns: new Map((options.open?.turns ?? []).map(([taskId, turn]) => [taskId, { ...turn }])),
      openStages: new Map((options.open?.stages ?? []).map(([taskId, stage]) => [taskId, { ...stage }])),
      stageRuns: new Map(options.open?.runs ?? []),
      pullRequestAges: new Map(options.open?.pullRequests ?? []),
    };
    if (!state.work) this.state = { ...state, work: { version: 0, since: work.since() } };
  }

  async profileChoices({ toolId, modelId }: ProfileChoiceRequest) { return demoProfileChoices(toolId, modelId); }
  async saveProfile(draft: ProfileDraft, clientId: Id, profileId?: Id): Promise<Id> {
    let id = clientId;
    this.update(state => {
      id = saveProfile(
      state,
      draft,
      demoProfileChoices(
      draft.toolId,
      draft.modelId
    ),
      clientId,
      profileId
    );
      state.planner = simPlanner(state);
    });
    return id;
  }
  removeProfile(profileId: Id): void { this.update(state => {
    removeProfile(state, profileId);
    state.planner = simPlanner(state);
  }); }
  getState = (): State => this.state;

  /** The simulator's work log (the demos read and shape it). */
  get workLog(): MemoryWorkLog {
    return this.rt.work;
  }

  /** What is still open, moved `delta` milliseconds in time. */
  openWork(delta = 0): SimOpenWork {
    return {
      turns: [...this.rt.openTurns.entries()].map(([taskId, turn]) => [
        taskId,
        {
        ...turn,
        startedAt: turn.startedAt + delta,
        ...(turn.waitingSince !== undefined ? { waitingSince: turn.waitingSince + delta } : {})
      }
      ]),
      stages: [...this.rt.openStages.entries()].map(([taskId, stage]) => [taskId, { ...stage, startedAt: stage.startedAt + delta }]),
      runs: [...this.rt.stageRuns.entries()],
      pullRequests: [...this.rt.pullRequestAges.entries()],
    };
  }

  /** The numbers for one view, the same way the engine works them out. */
  usage<R extends UsageRequest>(request: R): UsageViewFor<R> {
    return usageView(this.rt.work, request, { now: this.state.now, state: this.state });
  }

  historyPage(query: HistoryQuery) {
    const page = demoHistoryPage(this.state, query);
    return query.includeUsage ? historyPageUsage(page, this.rt.work) : page;
  }
  taskDetails(taskId: Id): Task | undefined { return this.state.tasks.find((task) => task.id === taskId); }
  taskDetailsDelta(taskId: Id, _sinceRevision: string): import("./task-details-delta.js").TaskDetailsUpdate | undefined {
    const task = this.taskDetails(taskId);
    return task ? { kind: "full", task } : undefined;
  }
  publicMessage(taskId: Id, messageId: Id, offset?: number, limit?: number) {
    const line = this.taskDetails(taskId)?.session.find((entry) => entry.id === messageId);
    return line ? messagePage(previewRecord(line), offset, limit) : undefined;
  }
  async previewImage(_taskId: Id, _path: string): Promise<{ mime: string; data: string }> {
    throw new Error("This image is unavailable in the demo.");
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** Advance every running agent by one step, merge old pull requests, retry removing working copies, and start what fits in the pool. */
  tick(now?: number): void {
    this.update((d) => {
      d.now = now ?? d.now + this.rt.tickMs;
      for (const task of d.tasks) {
        if (task.state === "running") simStep(this.rt, d, task);
        else if (task.state === "pr-open" || (task.state === "cancelled" && task.pr?.state === "open")) simAgePullRequest(this.rt, d, task);
        else if (task.cleanup?.error) simRemoveCopy(this.rt, d, task);
      }
      simSchedule(this.rt, d);
    });
  }

  // ── Coordinator actions ────────────────────────────────────────────────────

  answer(itemId: Id, answer: string): void {
    this.resolve(itemId, (d, task, item) => {
      settleAsk(task, item.id, "answered", d.now, answer);
      simSay(d, task, "you", answer);
      simLog(d, task, "you", `You answered: ${answer}`);
      simSay(d, task, "agent", `Thanks. Going with: ${answer}.`, item.roleId, item.profileId);
      simUnblock(d, task);
    }, "answered");
  }

  /** The agent goes with its own recommendation (the first option). */
  decideForMe(itemId: Id): void {
    const item = this.state.inbox.find((entry) => entry.id === itemId);
    const pick = item?.options?.[0];
    if (!item || !pick) return;
    this.resolve(itemId, (d, task) => {
      settleAsk(task, itemId, "decided", d.now, pick);
      simLog(d, task, "you", `You let the agent decide. It chose: ${pick}`);
      simSay(d, task, "agent", `I'll go with: ${pick}.`, item.roleId, item.profileId);
      simUnblock(d, task);
    }, "decided");
  }

  allow(itemId: Id, _scope: "once" | "always" = "once"): void {
    this.resolve(itemId, (d, task, item) => {
      settleAsk(task, item.id, "allowed", d.now);
      simLog(d, task, "you", `You allowed: ${item.title}`);
      simSay(d, task, "agent", "Thanks, continuing.", item.roleId, item.profileId);
      simUnblock(d, task);
    }, "allowed");
  }

  deny(itemId: Id, note?: string): void {
    this.resolve(itemId, (d, task, item) => {
      settleAsk(task, item.id, "denied", d.now, note);
      simLog(d, task, "you", note ? `You said no: ${note}` : `You said no to: ${item.title}`);
      if (note) simSay(d, task, "you", note);
      simSay(d, task, "agent", "Understood. I'll find a way without it.", item.roleId, item.profileId);
      simUnblock(d, task);
    }, "denied");
  }

  /** Approve a gate (plan, design, delivery) or settle a disagreement with the architect's position. */
  approve(itemId: Id): void {
    const existing = this.state.inbox.find((entry) => entry.id === itemId);
    if (existing?.kind === "maintenance-settings") {
      this.resolveMaintenanceSettings(existing.taskId, "keep");
      return;
    }
    this.resolve(itemId, (d, task, item) => simApproveItem(this.rt, d, task, item), "approved");
  }

  /** Retry a stuck failed task without touching non-stuck inbox gates. */
  retry(itemId: Id): void {
    this.update((d) => {
      const item = d.inbox.find((entry) => entry.id === itemId);
      const task = item && d.tasks.find((entry) => entry.id === item.taskId);
      if (!item || !task || item.kind !== "stuck") return;
      simRetryItem(this.rt, d, task, item);
    });
  }

  rerunChecks(itemId: Id): void {
    this.resolve(itemId, (d, task, item) => simRerunChecks(d, task, item), "answered");
  }

  /** "Add the ticked ones": the lessons of an offer the coordinator keeps, by their place in it. */
  addLessons(itemId: Id, keep: number[]): void {
    this.resolve(itemId, (d, task, item) => simAddLessons(d, task, item, keep));
  }

  /** "Not this time" on an offer: the review guide, or AGENTS.md, stays as it is. */
  decline(itemId: Id): void {
    this.resolve(
      itemId,
      (
      d,
      task,
      item
    ) => simLog(
      d,
      task,
      "you",
      item.kind === "learnings" ? "You left AGENTS.md as it is" : "You left the review guide as it is"
    )
    );
  }

  /**
   * Send a gate back with a note: the design goes back to the architects, a delivery back to the builder,
   * a plan back to the planner. On a disagreement the note is the coordinator's call, which settles the design.
   */
  requestChanges(itemId: Id, note: string): void {
    this.resolve(itemId, (d, task, item) => simRequestChanges(d, task, item, note), "changes");
  }

  /** First run's demo: a product picked from the made-up clones. */
  addProduct(product: Product): void {
    this.update((d) => {
      if (d.products.some((entry) => entry.id === product.id)) return;
      d.products.push(JSON.parse(JSON.stringify(product)) as Draft["products"][number]);
      this.rt.work.recordProduct({ id: product.id, name: product.name, repo: product.repo, addedAt: d.now });
      simWrote(this.rt, d);
    });
  }

  /** First run's demo: the furthest screen reached. */
  setSetupStep(step: SetupStep): void {
    const order = (value: SetupStep | undefined) => SETUP_STEPS.findIndex((entry) => entry.id === (value ?? "welcome"));
    this.update((d) => { if (d.setup && !d.setup.done && order(step) > order(d.setup.step)) d.setup.step = step; });
  }

  /** First run's demo: "Skip setup". */
  skipSetup(): void { this.update((d) => { if (d.setup) d.setup.done = true; }); }

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
  dismissTip(): void { this.update((d) => { if (d.setup) d.setup.tipDismissed = true; }); }

  /** Change what "ready" means for a product, and whether the coordinator checks first. */
  setProductDelivery(productId: Id, delivery: DeliveryMode, approveDelivery: boolean): void {
    const product = this.state.products.find((entry) => entry.id === productId);
    if (product) this.updateProduct(productId, { name: product.name, delivery, approveDelivery });
  }

  updateProduct(productId: Id, settings: ProductSettings): void {
    validateProductSettings(settings, this.state.products, productId);
    this.update((d) => {
      const product = d.products.find((entry) => entry.id === productId);
      if (!product) throw new Error("This product is no longer in Petrina.");
      applyProductSettings(product, settings, d.products);
      // The permanent list keeps the latest name, so a removed product shows under the name it last had.
      this.rt.work.recordProduct({ id: product.id, name: product.name, repo: product.repo });
    });
  }

  setProductChecks(productId: Id, checks: readonly { name: string; command: string }[] | null): void {
    this.update(d => simSetProductChecks(d, productId, checks));
  }

  setProductCheckSetup(productId: Id, requirements: readonly CheckPrerequisite[]): void {
    this.update(d => simSetProductCheckSetup(d, productId, requirements));
  }

  setProductRemoteChecks(productId: Id, checks: readonly string[]): void {
    this.update((d) => simSetProductRemoteChecks(d, productId, checks));
  }

  removeProduct(productId: Id): void {
    const { unfinished } = productHistory(this.state.tasks, productId);
    if (unfinished) throw new Error(`${unfinished} task${unfinished === 1 ? " must" : "s must"} finish or be cancelled before this product can be removed.`);
    this.update((d) => simRemoveProduct(this.rt, d, productId));
  }

  setToolCap(toolId: Id, cap: number): void {
    this.update((d) => {
      d.pool.toolCaps[toolId] = Math.max(1, Math.min(12, Math.round(cap)));
      simSchedule(this.rt, d);
    });
  }

  setPoolLimit(limit: number): void {
    this.update((d) => {
      d.pool.limit = Math.max(1, Math.min(12, Math.round(limit)));
      simSchedule(this.rt, d);
    });
  }

  setPoolPaused(paused: boolean): void {
    this.update((d) => {
      d.pool.paused = paused;
      simSchedule(this.rt, d);
    });
  }

  /** "Agents may use the screen". Off never stops the agent on the screen; nobody new gets it. */
  setScreenUse(mode: ScreenMode): void {
    this.update((d) => {
      d.pool.screen = mode === "hour" ? { mode, until: d.now + SCREEN_HOUR_MS } : { mode };
      simSchedule(this.rt, d);
    });
  }

  /** Allow now: this request may use the screen, one agent at a time. */
  allowScreen(taskId: Id): void {
    this.updateTask(taskId, (d, task) => {
      if (!task.screen || task.screen.granted || task.screen.allowed) return;
      task.screen.allowed = true;
      simLog(d, task, "you", SCREEN_WORDS.allowedNow);
      simSchedule(this.rt, d);
    });
  }

  /** "Allow the screen for this task", even while the switch is off. */
  setTaskScreen(taskId: Id, allowed: boolean): void {
    this.updateTask(taskId, (d, task) => {
      if (task.state === "done" || task.state === "cancelled" || (task.screenAllowed === true) === allowed) return;
      if (allowed) task.screenAllowed = true;
      else delete task.screenAllowed;
      simLog(d, task, "you", allowed ? SCREEN_WORDS.taskOn : SCREEN_WORDS.taskOff);
      simSchedule(this.rt, d);
    });
  }

  /** Put a queued task at `index` in the queue (0 is the top). */
  moveInQueue(taskId: Id, index: number): void { this.update((d) => simMoveInQueue(this.rt, d, taskId, index)); }
  moveToTop(taskId: Id): void { this.moveInQueue(taskId, 0); }

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
    this.updateTask(
      taskId,
      (
      d,
      task
    ) => {
      task.held = held;
      simLog(
      d,
      task,
      "you",
      held ? "You put it on hold" : "You released the hold"
    );
      simSchedule(
      this.rt,
      d
    );
    }
    );
  }

  /** Start this task only after the given tasks have landed. An empty list removes the wait. */
  setAfter(taskId: Id, after: readonly Id[]): void {
    assertTaskDependenciesEditable(this.state.tasks.find((task) => task.id === taskId));
    const ids = validateTaskDependencies(taskId, after, (id) => this.state.tasks.find((task) => task.id === id));
    this.updateTask(taskId, (d, task) => {
      task.after = ids;
      const find = (id: Id) => d.tasks.find((entry) => entry.id === id);
      if (task.state === "queued") syncWait(task, blockingDependencies(task, find), find, d.now);
      simLog(d, task, "you", ids.length ? AFTER_WORDS.starts(ids.map((id) => find(id)!.title)) : AFTER_WORDS.none);
      simSchedule(this.rt, d);
    });
  }

  pause(taskId: Id): void { this.updateTask(taskId, (d, task) => simPauseTask(this.rt, d, task)); }

  resume(taskId: Id): void {
    this.updateTask(taskId, (d, task) => {
      if (!resumeTaskState(task, d.inbox.some((item) => item.taskId === taskId && !item.blocking))) return;
      simLog(d, task, "you", "You resumed it");
      simSchedule(this.rt, d);
    });
  }

  cancel(taskId: Id): void { this.updateTask(taskId, (d, task) => simCancelTask(this.rt, d, task)); }

  /** Live guidance stays in the current turn; explicit waiting and stopping use a new prompt. */
  sendMessage(taskId: Id, text: string, mode: MessageMode = "now"): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.updateTask(taskId, (d, task) => simSendMessage(this.rt, d, task, trimmed, mode));
  }

  removeQueued(taskId: Id, messageId: Id): void {
    this.updateTask(taskId, (_d, task) => {
      if (task.queued.some((message) => message.id === messageId && !messageRemovable(message))) return;
      task.queued = task.queued.filter((message) => message.id !== messageId);
    });
  }

  setStageProfile(taskId: Id, stageId: Id, list: "profileIds" | "reviewerProfileIds", index: number, profileId: Id): void {
    this.updateTask(taskId, (d, task) => {
      const title = assignFutureProfile(task, d.profiles, stageId, list, index, profileId);
      if (title !== undefined) simLog(d, task, "you", `You changed who works on “${title}”`);
    });
  }

  addReviewer(taskId: Id, stageId: Id, profileId: Id): void {
    this.updateTask(taskId, (d, task) => {
      const title = appendFutureReviewer(task, d.profiles, stageId, profileId);
      if (title !== undefined) simLog(d, task, "you", `You added a reviewer to “${title}”`);
    });
  }

  // ── The role library ───────────────────────────────────────────────────────

  saveRole(roleId: Id, draft: RoleDraft): void { this.changeRoles((changes) => library.editRole(changes, roleId, draft)); }
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
      id ||= simId(d, "routine");
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
    if (choice === "stop") {
      this.cancel(taskId);
      return;
    }
    this.updateTask(taskId, (d, task) => {
      if (task.maintenance?.settingsDecision) task.maintenance.settingsDecision.choice = choice;
      d.inbox = d.inbox.filter(i => !(i.taskId === taskId && i.kind === "maintenance-settings"));
      task.state = "waiting";
      simSchedule(this.rt, d);
    });
  }

  resetRole(roleId: Id): void { this.changeRoles((changes) => library.resetRole(changes, roleId)); }
  removeRole(roleId: Id): void { this.changeRoles((changes) => library.removeRole(
    changes,
    roleId,
    this.state.tasks.some((task) => library.planUses(
    task,
    roleId
  ))
  )); }

  private changeRoles(change: (changes: RoleChanges) => RoleChanges): void {
    const next = change(this.state.roleChanges ?? library.NO_ROLE_CHANGES);
    this.update((d) => {
      d.roleChanges = next as Draft["roleChanges"];
      d.roles = library.libraryRoles(next) as Draft["roles"];
    });
  }

  async setTaskStart(taskId: Id, choice: WorkChoice): Promise<void> {
    const task = this.state.tasks.find((entry) => entry.id === taskId);
    if (task?.workRows) return this.setTaskProducts(
      taskId,
      task.workRows.map((row) => row.choice.productId === choice.productId ? choice : choice.lead ? {
      ...row.choice,
      lead: false
    } : row.choice)
    );
    this.updateTask(taskId, (d, task) => simSetTaskStartSingle(d, task, choice));
  }

  async setTaskProducts(taskId: Id, choices: readonly WorkChoice[]): Promise<void> {
    this.updateTask(taskId, (d, task) => simSetTaskProducts(d, task, choices));
  }

  async setTaskAddition(_taskId: Id, _repository: string, _name: string, _path: string): Promise<void> {
    throw new Error("The demo does not clone repositories. Choose an existing demo product.");
  }

  setTaskApproval(taskId: Id, ask: boolean): void { this.updateTask(taskId, (_d, task) => { task.approveDelivery = ask; }); }

  addTask(input: NewTask): Id {
    const known = input.clientId ? this.state.tasks.find((task) => task.clientId === input.clientId)?.id : undefined;
    if (known) return known;
    let created = "";
    this.update((d) => { created = simAddTask(this.rt, d, input); });
    return created;
  }

  queueTask(taskId: Id): void {
    this.updateTask(taskId, (d, task) => {
      if (!queueBacklogTask(task, queueOf(d.tasks).length)) return;
      simLog(d, task, "you", "You reviewed the request and queued it for work");
      simSchedule(this.rt, d);
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
    this.update((d) => simFinalizeCombineBacklog(this.rt, d, id, taskIds, clientId));
    return id;
  }

  moveToBacklog(taskId: Id): void {
    this.updateTask(taskId, (d, task) => {
      if (!returnQueuedTaskToBacklog(task)) return;
      syncWait(task, [], () => undefined, d.now);
      simLog(d, task, "you", "You moved it to the backlog for review");
    });
  }

  updateBacklog(taskId: Id, changes: { title: string; description: string }): void {
    if (!this.state.tasks.some((task) => task.id === taskId)) throw new Error("Only backlog requests can be edited before work starts.");
    this.updateTask(taskId, (d, task) => {
      editBacklogRequest(task, changes);
      task.area = areaFromTitle(task.title);
      simLog(d, task, "you", "You updated the backlog request");
    });
  }

  private update(change: (draft: Draft) => void): void {
    const draft = JSON.parse(JSON.stringify(this.state)) as Draft;
    change(draft);
    this.state = draft;
    for (const listener of this.listeners) listener();
  }

  private updateTask(taskId: Id, change: (draft: Draft, task: DraftTask) => void): void {
    this.update((d) => {
      const task = d.tasks.find((entry) => entry.id === taskId);
      if (task) change(d, task);
    });
  }

  private resolve(itemId: Id, change: (draft: Draft, task: DraftTask, item: DeepMutable<InboxItem>) => void, answer?: AskAnswer): void {
    this.update((d) => {
      const item = d.inbox.find((entry) => entry.id === itemId);
      const task = item && d.tasks.find((entry) => entry.id === item.taskId);
      if (!item || !task) return;
      d.inbox = d.inbox.filter((entry) => entry.id !== itemId);
      if (answer && ASKS.has(item.kind)) simAnswered(this.rt, d, task, item, answer);
      change(d, task, item);
      simSchedule(this.rt, d);
    });
  }
}
