import { proofOwner, proofStatus, sameVersions, type DeepMutable, type ProofRequest, type Task } from "@petrina/core";
import { addDeliveryCheck } from "./delivery-gate.js";
import type { RuntimeTask } from "./model.js";
import type { ReviewProofHost, ReviewProofProposal } from "./ports/review-proof.js";

export function checkProofRequests(k: Pick<ReviewProofHost, "role">, task: RuntimeTask, requests: readonly ReviewProofProposal[]): string | undefined {
  if (!requests.length) return;
  const owner = proofOwner(task as Task, task.plan!.stages.flatMap(stage => {
    const role = k.role(stage.roleId, task);
    return role ? [role] : [];
  }));
  if (!owner) return "This plan has no acceptance testing step. Do not return proofRequests; keep required verification with the coordinator.";
  const ids = (task.repositories ?? [task.repository!]).map(work => work.productId);
  for (const request of requests) {
    if (!request.text.trim() || !request.reason.trim()) return "Each proof request needs what must be proved and why.";
    if (!request.productIds.length || request.productIds.some(id => !ids.includes(id)) || new Set(request.productIds).size !== request.productIds.length) return `Assign every proof request to valid, distinct product ids: ${ids.join(", ")}.`;
    if (request.checklistText !== undefined && !task.brief?.acceptance.some(item => item.text === request.checklistText)) return "A proof request's checklistText must exactly match a saved acceptance item, or omit that optional link.";
  }
}

/** Called with the accepted seat result; identity is its position in this execution, never similar wording. */
export function recordReviewProofs(k: ReviewProofHost, task: RuntimeTask, stage: { readonly id: string }, requests: readonly ReviewProofProposal[], by: string, roleId: string, seat: string): void {
  const owner = task.plan?.stages.find(entry => entry.kind === "do" && k.role(entry.roleId, task)?.result === "checks");
  if (!owner || !requests.length) return;
  if (!addDeliveryCheck(k, task)) throw new Error("Required proof needs a delivery preparation step.");
  const round = task.rounds[stage.id] ?? 1;
  const hunt = task.hunt;
  if (!hunt || hunt.stageId !== stage.id) throw new Error("A proof request must belong to the current review execution.");
  const reviewId = hunt.id ??= k.id(task.id);
  for (const [index, item] of requests.entries()) {
    const source = `${reviewId}:${seat}:${index}`;
    if (task.proofRequests?.some(request => request.source === source)) continue;
    const request: DeepMutable<ProofRequest> = {
      ...item,
      id: k.id(task.id),
      source,
      requestedBy: {
      stageId: stage.id,
      round,
      seat,
      roleId,
      profileId: by,
      reviewId
    },
      reviewedVersions: { ...hunt.input?.trees },
      ownerStageId: owner.id,
      status: "pending"
    };
    // Only the latest saved checklist verdict, with its actual Tester record, can be reused.
    if (request.checklistText) {
      const step = task.journey?.findLast(step => step.stageId === owner.id && step.endedAt !== undefined && step.acceptanceChecks?.some(check => check.text === request.checklistText));
      const check = step?.acceptanceChecks?.find(check => check.text === request.checklistText);
      const versions = step?.agentResults?.findLast(report => k.role(report.roleId, task)?.result === "checks")?.versions;
      if (step && check?.result === "pass" && check.evidence && sameVersions(versions, request.reviewedVersions, request.productIds)) {
        request.status = "already-current";
        request.proof = { stepId: step.id, versions: versions!, result: "pass", evidence: check.evidence, checklist: true };
        request.status = proofStatus(task, request, request.reviewedVersions);
      }
    }
    task.proofRequests ??= [];
    task.proofRequests.push(request);
  }
}
