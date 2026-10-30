import type { Role } from "@petrina/core";
import type { RuntimeTask } from "../model.js";
import type { RepositoryContext } from "../repository-context.js";

/** Native observations captured before the conflict's durable transition. */
export interface SourceConflictObservation {
  sourceName: string;
  from: string;
  onto: string;
  ontoRef: string;
  files: string[];
  notes: string[];
  gained: number;
  reviewed: boolean;
}
export interface SourceConflictHost {
  role(id: string, task: RuntimeTask): Pick<Role, "result"> | undefined;
  productName(scope: RepositoryContext): string | undefined;
  checkpoint(): void;
  changed(): void;
  note(scope: RepositoryContext, tone: "status" | "warn", text: string): void;
  now(): number;
}
export interface BeginSourceConflictEffects {
  head(): Promise<string>;
  open(): Promise<void>;
}
export interface FinishSourcePortEffects {
  treeOf(savedHead: string): Promise<string | undefined>;
  merge(onto: string, savedHead: string): Promise<{ tree: string } | undefined>;
  changedFiles(mergedTree: string): Promise<readonly string[]>;
}
