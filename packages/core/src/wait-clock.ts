import type { Id } from "./model.js";

/**
 * How long an agent has spent waiting for the coordinator's permission answers, so it can be left out
 * of its working time. Each agent has its own, so one agent's wait never shortens another's time.
 * Waits that overlap (an agent asking twice at once) count once.
 */
export class WaitClock {
  private readonly open = new Map<Id, { count: number; since: number }>();
  private readonly closed = new Map<Id, number>();

  start(taskId: Id, now: number): void {
    const entry = this.open.get(taskId);
    if (entry) entry.count += 1;
    else this.open.set(taskId, { count: 1, since: now });
  }

  stop(taskId: Id, now: number): void {
    const entry = this.open.get(taskId);
    if (!entry) return;
    entry.count -= 1;
    if (entry.count > 0) return;
    this.open.delete(taskId);
    this.closed.set(taskId, (this.closed.get(taskId) ?? 0) + Math.max(0, now - entry.since));
  }

  /** The task's waiting so far, a wait still open included. */
  of(taskId: Id, now: number): number {
    const entry = this.open.get(taskId);
    return (this.closed.get(taskId) ?? 0) + (entry ? Math.max(0, now - entry.since) : 0);
  }
}
