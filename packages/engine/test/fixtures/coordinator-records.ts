import { Engine } from "../engine.js";
import { tempDir } from "../fixtures.js";
import { executionFor } from "@petrina/orchestrator";

/** Real private records and command composition, without repository or provider prerequisites. */
export async function coordinatorRecords(roots: string[], options: { prefix?: string; title?: string; productPath?: boolean; repo?: string; paused?: boolean } = {}) {
  const root = tempDir(options.prefix ?? "petrina-coordinator-records-");
  roots.push(root);
  const engine = new Engine(root, { admissionsClosed: true, agentCommand: () => undefined });
  try {
    await engine.waitUntilReady();
    await Promise.all([...engine.backgroundWork]);
    // Admission-refusal contracts retain the constructor's pool state; never resume a draining owner.
    if (options.paused ?? true) engine.setPoolPaused(true);
    engine.s.products.push({ id: "p", name: "Product", repo: options.repo ?? "local/p", tone: "blue", ...(options.productPath ? { path: root } : {}) });
    const task = engine.task(engine.addTask({ productId: "p", title: options.title ?? "A task", backlog: true }))!;
    return { engine, task, root, scope: executionFor(task) };
  } catch (error) { await engine.shutdown(); throw error; }
}
