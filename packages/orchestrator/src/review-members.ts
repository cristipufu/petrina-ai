import { portReviewerIndex, reviewerAt, type AgentProfile, type Id, type Role, type Stage } from "@petrina/core";
import type { RuntimeTask } from "./model.js";
import { executionFor, repositoryView } from "./repository-context.js";
import type { ParticipantRequest } from "./ports/agent-workflow.js";

export interface ReviewMemberCatalog {
  roles(): readonly Role[];
  profile(id: Id): AgentProfile | undefined;
  pendingVoter(task: RuntimeTask, stage: Stage): Id | undefined;
}

/** Exact planned/remaining places shared by driver selection and the native review adapter. */
export function plannedReviewPlaces(task: RuntimeTask, stage: Stage, catalog: Pick<ReviewMemberCatalog, "roles" | "profile">): {
  key: string;
  profileId: Id
}[] {
  const scope = executionFor(task);
  const planned = stage.profileIds.map((profileId, index) => ({ key: String(index), profileId }));
  return scope.work.portReview ? [planned[portReviewerIndex(
    repositoryView(scope),
    stage.profileIds,
    id => catalog.profile(id)?.toolId,
    catalog.roles()
  )]!] : planned;
}
export function pendingReviewPlaces(task: RuntimeTask, stage: Stage, catalog: Pick<ReviewMemberCatalog, "roles" | "profile">): {
  key: string;
  profileId: Id
}[] {
  const scope = executionFor(task);
  const reported = task.hunt?.stageId === stage.id && task.hunt.round === (task.rounds[stage.id] ?? 1) ? task.hunt.reported : {};
  if (scope.work.portReview && Object.keys(reported).length) return [];
  return plannedReviewPlaces(task, stage, catalog).filter(entry => !reported[entry.key]);
}
export function nextReviewPlace(task: RuntimeTask, stage: Stage, catalog: ReviewMemberCatalog): ParticipantRequest | undefined {
  const reviewer = pendingReviewPlaces(task, stage, catalog)[0];
  if (reviewer) return { roleId: reviewerAt(stage, Number(reviewer.key)), profileId: reviewer.profileId, reviewerKey: reviewer.key };
  const voter = catalog.pendingVoter(task, stage);
  const votesRoleId = catalog.roles().find((role) => !role.removed && role.result === "votes")?.id ?? "verifier";
  return voter ? { roleId: votesRoleId, profileId: voter, requiredToolId: catalog.profile(voter)?.toolId } : undefined;
}
export function rememberReviewProfile(task: RuntimeTask, key: string, profileId: Id): void {
  task.hunt = { ...task.hunt!, profiles: { ...task.hunt!.profiles, [key]: profileId } };
}
