import { BUILT_IN_ROLES, createTaskState, type Product, roleForTask } from "@petrina/core";
import { executionFor } from "@petrina/orchestrator";
import { Context, type ContextHost } from "../../src/context.js";

/** Context consumes saved state here, not a running Engine, Git inspection, or an agent's claim of native evidence. */
export function acceptanceContext(root: string) {
  const products: Product[] = [{ id: "a", name: "Product 1", repo: "local/one", tone: "blue" }, { id: "b", name: "Product 2", repo: "local/two", tone: "green" }];
  const task = createTaskState({ productId: "a", title: "Show the greeting", backlog: true }, products, { id: "acceptance-context", timelineId: "created", now: 100, priority: 0 });
  task.repositories = products.map(product => ({ productId: product.id, delivery: "local", completedStages: ["build"], ...(product.id === "a" ? { acceptanceReturns: 2 } : {}) }));
  delete task.repository; task.activeProductId = "a"; task.state = "running"; task.stageIndex = 2;
  task.plan = { rationale: "Context for an acceptance repair and its owed reviews", plannerProfileId: "sol-high", stages: [
    { id: "build", title: "Build", kind: "do", roleId: "builder", profileIds: ["sol-high"] },
    { id: "test", title: "Acceptance", kind: "do", roleId: "tester", profileIds: ["opus-high"] },
    { id: "review", title: "Review", kind: "review-chain", roleId: "code-reviewer", profileIds: ["opus-high", "sol-high"], maxRounds: 2 },
    { id: "security", title: "Security review", kind: "review-chain", roleId: "security-reviewer", profileIds: ["opus-high"], maxRounds: 2 },
    { id: "added-check", title: "Your delivery check", kind: "gate", gate: "delivery", roleId: "release-manager", profileIds: [] },
    { id: "ship", title: "Ship", kind: "do", roleId: "release-manager", profileIds: ["opus-high"] },
  ] };
  const scope = executionFor(task);
  const host: ContextHost = { dataDir: root, s: { tasks: [task], roles: BUILT_IN_ROLES },
    role: (id, owner) => roleForTask(BUILT_IN_ROLES, id, owner),
    productOf: bound => products.find(product => product.id === bound.work.productId),
    store: { history: { checkEvidence() { throw new Error("These acceptance inputs have no native check failure to inspect"); } } },
  };
  const context = new Context(host, { pendingPoints: async () => [] }, async () => { throw new Error("These context records carry no passing product checks"); });
  return { task, scope, host, context, products };
}
