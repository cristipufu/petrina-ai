import type { Candidate, Column, DeepMutable, Id, InboxItem, Pool } from "@petrina/core";
import type { RuntimeTask } from "../model.js";

export interface ScreenClock {
  now(): number;
  /** Defer synchronous delivery; cancellation before delivery suppresses the callback. */
  after(ms: number, callback: () => undefined): () => void;
}
export interface ScreenRuntimeState {
  tasks: RuntimeTask[];
  pool: DeepMutable<Pick<Pool, "screen">>;
  inbox: DeepMutable<InboxItem>[];
}
/** The live review group's participant/reservation protocol; no native process handles. */
export interface ScreenGroup {
  continue(): void;
  running(member: string): boolean;
  recipients(): readonly string[];
  finished(member: string): void;
  yield?(member: string): void;
  returning?(): Candidate[];
  rejoin?(): void;
}
export interface ScreenHost {
  /** Read lazily: the application may construct this controller before loading its state. */
  state(): ScreenRuntimeState;
  task(id: Id): RuntimeTask | undefined;
  stopped(): boolean;
  /** A driver or its closing session still owns the task when no live group supplies a member view. */
  sessionOwned(task: RuntimeTask): boolean;
  waitLine(task: RuntimeTask): string;
  column(task: RuntimeTask): Column;
  record(task: RuntimeTask, tone: "status" | "milestone" | "you", text: string, roleId?: Id, profileId?: Id): void;
  inboxId(): Id;
  checkpoint(): void;
  schedule(): void;
}
