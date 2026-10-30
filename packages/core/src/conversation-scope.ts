import type { Id, Role, Task } from "./model.js";
/** Native callers provide their established digest; this package owns only exact identity projection. */
export type ConversationDigest = (serialized: string) => string;

/** A return keeps its immutable participant, request and approved source identity. */
export function designConversationScope(task: Task, role: unknown, planned: unknown, actual: unknown, digest: ConversationDigest): string {
  return digest(JSON.stringify({
    role,
    planned,
    actual,
    productId: task.productId,
    path: task.worktree,
    title: task.title,
    request: task.description,
    source: task.source,
    base: task.baseSha,
    copies: task.repositories?.map((work) => ({
    productId: work.productId,
    path: work.worktree,
    base: work.baseSha,
    source: work.source
  }))
  }));
}

/** A changed patch is expected; changed assignment or immutable scope starts fresh. */
export function reviewConversationScope(task: Task, stageId: Id, seat: Id, role: Role, planned: unknown, actual: unknown, digest: ConversationDigest): string {
  return digest(JSON.stringify({
    stageId,
    seat,
    role,
    planned,
    actual,
    assignment: task.plan?.stages.find((stage) => stage.id === stageId)?.title,
    title: task.title,
    request: task.description,
    productId: task.productId,
    path: task.worktree,
    source: task.source,
    port: task.portReview,
    updating: task.updating,
    products: task.repositories?.map((work) => ({
    productId: work.productId,
    path: work.worktree,
    source: work.source,
    port: work.portReview,
    updating: work.updating
  }))
  }));
}
