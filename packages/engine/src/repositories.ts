import { observeCommittedCode, scopesFor } from "@petrina/orchestrator";
import { applyAcceptanceVersions, assignedProducts, type Task } from "@petrina/core";
import * as git from "@petrina/repositories/git";
import type { MTask } from "./kernel.js";
import { repositoryObservationQueries } from "@petrina/repositories/observations";

export function committedCodeOf(task: MTask) {
  return observeCommittedCode(task, repositoryObservationQueries);
}

export async function versionsOf(task: MTask): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(scopesFor(task).map(async ({ work }) =>
    [work.productId, work.worktree ? await git.treeOf(work.worktree) ?? "unavailable" : "unavailable"])));
}

/** Unlike full trees, these identities exclude incoming main changes. */
export async function changesOf(task: MTask): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(scopesFor(task).map(async ({ work }) => [work.productId,
    work.worktree && work.baseSha ? (await git.patchId(work.worktree, work.baseSha, await git.head(work.worktree))) ?? "unavailable" : "unavailable"])));
}

export async function acceptanceVersion(task: MTask, versions?: Record<string, string>): Promise<string | undefined> {
  if (!task.repositories) return undefined;
  return JSON.stringify(versions ?? await versionsOf(task));
}

export function productsFor(task: MTask, ids: readonly string[] | undefined): string[] {
  return assignedProducts(task as Task, ids);
}

/** Acceptance evidence belongs to all versions explicitly named by that item. */
export async function invalidateAcceptance(task: MTask, versions?: Record<string, string>): Promise<Record<string, string> | undefined> {
  if (!task.repositories) return;
  const current = versions ?? await versionsOf(task);
  applyAcceptanceVersions(task, current);
  return current;
}

export function designWorkKey(task: MTask, stageId: string): string {
  return `${stageId}:author:${task.rounds[stageId] ?? 1}:${task.designRevision ?? 0}`;
}
