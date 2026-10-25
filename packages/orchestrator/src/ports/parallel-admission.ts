import type { ActiveAgent, AgentProfile, Id, ReadinessRecheck } from "@petrina/core";
import type { RuntimeTask } from "../model.js";
import type { RepositoryContext } from "../repository-context.js";
import type { AgentAdmissionCatalog, AgentAdmissionErrors, AgentAdmissionReadiness, AgentOwnership, AgentWorkflowState } from "./agent-workflow.js";
import type { State } from "@petrina/core";

export interface ParallelSeatSelection { selectionReason?: string; freshReason?: string; readiness?: ReadinessRecheck }
export interface ParallelMember {
  key: string;
  reviewKey: string;
  roleId: Id;
  profileId: Id;
  reviewerKey?: string;
  work(copy: string, room: (toolId: Id, profile: AgentProfile) => boolean, seat: Id, used: (profileId: Id) => void, agent: ActiveAgent, continuing: boolean, signal: AbortSignal, selection?: ParallelSeatSelection): Promise<void>;
}

/**
 * The controller treats copy references as opaque values. Only this native owner chooses paths,
 * creates copies, maps companion workspaces or inspects/restores files. Reservation is already
 * published before prepare runs; reference selection stays synchronous at its original position.
 */
export interface PreparedParallelMember {
  /** Registers the prepared companion map, after the controller records made, without another await. */
  activate(): void;
  /** Saves retained screen ownership and removes the live companion map at the original finally position. */
  finish(): void;
}
export interface ParallelWorkspaceEffects {
  reference(member: string): string;
  prepare(member: ParallelMember, copy: string, continuing: boolean, reuse: boolean): Promise<PreparedParallelMember>;
  stopHelpers(): void;
  closeTaskRun(): void;
  releasedStops(): Promise<void>;
  /** Called only after all running member promises and released stops settle; owns original repository cleanup. */
  finish(readOnly: boolean): Promise<void>;
}

export interface ParallelAdmissionHost {
  state(): AgentWorkflowState;
  activeState(): State;
  now(): number;
  draining(): boolean;
  admissionsClosed(task: RuntimeTask): boolean;
  admissionWait(task: RuntimeTask): string;
  sourceRefreshDue(task: RuntimeTask): boolean;
  selectScreen(task: RuntimeTask): void;
  syncScreen(): void;
  showReviewWork(task: RuntimeTask): void;
  finishStep(task: RuntimeTask): void;
  waitForUsage(task: RuntimeTask, words: string): void;
  rememberReviewer(task: RuntimeTask, key: string, profileId: Id): void;
  changed(): void;
  checkpoint(): void;
  schedule(): void;
}

/** Shared registries/catalog are the same instances used by AgentWorkflow and native selected-profile activation. */
export interface ParallelAdmissionDependencies {
  readonly ownership: AgentOwnership;
  readonly catalog: AgentAdmissionCatalog;
  readonly readiness: AgentAdmissionReadiness;
  readonly errors: AgentAdmissionErrors;
}
export interface ParallelAdmissionRequest {
  readonly scope: RepositoryContext;
  readonly members: readonly ParallelMember[];
  readonly signal: AbortSignal;
  readonly status: (running: number, waiting: number) => string;
  readonly workspaces: ParallelWorkspaceEffects;
}
