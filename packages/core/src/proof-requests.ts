import { DELIVERY_MODE_CATALOG } from "./delivery-modes.js";
import type { DeepMutable } from "./flow.js";
import type { Role, Task } from "./model.js";
import type { ProofDecision, ProofRequest } from "./task-model.js";

export const proofOwner = (
  task: Pick<Task, "plan">,
  roles: readonly Role[]
) => task.plan?.stages.find(stage => stage.kind === "do" && roles.find(role => role.id === stage.roleId)?.result === "checks");

export function sameVersions(a: Readonly<Record<string, string>> | undefined, b: Readonly<Record<string, string>> | undefined, ids: readonly string[] = Object.keys(a ?? {})): boolean {
  return ids.length > 0 && ids.every(id => !!a?.[id] && a[id] !== "unavailable" && a[id] === b?.[id]);
}

/** Only a readable, completed Tester record is proof. Agent prose and opinions never enter this rule. */
export function proofStatus(task: Pick<Task, "journey">, request: ProofRequest, versions: Readonly<Record<string, string>>): ProofRequest["status"] {
  if (!request.productIds.length || request.productIds.some(id => !versions[id] || versions[id] === "unavailable")) return "unverified";
  const proof = request.proof;
  if (!proof) return "pending";
  const step = task.journey?.find(step => step.kind === "agent" && step.id === proof.stepId && step.stageId === request.ownerStageId && step.endedAt !== undefined && (!step.end || step.end === "done"));
  const recorded = step?.agentResults?.some(report => report.roleId === step.roleId && sameVersions(report.versions, proof.versions, request.productIds));
  const answer = proof.checklist
    ? step?.acceptanceChecks?.find(check => check.text === request.checklistText)
    : step?.proofChecks?.find(check => check.id === request.id);
  if (!recorded || !answer || answer.result !== proof.result) return "stale";
  if (!answer.evidence?.trim() || proof.result === "blocked") return "unverified";
  if (!sameVersions(proof.versions, versions, request.productIds)) return "stale";
  return proof.result === "fail" ? "failed" : proof.checklist ? "already-current" : "proved";
}

export function refreshProofs(task: DeepMutable<Pick<Task, "proofRequests" | "journey">>, versions: Readonly<Record<string, string>>): void {
  for (const request of task.proofRequests ?? []) request.status = proofStatus(task, request, versions);
}

export const proofPassed = (request: ProofRequest) => request.status === "proved" || request.status === "already-current";
export const openProofs = (task: Pick<Task, "proofRequests">) => (task.proofRequests ?? []).filter(request => !proofPassed(request));

/** Do not retry an unavailable probe unchanged; failed acceptance retains its own repair limits. */
export function proofTestNeeded(task: Pick<Task, "proofRequests" | "proofRefreshes">, mainOnly = true): boolean {
  const open = openProofs(task);
  return open.some(request => request.status === "pending" || request.status === "stale") && (!mainOnly || (task.proofRefreshes ?? 0) < 2);
}

export function proofDecision(task: Pick<Task, "proofRequests" | "proofRefreshBlocked">, versions: Readonly<Record<string, string>>): ProofDecision {
  return {
    versions: { ...versions },
    statuses: Object.fromEntries((task.proofRequests ?? []).map(request => [
    request.id,
    request.status
  ])),
    ...(task.proofRefreshBlocked ? { refreshBlocked: true } : {})
  };
}

export function sameProofDecision(a: ProofDecision | undefined, b: ProofDecision): boolean {
  return !!a && a.refreshBlocked === b.refreshBlocked && Object.keys(a.versions).length === Object.keys(b.versions).length && sameVersions(
    a.versions,
    b.versions
  ) && Object.keys(a.statuses).length === Object.keys(b.statuses).length && Object.entries(a.statuses).every(([id, status]) => status === b.statuses[id]);
}

export function proofGap(task: Pick<Task, "proofRequests" | "repositories" | "repository" | "delivery" | "proofRefreshBlocked">): string | undefined {
  if (!task.proofRequests?.length) return;
  const release = (task.repositories ?? (task.repository ? [task.repository] : [task])).some(work => DELIVERY_MODE_CATALOG[work.delivery].createsVersionCommit) ? "Requested proof does not cover the release version Petrina will create" : undefined;
  const open = openProofs(task);
  const gap = open.some(request => request.status === "unverified") ? "Requested proof could not be verified"
    : open.some(request => request.status === "failed") ? "Requested proof failed"
    : open.some(request => request.status === "stale") ? "Requested proof is on an earlier version"
    : open.length ? "Requested proof is still pending"
    : task.proofRefreshBlocked ? "Final acceptance is on an earlier version after two refreshes from main" : undefined;
  return gap && release ? `${gap}. ${release}` : gap ?? release;
}

export function proofContext(requests: readonly ProofRequest[]): string {
  const versions = (values: Readonly<Record<string, string>>) => Object.entries(values).map(([id, version]) => `${id}: ${version}`).join(", ");
  const words = {
    pending: "Pending final acceptance testing",
    "already-current": "Already proved on this version",
    proved: "Proved on this version",
    failed: "Failed",
    unverified: "Could not be verified",
    stale: "Proof is on an earlier version"
  };
  return requests.map(request => `${request.id}: ${request.text}\nProducts: ${request.productIds.join(", ")}; requested by ${request.requestedBy.roleId} (${request.requestedBy.profileId}), round ${request.requestedBy.round}, place ${request.requestedBy.seat}, step ${request.requestedBy.stageId}; owner: final acceptance testing (${request.ownerStageId}).\nReason: ${request.reason}\nReviewed versions: ${versions(request.reviewedVersions)}\nStatus: ${words[request.status]}${request.proof ? `; Tester step ${request.proof.stepId}, versions ${versions(request.proof.versions)}${request.proof.evidence ? `; ${request.proof.evidence}` : ""}${request.proof.reason ? `; ${request.proof.reason}` : ""}` : ""}`).join("\n\n");
}
