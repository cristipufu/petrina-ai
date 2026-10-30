// Native codec/clock composition. The portable owner retains the existing log/query/wait behavior.
import { boundWorkflowEvent, type WorkflowEvent } from "@petrina/core";
import {
  WorkflowEvents as EventController,
  WorkflowEventLog as EventLog,
  EVENT_BYTES,
  EVENT_RETENTION,
  type WorkflowEventCodec,
  type WorkflowEventClock,
  type WorkflowEventsHost
} from "@petrina/orchestrator";
import type { Result } from "./coordination.js";
import { cursor, readText } from "./evidence-read.js";
import { fingerprint } from "@petrina/storage/receipt-identity";
export { EVENT_RETENTION, EVENT_BYTES, BATCH_BYTES, BATCH_EVENTS, EVENT_KINDS } from "@petrina/orchestrator";
export type { EventScope, EventQuery, WorkflowEventsHost } from "@petrina/orchestrator";

const codec: WorkflowEventCodec<Result> = {
  encodedBytes: value => Buffer.byteLength(JSON.stringify(value)),
  fingerprint, encodeCursor: cursor, decodeCursor: value => JSON.parse(Buffer.from(value, "base64url").toString()),
  readDetails: (value, query, scope, extra) => readText(value, query, scope, extra),
};
const clock: WorkflowEventClock = {
  now: () => Date.now(),
  after: (ms, callback) => {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
};

export function boundEvent(event: WorkflowEvent, limit = EVENT_BYTES): WorkflowEvent {
  return boundWorkflowEvent(event, value => codec.encodedBytes(value), limit);
}
export class WorkflowEventLog extends EventLog<Result> {
  constructor(run: string, limits = EVENT_RETENTION) { super(run, codec, limits); }
}
export class WorkflowEvents extends EventController<Result> {
  constructor(
    host: WorkflowEventsHost,
    limits?: {
    events?: number;
    bytes?: number
  }
  ) { super(
    host,
    codec,
    clock,
    new WorkflowEventLog(
    host.boot,
    {
    ...EVENT_RETENTION,
    ...limits
  }
  )
  ); }
}
