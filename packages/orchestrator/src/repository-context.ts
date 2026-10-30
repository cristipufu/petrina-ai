import { REPOSITORY_FIELDS, repositoryTaskView, type DeepMutable, type RepositoryState, type Task, type TaskRepository } from "@petrina/core";
import type { RuntimeTask } from "./model.js";

/** Shared-only preparation/delivery metadata is absent on a single-product owner. */
export type RepositoryWork = DeepMutable<RepositoryState> & Partial<DeepMutable<Omit<TaskRepository, keyof RepositoryState>>>;

/** A stable owner for an operation, retained across every await and callback. */
export interface RepositoryContext {
  readonly task: RuntimeTask;
  readonly work: RepositoryWork;
}

/** All canonical owners, in approved order. An unapproved empty map stays empty. */
export function scopesFor(task: RuntimeTask, options: { includeExcluded?: boolean } = {}): RepositoryContext[] {
  const included = task.repositories ?? (task.repository ? [task.repository] : []);
  return [...included, ...(options.includeExcluded ? task.excludedRepositories ?? [] : [])].map((work) => ({ task, work }));
}

/** The native preparation host asks this after preparing every approved repository. */
export function nextWorkspaceProduct(task: RuntimeTask, editingProgress?: string): string {
  if (!task.repositories?.length) throw new Error("There is no approved shared workspace to select.");
  return task.repair?.products[task.repair.index]
    ?? (editingProgress ? task.repositories.find(work => !work.completedStages.includes(editingProgress))?.productId : undefined)
    ?? task.leadProductId ?? task.repositories[0]!.productId;
}

/** Bind once at a stage boundary. Every product has an independent execution record. */
export function executionFor(task: RuntimeTask, productId = task.activeProductId ?? task.productId): RepositoryContext {
  const work = task.repositories ? task.repositories.find((entry) => entry.productId === productId) : task.repository?.productId === productId ? task.repository : undefined;
  if (!work) throw new Error("That product is outside the approved task.");
  return { task, work };
}

/** Task-wide entry points bind the current step; repository operations pass their existing binding. */
export function executionOf(target: RuntimeTask | RepositoryContext): RepositoryContext {
  return "task" in target ? target : executionFor(target);
}

/** A read-only presentation of one repository. Never used to save execution state. */
export function repositoryView({ task, work }: RepositoryContext): Task {
  return repositoryTaskView(task, work);
}

export function taskView(task: RuntimeTask): Task {
  if (task.repositories?.length === 0) return task;
  return repositoryView(executionFor(task));
}

/** Discard the former writable projection. Product and delivery remain the task's requested defaults. */
export function detachRepositoryState(task: RuntimeTask): void {
  for (const field of REPOSITORY_FIELDS) if (field !== "productId" && field !== "delivery" && field !== "workChoice") Reflect.deleteProperty(task, field);
  if (task.repositories) delete task.repository;
}

/** Convert saved cursor-based tasks once, before any operation can observe them. */
export function restoreRepositoryState(task: DeepMutable<Task>): void {
  Reflect.deleteProperty(task, "prAge");
  const work = task.repositories
    ? task.repositories.find((entry) => entry.productId === task.activeProductId)
    : task.repository ??= { productId: task.productId, delivery: task.delivery, ...(task.workChoice ? { workChoice: task.workChoice } : {}) };
  if (work) for (const field of REPOSITORY_FIELDS) {
    if (field === "productId" || field === "delivery" || field === "workChoice") continue;
    if (task[field] !== undefined) Reflect.set(work, field, task[field]);
  }
  detachRepositoryState(task);
}
