import type { Id } from "@petrina/core";
import type { RuntimeTask } from "../model.js";
import type { RepositoryContext } from "../repository-context.js";

/** The accepted stage's actual role and version observations, never a freshness cache. */
export interface WorkCompletionInput {
  stageId: Id;
  canEdit: boolean;
  testedVersions?: Record<Id, string>;
}

/** Named existing effects, in their original order. Native version inspection stays with the host. */
export interface WorkCompletionHost {
  finishStep(scope: RepositoryContext): void;
  endStage(scope: RepositoryContext): void;
  rerun(task: RuntimeTask): boolean;
  invalidateAcceptance(scope: RepositoryContext, testedVersions?: Record<Id, string>): Promise<void>;
  checkpoint(): void;
  changed(): void;
}
