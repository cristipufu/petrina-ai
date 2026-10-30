import type { DeepMutable, Id, Stage } from "@petrina/core";
import type { RuntimeTask } from "../model.js";
import type { RepositoryContext } from "../repository-context.js";
import type { CheckVerification } from "./check-evidence.js";
import type { PendingVerification } from "./verifiers.js";

export type ReviewStage = DeepMutable<Stage>;
export type ReviewPlace = { key: string; profileId: Id };
export type PreparedReviewInput = NonNullable<NonNullable<RuntimeTask["hunt"]>["input"]>;

export interface ReviewWorkflowHost {
  now(): number;
  id(task: RuntimeTask): Id;
  checkpoint(task: RuntimeTask): void;
  changed(task: RuntimeTask): void;
  finishStep(task: RuntimeTask): void;
  clearStep(task: RuntimeTask): void;
  rerun(task: RuntimeTask): void;
}

/** Native observations and actual participant/round owners; supplied inputs do not claim native execution. */
export interface ReviewWorkflowEffects {
  prepareChecks(scope: RepositoryContext, signal: AbortSignal): Promise<boolean>;
  checks(scope: RepositoryContext, signal: AbortSignal): Promise<Pick<CheckVerification, "kind" | "productId">>;
  preparationChanged(error: unknown): boolean;
  backToBuilder(scope: RepositoryContext, eligibleProducts: ReadonlySet<Id>): boolean;
  blocked(task: RuntimeTask): "stop";
  versions(task: RuntimeTask): Promise<Record<Id, string>>;
  input(scope: RepositoryContext, signal: AbortSignal): Promise<PreparedReviewInput>;
  pendingReviewers(task: RuntimeTask, stage: ReviewStage): ReviewPlace[];
  hunt(task: RuntimeTask, stage: ReviewStage, reviewers: ReviewPlace[], signal: AbortSignal): Promise<void>;
  pendingVote(task: RuntimeTask, stage: ReviewStage): PendingVerification | undefined;
  vote(task: RuntimeTask, pending: PendingVerification, signal: AbortSignal): Promise<void>;
  finishBallot(task: RuntimeTask, pending: PendingVerification): string;
  closeRound(task: RuntimeTask, stage: ReviewStage, round: number, outcome: string, versions?: Readonly<Record<Id, string>>): Promise<"continue" | "stop">;
}
