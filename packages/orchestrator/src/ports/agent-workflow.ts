import type { ActiveAgent, AgentProfile, Column, DeepMutable, Id, Role, Stage, State, Task } from "@petrina/core";
import type { RuntimeTask } from "../model.js";
import type { ProfileSelectionResult, SelectionReadiness } from "../profile-selection.js";
import type { RepositoryContext } from "../repository-context.js";
import type { ScreenGroup } from "./screen.js";

export type WorkflowStage = DeepMutable<Stage>;
export interface ParticipantRequest { roleId: Id; profileId: Id; reviewerKey?: string; requiredToolId?: Id }

/** The host supplies the existing live registries, not a snapshot or another occupancy counter. */
export interface AgentOwnership {
  readonly drivers: Map<Id, AbortController>;
  readonly settling: Map<Id, Promise<void>>;
  readonly pendingAdmissions: Map<Id, { step: string; roleId: Id; profileId: Id }>;
  readonly groups: Map<Id, ScreenGroup>;
}

/** These are state values only; native accounts, programs and persistent stores are absent. */
export type AgentWorkflowState = DeepMutable<Pick<State, "products" | "roles" | "profiles" | "retiredProfiles" | "tools" | "inbox" | "pool" | "now">> & { tasks: RuntimeTask[] };

export interface AgentAdmissionReadiness {
  hold(task: RuntimeTask, need: SelectionReadiness): boolean;
  open(need: SelectionReadiness): boolean;
  resolve(need: SelectionReadiness): Promise<void>;
  resolveHeld(need: SelectionReadiness, signal: AbortSignal, yieldPlace?: () => boolean): Promise<boolean>;
  yieldHeld(task: RuntimeTask): boolean;
  charge(task: RuntimeTask, need: SelectionReadiness, reviewKey?: string): boolean;
}

/** Native error identities survive the boundary; unknown failure is never a successful empty result. */
export interface AgentAdmissionErrors {
  aborted(): Error;
  sourceRefresh(): Error;
  screenWait(): Error;
  usage(words: string): Error;
  classify(error: unknown): { kind: "abort" | "screen" | "source-refresh" } | {
    kind: "usage";
    error: Error;
    words: string;
    capacity: boolean
  } | { kind: "failure" };
  waitingFor(words: string): { error: Error; words: string; capacity: boolean };
}

export interface AgentAdmissionCatalog {
  profile(id: Id): AgentProfile | undefined;
  role(id: Id, task?: RuntimeTask): Role | undefined;
  onUsable(id: Id): Id;
  choose(request: ParticipantRequest, task: RuntimeTask | undefined, room?: (toolId: Id, profile: AgentProfile) => boolean): ProfileSelectionResult | undefined;
}

/** Preparation applies its existing source/gate mutations before resolving. A repeat re-reads the live task. */
export type WorkspacePreparation = { kind: "ready"; scope: RepositoryContext } | { kind: "repeat" } | { kind: "stop" };
/** Only completed actual check preparation may produce prepared; this is not stored passing check evidence. */
export type AcceptancePreparation = { kind: "prepared" | "repeat" | "stop" };
/** The effect applies retest/auto-approval or opens its real checkpoint before returning. */
export type DeliveryCheckpointPreparation = { kind: "repeat" | "stop" };
export type StageDisposition = "continue" | "stop";

/**
 * Named native phases of the existing driver. No command executor, unchecked bypass or synthetic SHA.
 * A native phase keeps the supplied task/execution binding across every await. Stage result application
 * belongs to that phase exactly as runDo/runConverge/runReview currently apply it before returning.
 */
export interface AgentWorkflowPhases {
  prepareWorkspace(task: RuntimeTask, stage: WorkflowStage | undefined, signal: AbortSignal): Promise<WorkspacePreparation>;
  prepareAcceptance(scope: RepositoryContext, signal: AbortSignal): Promise<AcceptancePreparation>;
  deliveryCheckpoint(scope: RepositoryContext, signal: AbortSignal): Promise<DeliveryCheckpointPreparation>;
  planner(task: RuntimeTask, signal: AbortSignal): Promise<void>;
  doStage(scope: RepositoryContext, stage: WorkflowStage, signal: AbortSignal): Promise<StageDisposition>;
  converge(scope: RepositoryContext, stage: WorkflowStage, signal: AbortSignal): Promise<StageDisposition>;
  review(task: RuntimeTask, stage: WorkflowStage, signal: AbortSignal): Promise<StageDisposition>;
  delivery(task: RuntimeTask, stage: WorkflowStage, signal: AbortSignal): Promise<StageDisposition>;
  nextReviewer(task: RuntimeTask, stage: WorkflowStage): ParticipantRequest | undefined;
  deliveryNeedsAgent(scope: RepositoryContext): boolean;
  carriedOver(task: RuntimeTask): void;
  clearUnpublishedOnFailure(task: RuntimeTask): Promise<void>;
  /** Runs at the original finally position, after driver ownership is released. */
  finish(taskId: Id, signal: AbortSignal): Promise<void>;
}

export interface CheckPreparationPlaces {
  claim(taskId: Id): boolean;
  release(taskId: Id): void;
  slots?(): number;
  clear?(task: RuntimeTask): void;
}

/** Selected-profile qualification precedes clock/journey preparation; activation keeps its original synchronous position. */
export interface SelectedParticipant {
  readonly task: RuntimeTask;
  readonly profile: AgentProfile;
  readonly roleId: Id;
  readonly step: string;
  readonly reviewKey?: string;
}
export interface ParticipantAdmission {
  /** Records a pending admission only at the existing no-room branch; throws the host's exact wait/abort error. */
  qualify(request: SelectedParticipant, signal: AbortSignal): void;
  /** Publishes agent/holdsSlot/state/column together, without I/O, after the caller's existing clock preparation. */
  activate(request: SelectedParticipant): DeepMutable<ActiveAgent>;
}

/** Actual recording/lifecycle operations consumed by scheduling; all callbacks preserve their owner receiver. */
export interface AgentWorkflowHost {
  state(): AgentWorkflowState;
  activeState(): State;
  task(id: Id): RuntimeTask | undefined;
  taskDetails(id: Id): Task | undefined;
  now(): number;
  stopped(): boolean;
  draining(): boolean;
  drainLine(): string;
  admissionsClosed(task: RuntimeTask): boolean;
  admissionWait(task: RuntimeTask): string;
  sourceRefreshDue(task: RuntimeTask): boolean;
  stepStarted(task: RuntimeTask): boolean;
  blockers(task: RuntimeTask): readonly Task[];
  column(task: RuntimeTask): Column;
  pauseStep(task: RuntimeTask): void;
  waitForUsage(task: RuntimeTask, words: string): void;
  syncScreen(): void;
  syncDeliveryTurns(): void;
  waitingForDelivery(task: RuntimeTask): string | undefined;
  expireLimits(): void;
  armLimitTimer(): void;
  changed(): void;
  checkpoint(task?: RuntimeTask): void;
  note(task: RuntimeTask, tone: "milestone" | "warn", text: string): void;
  gate(task: RuntimeTask, kind: "plan" | "design" | "delivery"): void;
  failed(taskId: Id, error: unknown): void;
  beginStage(scope: RepositoryContext): void;
  tidy(taskId: Id): void;
  /** Re-enters the application scheduler, including its other owned queues. */
  schedule(): void;
  idleChanged(): void;
  /** At completion handoff, register finalization before releasing its task-keyed owner; return the original result. */
  trackWork(work: Promise<void>): Promise<void>;
  /** Diagnostic only: finalization must not reclassify a newer run or a delivered/cancelled task. */
  reportDriverError(taskId: Id, error: unknown): void;
}

export interface AgentAdmissionDependencies {
  readonly ownership: AgentOwnership;
  readonly catalog: AgentAdmissionCatalog;
  readonly readiness: AgentAdmissionReadiness;
  readonly errors: AgentAdmissionErrors;
}
export interface AgentWorkflowDependencies extends AgentAdmissionDependencies {
  readonly phases: AgentWorkflowPhases;
  readonly checkPreparation: CheckPreparationPlaces;
  readonly plannerProfileId: Id;
}
