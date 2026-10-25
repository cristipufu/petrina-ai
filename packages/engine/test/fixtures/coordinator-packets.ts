import { BUILT_IN_ROLES, createTaskState, type Product } from "@petrina/core";
import { executionFor } from "@petrina/orchestrator";

/** Exact task/catalog data for packet contracts, with no demo history or runtime effects. */
export function coordinatorPacketState() {
  const product: Product = { id: "packet-product", name: "Product", repo: "local/product", tone: "blue", delivery: "local" };
  const task = createTaskState({ productId: product.id, title: "Keep coordinator decisions", description: "Preserve the complete recorded instructions.", backlog: true },
    [product], { id: "packet-task", timelineId: "created", now: 1_000_000_000, priority: 0 });
  task.repository = { productId: product.id, delivery: task.delivery };
  task.notes = []; task.queued = []; task.stepNotes = [];
  // Preservation assertions need existing records to lose, without unrelated demo journeys.
  task.session = [
    { id: "earlier-agent", at: 20, from: "agent", roleId: "builder", profileId: "sol-high", text: "An existing handoff remains recorded." },
    { id: "earlier-message", at: 30, from: "you", coordinatorMessageId: "older-guidance", text: "Previously delivered guidance remains in the transcript." },
  ];
  return { task, scope: executionFor(task), role: BUILT_IN_ROLES.find(role => role.result === "build")! };
}
