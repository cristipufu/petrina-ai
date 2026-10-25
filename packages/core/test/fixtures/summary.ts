import type { Task } from "../../src/model.js";
import { stateFixture, taskFixture } from "./state.js";

/** A named point in one explicit feature plan, without running unrelated earlier stages. */
export function summaryAt(roleId: "architect" | "design-reviewer" | "builder" | "code-reviewer", round = 1) {
  const state = stateFixture({ now: 0, products: [{ id: "p", name: "Product", repo: "acme/product", tone: "blue" }], pool: { limit: 4, paused: false, toolCaps: {} } });
  const stages = [
    { id: "design", kind: "converge", title: "Design", roleId: "architect", profileIds: ["opus-high"], reviewerRoleId: "design-reviewer", reviewerProfileIds: ["sol-xhigh"], maxRounds: 3 },
    { id: "design-check", kind: "gate", gate: "design", title: "Your design check", roleId: "architect", profileIds: [] },
    { id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-high"] },
    { id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high", "sol-xhigh"], maxRounds: 2 },
    { id: "delivery", kind: "gate", gate: "delivery", title: "Your delivery check", roleId: "release-manager", profileIds: [] },
    { id: "ship", kind: "do", title: "Open a pull request", roleId: "release-manager", profileIds: ["sonnet-medium"] },
  ] as const;
  const stageIndex = roleId === "builder" ? 2 : roleId === "code-reviewer" ? 3 : 0;
  const profileId = roleId === "builder" ? "sol-high" : roleId === "design-reviewer" ? "sol-xhigh" : "opus-high";
  const task: Task = taskFixture(state, { id: "summary", productId: "p", title: "Saved carts", kind: "feature", state: "running", column: "building", holdsSlot: true, approvePlan: false, approveDelivery: true, startedAt: 0, stageIndex, sub: roleId === "design-reviewer" ? 1 : 0, rounds: { [stages[stageIndex].id]: round }, plan: { rationale: "Feature summary", plannerProfileId: "sonnet-medium", stages }, agent: { roleId, profileId, since: 0, step: 0 }, statusLine: "Reading the code", journey: [{ id: "active", kind: "agent", stageId: stages[stageIndex].id, roleId, profileId, startedAt: 0, round, sub: 0 }] });
  return { state, task };
}
