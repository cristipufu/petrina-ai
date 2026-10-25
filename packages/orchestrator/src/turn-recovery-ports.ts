import type { AgentProfile, DeepMutable, Id, ReadinessRecheck, Role } from "@petrina/core";
import type { RuntimeTask } from "./model.js";
import type { RepositoryContext } from "./repository-context.js";
import type { ProfileSelectionResult } from "./profile-selection.js";
import type { AgentAdmissionCatalog, AgentAdmissionReadiness } from "./ports/agent-workflow.js";

/** Native adapters classify refusals; these structural facts retain the same original Error object. */
export interface CapacityRefusal extends Error {
  readonly toolId: string;
  readonly modelId: string;
  readonly profileId: string;
  readonly sessionId?: string;
  said?: string;
  streamed?: boolean;
  retryAfterMs?: number;
}
export interface UsageRefusal extends Error {
  readonly toolId: string;
  readonly until: number;
  readonly reason: string;
  readonly model?: string;
  readonly retry?: boolean;
  readonly source: "report" | "refusal";
  said?: string;
  streamed?: boolean;
  independent?: true;
}
export interface TurnRecoveryErrors {
  capacity(error: unknown): error is CapacityRefusal;
  usage(error: unknown): error is UsageRefusal;
  waiting(words: string): Error;
  usageWait(words: string): Error;
  capacityWait(words: string): Error;
  aborted(): Error;
  sourceRefresh(): Error;
  screenWait(): Error;
}
export interface CapacityRecoveryHost {
  profile(id: Id): AgentProfile | undefined;
  now(): number;
  record(task: RuntimeTask, roleId: Id, profileId: Id, error: CapacityRefusal, waitMs: number): void;
  words(until: number, now: number): string;
}
export interface TurnRecoveryHost {
  now(): number;
  catalog: Pick<AgentAdmissionCatalog, "profile" | "role"> & {
    choose(request: { profileId: Id; roleId: Id; reviewerKey?: string }, scope: RepositoryContext, room?: (toolId: Id, profile: AgentProfile) => boolean): ProfileSelectionResult | undefined;
  };
  readiness: Pick<AgentAdmissionReadiness, "hold" | "resolveHeld" | "resolve">;
  admissionsClosed(task: RuntimeTask): boolean;
  admissionWait(task: RuntimeTask): string;
  sourceRefreshDue(task: RuntimeTask): boolean;
  /** Exact native/main-seat room observation when the caller supplied no member room callback. */
  slotWait(task: RuntimeTask, profile: AgentProfile, toolId: Id): string | undefined;
  toolName(toolId: Id): string;
  attempt(scope: RepositoryContext, roleId: Id, plannedId: Id, profile: AgentProfile, retry: boolean): void;
  owesRetry(scope: RepositoryContext, roleId: Id, plannedId: Id): void;
  keepWords(scope: RepositoryContext, roleId: Id, profileId: Id, reviewerKey: string | undefined, error: { said?: string; streamed?: boolean }): void;
  waitForUsage(task: RuntimeTask, words: string): void;
  recordLimit(task: RuntimeTask, roleId: Id, profileId: Id, error: UsageRefusal): void;
  waitForScreen(task: RuntimeTask): void;
  discardUnavailable(scope: RepositoryContext, roleId: Id, error: unknown, reviewerKey?: string): boolean;
  beforeMainAttempt(scope: RepositoryContext, roleId: Id, profile: AgentProfile): void;
  showReviewWork(task: RuntimeTask): void;
  checkpoint(scope: RepositoryContext): void;
}
export interface RecoveryRequest {
  scope: RepositoryContext;
  roleId: Id;
  plannedId: Id;
  signal: AbortSignal;
  room?: (toolId: Id, profile: AgentProfile) => boolean;
  reviewerKey?: string;
  member?: string;
  used?: (profileId: Id) => void;
}
export interface MainRecoveryRequest<T> extends RecoveryRequest {
  attempt(profile: AgentProfile, choice: Exclude<ProfileSelectionResult, { kind: "none" }>): Promise<T>;
}
export interface MemberRecoveryRequest<T> extends RecoveryRequest {
  /** The native post-choice method call keeps its original owner; selection still gets the raw room callback. */
  roomCheck: (toolId: Id, profile: AgentProfile) => boolean;
  key?: string;
  seat?: Id;
  selectionReason?: string;
  freshReason?: string;
  readiness?: ReadinessRecheck;
  refresh?: boolean;
  attempt(role: DeepMutable<Role>, profile: AgentProfile, selected: {
    key: string; refresh: boolean; plannedId: Id;
    selectionReason?: string; freshReason?: string; readiness?: ReadinessRecheck;
    took?: { profileId: Id; at: number; refusal?: string };
  }): Promise<T>;
}
