import type { Id, InboxKind, RuntimeWaitTask, Role } from "@petrina/core";
import type { RuntimeTask } from "../model.js";
import type { PublishingAdmission } from "../delivery-admission.js";
import type { RepositoryContext, RepositoryWork } from "../repository-context.js";

export type DeliveryStage = NonNullable<RuntimeTask["plan"]>["stages"][number];
export type DeliveryRunResult = "continue" | "stop";
/** Queue admission re-reads the actual delivery order before a check may reuse its preparation. */
export type DeliveryCheckPreparation = (() => Promise<boolean>) & { beforeQueue(): boolean };

/** The same live admission owner used by the host's scheduler and native preparation. */
export interface DeliveryWorkflowAdmission {
  epoch(task: RuntimeTask): number;
  beforePublishing(scope: RepositoryContext, queuedCheck?: boolean): PublishingAdmission;
  invalidateUnpublishedPreparations(task: RuntimeTask): void;
  releaseDeliveryTurn(taskId: Id): void;
}

/** Native phases record their real observations on the supplied, bound execution before returning. */
export interface DeliveryPhaseEffects {
  restoredChecks(scope: RepositoryContext, signal: AbortSignal): Promise<{ kind: "passed" | "product-failed" | "blocked" }>;
  closedPullRequest(scope: RepositoryContext): Promise<NonNullable<RepositoryWork["pr"]>["state"] | undefined>;
  needGitHub(task: RuntimeTask): Promise<void>;
  readyToShip(scope: RepositoryContext, signal: AbortSignal): Promise<"ready" | "back">;
  head(scope: RepositoryContext): Promise<string>;
  patch(scope: RepositoryContext, ref?: string): Promise<string | undefined>;
  upToDate(scope: RepositoryContext, signal: AbortSignal): Promise<"current" | "moved" | "conflict">;
  checkOrder(taskId: Id): number | undefined;
  checksBeforeShipping(scope: RepositoryContext, signal: AbortSignal, preparation: DeliveryCheckPreparation): Promise<"passed" | "returned" | "blocked">;
  prepare(scope: RepositoryContext, stage: DeliveryStage, signal: AbortSignal): Promise<"ready" | DeliveryRunResult>;
  checkDelivery(scope: RepositoryContext, signal: AbortSignal): Promise<DeliveryRunResult>;
  proofApprovalCurrent(task: RuntimeTask, signal: AbortSignal, prepared?: boolean): Promise<boolean>;
  returnForDecision(task: RuntimeTask, why: "proof" | "acceptance"): Promise<void>;
  backToWork(scope: RepositoryContext): Promise<void>;
  publish(scope: RepositoryContext, signal: AbortSignal): Promise<"done" | "again">;
  prepareAgain(scope: RepositoryContext, why: string): Promise<"again">;
  clearUnpublishedVersion(scope: RepositoryContext): Promise<void>;
  finishCompanions(task: RuntimeTask): Promise<boolean>;
}

export interface DeliveryRecording {
  clearStep(scope: RepositoryContext): void;
  checksBlocked(task: RuntimeTask): void;
  productName(scope: RepositoryContext): string;
  defaultBranch(scope: RepositoryContext): string | undefined;
  findingId(task: RuntimeTask): Id;
  gate(task: RuntimeTask, problem: string): void;
  fail(taskId: Id, error: Error): void;
  changed(): void;
  noteScope(scope: RepositoryContext, tone: "warn", text: string): void;
  destination(scope: RepositoryContext): string;
  sourceName(scope: RepositoryContext): string;
  stopped(): boolean;
  now(): number;
  role(id: Id, task?: RuntimeTask): Role | undefined;
  taskDetails(id: Id): RuntimeWaitTask | undefined;
  hasDecision(taskId: Id, kinds: readonly InboxKind[]): boolean;
  raise(target: RuntimeTask | RepositoryContext, kind: "stuck" | "shipping", title: string, details?: { body: string }): void;
  log(task: RuntimeTask, tone: "done" | "warn", text: string): void;
  delivered(task: RuntimeTask): void;
  done(task: RuntimeTask): void;
  checkpoint(): void;
  schedule(): void;
}

export interface DeliveryFailures {
  aborted(): Error;
  waiting(reason: string): Error;
  prerequisiteRefresh(): Error;
  classify(error: unknown): { kind: "decision" | "refresh" | "other" } | { kind: "source-moved"; message: string };
}
