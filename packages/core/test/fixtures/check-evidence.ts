import { setupWork, setupExecutor } from "./check-setup.js";
import { builderReturnWords } from "../../src/check-evidence.js";
import { BUILT_IN_ROLES, DEFAULT_PROFILES } from "../../src/library.js";
import { createTaskState } from "../../src/task-transitions.js";
import type { CheckRun, Task } from "../../src/model.js";
import type { DeepMutable } from "../../src/flow.js";
import { completeCheckExecution } from "@petrina/test-support/check-execution-facts";

export const now = 1_000_000_000_000;
export function fixture(ok = false) {
  const state = { roles: BUILT_IN_ROLES, profiles: DEFAULT_PROFILES };
  const product = { id: "shop", name: "Shop", repo: "acme/shop", tone: "blue" as const };
  const task: DeepMutable<Task> = createTaskState({ productId: product.id, title: "Check the saved evidence", backlog: true }, [product],
    { id: "task", timelineId: "created", now, priority: 0 });
  // These cases describe a completed native pass/failure, separately from later reuse and code changes.
  const run: CheckRun = {
    name: "Tests",
    command: "bun run test",
    ok,
    execution: completeCheckExecution(ok ? 0 : 7),
    executor: { ...setupExecutor, runtime: { ...setupExecutor.runtime } },
    ms: 41_000,
    output: ok ? "passed" : "Original failure diagnostic",
    startedAt: now - 90_000,
    endedAt: now - 49_000,
    source: { stepId: "original", attemptId: "run-2", checkId: "run-2:check-0" },
  };
  // Explicit modeled modern observations for rule tests. Legacy cases remove these facts deliberately.
  const modeled = setupWork([run]);
  task.checkSetup = modeled.checkSetup;
  task.checks = { ...modeled.checks!, at: now - 49_000, current: true, results: [run] };
  task.checkReturns = 2;
  task.journey = [
    {
      id: "original",
      kind: "petrina",
      work: "checks",
      round: 1,
      sub: 0,
      startedAt: run.startedAt!,
      endedAt: run.endedAt,
      productChecks: [{
        id: run.source!.checkId,
        attemptId: "run-2",
        productId: task.productId,
        name: run.name,
        result: ok ? "pass" : "fail",
        run,
      }],
    },
    {
      id: "builder",
      kind: "agent",
      roleId: "renamed-builder",
      fixing: true,
      round: 1,
      sub: 0,
      startedAt: now - 40_000,
      endedAt: now - 1,
      builderReturn: {
        productId: task.productId,
        changed: false,
        claimedFixes: 0,
        outcome: builderReturnWords(false, ok ? undefined : "failing"),
      },
    },
  ];
  return { state, task, run };
}

