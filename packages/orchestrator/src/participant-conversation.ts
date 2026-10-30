import { designConversationScope } from "@petrina/core";
import { reviewerAt, type AgentProfile, type Role } from "@petrina/core";
import { repositoryView, type RepositoryContext } from "./repository-context.js";
import { reviewConversationScope } from "@petrina/core";

/** Shared by admission and turns. Native packets and base ancestry are checked before reopening. */
export function participantConversation(catalog: { readonly profiles: readonly AgentProfile[]; digest(serialized: string): string }, scope: RepositoryContext, role: Role, planned: AgentProfile, reviewerKey?: string) {
  const { task, work } = scope;
  const stage = task.plan?.stages[task.stageIndex];
  if (!stage || task.maintenance || work.conversation || task.screen) return;
  let prior;
  let requestedId = planned.id;
  let coordinator = false;
  if (stage.kind === "converge") {
    const side = task.sub === 0 && role.result === "brief" && role.id === stage.roleId ? "author"
      : task.sub === 1 && role.result === "objections" && role.id === (stage.reviewerRoleId ?? "design-reviewer") ? "reviewer" : undefined;
    if (!side) return;
    prior = task.designSessions?.[JSON.stringify([stage.id, side, work.productId])];
    requestedId = (side === "author" ? stage.profileIds : stage.reviewerProfileIds)?.[0] ?? planned.id;
    coordinator = (side === "author" ? stage.assignments : stage.reviewerAssignments)?.[0]?.by === "coordinator";
  } else if (stage.kind === "review-chain" && role.result === "findings") {
    const seat = reviewerKey ?? String(stage.profileIds.indexOf(planned.id));
    if (reviewerAt(stage, Number(seat)) !== role.id) return;
    prior = task.reviewSessions?.[stage.id]?.[seat];
    requestedId = stage.profileIds[Number(seat)] ?? planned.id;
    if (prior && prior.round > (task.rounds[stage.id] ?? 1)) return;
    coordinator = stage.assignments?.[Number(seat)]?.by === "coordinator";
    // Its saved conversation was dropped: the start says why, without one to return to.
    const dropped = task.reviewFreshReasons?.[stage.id]?.[seat];
    if (!prior && dropped) return { reason: dropped, coordinator };
  }
  if (!prior) return;
  const actual = catalog.profiles.find((profile) => profile.id === prior.profileId);
  let reason = prior.freshReason;
  if (!reason && prior.plannedProfileId !== requestedId) reason = "you changed who works on this seat";
  if (!reason && !catalog.profiles.some((profile) => profile.id === requestedId)) reason = "its planned profile is no longer offered";
  if (!reason && !actual) reason = "its saved profile is no longer offered";
  if (!reason && actual) {
    const expected = stage.kind === "converge" ? designConversationScope(repositoryView(scope), role, planned, actual, text => catalog.digest(text))
      : reviewConversationScope(repositoryView(scope), stage.id, reviewerKey ?? String(stage.profileIds.indexOf(planned.id)), role, planned, actual, text => catalog.digest(text));
    if (prior.scope !== expected) reason = "its role, profile, request or starting point changed";
  }
  return { prior, actual, reason, coordinator };
}

/** A late failure is retained until the fresh start, including across a slot wait or restart. */
export function discardParticipant(scope: RepositoryContext, role: Role, reason: string, reviewerKey?: string, status?: (text: string) => void): boolean {
  const { task, work } = scope;
  const stage = task.plan?.stages[task.stageIndex];
  const prior = stage?.kind === "converge"
    ? task.designSessions?.[JSON.stringify([stage.id, role.result === "brief" ? "author" : "reviewer", work.productId])]
    : stage?.kind === "review-chain" && reviewerKey !== undefined ? task.reviewSessions?.[stage.id]?.[reviewerKey] : undefined;
  if (!prior) return false;
  prior.freshReason = reason;
  const kind = role.result === "findings" ? "review conversation" : "conversation";
  status?.(`Could not go back to its own ${kind}: ${reason}. Choosing this seat again before sending instructions.`);
  return true;
}
