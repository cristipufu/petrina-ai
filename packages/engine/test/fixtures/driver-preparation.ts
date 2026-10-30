import { join } from "node:path";
import { executionFor } from "@petrina/orchestrator";
import { makeProduct } from "@petrina/test-support/repositories";
import { rejectionOf } from "@petrina/test-support/rejections";
import type { EngineCaseOwner } from "./engine-cases.js";
import { installPreparedProduct, privateCloneProduct } from "./prepared-product.js";

/** Real working-copy preparation, without planning, agent startup or source discovery. */
export async function driverPreparation(owner: EngineCaseOwner, objectFormat: "sha1" | "sha256" = "sha1") {
  const path = await owner.prepare(() => makeProduct(join(owner.root, "product"), { objectFormat }));
  const engine = owner.open(join(owner.root, "data"), { agentCommand: () => undefined });
  engine.setPoolPaused(true);
  engine.schedule = () => {};
  await owner.run(engine, async () => { await engine.waitUntilReady(); await Promise.all([...engine.backgroundWork]); });
  owner.check();
  engine.stopRequested.signal.throwIfAborted();
  const productId = installPreparedProduct(engine, privateCloneProduct(path));
  const product = engine.s.products.find(product => product.id === productId)!;
  const task = engine.task(engine.addTask({ productId, title: "Prepare the approved working copy", delivery: "local", backlog: true }))!;
  task.repositories = [{ productId, delivery: "local", completedStages: [] }];
  delete task.repository;
  task.activeProductId = productId;
  task.leadProductId = productId;
  const scope = executionFor(task);
  scope.work.source = { product: { ...product }, start: { kind: "default", branch: "main" },
    destination: { mode: "local", kind: "branch", repo: product.repo, branch: "main" }, confirmed: true };
  return { engine, task, scope, path, product,
    prepare: (signal = new AbortController().signal) => owner.run(engine, () => engine["driver"]["prepare"](scope, signal)),
    prepareFailure: (signal = new AbortController().signal) => owner.run(engine, () => rejectionOf(engine["driver"]["prepare"](scope, signal))),
  };
}
