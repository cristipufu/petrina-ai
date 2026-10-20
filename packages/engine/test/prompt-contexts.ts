// Stable situations for comparing built-in role contracts. `today-prompts.json` retains the
// role-editing baseline with deliberate shared-policy updates; assertions separately cover
// newer planning and screen behavior rather than regenerating every fixture on each change.
import { BUILT_IN_ROLES, createDemoState, DEFAULT_PROFILES, DEMO_PRODUCTS, type DeliveryMode, type Role, type Task } from "@petrina/core";
import type { PromptContext } from "../src/prompts.js";

const base: Task = {
  ...createDemoState(1_000_000_000).tasks[0]!,
  // The prompt fixture keeps its task wording when main changes the demo's order.
  title: "Guest checkout",
  description: "Let people buy without creating an account. Ask for an email so they get the receipt.",
  kind: "feature",
  risk: { level: "medium", why: "New behaviour in one part of the product." },
};
const role = (id: string): Role => BUILT_IN_ROLES.find((entry) => entry.id === id)!;
const SECTIONS = [{ title: "Design brief", body: "A greeting file.\n\nAcceptance checklist:\n- A greeting file exists" }];

function context(roleId: string, task: Task = base, sections: PromptContext["sections"] = SECTIONS): PromptContext {
  return {
    task,
    product: { ...DEMO_PRODUCTS[0]!, path: "/tmp/shop", releaseBump: "minor" },
    role: role(roleId),
    roles: BUILT_IN_ROLES,
    profiles: DEFAULT_PROFILES,
    worktree: "/tmp/worktree",
    branch: "petrina/task",
    base: "abc1234",
    defaultBranch: "main",
    sections,
  };
}

const design = { id: "t:design", kind: "converge" as const, title: "Design", roleId: "architect", profileIds: ["opus-high"], reviewerRoleId: "design-reviewer", reviewerProfileIds: ["codex-xhigh"], maxRounds: 3 };
const following: Task = {
  ...base,
  plan: { stages: [design], rationale: "Design it.", plannerProfileId: "sonnet-medium" },
  stageIndex: 0,
  call: { text: "Keep it in English.", stageId: design.id, open: ["o1"], at: 1 },
  objections: [{ id: "o1", round: 1, text: "Which languages?", blocking: true, raisedBy: "codex-xhigh", status: "open" }],
};
const settled: Task = { ...following, objections: [{ ...following.objections[0]!, status: "rejected", call: "Keep it in English." }] };
const delivering = (delivery: DeliveryMode): Task => ({ ...base, delivery });

/** Every situation, by name. */
export function promptContexts(): Record<string, PromptContext> {
  const contexts: Record<string, PromptContext> = {};
  for (const entry of BUILT_IN_ROLES) {
    contexts[entry.id] = context(entry.id);
    contexts[`${entry.id} with no sections`] = context(entry.id, base, []);
  }
  contexts["builder fixing review findings"] = context("builder", { ...base, fixing: true });
  contexts["architect following the coordinator's call"] = context("architect", following);
  contexts["design reviewer after the coordinator's call"] = context("design-reviewer", settled);
  contexts["release-manager publishing a release"] = context("release-manager", delivering("release"));
  contexts["release-manager committing to main"] = context("release-manager", delivering("local"));
  return contexts;
}
