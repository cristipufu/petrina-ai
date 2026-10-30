import type { DeepMutable, Id, InboxItem, Product, RuntimeWaitTask } from "@petrina/core";
import type { RuntimeTask } from "../model.js";
import type { RepositoryContext } from "../repository-context.js";
import type { GitHubCreated } from "./github.js";

/** Verified adapter observations, never an instruction to complete a task. */
export type DeliveryEvidence =
  | { kind: "pr"; pr: { number: number; url: string; state: "open" | "merged" | "closed" }; updated?: boolean }
  | { kind: "release"; release: { tag: string; url: string } }
  | { kind: "local"; branch: string; tested: string };
export type DeliveryLookup = { found: true; text: string; evidence: DeliveryEvidence } | { found: false | "unknown" | "other"; text: string };

export interface DeliveryRecoveryHost {
  readonly state: { tasks: RuntimeTask[]; inbox: DeepMutable<InboxItem>[] };
  readonly boot: string;
  now(): number;
  task(id: Id): RuntimeTask | undefined;
  repository(target: RuntimeTask | RepositoryContext): Pick<Product, "defaultBranch"> | undefined;
  taskDetails(id: Id): RuntimeWaitTask | undefined;
  log(target: RuntimeTask | RepositoryContext, tone: "status" | "done" | "warn" | "you", text: string): void;
  raise(target: RuntimeTask | RepositoryContext, kind: "shipping", title: string, blocking: false, extra: { body: string }): void;
  commit(): void;
  commitNow(): void;
  delivered(target: RuntimeTask | RepositoryContext): void;
  done(task: RuntimeTask): void;
  takeItem(id: Id): DeepMutable<InboxItem> | undefined;
  toWaiting(task: RuntimeTask): void;
  clearStep(task: RuntimeTask): void;
  schedule(): void;
  tidy(id: Id): void;
}

export interface DeliveryRecoveryEffects {
  lookForDelivery(scope: RepositoryContext): Promise<DeliveryLookup>;
  noteCancelledLocal(scope: RepositoryContext): Promise<boolean | "unknown">;
  landLocal(scope: RepositoryContext, signal: AbortSignal, tested: string, how: "found"): Promise<"done">;
  rememberDelivery(scope: RepositoryContext, sha: string, branch: string): Promise<void>;
  clearApproval(scope: RepositoryContext): void;
  finishMany(task: RuntimeTask): void;
  checkUnrecordedPullRequest(scope: RepositoryContext): Promise<void>;
}

export interface DeliveryRecoveryFailures {
  aborted(): Error;
  unreachable(text: string): Error;
}

/** A saved native creation step and fresh observations of its outcome. */
export interface PullRequestCreationEffects {
  create(): Promise<GitHubCreated>;
  find(): Promise<Extract<DeliveryEvidence, { kind: "pr" }>["pr"] | undefined>;
}
export interface ReleaseCreationEffects {
  create(): Promise<GitHubCreated>;
  find(): Promise<{ tag: string; url: string } | undefined>;
  tag(): Promise<string | undefined>;
}
