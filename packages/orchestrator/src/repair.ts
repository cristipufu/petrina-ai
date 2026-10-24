import { exhaustedAcceptanceFailure, repairOrder, repositoryPublished, type Task } from "@petrina/core";
import { executionFor } from "./repository-context.js";
import type { RuntimeTask } from "./model.js";
import type { RepairHost } from "./ports/repair.js";

/**
 * A pass visits only named owners. Each owner's applicable allowance is charged once before work starts. Findings a
 * decision to continue still `covered` name no owner. `final`: an acceptance repair of testing the delivery check started,
 * which returns to that final testing and then the check.
 */
export function beginRepair(k: RepairHost, task: RuntimeTask, kind: "checks" | "acceptance" | "review", returnStage: number, { covered = new Set<string>(), final = false }: { covered?: ReadonlySet<string>; final?: boolean } = {}): boolean {
  if (!task.repositories) return false;

  const open = task.findings.filter((finding) => finding.status === "open" && finding.severity === "blocking" && !covered.has(finding.id));
  // A check repair visits only products whose checks fail: their episode, and its allowance, stay open until a
  // genuine pass. Petrina's other findings, such as a deleted test, go through review with everything else.
  // Acceptance failures whose returns are used up wait for the coordinator: they send no product back.
  const affected = repairOrder(task as Task, open.filter((finding) => kind === "checks" ? finding.raisedBy === "petrina" && finding.text.startsWith("Check failed") : kind === "acceptance" ? finding.text.startsWith("Failed acceptance check:") : !exhaustedAcceptanceFailure(task as Task, finding)));
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
  task.repair = { products, index: 0, returnStage, kind, ...(kind === "acceptance" && final ? { final: true as const } : {}) };
  task.activeProductId = products[0]!;
  task.stageIndex = builder;
  task.sub = 0;
  task.fixing = true;
  delete executionFor(task, products[0]!).work.conversation;
  k.commitNow(task);
  return true;
}
