import type {
  CheckAttemptEvidence,
  CheckEnvironmentBinding,
  CheckRun,
  CheckSetupAttempt,
  CheckSetupOutcome,
  DeepMutable,
  Id,
  JourneyProductCheck
} from "@petrina/core";
import type { RepositoryContext } from "../repository-context.js";

export type CheckVerification = { readonly results: readonly CheckRun[] } & (
  | { kind: "passed"; productId: Id; basis: "executed" | "reused"; binding: CheckEnvironmentBinding }
  | { kind: "product-failed"; productId: Id; failed: readonly CheckRun[]; binding: CheckEnvironmentBinding }
  | { kind: "blocked"; productId: Id; reason: "setup" | "native-incomplete" | "inputs-changed"; setup: CheckSetupOutcome });

export interface CheckEvidenceState { sha?: string; tree?: string; trackedChanged: boolean; definition: string; contract: string; invalidationId?: Id }
export interface CheckEnvironmentObservation { attempt: CheckSetupAttempt; outcome: CheckSetupOutcome; valid(): boolean; forceFresh: boolean }

/** Observations belong to the adapter that executed and restored the commands; none are synthesized here. */
export interface CheckBatchEvidence {
  state: CheckEvidenceState;
  finalState: CheckEvidenceState;
  live: CheckEnvironmentObservation;
  after: CheckEnvironmentObservation;
  before: string;
  rawTree?: string;
  results: CheckRun[];
  expected: readonly string[];
  commands: readonly string[];
  attemptId?: string;
  stepId?: string;
  provenance?: DeepMutable<CheckAttemptEvidence>;
  entries: ReadonlyMap<string, DeepMutable<JourneyProductCheck>>;
}

export interface CheckEvidenceHost {
  now(): number;
  changed(): void;
  log(scope: RepositoryContext, tone: "warn" | "done", text: string): void;
  deliveryRole(scope: RepositoryContext): boolean;
  settleFindings(scope: RepositoryContext, results: readonly CheckRun[]): readonly CheckRun[];
  refreshInterruptions(scope: RepositoryContext, signal: AbortSignal): Promise<void>;
  recordFailedFindings(scope: RepositoryContext, results: readonly CheckRun[]): void;
  check(signal: AbortSignal): void;
  closeEpisode(scope: RepositoryContext, state: CheckEvidenceState, valid: () => boolean): Promise<void>;
}

/** One verification operation; its native adapter retains every freshness read and admission check. */
export interface CheckVerificationEffects<Checks> {
  verify(checks: Checks | undefined): Promise<CheckVerification>;
  currentChecks(previous: Checks | undefined): Checks;
  check(): void;
}

/** Command order and hook names come from the native declaration adapter, before any execution. */
export interface CheckEvidenceDeclaration {
  expected: readonly string[];
  commands: readonly string[];
  hooks: readonly string[];
}

export interface CheckAttemptEffects<State extends CheckEvidenceState> {
  capture(): Promise<State>;
  setupContract(): string;
  setupRequired(): boolean;
  applies(state: State): Promise<boolean>;
  observe(state: State): Promise<CheckEnvironmentObservation>;
  execute(state: State): Promise<CheckVerification>;
}
