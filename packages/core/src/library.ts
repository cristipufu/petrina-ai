import type { AgentProfile, Plan, Role, Stage, Task, Tool } from "./model.js";

/** The roles every product starts with. They are data, so the coordinator can edit them. */
export const BUILT_IN_ROLES: readonly Role[] = [
  {
    id: "planner",
    name: "Planner",
    icon: "map",
    tone: "indigo",
    purpose: "Reads the task and composes the plan: which roles, on which tools, in what order.",
    canEdit: false,
    sees: "The task, an overview of the product, the role library and the tools on this machine.",
    handsBack: "A plan, with a reason for every stage.",
    column: "planning",
  },
  {
    id: "researcher",
    name: "Researcher",
    icon: "book",
    tone: "orange",
    purpose: "Finds out what users expect and how others solved it before anything is designed.",
    canEdit: false,
    sees: "The task and the product.",
    handsBack: "Research notes with sources.",
    column: "designing",
  },
  {
    id: "architect",
    name: "Architect",
    icon: "compass",
    tone: "violet",
    purpose: "Designs how the change should work for users and in the product.",
    canEdit: false,
    sees: "The task, research notes and the product.",
    handsBack: "A design brief: what changes for users, which parts change, acceptance checklist, risks.",
    column: "designing",
  },
  {
    id: "design-reviewer",
    name: "Design reviewer",
    icon: "scale",
    tone: "purple",
    purpose: "Challenges the design until nothing blocking is left.",
    canEdit: false,
    sees: "The design brief and the product. Never the architect's transcript.",
    handsBack: "Objections, each blocking or not.",
    column: "designing",
  },
  {
    id: "ux-designer",
    name: "UX designer",
    icon: "palette",
    tone: "pink",
    purpose: "Shapes the screens and the words users will see.",
    canEdit: false,
    sees: "The design brief and the product's current screens.",
    handsBack: "UI notes and screen sketches.",
    column: "designing",
  },
  {
    id: "builder",
    name: "Builder",
    icon: "hammer",
    tone: "blue",
    purpose: "Implements the design in its own working copy and keeps the tests green.",
    canEdit: true,
    sees: "The design brief, the acceptance checklist and review findings.",
    handsBack: "A change ready for review and a plain-language summary of it.",
    column: "building",
  },
  {
    id: "tester",
    name: "Tester",
    icon: "flask",
    tone: "green",
    purpose: "Runs the product like a user and checks every acceptance item.",
    canEdit: false,
    sees: "The acceptance checklist and the running product.",
    handsBack: "Pass or fail per acceptance item, with screenshots.",
    column: "building",
  },
  {
    id: "code-reviewer",
    name: "Code reviewer",
    icon: "search",
    tone: "teal",
    purpose: "Tries to prove the change is not done. Pass or fail, never a score.",
    canEdit: false,
    sees: "The design, the acceptance checklist, the change and earlier verdicts. Never the builder's transcript.",
    handsBack: "Findings, each pass or fail with where it is and the evidence.",
    column: "reviewing",
  },
];

/** Tools Petrina knows how to start through their ACP adapters. */
export const KNOWN_TOOLS: readonly Tool[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    command: ["npx", "-y", "@agentclientprotocol/claude-agent-acp"],
    status: "ready",
    models: ["Opus 5.5", "Sonnet 5.5", "Haiku 5.5"],
  },
  {
    id: "codex",
    name: "Codex",
    command: ["npx", "-y", "@agentclientprotocol/codex-acp"],
    status: "ready",
    models: ["sol"],
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    command: ["gemini", "--experimental-acp"],
    status: "not-installed",
    models: [],
  },
  {
    id: "opencode",
    name: "OpenCode",
    command: ["opencode", "acp"],
    status: "not-installed",
    models: [],
  },
];

export const DEFAULT_PROFILES: readonly AgentProfile[] = [
  { id: "opus-high", toolId: "claude-code", model: "Opus 5.5", effort: "high" },
  { id: "sonnet-medium", toolId: "claude-code", model: "Sonnet 5.5", effort: "medium" },
  { id: "codex-xhigh", toolId: "codex", model: "sol", effort: "xhigh" },
  { id: "codex-high", toolId: "codex", model: "sol", effort: "high" },
];

const PLANNER_PROFILE = "sonnet-medium";

const designStages = (taskId: string): Stage[] => [
  {
    id: `${taskId}:design`,
    kind: "converge",
    title: "Design",
    roleId: "architect",
    profileIds: ["opus-high"],
    reviewerRoleId: "design-reviewer",
    reviewerProfileIds: ["codex-xhigh"],
    maxRounds: 3,
  },
  { id: `${taskId}:design-ok`, kind: "gate", title: "Your design check", roleId: "planner", profileIds: [], gate: "design" },
];

const deliveryGate = (taskId: string): Stage => ({
  id: `${taskId}:delivery`,
  kind: "gate",
  title: "Your delivery check",
  roleId: "code-reviewer",
  profileIds: [],
  gate: "delivery",
});

/**
 * What the planner proposes for a task. The real planner is an agent; this is the
 * deterministic stand-in the simulator and the tests use.
 */
export function composePlan(task: Pick<Task, "id" | "kind">): Plan {
  const id = task.id;
  switch (task.kind) {
    case "bug":
      return {
        plannerProfileId: PLANNER_PROFILE,
        rationale: "A focused fix: one builder, then two reviewers on different tools, so a miss by one is caught by the other.",
        stages: [
          { id: `${id}:build`, kind: "do", title: "Fix", roleId: "builder", profileIds: ["opus-high"] },
          { id: `${id}:review`, kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["codex-xhigh", "sonnet-medium"], maxRounds: 2 },
          deliveryGate(id),
        ],
      };
    case "chore":
      return {
        plannerProfileId: PLANNER_PROFILE,
        rationale: "Small and low risk: a quick build and one careful reviewer.",
        stages: [
          { id: `${id}:build`, kind: "do", title: "Build", roleId: "builder", profileIds: ["sonnet-medium"] },
          { id: `${id}:review`, kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["codex-high"], maxRounds: 2 },
          deliveryGate(id),
        ],
      };
    case "new":
      return {
        plannerProfileId: PLANNER_PROFILE,
        rationale: "Something new: research first, a design both architects agree on, screens from the UX designer, a tester, then three reviewers.",
        stages: [
          { id: `${id}:research`, kind: "do", title: "Research", roleId: "researcher", profileIds: ["sonnet-medium"] },
          ...designStages(id).slice(0, 1),
          { id: `${id}:ux`, kind: "do", title: "Screens", roleId: "ux-designer", profileIds: ["opus-high"] },
          ...designStages(id).slice(1),
          { id: `${id}:build`, kind: "do", title: "Build", roleId: "builder", profileIds: ["opus-high"] },
          { id: `${id}:test`, kind: "do", title: "Test", roleId: "tester", profileIds: ["sonnet-medium"] },
          { id: `${id}:review`, kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high", "sonnet-medium", "codex-xhigh"], maxRounds: 2 },
          deliveryGate(id),
        ],
      };
    case "feature":
      return {
        plannerProfileId: PLANNER_PROFILE,
        rationale: "A feature users will see: the architects agree on a design before anyone builds, then two reviewers on different tools check it.",
        stages: [
          ...designStages(id),
          { id: `${id}:build`, kind: "do", title: "Build", roleId: "builder", profileIds: ["codex-high"] },
          { id: `${id}:review`, kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high", "codex-xhigh"], maxRounds: 2 },
          deliveryGate(id),
        ],
      };
  }
}
