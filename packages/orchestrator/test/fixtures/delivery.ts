import { afterChangesAsked, BUILT_IN_ROLES } from "@petrina/core";
import { executionFor, type RuntimeTask } from "../../src/index.js";
import { acceptanceTask } from "./acceptance.js";

export function deliveryReturnTask(shared = true, fromCheck = 4) {
  const task = acceptanceTask(shared);
  task.stageIndex = fromCheck;
  const scope = executionFor(task);
  const input = { note: "Try a different approach", fromCheck, now: 200 };
  return { task, scope, input, transition() { afterChangesAsked(task, "delivery", input.note, input.now, BUILT_IN_ROLES); } };
}

export function importantFor(task: RuntimeTask, products: string[]) {
  task.findings.push({ id: "important", text: "The guest loses its work", productIds: products,
    severity: "blocking", raisedBy: "reviewer", confirmedBy: [], status: "open" });
}
