import { createTaskState } from "@petrina/core";
import { cpSync } from "node:fs";
import { join } from "node:path";
import { repositorySeed } from "@petrina/test-support/repositories";

/** Private canonical task data; no running Engine, agents, checks or persistence. */
export function observationTask(worktree?: string, baseSha?: string) {
  const task = createTaskState({ productId: "product", title: "Observe committed code", backlog: true },
    [{ id: "product", name: "Product", repo: "local/product", tone: "blue" }],
    { id: "task", timelineId: "created", now: 100, priority: 0 });
  task.repository = { productId: "product", delivery: "local", ...(worktree ? { worktree } : {}), ...(baseSha ? { baseSha } : {}) };
  return task;
}

/** The seed is immutable; this test owns independent refs, objects and writable contents. */
export async function observationRepository(root: string, format: "sha1" | "sha256") {
  const seed = await repositorySeed(undefined, false, format), path = join(root, "repository");
  cpSync(seed.clone, path, { recursive: true });
  return { path, base: seed.head, task: observationTask(path, seed.head) };
}
