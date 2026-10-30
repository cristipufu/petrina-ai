import type { AgentProfile, CallAnswer, Id, Objection, Role, Task } from "@petrina/core";
import type { DesignConversations } from "../design-conversations.js";
import type { RuntimeTask } from "../model.js";
import type { RepositoryContext } from "../repository-context.js";

export type DesignStage = NonNullable<RuntimeTask["plan"]>["stages"][number];
export type DesignParticipant = ReturnType<DesignConversations["participant"]>;

export interface DesignBriefReply {
  readonly sourcePointers?: unknown;
  readonly summary: string;
  readonly forUsers: string[];
  readonly areas: string[];
  readonly acceptance: string[];
  readonly risks: string[];
  readonly answers: CallAnswer[];
}

export interface DesignObjectionsReply {
  readonly objections: { text: string; blocking: boolean }[];
}

export interface DesignAuthorTurnInput {
  readonly roleId: Id;
  readonly profileId: Id;
  readonly status?: string;
  readonly resume: (actual: AgentProfile) => Promise<unknown>;
  readonly used: (id: Id) => void;
  readonly check: (value: DesignBriefReply) => string | undefined;
}

export interface DesignReviewerTurnInput {
  readonly roleId: Id;
  readonly profileId: Id;
  readonly resume: (actual: AgentProfile) => Promise<unknown>;
  readonly used: (id: Id) => void;
}

export interface DesignWorkflowHost {
  now(): number;
  id(prefix: string): Id;
  role(id: Id): Role | undefined;
  formatObjections(objections: readonly Objection[]): string;
  note(
    scope: RepositoryContext,
    tone: Task["timeline"][number]["tone"],
    text: string,
    roleId?: Id,
    profileId?: Id,
  ): void;
  finishStep(scope: RepositoryContext): void;
  rerun(task: RuntimeTask): boolean;
  recordDesignRound(
    scope: RepositoryContext,
    stage: DesignStage,
    reviewer: { roleId: Id; profileId: Id },
    round: number,
    objectionCount: number,
    blockingCount: number,
  ): void;
  recordDesignEnd(scope: RepositoryContext, stage: DesignStage, round: number, outcome: "settled" | "to-you"): void;
  endStage(scope: RepositoryContext, outcome: "settled"): void;
  raiseDisagreement(scope: RepositoryContext, title: string, body: string): void;
  checkpoint(): void;
  changed(): void;
}

export interface DesignWorkflowEffects {
  runAuthorTurn(
    scope: RepositoryContext,
    input: DesignAuthorTurnInput,
    signal: AbortSignal,
  ): Promise<DesignBriefReply>;
  runReviewerTurn(
    scope: RepositoryContext,
    input: DesignReviewerTurnInput,
    signal: AbortSignal,
  ): Promise<DesignObjectionsReply>;
  saveRoleEdits(scope: RepositoryContext, roleId: Id, profileId: Id): Promise<void>;
}
