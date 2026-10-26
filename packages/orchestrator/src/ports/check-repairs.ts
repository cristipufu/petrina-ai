import type { Id } from "@petrina/core";
import type { RuntimeTask } from "../model.js";
import type { RepositoryContext } from "../repository-context.js";
import type { RepairHost } from "./repair.js";

/** Recording and fresh declaration inspection retain their original ordering and failure behavior. */
export interface CheckRepairHost extends RepairHost {
  id(task: RuntimeTask): Id;
  definition(scope: RepositoryContext, sha?: string): Promise<string>;
  log(scope: RepositoryContext, tone: "warn", text: string): void;
  changed(): void;
  checkpoint(): void;
}
