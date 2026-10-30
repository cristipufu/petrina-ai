import type { Id, Role } from "@petrina/core";
import type { RuntimeTask } from "../model.js";
import type { RepositoryContext } from "../repository-context.js";
import type { DeliveryStage } from "./delivery-workflow.js";

/** Lookups and recording on the same live task; no repository/native host escapes this boundary. */
export interface DeliveryCheckpointHost {
  admissionsClosed(task: RuntimeTask): boolean;
  admissionWait(task: RuntimeTask): string;
  column(task: RuntimeTask): RuntimeTask["column"];
  role(id: Id, task: RuntimeTask): Role | undefined;
  blocked(task: RuntimeTask): void;
  note(task: RuntimeTask, tone: "milestone", text: string): void;
  checkpoint(): void;
  gate(task: RuntimeTask): void;
  shipsUnasked(task: RuntimeTask): boolean;
  destination(scope: RepositoryContext): string;
}

/** Each observation is bound to its original execution and keeps its original await/error position. */
export interface DeliveryCheckpointEffects {
  writeGuide(scope: RepositoryContext): Promise<void>;
  writeLearnings(scope: RepositoryContext): Promise<void>;
  upToDate(scope: RepositoryContext, signal: AbortSignal): Promise<"current" | "moved" | "conflict">;
  checksBeforeDelivery(scope: RepositoryContext, signal: AbortSignal, prepare: () => Promise<boolean>): Promise<"passed" | "returned" | "exhausted" | "blocked">;
  offerLearnings(scope: RepositoryContext): Promise<void>;
  previewRelease(scope: RepositoryContext, stage: DeliveryStage, signal: AbortSignal): Promise<void>;
  head(scope: RepositoryContext): Promise<string>;
  patch(scope: RepositoryContext, head?: string): Promise<string | undefined>;
  committedCode(task: RuntimeTask): Promise<{ versions: Record<Id, string>; changes: Record<Id, string> }>;
  invalidateAcceptance(task: RuntimeTask, versions?: Record<Id, string>): Promise<Record<Id, string> | undefined>;
  versions(task: RuntimeTask): Promise<Record<Id, string>>;
  acceptanceVersion(scope: RepositoryContext, versions?: Record<Id, string>): Promise<string | undefined>;
}
