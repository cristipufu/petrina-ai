import type { NewTaskInput } from "../../src/commands.js";
import type { Product } from "../../src/model.js";
import { createTaskState } from "../../src/task-transitions.js";

export const products: Product[] = [
  { id: "a", name: "Shop", repo: "local/shop", tone: "blue", delivery: "local", approveDelivery: false },
  { id: "b", name: "Notes", repo: "local/notes", tone: "green", delivery: "pull-request", approveDelivery: true },
];
export function request(input: Partial<NewTaskInput> = {}, id = "task") {
  return createTaskState({ productId: "a", title: "  Tidy the footer  ", ...input }, products, { id, timelineId: `${id}-added`, now: 100, priority: 4 });
}
