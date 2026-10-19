import { REPOSITORY_FIELDS, repositoryTaskView, type DeepMutable, type RepositoryState, type Task } from "@petrina/core";
import type { MTask } from "./kernel.js";

export type RepositoryWork = DeepMutable<RepositoryState>;

/** A stable owner for an operation, retained across every await and callback. */
export interface RepositoryContext {
  readonly task: MTask;
  readonly work: RepositoryWork;
}

/** Bind once at a stage boundary. Every product has an independent execution record. */
export function executionFor(task: MTask, productId = task.activeProductId ?? task.productId): RepositoryContext {
  const work = task.repositories ? task.repositories.find((entry) => entry.productId === productId) : task.repository?.productId === productId ? task.repository : undefined;
  if (!work) throw new Error("That product is outside the approved task.");
  return { task, work };
}

/** Task-wide entry points bind the current step; repository operations pass their existing binding. */
export function executionOf(target: MTask | RepositoryContext): RepositoryContext {
  return "task" in target ? target : executionFor(target);
}

/** A read-only presentation of one repository. Never used to save execution state. */
export function repositoryView({ task, work }: RepositoryContext): Task {
  return repositoryTaskView(task, work);
}

export function taskView(task: MTask): Task {
  if (task.repositories?.length === 0) return task;
  return repositoryView(executionFor(task));
}

/** Discard the former writable projection. Product and delivery remain the task's requested defaults. */
export function detachRepositoryState(task: MTask): void {
  for (const field of REPOSITORY_FIELDS) if (field !== "productId" && field !== "delivery" && field !== "workChoice") Reflect.deleteProperty(task, field);
  if (task.repositories) delete task.repository;
}

/** Convert saved cursor-based tasks once, before any operation can observe them. */
export function restoreRepositoryState(task: DeepMutable<Task>): void {
  const work = task.repositories
    ? task.repositories.find((entry) => entry.productId === task.activeProductId)
    : task.repository ??= { productId: task.productId, delivery: task.delivery, ...(task.workChoice ? { workChoice: task.workChoice } : {}) };
  if (work) for (const field of REPOSITORY_FIELDS) {
    if (field === "productId" || field === "delivery" || field === "workChoice") continue;
    if (task[field] !== undefined) Reflect.set(work, field, task[field]);
  }
  detachRepositoryState(task);
}
