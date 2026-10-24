import type { Product, Role, TaskSource, WorkChoice } from "@petrina/core";
import type { RuntimeTask } from "../model.js";

/** Validated remote identity, independent of the GitHub CLI response shape. */
export interface SourcePullRequest {
  number: number;
  url: string;
  state: "open" | "closed" | "merged";
  branch: string;
  headRepo: string;
}

/** Source resolution performs read-only queries; rejections preserve unavailable/error evidence. */
export interface SourceQueries {
  validBranch(name: string): Promise<boolean>;
  requireBranch(repo: string, branch: string): Promise<void>;
  pullRequest(repo: string, number: number): Promise<SourcePullRequest>;
}

/** Proposal validation does not clone, publish, prepare a workspace or start an agent. */
export interface SourceSelectionEffects {
  resolve(task: RuntimeTask, choice: WorkChoice, candidate?: TaskSource["product"]): Promise<TaskSource>;
  repository(repo: string): Promise<{ repo: string; defaultBranch: string }>;
  isAbsoluteFolder(path: string): boolean;
}

/** Decisions stay task-bound; confirmation is checkpointed atomically by its caller. */
export interface SourceSelectionHost {
  products(): readonly Product[];
  role(id: string, task: RuntimeTask): Pick<Role, "result"> | undefined;
  profileExists(id: string): boolean;
  planCheck(taskId: string): { body?: string } | undefined;
  commitNow(task: RuntimeTask): void;
  recordChoice(task: RuntimeTask, text: string): void;
}
