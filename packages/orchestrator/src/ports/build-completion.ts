import type { CheckFailureReference, DeepMutable, Finding, Id } from "@petrina/core";
import type { RuntimeTask } from "../model.js";
import type { RepositoryContext } from "../repository-context.js";
import type { FoldedVersion } from "../source-update.js";
import type { AcceptanceLearning } from "./acceptance-results.js";

/** Validated output; provider parsing and conversation ownership precede completion. */
export interface BuildReply {
  summary: string; changes: string[]; tests?: string; title?: string; description?: string; complete?: boolean;
  answers: { id: Id; fixed: boolean; text: string }[];
  learnings: AcceptanceLearning[];
}
export interface BuildCompletionInput {
  stageId: Id; roleId: Id; plannedProfileId: Id; actualProfileId: Id;
  result: BuildReply; maintenance: boolean; sourceName: string;
  startingTree?: string; updating?: RepositoryContext["work"]["updating"]; rethought?: boolean;
  given: DeepMutable<Finding>[]; checkFailures: readonly CheckFailureReference[];
}
export interface BuildRepairVersion { sha?: string; tree?: string; definition: string; commands: string[] }
export interface BuildCompletionHost {
  now(): number;
  checkpoint(task: RuntimeTask): void;
  note(scope: RepositoryContext, tone: "done", words: string, roleId: Id, profileId: Id): void;
  noteLearnings(scope: RepositoryContext, lessons: AcceptanceLearning[], roleId: Id, profileId: Id): Promise<void>;
}
/** Each effect belongs to the captured execution; native commit/fold/snapshot checks remain in its adapter. */
export interface BuildCompletionEffects {
  saveChanges(scope: RepositoryContext): Promise<void>;
  finishPort(scope: RepositoryContext, updating: NonNullable<RepositoryContext["work"]["updating"]>): Promise<void>;
  fold(scope: RepositoryContext): Promise<FoldedVersion | undefined>;
  tree(scope: RepositoryContext): Promise<string | undefined>;
  versions(task: RuntimeTask): Promise<Record<Id, string>>;
  repairVersion(scope: RepositoryContext): Promise<BuildRepairVersion | undefined>;
}
