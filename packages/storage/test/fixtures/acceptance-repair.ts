import { beginAgentStep, BUILT_IN_ROLES, createTaskState, endAgentStep, DEFAULT_PROFILES, KNOWN_TOOLS, type DeepMutable, type Product, type State } from "@petrina/core";

/** The exact old saved shape: an early repair has finished, but only retest records its owed Tester. */
export function legacyRepairState(): DeepMutable<State> {
  const products: Product[] = [{ id: "a", name: "Product 1", repo: "local/one", tone: "blue" }, { id: "b", name: "Product 2", repo: "local/two", tone: "green" }];
  const task = createTaskState({ productId: "a", title: "Show the greeting", backlog: true }, products, { id: "legacy-repair", timelineId: "created", now: 1_000, priority: 0 });
  task.repositories = products.map(product => ({ productId: product.id, delivery: "local", completedStages: ["build"], ...(product.id === "a" ? { acceptanceReturns: 1 } : {}) }));
  delete task.repository; task.activeProductId = "a";
  task.state = "paused"; task.stageIndex = 1; task.retest = true; task.proofDeliveryGate = "added-check";
  task.plan = { rationale: "Restored early repair before owed reviews", plannerProfileId: "sol-high", stages: [
    { id: "build", title: "Build", kind: "do", roleId: "builder", profileIds: ["sol-high"] },
    { id: "test", title: "Acceptance", kind: "do", roleId: "tester", profileIds: ["opus-high"] },
    { id: "review", title: "Review", kind: "review-chain", roleId: "code-reviewer", profileIds: ["sol-high", "opus-high"], maxRounds: 2 },
    { id: "security", title: "Security review", kind: "review-chain", roleId: "security-reviewer", profileIds: ["opus-high"], maxRounds: 2 },
    { id: "added-check", title: "Your delivery check", kind: "gate", gate: "delivery", roleId: "release-manager", profileIds: [] },
    { id: "ship", title: "Ship", kind: "do", roleId: "release-manager", profileIds: ["opus-high"] },
  ] };
  // Recorded history is part of the old shape: the next Tester is genuinely a repeated run.
  const firstTest = beginAgentStep(task, "tester", "opus-high", 200, BUILT_IN_ROLES, undefined, task.repositories[0]!);
  firstTest.agentResults = [{ roleId: "tester", profileId: "opus-high", at: 201, value: { summary: "The greeting failed", checks: [{ text: "Greeting", result: "fail" }] } }];
  endAgentStep(task, { outcome: "1 failed", reason: "Acceptance failed" }, 202);
  task.stageIndex = 0;
  beginAgentStep(task, "builder", "sol-high", 203, BUILT_IN_ROLES, undefined, task.repositories[0]!);
  endAgentStep(task, { outcome: "Changes returned", reason: "Ready for acceptance" }, 204);
  task.stageIndex = 1;
  const state = { now: 1_000, seq: 1, products, tasks: [task], inbox: [], roles: BUILT_IN_ROLES, profiles: DEFAULT_PROFILES, tools: KNOWN_TOOLS, pool: { limit: 3, paused: true, toolCaps: {} } } satisfies State;
  return JSON.parse(JSON.stringify(state)) as DeepMutable<State>;
}
