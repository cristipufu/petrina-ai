import type { CheckRun } from "@petrina/core";
import { completeCheckExecution } from "@petrina/test-support/check-execution-facts";
import { CheckRepairs } from "../../src/check-repairs.js";
import type { CheckRepairHost } from "../../src/ports/check-repairs.js";
import { executionFor } from "../../src/repository-context.js";
import { repairHost, repairTask } from "./tasks.js";

/** Modeled boundary observations; this fixture executes the actual policy without claiming native execution. */
export function checkRepairs(shared = false) {
  const task = repairTask(shared), scope = executionFor(task), recording = repairHost();
  let sequence = 0, definition = "declared-checks";
  const calls: string[] = [], notes: { productId: string; text: string }[] = [];
  scope.work.worktree = "modeled:working-copy";
  const host: CheckRepairHost = {
    ...recording.host,
    id: () => `finding-${++sequence}`,
    async definition(bound, sha) { calls.push(`definition:${bound.work.productId}:${sha}`); return definition; },
    log(bound, _tone, text) { notes.push({ productId: bound.work.productId, text }); },
    changed() { calls.push("changed"); }, checkpoint() { calls.push("checkpoint"); },
  };
  return { task, scope, host, calls, notes, checkpoints: recording.checkpoints, controller: new CheckRepairs(host),
    definition(value: string) { definition = value; } };
}

export function observedCheck(code = 1): CheckRun {
  return { name: "Tests", command: "test-product", ok: code === 0, output: code ? "An assertion failed" : "All assertions passed",
    ms: 1, execution: completeCheckExecution(code) };
}
export const findingText = (run = observedCheck()) => `Check failed: ${run.name} (${run.command})`;
