import type { Id, Product } from "@petrina/core";
import type { RuntimeTask } from "../model.js";
import type { RepositoryContext } from "../repository-context.js";
import type { GitHubPullRequestInfo, GitHubService } from "./github.js";
import type { DeliveryEvidence, DeliveryLookup } from "./delivery-recovery.js";

export interface DeliveryRecorder {
  recordDelivery(scope: RepositoryContext, evidence: DeliveryEvidence, signal: AbortSignal): Promise<"done" | "unknown">;
  finishMany(task: RuntimeTask): void;
}

export interface DeliveryMonitorHost {
  task(id: Id): RuntimeTask | undefined;
  tasks(): RuntimeTask[];
  stopped(): boolean;
  hasDriver(id: Id): boolean;
  hasSettling(id: Id): boolean;
  now(): number;
  log(target: RuntimeTask | RepositoryContext, tone: "status" | "done" | "warn", text: string): void;
  commitNow(): void;
  commit(): void;
  tidy(id: Id): void;
  trackWork(operation: Promise<void>): Promise<void>;
  repository(target: RuntimeTask | RepositoryContext): Pick<Product, "repo" | "defaultBranch"> | undefined;
  done(task: RuntimeTask): void;
  prSettled(task: RuntimeTask, state: "merged" | "closed"): void;
  schedule(): void;
}

export interface DeliveryMonitorEffects extends Pick<GitHubService, "pullRequests" | "prState" | "prStates"> {
  lookForDelivery(scope: RepositoryContext): Promise<DeliveryLookup>;
  releaseRefs(scope: RepositoryContext): Promise<{ main?: string; tag?: string }>;
  matchesPullRequest(scope: RepositoryContext, pr: GitHubPullRequestInfo, tested: string, base: string): Promise<boolean>;
  unreachable(error: unknown): boolean;
}
