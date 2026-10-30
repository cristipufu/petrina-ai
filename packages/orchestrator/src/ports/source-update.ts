import type { Product, Role } from "@petrina/core";
import type { RuntimeTask } from "../model.js";
import type { RepositoryContext } from "../repository-context.js";
import type { LearningMergeResult } from "./learning-merge.js";

/** A fold uses one observation, including its bound single-use native write. */
export type SourceFoldObservation = ({ kind: "observed"; head: string; tree: string; parents: readonly string[] }
  | { kind: "unavailable" }) & { squash(fork: string, message: string): Promise<{ head: string; tree: string }> };
export type SourceMerge = { tree: string; conflicts: string[]; notes: string[] };
export type SourceFetch = { ok: true; sha: string } | { ok: false; error: string; risky?: string[]; timedOut?: boolean; missing?: boolean };
export type SourceVersion = { ref: string; sha: string };

/** Every operation is bound to the same execution's working copy; source reads use the product clone separately. */
export interface SourceUpdateRepository {
  observeFold(): Promise<SourceFoldObservation>;
  mergeBase(head: string, base: string, raw?: boolean): Promise<string | undefined>;
  contains(head: string, base: string, raw?: boolean): Promise<boolean>;
  isClean(): Promise<boolean>;
  mergeTree(onto: string, ref?: string): Promise<SourceMerge | undefined>;
  commitsSince(from: string, to: string): Promise<number>;
  treeOf(ref?: string): Promise<string | undefined>;
  moveTo(sha: string): Promise<void>;
  commitTree(tree: string, parent: string, message: string): Promise<string>;
  head(): Promise<string>;
  openOn(onto: string, tree: string): Promise<void>;
  patchId(from: string, ref: string): Promise<string | undefined>;
}
export interface SourceUpdateEffects {
  repository(worktree: string): SourceUpdateRepository;
  sourceRef(productPath: string, ref: string): Promise<string | undefined>;
  sourceContains(productPath: string, head: string, base: string): Promise<boolean>;
  fetchDefault(scope: RepositoryContext, signal: AbortSignal): Promise<SourceFetch>;
  fetchSource(scope: RepositoryContext, signal: AbortSignal): Promise<SourceVersion>;
  keptLearnings(
    scope: RepositoryContext,
    fork: string,
    onto: string,
    merged: {
    tree: string;
    conflicts: readonly string[]
  },
    ref: string
  ): Promise<LearningMergeResult | undefined>;
}
export interface SourceUpdateHost {
  role(id: string, task: RuntimeTask): Role | undefined;
  repositoryOf(scope: RepositoryContext): Pick<Product, "path" | "name" | "repo" | "remote" | "remoteRefused" | "defaultBranch"> | undefined;
  productName(scope: RepositoryContext): string | undefined;
  describe(roleId: string, profileId: string): string;
  rememberVersion(scope: RepositoryContext, version?: { head: string; tree: string }): Promise<void>;
  fetchFailure(scope: RepositoryContext, failure: Extract<SourceFetch, { ok: false }>): string;
  checkpoint(): void;
  changed(): void;
  note(scope: RepositoryContext, tone: "warn" | "done" | "status", text: string): void;
  now(): number;
}
