// Bounded readiness rechecks before a saved participant is replaced (the decision is `readinessGate` in core).
// Selection only reports the need. Scheduling, a live step and a running review group record the first wait
// here, start or join the tool's one shared check, and choose again once it answers or the wait's limit passes.

import { runtimeWaitHolds, CHECK_NAMES, checkOf, slotWait, type CheckId, type Id, type ReadinessWait } from "@petrina/core";
import type { Kernel, MTask } from "./kernel.js";
import { readinessLimitMs, type ToolChecks } from "./tool-checks.js";

/** Readiness alone keeps an otherwise eligible saved participant from its saved tool. */
export type { SelectionReadiness as ReadinessNeed } from "@petrina/orchestrator";
import type { SelectionReadiness as ReadinessNeed } from "@petrina/orchestrator";

export class Readiness {
  /** Waits under way, one per tool and limit, so repeated selection and competing seats share them. */
  private readonly waits = new Map<string, Promise<void>>();
  /** Ends every open wait at shutdown. */
  private readonly ends = new Set<() => void>();
  /** Admission owners retaining a main place; releasing one never stops the tool's shared check. */
  private readonly held = new Map<Id, Set<() => boolean>>();

  constructor(private readonly k: Kernel, private readonly tools: ToolChecks) {}

  /** One agent check plus the previous check's stop: test overrides of the check timeout included. */
  limitMs(): number {
    return readinessLimitMs(this.k.options.toolCheckTimeoutMs);
  }

  /** The wait's limit has not passed, so a place may still be kept for it. A wait not recorded yet has its whole limit. */
  open(need: ReadinessNeed, now = Date.now()): boolean {
    const at = need.saved.readinessWait?.at;
    return at === undefined || now < at + this.limitMs();
  }

  /**
   * Records this pending return's first wait, then starts or joins the tool's one shared check. A later call only
   * joins: the return's automatic recheck is spent. Settles when the check answers, the wait's limit passes, or for a
   * kept place when `signal` aborts or Petrina starts stopping, whichever comes first; scheduling then chooses again.
   */
  resolve(need: ReadinessNeed, owner?: AbortSignal): Promise<void> {
    const signal = owner && AbortSignal.any([owner, this.k.stopRequested.signal]);
    if (this.k.stopped || signal?.aborted || runtimeWaitHolds(need.scope.task)) return Promise.resolve();
    if (!need.saved.readinessWait) {
      const check = checkOf(this.k.s.setup?.checks, need.toolId);
      const wait: ReadinessWait = { at: Date.now(), toolId: need.toolId, previous: { status: check.status, ...(check.at !== undefined ? { at: check.at } : {}) }, check: check.checking ? "joined" : "started" };
      need.saved.readinessWait = wait;
      // A Ready tool's ordinary check only settles, as before. Otherwise the timeline says why the participant waits: a line of
      // Petrina's own, never attributed to the participant, so a restart never reports it as the agent's last activity.
      if (check.status !== "ready") {
        const tool = this.k.s.tools.find((entry) => entry.id === need.toolId)?.name ?? CHECK_NAMES[need.toolId];
        const before = { unknown: `${tool}'s last readiness check was inconclusive`, unchecked: `${tool} has no readiness answer yet`,
          "logged-out": `${tool} was last found logged out`, "not-installed": `${tool} was last found not installed` }[check.status];
        const role = this.k.role(need.roleId, need.scope.task)?.name ?? need.roleId;
        this.k.log(need.scope, "status", `${need.words} (${role}): ${before}, so Petrina ${wait.check === "joined" ? "joined the check under way" : "started one recheck"}`);
      }
      this.k.commitNow(need.scope);
      void this.tools.check(need.toolId);
    }
    const settled = this.settled(need.saved.readinessWait);
    if (!signal) return settled;
    return new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
      void settled.then(() => resolve());
    });
  }

  /** A retained place belongs to this admission attempt, even if the shared check outlives a task hold.
   * Groups reconcile their working peers before reporting whether the task's last place was released. */
  async resolveHeld(need: ReadinessNeed, owner: AbortSignal, yieldPlace?: () => boolean): Promise<boolean> {
    const taskId = need.scope.task.id;
    const interrupted = new AbortController();
    const end = () => { interrupted.abort(); return yieldPlace?.() ?? true; };
    const waits = this.held.get(taskId) ?? new Set<() => boolean>();
    waits.add(end);
    this.held.set(taskId, waits);
    try {
      if (runtimeWaitHolds(need.scope.task)) return false;
      await this.resolve(need, AbortSignal.any([owner, interrupted.signal]));
      return !interrupted.signal.aborted;
    } finally {
      waits.delete(end);
      if (!waits.size) this.held.delete(taskId);
    }
  }

  /** The task waits without a place now; its next admission must qualify again after the hold. */
  yieldHeld(task: MTask): boolean {
    const waits = this.held.get(task.id);
    if (!waits?.size) return false;
    let released = false;
    for (const end of waits) released = end() || released;
    return released;
  }

  /**
   * A step that already holds its main place keeps it for one open decision, charged once to the saved profile's tool
   * where the pool and that tool's cap allow it. False when it cannot: the step waits without a place, as before.
   */
  hold(task: MTask, need: ReadinessNeed): boolean {
    if (!task.holdsSlot || this.k.taskAdmissionsClosed(task) || !this.open(need) || !this.charge(task, need)) return false;
    task.state = this.k.s.inbox.some((item) => item.taskId === task.id && item.blocking) ? "needs-you" : "running";
    task.statusLine = need.words;
    task.column = this.k.columnFor(task);
    this.k.commitNow(task);
    return true;
  }

  /**
   * Moves the task's one main place to the waiting participant's saved profile, replacing the previous agent's charge.
   * Only this task's own places are left out when asking whether the saved tool has room; every other task counts.
   */
  charge(task: MTask, need: ReadinessNeed, reviewKey?: string): boolean {
    const profile = this.k.profile(need.profileId);
    if (runtimeWaitHolds(task) || !profile || slotWait(this.k.activeState(), { ...profile, taskId: task.id, toolId: profile.toolId })) return false;
    const same = task.agent?.roleId === need.roleId && task.agent.profileId === need.profileId && task.agent.reviewKey === reviewKey;
    if (!same) task.agent = { roleId: need.roleId, profileId: need.profileId, since: Date.now(), step: 0, ...(reviewKey !== undefined ? { reviewKey } : {}) };
    delete task.helpers;
    task.holdsSlot = true;
    return true;
  }

  /** Quitting ends every open wait at once; the tool checks stop with the engine's own check shutdown. */
  stop(): void {
    for (const end of [...this.ends]) end();
  }

  /** Until the tool answers since `wait` began, or its limit passes; a check that outlasts the limit can still end it. */
  private settled(wait: ReadinessWait): Promise<void> {
    const toolId = wait.toolId as CheckId;
    const check = checkOf(this.k.s.setup?.checks, toolId);
    const answered = !check.checking && check.at !== undefined && check.at >= wait.at;
    const running = this.tools.running(toolId);
    const until = wait.at + this.limitMs();
    const remaining = until - Date.now();
    // Nothing left to wait for: the caller decides from the latest answer, and nothing schedules again by itself.
    if (!answered && remaining <= 0 && !running) return Promise.resolve();
    const key = `${toolId}:${answered ? `answered ${check.at}` : remaining > 0 ? until : "check"}`;
    const known = this.waits.get(key);
    if (known) return known;
    const { promise, resolve } = Promise.withResolvers<void>();
    const timer = !answered && remaining > 0 ? setTimeout(resolve, remaining) : undefined;
    if (answered) resolve();
    else void running?.then(resolve, resolve);
    this.ends.add(resolve);
    const done = promise.then(() => {
      clearTimeout(timer);
      this.ends.delete(resolve);
      this.waits.delete(key);
      if (!this.k.stopped) this.k.schedule();
    });
    this.waits.set(key, done);
    return done;
  }
}
