import { stateFixture, taskFixture } from "./state.js";

/** Explicit workflow facts for decisions; no completed demo, simulated agents or hidden history. */
export function workflowFixture() {
  const state = stateFixture();
  const task = taskFixture(state, {
    title: "Workflow rules", kind: "bug", state: "waiting", stageIndex: 0, approveDelivery: true,
    plan: { rationale: "Build, review and deliver", plannerProfileId: "sonnet-medium", stages: [
      { id: "build", kind: "do", title: "Fix", roleId: "builder", profileIds: ["opus-high"] },
      { id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["sol-xhigh", "sonnet-medium"], maxRounds: 2 },
      { id: "delivery", kind: "gate", title: "Your delivery check", roleId: "release-manager", profileIds: [], gate: "delivery" },
      { id: "ship", kind: "do", title: "Open a pull request", roleId: "release-manager", profileIds: ["sonnet-medium"] },
    ] },
    brief: { summary: "A focused repair", forUsers: [], areas: [], risks: [], acceptance: [] },
  });
  return { state, task };
}
