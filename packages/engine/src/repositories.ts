import { observeCommittedCode, scopesFor } from "@petrina/orchestrator";
import { applyAcceptanceVersions, assignedProducts, completeAll, type Task } from "@petrina/core";
import * as git from "@petrina/repositories/git";
import type { RuntimeTask } from "./kernel.js";
import { repositoryObservationQueries } from "@petrina/repositories/observations";

export async function committedCodeOf(task: RuntimeTask) {
  const heads: Record<string, string> = {};
  const code = await observeCommittedCode(task, {
    bind(scope) {
      const reader = repositoryObservationQueries.bind(scope);
      if (!reader) return undefined;
      return {
        async committed() {
          const version = await reader.committed();
          if (version) heads[scope.work.productId] = version.head;
          return version;
        },
        change: (base, head) => reader.change(base, head),
      };
    },
  });
  Object.defineProperty(code, "heads", { value: heads, enumerable: false });
  return code;
}

export async function versionsOf(task: RuntimeTask): Promise<Record<string, string>> {
  return Object.fromEntries(await completeAll(scopesFor(task).map(async ({ work }) =>
    [work.productId, work.worktree ? await git.treeOf(work.worktree) ?? "unavailable" : "unavailable"])));
}

/** Unlike full trees, these identities exclude incoming main changes. */
export async function changesOf(task: RuntimeTask): Promise<Record<string, string>> {
  return Object.fromEntries(await completeAll(scopesFor(task).map(async ({ work }) => [work.productId,
    work.worktree && work.baseSha ? (await git.patchId(work.worktree, work.baseSha, "HEAD")) ?? "unavailable" : "unavailable"])));
}

export async function acceptanceVersion(task: RuntimeTask, versions?: Record<string, string>): Promise<string | undefined> {
  if (!task.repositories) return undefined;
  return JSON.stringify(versions ?? await versionsOf(task));
}

export function productsFor(task: RuntimeTask, ids: readonly string[] | undefined): string[] {
  return assignedProducts(task as Task, ids);
}

/** Acceptance evidence belongs to all versions explicitly named by that item. */
export async function invalidateAcceptance(task: RuntimeTask, versions?: Record<string, string>): Promise<Record<string, string> | undefined> {
  if (!task.repositories) return;
  const current = versions ?? await versionsOf(task);
  applyAcceptanceVersions(task, current);
  return current;
}

export function designWorkKey(task: RuntimeTask, stageId: string): string {
  return `${stageId}:author:${task.rounds[stageId] ?? 1}:${task.designRevision ?? 0}`;
}
