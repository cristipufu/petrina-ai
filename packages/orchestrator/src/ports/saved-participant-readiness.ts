import type { AgentProfile, CheckId, Column, Id, Role, State } from "@petrina/core";
import type { RuntimeTask } from "../model.js";
import type { RepositoryContext } from "../repository-context.js";
import type { AgentWorkflowState } from "./agent-workflow.js";

export interface SavedParticipantReadinessHost {
  state(): AgentWorkflowState & Pick<State, "setup">;
  activeState(): State;
  stopped(): boolean;
  readonly stopSignal: AbortSignal;
  limitMs(): number;
  profile(id: Id): AgentProfile | undefined;
  role(id: Id, task: RuntimeTask): Role | undefined;
  admissionsClosed(task: RuntimeTask): boolean;
  column(task: RuntimeTask): Column;
  note(scope: RepositoryContext, kind: "status", text: string): void;
  checkpoint(subject: RepositoryContext | RuntimeTask): void;
  schedule(): void;
}

/** The same tool-check owner used by manual checks, startup and competing participants. */
export interface SavedParticipantChecks {
  check(id: CheckId): Promise<void>;
  running(id: CheckId): Promise<void> | undefined;
}

/** Deadline registration is synchronous; its cancel function releases that same timer. */
export interface SavedParticipantReadinessClock {
  now(): number;
  after(ms: number, done: () => void): () => void;
}
