import type { DeepMutable } from "./flow.js";
import type { HistoryItem } from "./history.js";
import { AFTER_WORDS, openStep, syncRuntimeWaitJourney } from "./journey.js";
import type { Id, RepositoryState, TaskRepository, TaskState } from "./model.js";
import { validateTaskDependencies } from "./task-transitions.js";
import { publishingResult } from "./workflow-events.js";

/** Graph lookups may use compact archived records, without loading conversations. */
export type DependencyNode = Pick<TaskState, "id"> & Partial<Pick<TaskState, "after" | "runtimeWait" | "state">>;
export type RuntimeWaitTask = Pick<TaskState, "id" | "title" | "state"> & Partial<Pick<TaskState, "repository" | "repositories" | "combinedInto">> & Partial<RepositoryState> & Pick<HistoryItem, "deliveries" | "maintenance">;
export type RuntimeWaitLookup = (id: Id) => RuntimeWaitTask | undefined;

export interface RuntimePrerequisite {
  id: Id;
  title: string;
  state: string;
  landed: boolean;
  decisionNeeded: boolean;
}

/** Read only confirmed per-product delivery facts. Finishing or accepting a closed PR is no landing. */
export function runtimePrerequisite(id: Id, task: RuntimeWaitTask | undefined, savedTitle?: string): RuntimePrerequisite {
  const base = { id, title: task?.title ?? savedTitle ?? "Unavailable task", landed: false, decisionNeeded: false };
  if (!task) return { ...base, state: "no longer available", decisionNeeded: true };
  if (task.combinedInto) return { ...base, state: "combined into another task", decisionNeeded: true };
  if (task.state === "cancelled") return { ...base, state: "cancelled", decisionNeeded: true };
  const works: readonly (RepositoryState & Partial<TaskRepository>)[] = task.repositories
    ?? task.deliveries?.map(work => ({ ...work }))
    ?? [task.repository ?? { ...task, productId: task.productId ?? "", delivery: task.delivery ?? "local" }];
  const publishing = works.filter(work => !work.nothingToPublish);
  if (task.maintenance?.noProductChanges || works.length && !publishing.length) return task.state === "done"
    ? { ...base, state: "finished with no product changes", decisionNeeded: true }
    : { ...base, state: "still in progress" };
  if (!works.length) return task.state === "done" ? { ...base, state: "marked done without a confirmed delivery", decisionNeeded: true } : { ...base, state: "still in progress" };
  const results = publishing.map(work => work.shipping?.step || work.companion && work.companion.state !== "done"
    ? { kind: "publishing" as const, landed: false as const, step: work.shipping?.step ?? "companion links" }
    : publishingResult(task, work, false));
  if (results.every(result => result.landed === true)) return { ...base, state: "landed", landed: true };
  if (results.some(result => result.kind === "pull-request-closed")) return { ...base, state: "closed without merging", decisionNeeded: true };
  if (results.some(result => result.kind === "unconfirmed")) return { ...base, state: "marked done without a confirmed delivery", decisionNeeded: true };
  if (task.state === "done" && results.some(result => result.kind === "unknown" || result.kind === "interrupted")) return { ...base, state: "delivery could not be confirmed", decisionNeeded: true };
  if (results.some(result => result.kind === "no-changes")) return { ...base, state: "finished with no product changes", decisionNeeded: true };
  if (results.some(result => result.kind === "local-unpushed")) return { ...base, state: "delivery has not been pushed" };
  if (results.some(result => result.kind === "publishing")) return { ...base, state: "still publishing" };
  if (results.some(result => result.kind === "pull-request-open")) return { ...base, state: "awaiting merge" };
  return { ...base, state: "still in progress" };
}

/** Saved release is authoritative until the task ends: a missing lookup never opens admission. */
export function runtimeWaitHolds(task: Partial<Pick<TaskState, "state" | "runtimeWait">>): boolean {
  return task.state !== "pr-open" && task.state !== "done" && task.state !== "cancelled" && !!task.runtimeWait?.after.length && task.runtimeWait.releasedAt === undefined;
}

function admittedWork(task: Pick<TaskState, "state" | "agent" | "helpers" | "driving" | "repository" | "repositories" | "journey"> & Partial<Pick<RepositoryState, "shipping">>): boolean {
  // Recovery puts an interrupted driver back in Waiting. A saved publication alone is work
  // still to recover; only its running driver is finishing the already-admitted publication.
  const publishing = task.state === "running" && (task.shipping?.step || task.repository?.shipping?.step || task.repositories?.some(work => work.shipping?.step));
  return !!(task.agent || task.helpers?.length || task.driving
    || publishing
    || openStep(task)?.productChecks?.some(check => check.result === "running"));
}

export function runtimeWaitView(task: Pick<TaskState, "runtimeWait" | "state" | "agent" | "helpers" | "driving" | "repository" | "repositories" | "journey"> & Partial<Pick<RepositoryState, "shipping">>, find: RuntimeWaitLookup) {
  const wait = task.runtimeWait;
  if (!wait) return undefined;
  const prerequisites = wait.after.map(id => runtimePrerequisite(id, find(id), wait.titles?.[id]));
  const held = runtimeWaitHolds(task);
  return {
    held, reason: wait.reason, prerequisites,
    phase: !held ? "released" as const : admittedWork(task) ? "after-current-work" as const : "active" as const,
    decisionNeeded: held && prerequisites.some(entry => entry.decisionNeeded),
    changes: wait.changes, latestChange: wait.changes.at(-1), changeCount: wait.changes.length,
    releasedAt: wait.releasedAt, releaseReason: wait.releaseReason,
  };
}

export function runtimeWaitWords(view: NonNullable<ReturnType<typeof runtimeWaitView>>): string {
  const decision = view.prerequisites.find(entry => entry.decisionNeeded);
  if (decision) return `Waiting for your decision: “${decision.title}” did not land (${decision.state})`;
  const pending = view.prerequisites.filter(entry => !entry.landed).map(entry => entry.title);
  return pending.length ? AFTER_WORDS.waiting(pending) : "Required tasks have landed; waiting to resume";
}

/** Validate all inputs before mutating either task or receipt. Empty lists explicitly clear the hold. */
export function validateRuntimeWait(task: Pick<TaskState, "id" | "state" | "startedAt" | "runtimeWait"> | undefined, after: readonly Id[], reason: string, find: (id: Id) => (DependencyNode & Partial<Pick<TaskState, "title">>) | undefined): { after: Id[]; reason: string } {
  if (!task) throw new Error("This task is unavailable. Choose another task.");
  if (task.startedAt === undefined) throw new Error("This task has not started. Use its Start after other tasks land prerequisites instead.");
  if (task.state === "done" || task.state === "cancelled" || task.state === "pr-open") throw new Error("This task has finished or is already awaiting merge. Only started, unfinished tasks can wait.");
  const text = reason.trim();
  if (!text || reason.length > 1000) throw new Error("Give a reason between 1 and 1,000 characters.");
  if (after.length > 20) throw new Error("Choose up to 20 prerequisites. Remove a task before adding another.");
  const saved = task.runtimeWait;
  const requested = [...new Set(after)];
  if (saved?.reason === text && saved.after.length === requested.length && saved.after.every(id => requested.includes(id))) return { after: requested, reason: text };
  const ids = validateTaskDependencies(task.id, after, find);
  for (const id of ids) {
    const other = find(id)!;
    if (other.state === "done" || other.state === "cancelled") throw new Error("An awaited task has already finished. Choose unfinished prerequisites, or clear the wait with a reason.");
  }
  return { after: ids, reason: text };
}

/** The caller saves this mutation and its request receipt atomically. */
export function changeRuntimeWait(task: DeepMutable<Pick<TaskState, "runtimeWait">>, input: { after: readonly Id[]; reason: string; requestId?: Id }, now: number): boolean {
  const before = task.runtimeWait?.after ?? [];
  if (!input.after.length && (!before.length || task.runtimeWait?.releasedAt !== undefined)) return false;
  if (task.runtimeWait?.reason === input.reason && before.length === input.after.length && before.every(id => input.after.includes(id))) return false;
  const previous = task.runtimeWait;
  task.runtimeWait = {
    ...previous, after: [...input.after], reason: input.reason,
    changes: [...(previous?.changes ?? []), { at: now, before: [...before], after: [...input.after], reason: input.reason, ...(input.requestId ? { requestId: input.requestId } : {}) }],
  };
  delete task.runtimeWait.refreshProducts;
  if (input.after.length) {
    delete task.runtimeWait.releasedAt; delete task.runtimeWait.releaseReason;
  } else {
    task.runtimeWait.releasedAt = now;
    task.runtimeWait.releaseReason = `You cleared the wait: ${input.reason}`;
    task.runtimeWait.refreshPending = true;
  }
  return true;
}

export function cancelRuntimeWait(task: DeepMutable<Pick<TaskState, "runtimeWait">>, now: number): void {
  finishRuntimeWait(task, now, "The task was cancelled");
}

/** No new task work remains after publication, completion or cancellation. Preserve how an earlier wait ended. */
function finishRuntimeWait(task: DeepMutable<Pick<TaskState, "runtimeWait">>, now: number, reason: string): boolean {
  const wait = task.runtimeWait;
  if (!wait) return false;
  let changed = false;
  if (wait.releasedAt === undefined) {
    wait.releasedAt = now;
    wait.releaseReason = reason;
    changed = true;
  }
  if (wait.refreshPending !== undefined || wait.refreshAfterStep !== undefined || wait.refreshProducts !== undefined) changed = true;
  delete wait.refreshPending; delete wait.refreshAfterStep; delete wait.refreshProducts;
  return changed;
}

/** Resume unfinished work only from real landing evidence; a finished task retires its hold. */
export function syncRuntimeWait(task: DeepMutable<TaskState>, find: RuntimeWaitLookup, now: number): boolean {
  const wait = task.runtimeWait;
  if (!wait) return false;
  let changed = false;
  if (task.state === "pr-open" || task.state === "done" || task.state === "cancelled") {
    const reason = task.state === "pr-open" ? "Publishing finished; the task is awaiting merge"
      : task.state === "cancelled" ? "The task was cancelled" : "The task finished";
    changed = finishRuntimeWait(task, now, reason);
  }
  if (!runtimeWaitHolds(task) && !openStep(task)?.runtimeWait) return changed;
  if (runtimeWaitHolds(task) && wait.after.every(id => runtimePrerequisite(id, find(id)).landed)) {
    wait.releasedAt = now; wait.releaseReason = "All required tasks landed"; wait.refreshPending = true;
    delete wait.refreshProducts;
    changed = true;
  }
  const view = runtimeWaitView(task, find)!;
  const journeyChanged = syncRuntimeWaitJourney(task, view, now);
  return changed || journeyChanged;
}
