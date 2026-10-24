import { scopesFor } from "@petrina/orchestrator";
import { assignedProducts, type Task } from "@petrina/core";
import * as git from "./git.js";
import type { MTask } from "./kernel.js";

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
  for (const work of task.repositories) if (work.checks) work.checks.current = work.checks.tree === current[work.productId];
  if (!task.brief) return current;
  let changed = false;
  for (const item of task.brief.acceptance) {
    if (item.verification !== "passed" || !item.versions) continue;
    if (Object.entries(item.versions).some(([id, version]) => current[id] !== version)) {
      delete item.met;
      item.verification = "stale";
      item.reason = "An affected product changed after this acceptance check. Combined verification is required again.";
      changed = true;
    }
  }
  if (changed) task.acceptancePassed = false;
  return current;
}

export function designWorkKey(task: MTask, stageId: string): string {
  return `${stageId}:author:${task.rounds[stageId] ?? 1}:${task.designRevision ?? 0}`;
}
