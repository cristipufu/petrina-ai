import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { detachRepositoryState } from "@petrina/orchestrator";
import { completeAll } from "@petrina/core";
import { makeProduct } from "@petrina/test-support/repositories";
import { tempDir } from "@petrina/test-support/fixtures";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import type { Engine, EngineOptions } from "../engine.js";
import type { MachineRecords } from "../../src/check-interruption.js";
import { privateAgentToolProbe } from "../scripted-probes.js";
import { directDrivers } from "./direct-drivers.js";
import { installSharedWorkflowFastPaths } from "./shared-preparation.js";

export interface RepositoryRecordOptions {
  /** Only an owner whose real Git boundary is asserted gets a repository. */
  git?: readonly ("first" | "second")[];
  machineRecords?: MachineRecords;
  runCheckCommand?: EngineOptions["runCheckCommand"];
}

/** Saved repository inputs in a real private Engine/SQLite store, with no planning or provider transport. */
async function repositoryRecords(options: RepositoryRecordOptions, owner: { root: string; open(dataDir: string, options: EngineOptions): Engine }) {
  const root = owner.root;
  const products = await completeAll((["first", "second"] as const).map(async (id, index) => {
    const folder = join(root, id);
    mkdirSync(folder, { recursive: true });
    const path = options.git?.includes(id) ? await makeProduct(folder) : join(folder, "recorded-worktree");
    return { id, name: index ? "Second" : "First", repo: `acme/${id}`, path, tone: "blue" as const };
  }));
  const start = () => {
    const settings: EngineOptions = {
      toolProbe: privateAgentToolProbe(),
      ...(options.machineRecords ? { machineRecords: options.machineRecords } : {}),
      ...(options.runCheckCommand ? { runCheckCommand: options.runCheckCommand } : {}),
    };
    return installSharedWorkflowFastPaths(owner.open(join(root, "data"), settings));
  };
  const engine = start();
  engine.setPoolPaused(true);
  // These tests invoke their owning operation explicitly. A restart gets the real scheduler again.
  engine.schedule = () => {};
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
}

export type RepositoryRecords = Awaited<ReturnType<typeof repositoryRecords>>;
export type OwnedRepositoryRecords = RepositoryRecords & {
  owners: ReturnType<typeof directDrivers>;
  run<R>(start: () => Promise<R>): Promise<R>;
};

/** Bounded native setup, complete case work and manual runs, using the canonical owner. */
export async function withRepositoryRecords<T>(name: string, options: RepositoryRecordOptions,
  body: (fixture: OwnedRepositoryRecords) => Promise<T>): Promise<T> {
  const root = tempDir(`petrina-repository-${name}-`), owners = directDrivers(root);
  const fixture = await setupWithCleanup(() => owners.prepare(() => repositoryRecords(options, {
    root, open: (dataDir, settings) => owners.open(dataDir, settings),
  })), () => owners.close());
  const result = await setupWithCleanup(() => owners.prepare(() => body({ ...fixture, owners,
    run: <R>(start: () => Promise<R>) => owners.run(fixture.engine, start),
  })), () => owners.close());
  await owners.close();
  return result;
}
