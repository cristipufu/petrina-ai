import { applyAcceptanceVersions, finishTaskStep } from "@petrina/core";
import { executionFor } from "../../src/repository-context.js";
import { WorkCompletion } from "../../src/work-completion.js";
import type { WorkCompletionHost } from "../../src/ports/work-completion.js";
import { acceptanceTask } from "./acceptance.js";

/** Actual completion owner with explicit observations; neither a process nor passing check is invented. */
export function workCompletionFixture(shared = true) {
  const task = acceptanceTask(shared), scope = executionFor(task);
  task.activeProductId = scope.work.productId;
  const versions = Object.fromEntries((task.repositories ?? [scope.work]).map(work => [work.productId, `${work.productId}-observed-tree`]));
  const calls: string[] = [], checkpoints: typeof task[] = [];
  const host: WorkCompletionHost = {
    finishStep(bound) { if (bound !== scope) throw new Error("Unexpected completion execution"); calls.push("finish"); finishTaskStep(bound.task, bound.work, 200); },
    endStage(bound) { if (bound !== scope) throw new Error("Unexpected stage owner"); calls.push("end"); },
    rerun(current) { if (current !== task || current.rereview) throw new Error("Unexpected coordinator rerun"); calls.push("rerun"); return false; },
    async invalidateAcceptance(bound, tested) {
      if (bound !== scope) throw new Error("Unexpected version observation owner");
      calls.push("versions"); applyAcceptanceVersions(bound.task, tested ?? versions);
    },
    checkpoint() { calls.push("checkpoint"); checkpoints.push(structuredClone(task)); },
    changed() { calls.push("changed"); checkpoints.push(structuredClone(task)); },
  };
  const owner = new WorkCompletion(host);
  return { task, scope, versions, calls, checkpoints, host, owner };
}
