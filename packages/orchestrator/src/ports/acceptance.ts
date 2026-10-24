import type { RuntimeTask } from "../model.js";
import type { RepositoryContext } from "../repository-context.js";
import type { RepairHost } from "./repair.js";

/** Post-run routing consumes recorded evidence, not commands, agent sessions or a database. */
export interface AcceptanceRoutingHost extends RepairHost {
  finishStep(scope: RepositoryContext): void;
  note(scope: RepositoryContext, tone: "milestone" | "warn", text: string): void;
  commit(task: RuntimeTask): void;
  openDeliveryDecision(task: RuntimeTask): void;
}

/** Facts already normalized and tied to the completed acceptance run by its owner. */
export interface AcceptanceRoutingInput {
  readonly failed: number;
  readonly requiredGap: boolean;
  readonly requiredCount: number;
  readonly restored: boolean;
}
