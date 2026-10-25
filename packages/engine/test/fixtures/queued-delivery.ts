import type { Engine } from "../engine.js";
import { prepareSharedDelivery } from "./shared-preparation.js";

/** Shipping-only inputs: use real private Git prerequisites and retain native checks and publication. */
export async function queuePreparedDelivery(engine: Engine, input: Parameters<Engine["addTask"]>[0]) {
  const id = engine.addTask({ ...input, backlog: true });
  const task = engine.task(id)!;
  // Source selection normally materializes this product default during plan approval.
  // This fixture starts after that decision, so preserve the same explicit choice as its input.
  task.approveDelivery = input.approveDelivery ?? engine.productOf(task)?.approveDelivery ?? true;
  await prepareSharedDelivery(engine, id);
  if (!task.approveDelivery) task.stageIndex = 3;
  engine.schedule();
  return id;
}
