import { repositoryPublished } from "@petrina/core";
import { beginRepair } from "./repair.js";
import type { DeliveryReturnInput, DeliveryReturnRoute } from "./ports/delivery.js";
import type { RepairHost } from "./ports/repair.js";
import type { RepositoryContext } from "./repository-context.js";

/** Forget only temporary preparation. Recorded publication and its failures remain owned by delivery. */
export function clearDeliveryPreparation(scope: RepositoryContext): void {
  const { work: repository } = scope;
  if (repository.shipping) repository.shipping = { moves: 0, failures: repository.shipping.failures };
}

/** Apply a delivery send-back after the checkpoint recorded its note and ordinary stage transition. */
export function prepareDeliveryReturn(host: RepairHost, scope: RepositoryContext, input: DeliveryReturnInput): DeliveryReturnRoute {
  const { task } = scope;
  delete task.proofRefreshes;
  delete task.proofRefreshBlocked;
  delete task.approvedProofDecision;
  delete task.checkedProofDecision;
  delete task.approvedAcceptanceGap;
  delete task.acceptanceRun;
  delete task.proofRetestReason;
  // A new coordinator request authorizes another bounded attempt at acceptance fixes.
  if (!task.repositories) delete scope.work.acceptanceReturns;
  delete task.acceptanceBlocked;
  delete task.acceptanceUnverified;
  // The Guide keeper looks for what reviewers missed, only when they had passed it: if Important findings
  // were open (the rounds ran out), the reviewers had caught it, and nothing was missed.
  if (!task.findings.some((finding) => finding.status === "open" && finding.severity === "blocking")) task.miss = { note: input.note, at: input.now };
  clearDeliveryPreparation(scope);
  if (task.repositories) {
    for (const work of task.repositories) if (!repositoryPublished(work)) delete work.acceptanceReturns;
    const open = task.findings.filter((finding) => finding.status === "open" && finding.severity === "blocking");
    if (open.length) {
      const review = task.plan!.stages.findIndex((stage, index) => index > task.stageIndex && stage.kind === "review-chain");
      // A check problem raised before the review (at acceptance testing) returns there, then walks on through review.
      const back = review >= 0 && input.fromCheck > task.stageIndex && input.fromCheck < review ? input.fromCheck : review;
      if (!beginRepair(host, task, "review", back)) {
        task.stageIndex = input.fromCheck;
        return "decision";
      }
    } else {
      const products = task.repositories.filter((work) => !repositoryPublished(work)).map((work) => work.productId);
      const lead = task.leadProductId;
      if (lead && products.includes(lead)) products.splice(0, 0, ...products.splice(products.indexOf(lead), 1));
      if (!products.length) { task.stageIndex = input.fromCheck; return "decision"; }
      task.repair = { products, index: 0, returnStage: task.stageIndex + 1, kind: "review" };
      task.activeProductId = products[0]!;
      task.fixing = true;
    }
  }
  return "waiting";
}
