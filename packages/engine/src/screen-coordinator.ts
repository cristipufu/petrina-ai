// Screen arbitration and the working copies retained by waiting review members.
import { join } from "node:path";
import { onScreen, SCREEN_WORDS, screenAllowed, screenMode, screenQueue, screenWait, type Id, type State, type Task } from "@petrina/core";
import type { Kernel, MTask } from "./kernel.js";
import { executionFor, executionOf, scopesFor, type RepositoryContext } from "./repository-context.js";
import * as git from "./git.js";
import { completeAll } from "./parallel.js";
type ScreenHost = Pick<Kernel, "settling" | "dataDir" | "productOf" | "log" | "syncIdleSleep" | "s" | "columnFor" | "commitNow" | "id" | "activeState" | "schedule" | "stopped">;
export class ScreenCoordinator {
  readonly groups = new Map<Id, { continue: () => void; running: (member: string) => boolean; recipients: () => readonly string[]; finished: (member: string) => void; yield?: (member: string) => void }>();
  readonly copyCleanups = new Map<Id, Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private releaseTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly k: ScreenHost) {}
  stop(): void { clearTimeout(this.timer); clearTimeout(this.releaseTimer); }

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
    const owners = scopesFor(task, { includeExcluded: true }).map((scope) => ({ productId: scope.work.productId, root: scope.work.source?.product.path ?? this.k.productOf(scope)?.path }));
    if (!owners.some((owner) => owner.root)) return;
    const stopped = this.k.settling.get(task.id);
    const cleanup = Promise.all([stopped, this.copyCleanups.get(task.id)])
      .then(async () => { await completeAll(owners.flatMap((owner) => owner.root ? [git.removeCopies(owner.root, join(this.k.dataDir, "worktrees", owner.productId, `${task.id}.copies`))] : [])); })
      .catch((error: unknown) => this.k.log(task, "warn", `Could not remove the reviewers' working copies: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        if (this.copyCleanups.get(task.id) === cleanup) this.copyCleanups.delete(task.id);
        this.k.syncIdleSleep();
      });
    this.copyCleanups.set(task.id, cleanup);
    this.k.syncIdleSleep();
  }

  /**
   * The agent asked for the screen. Allowed and free: it has it now, in the same conversation. Otherwise its
   * conversation closes but is kept, its slot frees at once, and the task waits: for the coordinator's OK (with
   * a quiet inbox item), or for its turn.
   */
  askScreen(task: MTask, roleId: Id, profileId: Id, reason: string, member?: string): boolean {
    const now = Date.now();
    task.screen = { reason, at: now, roleId, profileId, ...(member ? { member } : {}) };
    this.k.log(task, "status", SCREEN_WORDS.asked(reason), roleId, profileId);
    const allowed = screenAllowed(task as Task, this.k.s.pool as State["pool"], now);
    // First asked, first served: an earlier allowed request still waiting goes first.
    const free = !onScreen(this.k.s.tasks as Task[]) && !screenQueue(this.k.s.tasks as Task[]).some((other) => other.id !== task.id && screenAllowed(other, this.k.s.pool as State["pool"], now));
    if (allowed && free) {
      task.screen.granted = true;
      this.k.log(task, "milestone", SCREEN_WORDS.using(reason), roleId, profileId);
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
    const group = task.screen?.member && this.groups.get(task.id);
    if (group && group.yield) {
      // Release just this member's admission. A peer may still be starting or using its copy;
      // exposing zero slots here would let other work start before that peer has settled.
      group.yield(task.screen!.member!);
      this.k.commitNow();
      return;
    }
    task.state = "waiting";
    task.holdsSlot = false;
    delete task.agent;
    task.column = this.k.columnFor(task);
    this.syncScreen();
    this.k.commitNow();
  }

  /** Keep each waiting request's status line and quiet inbox item in step with who may use the screen now. */
  syncScreen(): void {
    const now = Date.now();
    // For an hour ran out: it is Off from now on, without anyone touching it.
    if (this.k.s.pool.screen && this.k.s.pool.screen.mode !== screenMode(this.k.s.pool as State["pool"], now)) this.k.s.pool.screen = { mode: "off" };
    for (const task of this.k.s.tasks) {
      this.selectScreen(task);
      const wait = screenWait(task as Task, this.k.activeState(), now);
      const item = this.k.s.inbox.find((entry) => entry.taskId === task.id && entry.kind === "screen");
      if (wait === "ask" && !item) {
        const request = task.screen!;
        this.k.s.inbox.push({ id: this.k.id("inbox"), taskId: task.id, kind: "screen", title: SCREEN_WORDS.needs(request.reason), body: SCREEN_WORDS.body, at: request.at, blocking: false, roleId: request.roleId, profileId: request.profileId });
      } else if (wait !== "ask" && item) {
        this.k.s.inbox = this.k.s.inbox.filter((entry) => entry !== item);
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
    const group = this.groups.get(task.id);
    const pending = Object.entries(saved ?? {}).filter(([key]) => !group?.running(key)).sort((a, b) => a[1].at - b[1].at);
    const byTask = screenAllowed({ ...task, screen: undefined } as Task, this.k.s.pool as State["pool"], Date.now());
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
    this.k.s.inbox = this.k.s.inbox.filter((item) => !(item.taskId === task.id && item.kind === "screen"));
    if (!held || this.k.stopped) return;
    // The next request stops waiting its turn now. It starts after this task's own driver has taken
    // its next step, so a screen request does not jump ahead of it.
    this.syncScreen();
    if (!this.releaseTimer) this.releaseTimer = setTimeout(() => {
      this.releaseTimer = undefined;
      if (!this.k.stopped) this.k.schedule();
    }, 0);
  }

  /** For an hour turns itself off when it runs out. */
  armScreenTimer(): void {
    clearTimeout(this.timer);
    const screen = this.k.s.pool.screen;
    if (screen?.mode !== "hour" || screen.until === undefined) return;
    this.timer = setTimeout(() => this.k.schedule(), Math.max(0, screen.until - Date.now()) + 20);
  }
}
