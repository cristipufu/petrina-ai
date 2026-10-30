import { runtimeWaitHolds, onScreen, SCREEN_HOUR_MS, SCREEN_WORDS, screenAllowed, screenMode, screenQueue, screenWait, type ConversationNote, type Id, type ScreenMode } from "@petrina/core";
import { executionFor, type RepositoryContext } from "./repository-context.js";
import type { RuntimeTask } from "./model.js";
import type { ScreenClock, ScreenGroup, ScreenHost } from "./ports/screen.js";

/** Portable permission, queue and deadline coordination. Native session/copy cleanup stays with the host. */
export class ScreenArbitration {
  private timer: (() => void) | undefined;
  private releaseTimer: (() => void) | undefined;
  constructor(private readonly host: ScreenHost, private readonly clock: ScreenClock, readonly groups = new Map<Id, ScreenGroup>()) {}
  stop(): void { this.timer?.(); this.releaseTimer?.(); this.timer = undefined; this.releaseTimer = undefined; }

  setScreenUse(mode: ScreenMode, hourMs = SCREEN_HOUR_MS): void {
    this.host.state().pool.screen = mode === "hour" ? { mode, until: this.clock.now() + hourMs } : { mode };
    this.armScreenTimer();
    this.host.schedule();
  }

  allowScreen(taskId: Id): void {
    const task = this.host.task(taskId);
    if (!task?.screen || task.screen.granted || task.screen.allowed) return;
    task.screen.allowed = true;
    this.host.record(task, "you", SCREEN_WORDS.allowedNow);
    this.host.schedule();
  }

  setTaskScreen(taskId: Id, allowed: boolean): void {
    const task = this.host.task(taskId);
    if (!task || task.state === "done" || task.state === "cancelled" || (task.screenAllowed === true) === allowed) return;
    if (allowed) task.screenAllowed = true;
    else delete task.screenAllowed;
    this.host.record(task, "you", allowed ? SCREEN_WORDS.taskOn : SCREEN_WORDS.taskOff);
    this.host.schedule();
  }

  /** Keep the participant's own copy and conversation while its screen request waits. */
  saveTurn(scope: RepositoryContext, roleId: Id, profileId: Id, member: string, copy: string, note: ConversationNote | undefined, reason: string): boolean {
    const { task, work } = scope;
    if (!this.host.task(task.id)?.hunt || !note) return false;
    const conversation = structuredClone(note);
    task.hunt!.screenTurns = { ...task.hunt!.screenTurns, [member]: { reason, at: this.clock.now(), copy, conversation } };
    if (task.screen) this.host.record(scope, "status", SCREEN_WORDS.asked(reason), roleId, profileId);
    const granted = !task.screen && this.askScreen(task, roleId, profileId, reason, member);
    if (granted) work.conversation = conversation;
    this.host.checkpoint(scope);
    return granted;
  }

  /**
   * The agent asked for the screen. Allowed and free: it has it now, in the same conversation. Otherwise its
   * conversation closes but is kept, its slot frees at once, and the task waits: for the coordinator's OK (with
   * a quiet inbox item), or for its turn.
   */
  askScreen(task: RuntimeTask, roleId: Id, profileId: Id, reason: string, member?: string): boolean {
    const state = this.host.state();
    const now = this.clock.now();
    task.screen = { reason, at: now, roleId, profileId, ...(member ? { member } : {}) };
    this.host.record(task, "status", SCREEN_WORDS.asked(reason), roleId, profileId);
    const allowed = screenAllowed(task, state.pool, now);
    // First asked, first served: an earlier allowed request still waiting goes first.
    const free = !onScreen(state.tasks) && !screenQueue(state.tasks).some((other) => other.id !== task.id && screenAllowed(other, state.pool, now));
    if (allowed && free && !runtimeWaitHolds(task)) {
      task.screen.granted = true;
      this.host.record(task, "milestone", SCREEN_WORDS.using(reason), roleId, profileId);
      return true;
    }
    // Other members of a review group finish their background work before its task waits.
    if (member) return false;
    this.waitForScreen(task);
    return false;
  }

  /** Wait without a slot; a screen attempt that ran out of usage returns to the end of the queue. */
  waitForScreen(task: RuntimeTask): void {
    if (task.screen?.granted) {
      task.screen.granted = false;
      task.screen.heard = false;
      task.screen.at = this.clock.now();
      const pending = task.screen.member ? task.hunt?.screenTurns?.[task.screen.member] : undefined;
      if (pending) pending.at = task.screen.at;
    }
    const group = task.screen?.member && this.groups.get(task.id);
    if (group && group.yield) {
      // Release just this member's admission. A peer may still be starting or using its copy;
      // exposing zero slots here would let other work start before that peer has settled.
      group.yield(task.screen!.member!);
      this.host.checkpoint();
      return;
    }
    task.state = "waiting";
    task.holdsSlot = false;
    delete task.agent;
    task.column = this.host.column(task);
    this.syncScreen();
    this.host.checkpoint();
  }

  /** Keep each waiting request's status line and quiet inbox item in step with who may use the screen now. */
  syncScreen(): void {
    const state = this.host.state();
    const now = this.clock.now();
    // For an hour ran out: it is Off from now on, without anyone touching it.
    if (state.pool.screen && state.pool.screen.mode !== screenMode(state.pool, now)) state.pool.screen = { mode: "off" };
    for (const task of state.tasks) {
      if (runtimeWaitHolds(task) && task.screen?.granted && !task.driving) {
        // A held task cannot retain the screen between sessions, including after a restart. The
        // admitted agent (or coordinator driving it) keeps its turn until it reaches that boundary.
        const member = task.screen.member;
        const group = this.groups.get(task.id);
        // A failed group deregisters before its admitted sessions finish closing. Without its
        // member record, the driver and its cleanup still own the grant until they settle.
        const using = member && group ? group.running(member) : this.host.sessionOwned(task);
        if (!using) {
          task.screen.granted = false;
          task.screen.heard = false;
        }
      }
      this.selectScreen(task);
      const wait = screenWait(task, state, now);
      const item = state.inbox.find((entry) => entry.taskId === task.id && entry.kind === "screen");
      if (wait === "ask" && !item) {
        const request = task.screen!;
        state.inbox.push({ id: this.host.inboxId(), taskId: task.id, kind: "screen", title: SCREEN_WORDS.needs(request.reason), body: SCREEN_WORDS.body, at: request.at, blocking: false, roleId: request.roleId, profileId: request.profileId });
      } else if (wait !== "ask" && item) {
        state.inbox = state.inbox.filter((entry) => entry !== item);
      }
      if (runtimeWaitHolds(task) && task.state === "waiting") { task.statusLine = this.host.waitLine(task); continue; }
      if (wait === "ask") task.statusLine = SCREEN_WORDS.needs(task.screen!.reason);
      else if (wait === "turn") task.statusLine = SCREEN_WORDS.turn;
      // Its turn on the screen: it waits for a slot like any other task (the scheduler says which).
      else if (task.state === "waiting" && task.screen && !task.screen.granted) task.statusLine = "Waiting for a free slot";
    }
  }

  /** Expose the group's earliest allowed request, including after usage requeues or permission changes. */
  selectScreen(task: RuntimeTask): void {
    const state = this.host.state();
    if (task.screen?.granted || !["running", "waiting", "needs-you"].includes(task.state)) return;
    const saved = task.hunt?.screenTurns;
    const current = task.screen?.member && saved?.[task.screen.member];
    if (current && task.screen?.allowed) current.allowed = true;
    const group = this.groups.get(task.id);
    const pending = Object.entries(saved ?? {}).filter(([key]) => !group?.running(key)).sort((a, b) => a[1].at - b[1].at);
    const byTask = screenAllowed({ ...task, screen: undefined }, state.pool, this.clock.now());
    const next = pending.find(([, request]) => byTask || request.allowed) ?? pending[0];
    if (!next || next[0] === task.screen?.member) return;
    const [member, request] = next;
    task.screen = { member, reason: request.reason, at: request.at, roleId: request.conversation.roleId, profileId: request.conversation.profileId, ...(request.allowed ? { allowed: true } : {}) };
    executionFor(task).work.conversation = request.conversation;
  }

  /** The step's screen request ends with the step (or a pause, a cancel, a failure): the next request may have the screen. */
  releaseScreen(task: RuntimeTask): void {
    const state = this.host.state();
    const held = task.screen?.granted;
    delete task.screen;
    state.inbox = state.inbox.filter((item) => !(item.taskId === task.id && item.kind === "screen"));
    if (!held || this.host.stopped()) return;
    // The next request stops waiting its turn now. It starts after this task's own driver has taken
    // its next step, so a screen request does not jump ahead of it.
    this.syncScreen();
    if (!this.releaseTimer) this.releaseTimer = this.clock.after(0, () => {
      this.releaseTimer = undefined;
      if (!this.host.stopped()) this.host.schedule();
    });
  }

  /** For an hour turns itself off when it runs out. */
  armScreenTimer(): void {
    this.timer?.();
    this.timer = undefined;
    const screen = this.host.state().pool.screen;
    if (this.host.stopped() || screen?.mode !== "hour" || screen.until === undefined) return;
    this.timer = this.clock.after(Math.max(0, screen.until - this.clock.now()) + 20, () => {
      this.timer = undefined;
      if (!this.host.stopped()) this.host.schedule();
    });
  }
}
