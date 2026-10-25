import type { Id, Role } from "@petrina/core";
import type { RuntimeTask } from "../model.js";
import type { RepositoryContext } from "../repository-context.js";
import type { RepairHost } from "./repair.js";

export interface ReviewRoundAnchor { head?: string; tree?: string }

/** Task-bound round observations and recording. Native Git/input caches/checkpoints stay in the adapter. */
export interface ReviewRoundCompletionHost extends RepairHost {
  roles(): readonly Role[];
  incrementalReview(roleId: Id): boolean | undefined;
  ownChanges(task: RuntimeTask): Promise<Record<Id, string>>;
  anchor(scope: RepositoryContext, observation: { incremental: boolean; passed: boolean }): Promise<ReviewRoundAnchor>;
  reviewEnd(task: RuntimeTask, round: number, result: "sent-back" | "rounds-used" | "passed"): void;
  releaseInput(task: RuntimeTask): void;
  note(task: RuntimeTask, tone: "warn" | "done", text: string): void;
  changed(task: RuntimeTask): void;
  openDeliveryDecision(task: RuntimeTask): void;
  now(): number;
}
