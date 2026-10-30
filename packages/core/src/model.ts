// The domain model shared by the engine, the simulator and the UI.
// Everything here is plain data so it can be stored, diffed and rendered.
import type { AgentProfile, Id, InboxItem, Pool, Role, RoleChanges, Terminal, Tool } from "./catalog-model.js";
import type { Product } from "./check-model.js";
import type { Task } from "./task-model.js";
import type { Setup } from "./setup.js";
import type { WorkInfo } from "./worklog.js";

export * from "./catalog-model.js";
export * from "./check-model.js";
export * from "./review-model.js";
export * from "./journey-model.js";
export { REPOSITORY_FIELDS } from "./task-model.js";
export type {
  ProofRequest,
  ProofDecision,
  RepositoryState,
  RepositoryField,
  TaskRepository,
  TaskRequest,
  TaskScopeState,
  TaskProgress,
  RuntimeWaitChange,
  RuntimeWait,
  TaskDesignState,
  TaskReviewState,
  TaskAcceptanceState,
  TaskActivity,
  TaskHistoryState,
  TaskState,
  Task,
} from "./task-model.js";

export interface State {
  /** Durable ownership, independent of task archive retention. Removed after confirmed cleanup. */
  extraValidations?: readonly import("./extra-validation.js").ExtraValidation[];
  routines?: readonly import("./routines.js").Routine[];
  /** Short engine-owned conversations, counted in the same pool as task agents. Cleared on restart. */
  backgroundAgents?: readonly { id: Id; roleId: Id; profileId: Id; label: string; since: number }[];
  /** Compact totals and recent durations for finished work, fetched separately from the board. */
  history?: import("./history.js").HistoryMetadata;
  now: number;
  seq: number;
  products: readonly Product[];
  /** Every role: the built-in ones as the coordinator left them, then the ones they added. */
  roles: readonly Role[];
  /** What the coordinator changed in the roles. `roles` is built from it. */
  roleChanges?: RoleChanges;
  tools: readonly Tool[];
  profiles: readonly AgentProfile[];
  /** Removed profile definitions remain readable for historical records, never offered for new work. */
  retiredProfiles?: readonly AgentProfile[];
  /** Defaults initialize once; saved edits and deletions survive restarts. */
  profileCatalogSaved?: boolean;
  tasks: readonly Task[];
  inbox: readonly InboxItem[];
  pool: Pool;
  /** First run and the tools check. Absent in the demo and from older engines: no first run. */
  setup?: Setup;
  /** The terminals found on this machine, the usual one first. Unset in the demo. */
  terminals?: readonly Terminal[];
  /** The terminal the coordinator chose for take-overs. Unset: the usual one. */
  terminal?: Id;
  /** The work log's counter and when tracking began. Never the log itself. */
  work?: WorkInfo;
  /** The profile the planner runs on, so a task's journey can name it before it starts. */
  planner?: Id;
  /**
   * Follow-up links that are decided but not finished, or waiting because matching could not run.
   * Kept here so a restart can finish them without reading every finished task.
   */
  followUpPending?: readonly { keys: readonly string[]; cardId?: Id; retry?: boolean }[];
}
