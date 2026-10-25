import { BUILT_IN_ROLES, DEFAULT_PROFILES, boundWorkflowEvent, createTaskState, involvesProduct, readEvidenceText, type DeepMutable, type EvidencePageResult, type NewTaskInput, type State, type WorkflowEvent } from "@petrina/core";
import { WorkflowEvents, WorkflowEventLog, EVENT_RETENTION } from "../../src/workflow-events.js";
import type { WorkflowEventCodec, WorkflowEventReply, WorkflowEventsHost } from "../../src/ports/workflow-events.js";
import type { RuntimeTask } from "../../src/model.js";
import { restoreRepositoryState, taskView } from "../../src/repository-context.js";
import { ControlledClock } from "./clock.js";

/** Private identity map, not a hash substitute claim. Native SHA/Base64 composition has separate contracts. */
export class EventTestCodec implements WorkflowEventCodec<EvidencePageResult> {
  private readonly identities = new Map<string, string>();
  encodedBytes(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).length; }
  fingerprint(value: unknown): string {
    const text = JSON.stringify(value);
    if (!this.identities.has(text)) this.identities.set(text, `recorded-identity-${this.identities.size}`);
    return this.identities.get(text)!;
  }
  encodeCursor(value: unknown): string { return JSON.stringify(value); }
  decodeCursor(value: string): unknown { return JSON.parse(value); }
  readDetails(value: WorkflowEvent, query: { cursor?: string; limit?: number }, scope: readonly string[], extra: { eventId: string; evidence: "recorded" }): EvidencePageResult {
    return readEvidenceText(value, query, scope, extra, this);
  }
}

/** The real observer/log/page owners with a controlled clock and explicit private task observations. */
export function eventFixture(limits?: { events?: number; bytes?: number }) {
  const clock = new ControlledClock(), codec = new EventTestCodec();
  const state: DeepMutable<Pick<State, "roles" | "profiles" | "retiredProfiles" | "inbox" | "products" | "pool">> & { tasks: RuntimeTask[] } = {
    roles: structuredClone([...BUILT_IN_ROLES]), profiles: structuredClone([...DEFAULT_PROFILES]), inbox: [],
    products: [{ id: "product", name: "Example", repo: "local/example", tone: "blue", delivery: "local" }], pool: { limit: 3, paused: true, toolCaps: {} }, tasks: [],
  };
  let sequence = 0;
  const task = (id: string) => state.tasks.find(task => task.id === id);
  const host = {
    boot: "private-event-run", stopped: false, s: state,
    taskInvolves: (id: string, productId: string) => { const found = task(id); return !!found && involvesProduct(found, productId); },
    taskDetails: (id: string) => { const found = task(id); return found ? taskView(found) : undefined; },
  } satisfies WorkflowEventsHost;
  const log = new WorkflowEventLog(host.boot, codec, { ...EVENT_RETENTION, ...limits });
  const events = new WorkflowEvents(host, codec, clock, log);
  const newTask = (input: NewTaskInput) => {
    const created = createTaskState(input, state.products, { id: `task-${++sequence}`, timelineId: `created-${sequence}`, now: clock.now(), priority: state.tasks.length });
    restoreRepositoryState(created); state.tasks.push(created); events.observe([created]); return created;
  };
  const observe = (changed?: RuntimeTask) => events.observe(changed ? [changed] : state.tasks);
  return { state, clock, codec, host, events, newTask, task, observe,
    query: events.wait.bind(events),
    bound: (event: WorkflowEvent, limit?: number) => boundWorkflowEvent(event, value => codec.encodedBytes(value), limit),
  };
}

export const kinds = (result: WorkflowEventReply) => (result.events as WorkflowEvent[]).map(event => event.kind);
export const all = (result: WorkflowEventReply) => result.events as WorkflowEvent[];
