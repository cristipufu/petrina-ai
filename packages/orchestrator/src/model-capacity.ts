import { untilWords, type AgentProfile, type Id } from "@petrina/core";
import type { RuntimeTask } from "./model.js";
import type { RepositoryContext } from "./repository-context.js";
import type { CapacityRecoveryHost, CapacityRefusal } from "./turn-recovery-ports.js";

export const MODEL_CAPACITY_WAIT_MS = 5 * 60_000;
export const CAPACITY_RETRY_DELAYS_MS = [5_000, 10_000, 30_000] as const;
export function capacityRetryDelay(tried: number, providerMs?: number): number | undefined {
  const slot = CAPACITY_RETRY_DELAYS_MS[tried];
  if (slot === undefined) return undefined;
  return Math.max(slot, providerMs ?? 0);
}
/** The native composition supplies its public refusal prefix without duplicating it here. */
export function capacityWaitingWords(until: number, now: number, prefix: string): string {
  return `${prefix}. Trying again after ${untilWords(until, now)}`;
}
export function sameCapacityModel(error: Pick<CapacityRefusal, "toolId" | "modelId">, profile: Pick<AgentProfile, "toolId" | "model" | "modelId">): boolean {
  return error.toolId === profile.toolId && error.modelId === (profile.modelId ?? profile.model);
}
/** Task-local model exclusion only: account usage is neither supplied nor changed. */
export function recordModelCapacity(task: RuntimeTask, profileId: Id, error: Pick<CapacityRefusal, "toolId" | "modelId">, waitMs: number, now: number): void {
  const until = now + waitMs;
  const next = { toolId: error.toolId, modelId: error.modelId, profileId, until };
  const kept = (task.modelCapacity ?? []).filter((entry) => entry.until > now && !(entry.toolId === next.toolId && entry.modelId === next.modelId));
  task.modelCapacity = [...kept, next];
}
export function expireModelCapacity(task: RuntimeTask, now: number): boolean {
  let changed = false;
  if (task.modelCapacity?.length) {
    const kept = task.modelCapacity.filter((entry) => entry.until > now);
    if (kept.length !== task.modelCapacity.length) {
      changed = true;
      if (kept.length) task.modelCapacity = kept;
      else delete task.modelCapacity;
    }
  }
  if (!task.capacityPaused?.length) return changed;
  const active = new Set((task.modelCapacity ?? []).map((entry) => `${entry.toolId}\0${entry.modelId}`));
  const paused = task.capacityPaused.filter((entry) => active.has(`${entry.toolId}\0${entry.modelId}`));
  if (paused.length === task.capacityPaused.length) return changed;
  if (paused.length) task.capacityPaused = paused;
  else delete task.capacityPaused;
  return true;
}

/** The actual retry/resume mutations shared by main and parallel turns. */
export class ModelCapacity {
  constructor(private readonly host: CapacityRecoveryHost) {}
  defer(scope: RepositoryContext, roleId: Id, profileId: Id, error: CapacityRefusal, plannedId: Id, member?: string): boolean {
    const { task } = scope;
    const sameRetry = (entry: { roleId: Id; profileId: Id; member?: string }) => entry.roleId === roleId && entry.profileId === profileId && entry.member === member;
    const tried = task.capacityRetries?.find(sameRetry)?.tried ?? 0;
    const delay = capacityRetryDelay(tried, error.retryAfterMs);
    if (delay !== undefined) {
      const next = { toolId: error.toolId, modelId: error.modelId, profileId, roleId, tried: tried + 1, ...(member ? { member } : {}) };
      task.capacityRetries = [...(task.capacityRetries ?? []).filter((entry) => !sameRetry(entry)), next];
      const pause = { toolId: error.toolId, modelId: error.modelId, profileId, roleId, plannedId, ...(member ? { member } : {}) };
      task.capacityPaused = [...(task.capacityPaused ?? []).filter((entry) => !sameRetry(entry)), pause];
      this.host.record(task, roleId, profileId, error, delay);
      this.prepare(scope, roleId, profileId, error, member);
      return true;
    }
    const paused = (task.capacityPaused ?? []).filter((entry) => !sameRetry(entry));
    if (paused.length) task.capacityPaused = paused;
    else delete task.capacityPaused;
    this.host.record(task, roleId, profileId, error, Math.max(MODEL_CAPACITY_WAIT_MS, error.retryAfterMs ?? 0));
    return false;
  }
  prepare(scope: RepositoryContext, roleId: Id, profileId: Id, error: CapacityRefusal, member?: string): void {
    const { task, work: repository } = scope;
    const profile = this.host.profile(profileId);
    const note = repository.conversation;
    const model = profile?.modelId ?? profile?.model;
    if (note && profile && note.roleId === roleId && note.profileId === profileId && note.toolId === profile.toolId && note.model === model) note.capacityContinue = true;
    if (error.sessionId && profile && model) {
      const next = { sessionId: error.sessionId, profileId, roleId, toolId: profile.toolId, model, ...(member ? { member } : {}) };
      const others = (task.capacityResume ?? []).filter((entry) => !(entry.roleId === roleId && entry.profileId === profileId && entry.member === member));
      task.capacityResume = [...others, next];
    }
  }
  forget(task: { capacityResume?: { sessionId: string; profileId: Id; roleId: Id; toolId: Id; model: string; member?: string }[] }, match: (entry: { sessionId: string; profileId: Id; roleId: Id; member?: string }) => boolean): void {
    const kept = (task.capacityResume ?? []).filter((entry) => !match(entry));
    if (kept.length) task.capacityResume = kept;
    else delete task.capacityResume;
  }
  words(scope: RepositoryContext, profileId: Id): string {
    const { task } = scope;
    const profile = this.host.profile(profileId);
    const model = profile?.modelId ?? profile?.model;
    const until = task.modelCapacity?.find((entry) => entry.until > this.host.now() && entry.toolId === profile?.toolId && entry.modelId === model)?.until ?? this.host.now() + MODEL_CAPACITY_WAIT_MS;
    return this.host.words(until, this.host.now());
  }
}
