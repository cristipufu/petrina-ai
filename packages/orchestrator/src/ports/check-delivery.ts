import type { Id, Role, State, JourneyCheckReuse } from "@petrina/core";
import type { RuntimeTask } from "../model.js";
import type { RepositoryContext } from "../repository-context.js";
import type { CheckVerification } from "./check-evidence.js";

export interface CheckDeliveryEffects<Preparation> {
  failing(scope: RepositoryContext, signal: AbortSignal, purpose: JourneyCheckReuse["purpose"], prepare?: Preparation): Promise<CheckVerification>;
  preparationChanged(error: unknown): boolean;
  backToBuilder(scope: RepositoryContext, when: string, eligibleProducts: ReadonlySet<Id>): boolean;
  blocked(task: RuntimeTask): void;
}
export interface CheckDecisionHost {
  state(): State;
  role(id: Id, task: RuntimeTask): Role | undefined;
  productName(scope: RepositoryContext): string;
  id(task: RuntimeTask): Id;
  now(): number;
  log(subject: RepositoryContext | RuntimeTask, tone: "warn" | "you", text: string): void;
  gate(task: RuntimeTask, problem: { title: string; body: string; line: string }): void;
}
