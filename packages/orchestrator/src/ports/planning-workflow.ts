import type { AgentProfile, Id, PlanInput, Product, RiskLevel, Role, Task, WorkChoice } from "@petrina/core";
import type { RuntimeTask } from "../model.js";
import type { InputSection } from "./participant-input.js";
import type { RepositoryContext } from "../repository-context.js";

export type PlannerReply = Omit<PlanInput["result"], "risk"> & {
  readonly risk?: { level: RiskLevel; why: string };
  readonly sourcePointers?: unknown;
  readonly worksOn?: readonly WorkChoice[];
};

export interface PlannerTurnRequest {
  readonly plannerProfileId: Id;
  readonly requestedProfileId: Id;
  readonly selectionReason?: string;
  readonly sections: () => InputSection[];
  readonly used: (profileId: Id) => void;
}

export interface PlanningWorkflowHost {
  readonly plannerProfileId: Id;
  readonly releaseManagerProfileId: Id;
  readonly riskWord: Readonly<Record<RiskLevel, string>>;
  now(): number;
  products(): readonly Product[];
  roles(): readonly Role[];
  profiles(): readonly AgentProfile[];
  onUsable(profileId: Id): Id;
  note(task: RuntimeTask, tone: Task["timeline"][number]["tone"], text: string, roleId: Id, profileId: Id): void;
  finishStep(task: RuntimeTask): void;
  endStage(task: RuntimeTask): void;
  changed(): void;
}

export interface PlanningWorkflowEffects {
  readOrientation(products: readonly Product[]): Promise<InputSection[]>;
  runTurn(scope: RepositoryContext, request: PlannerTurnRequest, signal: AbortSignal): Promise<PlannerReply>;
  proposeSources(task: RuntimeTask, worksOn: readonly WorkChoice[] | undefined): Promise<void>;
}
