import { executionFor, scopesFor } from "./repository-context.js";
import { assignedProducts, repairOrder, repositoryPublished, type Task } from "@petrina/core";
import * as git from "./git.js";
import type { Kernel, MTask } from "./kernel.js";

export async function versionsOf(task: MTask): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(scopesFor(task).map(async ({ work }) =>
    [work.productId, work.worktree ? await git.treeOf(work.worktree) ?? "unavailable" : "unavailable"])));
}

export async function acceptanceVersion(task: MTask, versions?: Record<string, string>): Promise<string | undefined> {
  if (!task.repositories) return undefined;
  return JSON.stringify(versions ?? await versionsOf(task));
}

/** A pass visits only named owners. Each owner's applicable allowance is charged once before work starts. */
export function beginRepair(k: Pick<Kernel, "role" | "commitNow">, task: MTask, kind: "checks" | "acceptance" | "review", returnStage: number): boolean {
  if (!task.repositories) return false;

  const open = task.findings.filter((finding) => finding.status === "open" && finding.severity === "blocking");
  const affected = repairOrder(task as Task, open.filter((finding) => kind === "checks" ? finding.raisedBy === "petrina" : kind === "acceptance" ? finding.text.startsWith("Failed acceptance check:") : true));
  const field = kind === "checks" ? "checkReturns" : kind === "acceptance" ? "acceptanceReturns" : undefined;
  // An unavailable owner keeps its findings for the coordinator, without consuming another owner's tries.
  const products = affected.filter((id) => {
    const work = task.repositories!.find((entry) => entry.productId === id)!;
    return !repositoryPublished(work) && (!field || (work[field] ?? 0) < 2);
  });
  if (!products.length) return false;
  const builder = task.plan?.stages.findIndex((stage) => stage.kind === "do" && k.role(stage.roleId, task)?.result === "build") ?? -1;
  if (builder < 0) return false;
  for (const id of products) {
    const work = task.repositories.find((entry) => entry.productId === id)!;
    if (field) work[field] = (work[field] ?? 0) + 1;
  }
  task.repair = { products, index: 0, returnStage, kind };
  task.activeProductId = products[0]!;
  task.stageIndex = builder;
  task.sub = 0;
  task.fixing = true;
  delete executionFor(task, products[0]!).work.conversation;
  k.commitNow();
  return true;
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
