import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { detachRepositoryState } from "@petrina/orchestrator";
import { completeAll } from "@petrina/core";
import { makeProduct } from "@petrina/test-support/repositories";
import { tempDir } from "@petrina/test-support/fixtures";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { Engine, type EngineOptions } from "../engine.js";
import type { MachineRecords } from "../../src/check-interruption.js";
import { directDrivers } from "./direct-drivers.js";

export interface RepositoryRecordOptions {
  /** Only an owner whose real Git boundary is asserted gets a repository. */
  git?: readonly ("first" | "second")[];
  machineRecords?: MachineRecords;
  /** An existing fixture owns setup and every Engine before either starts. */
  owner?: { root: string; open(dataDir: string, options: EngineOptions): Engine };
}

/** Saved repository inputs in a real private Engine/SQLite store, with no planning or provider transport. */
export async function repositoryRecords(name: string, roots: string[], options: RepositoryRecordOptions = {}) {
  const root = options.owner?.root ?? tempDir(`petrina-repository-${name}-`);
  if (!options.owner) roots.push(root);
  const products = await completeAll((["first", "second"] as const).map(async (id, index) => {
    const folder = join(root, id);
    mkdirSync(folder, { recursive: true });
    const path = options.git?.includes(id) ? await makeProduct(folder) : join(folder, "recorded-worktree");
    return { id, name: index ? "Second" : "First", repo: `acme/${id}`, path, tone: "blue" as const };
  }));
  const start = () => {
    const settings = { ...(options.machineRecords ? { machineRecords: options.machineRecords } : {}) };
    return options.owner ? options.owner.open(join(root, "data"), settings) : new Engine(join(root, "data"), settings);
  };
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
  } catch (error) {
    // An injected owner joins setup and preserves both its error and any cleanup failure.
    if (!options.owner) await engine.shutdown();
    throw error;
  }
}

/** Bounded native setup, complete case work and manual runs, using the canonical owner. */
export async function withRepositoryRecords<T>(name: string, options: Omit<RepositoryRecordOptions, "owner">,
  body: (fixture: Awaited<ReturnType<typeof repositoryRecords>> & { run<R>(start: () => Promise<R>): Promise<R> }) => Promise<T>): Promise<T> {
  const root = tempDir(`petrina-repository-${name}-`), owners = directDrivers(root);
  const fixture = await setupWithCleanup(() => owners.prepare(() => repositoryRecords(name, [], {
    ...options, owner: { root, open: (dataDir, settings) => owners.open(dataDir, settings) },
  })), () => owners.close());
  const result = await setupWithCleanup(() => owners.prepare(() => body({ ...fixture,
    run: <R>(start: () => Promise<R>) => owners.run(fixture.engine, start),
  })), () => owners.close());
  await owners.close();
  return result;
}
