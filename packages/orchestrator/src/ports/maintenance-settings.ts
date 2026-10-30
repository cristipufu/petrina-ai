import type { AgentProfile, DeepMutable, InboxItem, Role } from "@petrina/core";
import type { RuntimeTask } from "../model.js";
import type { SessionSettings, TurnNotes, TurnResult } from "./agents.js";

export interface MaintenanceSettingsInput {
  role: Pick<Role, "id" | "canEdit">;
  profile: AgentProfile;
  settings: SessionSettings;
  lastTurn: TurnNotes | undefined;
  worktree: string;
  headBefore?: string;
  reply?: TurnResult;
  result?: unknown;
}

export interface MaintenanceSettingsHost {
  now(): number;
  pauseStep(task: RuntimeTask): void;
  addDecision(item: DeepMutable<InboxItem>): void;
  checkpoint(task: RuntimeTask): void;
  aborted(): Error;
  unconfirmed(message: string): Error;
}

export interface MaintenanceSettingsEffects {
  readOnlyStatus(worktree: string): Promise<{ head?: string; clean: boolean }>;
}

export interface MaintenanceDecisionHost {
  note(task: RuntimeTask, text: string): void;
  removeDecision(taskId: string): void;
  cancel(taskId: string): void;
  checkpoint(task: RuntimeTask): void;
  schedule(): void;
}
