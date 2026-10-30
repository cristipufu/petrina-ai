import {
  boundWorkflowEvent,
  eventInvolvesProduct,
  WORKFLOW_EVENT_BYTES,
  WORKFLOW_EVENT_KINDS,
  WorkflowObserver,
  type Id,
  type TaskState,
  type WorkflowContext,
  type WorkflowEvent,
  type WorkflowEventDraft,
  type WorkflowEventKind
} from "@petrina/core";
import type { WorkflowEventClock, WorkflowEventCodec, WorkflowEventReadReply, WorkflowEventReply, WorkflowEventsHost } from "./ports/workflow-events.js";

export const EVENT_RETENTION = { events: 10_000, bytes: 16 * 1024 * 1024 };
export const BATCH_BYTES = 64 * 1024;
export const BATCH_EVENTS = 100;
export const EVENT_BYTES = WORKFLOW_EVENT_BYTES;

export interface EventScope { taskIds?: readonly Id[]; productId?: Id; kinds?: readonly WorkflowEventKind[] }
export interface EventQuery extends EventScope { cursor?: string; from?: "now" | "oldest"; limit?: number; timeoutMs?: number }
interface Retained { event: WorkflowEvent; details: WorkflowEvent; bytes: number }

export class WorkflowEventLog<Read extends WorkflowEventReadReply> {
  private readonly retained: Retained[] = [];
  private bytes = 0;
  private seq = 0;
  /** Set once the first event was evicted: replay before it is unavailable. */
  private evictedThrough = 0;
  private readonly listeners = new Set<() => void>();

  constructor(readonly run: string, private readonly codec: WorkflowEventCodec<Read>, private readonly limits = EVENT_RETENTION) {}

  get newest(): number { return this.seq; }
  get oldest(): number | undefined { return this.retained[0]?.event.seq; }
  get size(): number { return this.retained.length; }
  get evicted(): number { return this.evictedThrough; }
  get waiting(): number { return this.listeners.size; }

  append(drafts: readonly WorkflowEventDraft[]): WorkflowEvent[] {
    if (!drafts.length) return [];
    const added: WorkflowEvent[] = [];
    for (const draft of drafts) {
      const seq = ++this.seq;
      const details = { ...draft, id: `${this.run}:${seq}`, seq, run: this.run };
      const event = boundWorkflowEvent(details, value => this.codec.encodedBytes(value));
      const bytes = this.codec.encodedBytes(event) + this.codec.encodedBytes(details);
      this.retained.push({ event, details, bytes });
      this.bytes += bytes;
      added.push(event);
    }
    while (this.retained.length > this.limits.events || (this.bytes > this.limits.bytes && this.retained.length > 0)) {
      const dropped = this.retained.shift()!;
      this.bytes -= dropped.bytes;
      this.evictedThrough = dropped.event.seq;
    }
    for (const listener of [...this.listeners]) listener();
    return added;
  }

  /** Complete compact details are immutable, paged, and expire with this event's retained window. */
  read(eventId: string, args: { cursor?: string; limit?: number }): Read | WorkflowEventReply {
    const saved = this.retained.find(({ event }) => event.id === eventId);
    if (!saved) return {
      outcome: "unavailable",
      reason: eventId.startsWith(`${this.run}:`) ? "replay-expired" : "different-engine-run",
      message: "That event is outside this engine run's retained window. No newer evidence is substituted."
    };
    return this.codec.readDetails(saved.details, args, ["watch.event", eventId], { eventId, evidence: "recorded" });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** The engine is stopping: every wait wakes now and reports the stop, instead of running out its deadline. */
  wake(): void {
    for (const listener of [...this.listeners]) listener();
  }

  matches(event: WorkflowEvent, scope: EventScope): boolean {
    if (scope.kinds && !scope.kinds.includes(event.kind)) return false;
    if (scope.taskIds) return scope.taskIds.includes(event.taskId);
    if (scope.productId) return eventInvolvesProduct(event, scope.productId);
    return true;
  }

  /** Matching events after `after`, bounded by count and bytes. The continuation never passes an undelivered match. */
  collect(scope: EventScope, after: number, limit: number, byteLimit = BATCH_BYTES): {
    events: WorkflowEvent[];
    position: number;
    more: boolean;
    shortened: boolean
  } {
    const events: WorkflowEvent[] = [];
    let position = after;
    let bytes = 2;
    for (const { event, details } of this.retained) {
      if (event.seq <= after) continue;
      if (!this.matches(details, scope)) continue;
      const size = this.codec.encodedBytes(event);
      if (events.length >= limit) return { events, position, more: true, shortened: false };
      if (bytes + size + (events.length ? 1 : 0) > byteLimit) return { events, position, more: true, shortened: true };
      events.push(event);
      bytes += size + (events.length > 1 ? 1 : 0);
      position = event.seq;
    }
    // Everything retained was inspected and no match is left behind: unrelated later events can be passed.
    return { events, position: Math.max(position, this.seq), more: false, shortened: false };
  }
}

export class WorkflowEvents<Read extends WorkflowEventReadReply> {
  private readonly observer = new WorkflowObserver();
  private pendingWaits = 0;

  constructor(
    private readonly k: WorkflowEventsHost,
    private readonly codec: WorkflowEventCodec<Read>,
    private readonly clock: WorkflowEventClock,
    readonly log: WorkflowEventLog<Read>
  ) {}

  private context(): WorkflowContext {
    return {
      roles: this.k.s.roles,
      profiles: [
      ...this.k.s.profiles,
      ...(this.k.s.retiredProfiles ?? [])
    ],
      inbox: this.k.s.inbox,
      products: this.k.s.products,
      limited: this.k.s.pool.limited,
      now: this.clock.now(),
      findTask: (id) => this.k.s.tasks.find((task) => task.id === id) ?? this.k.taskDetails?.(id)
    };
  }

  /** The engine's starting state produces no events. */
  baseline(tasks: readonly TaskState[]): void {
    const ctx = this.context();
    for (const task of tasks) if (!this.observer.known(task.id)) this.observer.baseline(task, ctx);
  }

  /** Compare the changed tasks with their recorded facts and retain the resulting events. */
  observe(tasks: readonly TaskState[]): WorkflowEvent[] {
    if (this.k.stopped) return [];
    const ctx = this.context();
    const drafts: WorkflowEventDraft[] = [];
    for (const task of tasks) {
      try { drafts.push(...this.observer.observe(task, ctx)); }
      catch (error) { console.error("Could not record workflow events:", error); }
    }
    return this.log.append(drafts);
  }

  get waiting(): number { return this.pendingWaits; }

  /** Release every pending wait at engine shutdown. */
  stop(): void { this.log.wake(); }

  /** A compact scope for the cursor: all work, one product, or a hash of the selected tasks; kinds as a hash. */
  private scopeOf(scope: EventScope): { all?: true; product?: Id; tasks?: string; kinds?: string } {
    return {
      ...(scope.taskIds ? { tasks: this.codec.fingerprint([...scope.taskIds].sort()) } : scope.productId ? { product: scope.productId } : { all: true }),
      ...(scope.kinds ? { kinds: this.codec.fingerprint([...scope.kinds].sort()) } : {}),
    };
  }

  private cursorFor(scope: EventScope, seq: number): string {
    return this.codec.encodeCursor({ run: this.log.run, seq, scope: this.scopeOf(scope) });
  }

  /**
   * A cursor may be reused with the same scope or a narrower one: all work can narrow to a product or to
   * tasks, a product to tasks it involves, and unfiltered kinds to a subset. A wider scope would pass events
   * the cursor's scope never delivered, so it is refused.
   */
  private scopeAllows(saved: { all?: unknown; product?: unknown; tasks?: unknown; kinds?: unknown }, scope: EventScope): boolean {
    const wanted = this.scopeOf(scope);
    if (saved.kinds !== undefined) {
      if (typeof saved.kinds !== "string" || wanted.kinds !== saved.kinds) return false;
    }
    if (saved.all === true) return true;
    if (typeof saved.product === "string") {
      if (wanted.product === saved.product) return true;
      return !!scope.taskIds && scope.taskIds.every((id) => this.k.taskInvolves(id, saved.product as Id));
    }
    return typeof saved.tasks === "string" && wanted.tasks === saved.tasks;
  }

  private boundary() {
    return {
      run: this.log.run,
      oldest: this.log.oldest ?? null,
      newest: this.log.newest || null,
      retained: this.log.size,
      ...(this.log.evicted ? { evictedThrough: this.log.evicted } : {})
    };
  }

  /** Validate the query's scope and continuation before anything waits. */
  private position(query: EventQuery): { ok: true; after: number } | { ok: false; result: WorkflowEventReply } {
    const scope: EventScope = { taskIds: query.taskIds, productId: query.productId, kinds: query.kinds };
    const refuse = (result: WorkflowEventReply) => ({ ok: false as const, result });
    if (!query.cursor) {
      const after = query.from === "oldest" ? Math.max(0, (this.log.oldest ?? this.log.newest + 1) - 1) : this.log.newest;
      return { ok: true, after };
    }
    let saved: { run?: unknown; seq?: unknown; scope?: unknown };
    try { saved = this.codec.decodeCursor(query.cursor) as typeof saved; }
    catch { return refuse({
      outcome: "invalid",
      message: "That cursor could not be read. Use a cursor returned by a workflow-events result, or omit it to observe from now."
    }); }
    if (typeof saved !== "object" || saved === null || typeof saved.run !== "string" || typeof saved.seq !== "number" || !Number.isSafeInteger(saved.seq) || saved.seq < 0 || typeof saved.scope !== "object" || saved.scope === null) return refuse({
      outcome: "invalid",
      message: "That cursor is malformed. Use a cursor returned by a workflow-events result."
    });
    if (!this.scopeAllows(
      saved.scope as Record<string, unknown>,
      scope
    )) return refuse({
      outcome: "invalid",
      message: "That cursor belongs to a wider or different scope (tasks, product or kinds). Reuse it with the same scope or a narrower one, or start a new observation."
    });
    const seq = saved.seq;
    if (saved.run !== this.log.run) return refuse({
      outcome: "continuity-lost",
      continuity: "lost",
      reason: "engine-restarted",
      message: "The engine restarted since that cursor was issued. Events between the two runs were not recorded; begin a new observation from now, or replay this run's retained events explicitly with from=oldest.",
      boundary: this.boundary(),
      cursor: this.cursorFor(
      scope,
      this.log.newest
    ),
      events: [],
      more: false
    });
    if (seq > this.log.newest) return refuse({
      outcome: "invalid",
      message: "That cursor is ahead of this engine run's events. Use a cursor this run returned.",
      boundary: this.boundary()
    });
    if (seq < this.log.evicted) return refuse({
      outcome: "continuity-lost",
      continuity: "lost",
      reason: "replay-expired",
      message: "Events after that cursor were evicted from the bounded replay window. Observation is incomplete from there; begin a new observation from now, or replay the oldest retained events explicitly with from=oldest.",
      boundary: this.boundary(),
      cursor: this.cursorFor(
      scope,
      this.log.newest
    ),
      events: [],
      more: false
    });
    return { ok: true, after: seq };
  }

  /** Available events return at once; otherwise the wait stays open until a matching batch, the deadline, cancellation or engine stop. */
  async wait(query: EventQuery, signal?: AbortSignal): Promise<WorkflowEventReply> {
    const scope: EventScope = { taskIds: query.taskIds, productId: query.productId, kinds: query.kinds };
    const limit = Math.max(1, Math.min(BATCH_EVENTS, query.limit ?? 25));
    const timeoutMs = Math.max(0, query.timeoutMs ?? 30_000);
    const start = this.position(query);
    if (!start.ok) return start.result;
    const after = start.after;
    const continuity = query.cursor ? "continuous" : "fresh";
    const deadline = this.clock.now() + timeoutMs;
    const batch = (outcome: "completed" | "timed-out" | "disconnected", extra: Record<string, unknown> = {}): WorkflowEventReply => {
      // A synchronous burst can overtake this waiter after it subscribes and before its promise resumes.
      // Revalidate the retained boundary before claiming continuity or advancing its cursor.
      if (after < this.log.evicted) {
        const expired = this.position({ ...query, cursor: this.cursorFor(scope, after) });
        if (!expired.ok) return expired.result;
      }
      // Account for the full reply, including its continuation, boundary and shortening metadata.
      const envelope = {
        outcome,
        continuity,
        events: [],
        cursor: this.cursorFor(
        scope,
        Number.MAX_SAFE_INTEGER
      ),
        more: true,
        shortened: true,
        boundary: this.boundary(),
        ...extra
      };
      const found = this.log.collect(scope, after, limit, BATCH_BYTES - this.codec.encodedBytes(envelope));
      return {
        outcome,
        continuity,
        events: found.events,
        cursor: this.cursorFor(
        scope,
        found.position
      ),
        more: found.more,
        ...(found.shortened ? { shortened: true } : {}),
        boundary: this.boundary(),
        ...extra
      };
    };
    if (this.log.collect(scope, after, 1).events.length) return batch("completed");
    if (timeoutMs === 0 || this.k.stopped || signal?.aborted) return batch(
      this.k.stopped ? "disconnected" : "completed",
      timeoutMs === 0 && !this.k.stopped ? { message: "No new events. Keep this cursor and wait from it." } : {}
    );
    this.pendingWaits += 1;
    try {
      for (;;) {
        const woke = await new Promise<"event" | "deadline" | "aborted">((resolve) => {
          let done = false;
          const finish = (how: "event" | "deadline" | "aborted") => {
            if (done) return;
            done = true;
            cancel();
            off();
            signal?.removeEventListener("abort", onAbort);
            resolve(how);
          };
          const onAbort = () => finish("aborted");
          const cancel = this.clock.after(Math.max(0, deadline - this.clock.now()), () => {
            finish("deadline");
            return undefined;
          });
          const off = this.log.subscribe(() => { if (this.k.stopped || after < this.log.evicted || this.log.collect(
            scope,
            after,
            1
          ).events.length) finish("event"); });
          signal?.addEventListener("abort", onAbort, { once: true });
          if (signal?.aborted) onAbort();
          else if (this.k.stopped) finish("event");
        });
        if (this.k.stopped) return batch("disconnected", { message: "The engine stopped. Reconnect and begin a new observation; this run's events are gone." });
        if (woke === "aborted") return batch("disconnected", { message: "The wait was cancelled." });
        if (after < this.log.evicted || this.log.collect(scope, after, 1).events.length) return batch("completed");
        if (woke === "deadline" || this.clock.now() >= deadline) return batch(
          "timed-out",
          { message: "The deadline ended this wait quietly. Keep this cursor and wait again." }
        );
      }
    } finally {
      this.pendingWaits -= 1;
    }
  }
}

export const EVENT_KINDS: readonly WorkflowEventKind[] = WORKFLOW_EVENT_KINDS;
