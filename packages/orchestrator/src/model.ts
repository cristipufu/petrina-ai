import type { DeepMutable, TaskState } from "@petrina/core";

/** Canonical workflow state. Repository fields belong to its explicit execution records. */
export type RuntimeTask = DeepMutable<TaskState>;
