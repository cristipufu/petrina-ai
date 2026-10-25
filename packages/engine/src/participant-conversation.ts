import { participantConversation as selectParticipant } from "@petrina/orchestrator";
import type { AgentProfile, Role } from "@petrina/core";
import type { RepositoryContext } from "@petrina/orchestrator";
import type { Kernel } from "./kernel.js";
import { createHash } from "node:crypto";
import { designConversationScope as projectDesignScope, type Task } from "@petrina/core";
export const conversationDigest = (serialized: string) => createHash("sha256").update(serialized).digest("hex");
export const designDigest = (value: unknown) => conversationDigest(JSON.stringify(value));
export function designConversationScope(task: Task, role: unknown, planned: unknown, actual: unknown): string {
  return projectDesignScope(task, role, planned, actual, conversationDigest);
}
export { discardParticipant } from "@petrina/orchestrator";

/** Host catalog binding; selection does not read packets or Git. */
export function participantConversation(k: Pick<Kernel, "s">, scope: RepositoryContext, role: Role, planned: AgentProfile, reviewerKey?: string) {
  return selectParticipant({ profiles: k.s.profiles, digest: text => conversationDigest(text) }, scope, role, planned, reviewerKey);
}
export class ParticipantUnavailable extends Error {}
