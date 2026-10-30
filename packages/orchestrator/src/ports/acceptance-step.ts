import type { Id } from "@petrina/core";
import type { RuntimeTask } from "../model.js";
import type { RepositoryContext } from "../repository-context.js";
import type { AcceptanceReply } from "./acceptance-results.js";
import type { CommittedCode } from "./repository-observations.js";

export interface AcceptanceStepHost {
  now(): number;
  checkpoint(): void;
}
export interface AcceptanceTurnInput {
  roleId: Id;
  profileId: Id;
  committed?: Readonly<Record<Id, string>>;
  used(profileId: Id): void;
  check(value: AcceptanceReply): string | undefined;
}
export interface AcceptanceStepEffects {
  committedCode(task: RuntimeTask): Promise<CommittedCode>;
  versions(task: RuntimeTask): Promise<Record<Id, string>>;
  saveEdits(scope: RepositoryContext, roleId: Id, profileId: Id): Promise<void>;
  turn(scope: RepositoryContext, input: AcceptanceTurnInput, signal: AbortSignal): Promise<AcceptanceReply>;
}
