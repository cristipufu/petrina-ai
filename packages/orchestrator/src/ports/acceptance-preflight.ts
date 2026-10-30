import type { Id, ProductCheck, Role } from "@petrina/core";
import type { RuntimeTask } from "../model.js";
import type { RepositoryContext } from "../repository-context.js";
import type { CheckVerification } from "./check-evidence.js";

export interface AcceptancePreflightHost {
  role(id: Id, task: RuntimeTask): Role | undefined;
  backToBuilder(scope: RepositoryContext, eligibleProducts: ReadonlySet<Id>): boolean;
  blocked(task: RuntimeTask): void;
}
export interface AcceptancePreflightEffects {
  upToDate(scope: RepositoryContext, signal: AbortSignal): Promise<"current" | "moved" | "conflict">;
  ensureChecks(scope: RepositoryContext, signal: AbortSignal): Promise<readonly ProductCheck[]>;
  failing(scope: RepositoryContext, signal: AbortSignal, required: readonly ProductCheck[], prepare: () => Promise<boolean>): Promise<Pick<CheckVerification, "kind" | "productId">>;
  preparationChanged(error: unknown): boolean;
}
