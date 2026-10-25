import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { detachRepositoryState } from "@petrina/orchestrator";
import { completeAll } from "@petrina/core";
import { makeProduct } from "@petrina/test-support/repositories";
import { tempDir } from "@petrina/test-support/fixtures";
import { Engine } from "../engine.js";
import type { MachineRecords } from "../../src/check-interruption.js";

export interface RepositoryRecordOptions {
  /** Only an owner whose real Git boundary is asserted gets a repository. */
  git?: readonly ("first" | "second")[];
  machineRecords?: MachineRecords;
}

/** Saved repository inputs in a real private Engine/SQLite store, with no planning or provider transport. */
export async function repositoryRecords(name: string, roots: string[], options: RepositoryRecordOptions = {}) {
  const root = tempDir(`petrina-repository-${name}-`);
  roots.push(root);
  const products = await completeAll((["first", "second"] as const).map(async (id, index) => {
    const folder = join(root, id);
    mkdirSync(folder, { recursive: true });
    const path = options.git?.includes(id) ? await makeProduct(folder) : join(folder, "recorded-worktree");
    return { id, name: index ? "Second" : "First", repo: `acme/${id}`, path, tone: "blue" as const };
  }));
  const start = () => new Engine(join(root, "data"), { ...(options.machineRecords ? { machineRecords: options.machineRecords } : {}) });
  const engine = start();
  engine.setPoolPaused(true);
  // These tests invoke their owning operation explicitly. A restart gets the real scheduler again.
  engine.schedule = () => {};
  try {
    await engine.waitUntilReady();
    await Promise.all([...engine.backgroundWork]);
    engine.s.products.push(...products);
    const id = engine.addTask({ productId: "first", title: "Keep each repository's execution state", backlog: true });
    const task = engine.task(id)!;
    task.repositories = products.map(product => ({ productId: product.id, worktree: product.path, delivery: "local", branch: `task-${product.id}`,
      report: { summary: `${product.id} report`, changes: [] },
      builderSession: { stageId: "build", profileId: "sol-high", toolId: "codex", model: "sol", sessionId: `${product.id}-conversation` }, completedStages: [] }));
    task.activeProductId = "first";
    detachRepositoryState(task);
    return { engine, start, task, id };
  } catch (error) { await engine.shutdown(); throw error; }
}
