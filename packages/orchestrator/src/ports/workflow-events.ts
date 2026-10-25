import type { Id, Task, TaskState, WorkflowContext, WorkflowEvent } from "@petrina/core";

export interface WorkflowEventReply {
  outcome: "completed" | "invalid" | "unavailable" | "changed" | "disconnected" | "continuity-lost" | "timed-out";
  message?: string;
  events?: readonly WorkflowEvent[];
  cursor?: string;
  more?: boolean;
  shortened?: boolean;
  [key: string]: unknown;
}

/** Retained evidence pages are opaque to the log; the application keeps its existing page result type. */
export interface WorkflowEventReadReply { outcome: string; [key: string]: unknown }
export interface WorkflowEventCodec<Read extends WorkflowEventReadReply> {
  encodedBytes(value: unknown): number;
  fingerprint(value: unknown): string;
  encodeCursor(value: unknown): string;
  decodeCursor(cursor: string): unknown;
  readDetails(value: WorkflowEvent, query: { cursor?: string; limit?: number }, scope: readonly string[], extra: { eventId: string; evidence: "recorded" }): Read;
}

export interface WorkflowEventClock {
  now(): number;
  /** Deferred delivery; cancelling before delivery suppresses the callback. */
  after(ms: number, callback: () => undefined): () => void;
}

/** Existing scoped observations, with no native execution or command dispatch capability. */
export interface WorkflowEventsHost {
  readonly boot: string;
  readonly stopped: boolean;
  readonly taskInvolves: (taskId: Id, productId: Id) => boolean;
  readonly taskDetails?: (taskId: Id) => Task | undefined;
  readonly s: {
    readonly roles: WorkflowContext["roles"];
    readonly profiles: WorkflowContext["profiles"];
    readonly retiredProfiles?: WorkflowContext["profiles"];
    readonly inbox: WorkflowContext["inbox"];
    readonly products: WorkflowContext["products"];
    readonly pool: { readonly limited?: WorkflowContext["limited"] };
    readonly tasks: readonly TaskState[];
  };
}
