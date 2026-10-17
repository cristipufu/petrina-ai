import type { AgentProfile, DeliveryMode, Plan, Role, Stage, Task, Tool } from "./model.js";

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
    internal: true,
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
    id: "check-finder",
    name: "Check finder",
    icon: "flask",
    tone: "green",
    purpose: "Works out, once per product, which commands prove it works. Petrina runs them itself on every task.",
    canEdit: false,
    sees: "The repository, its CI workflows, build files and README.",
    handsBack: "The product's checks as exact commands, each with why.",
    column: "reviewing",
    internal: true,
  },
  {
    id: "security-reviewer",
    name: "Security reviewer",
    icon: "search",
    tone: "pink",
    purpose: "Reviews high-risk changes for security problems only: access, secrets, input from outside, data exposure.",
    canEdit: false,
    sees: "The change, the design brief and the code around it.",
    handsBack: "Security findings, each tagged Important, Nit or Pre-existing, with evidence.",
    column: "reviewing",
    internal: true,
  },
  {
    id: "guide-keeper",
    name: "Guide keeper",
    icon: "book",
    tone: "teal",
    purpose: "When the coordinator sends back work every reviewer passed, proposes one line for the product's review guide so the miss does not happen again.",
    canEdit: false,
    sees: "The coordinator's note, the review findings and the product's review guide.",
    handsBack: "One line for REVIEW.md and why, or nothing when the note was a change of mind.",
    column: "building",
    internal: true,
  },
  {
    id: "verifier",
    name: "Verifier",
    icon: "scale",
    tone: "teal",
    purpose: "Votes on Important review findings with fresh eyes, one voter per tool, before they can send work back.",
    canEdit: false,
    sees: "The change, the findings to check and the reviewers' evidence.",
    handsBack: "For each finding: real, not a bug, only a nit, or older than the change, with why.",
    column: "reviewing",
    internal: true,
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
    id: "release-manager",
    name: "Release Manager",
    icon: "rocket",
    tone: "green",
    purpose: "Writes a release's notes, across everything on the default branch since the previous release. The only agent at delivery, and only for releases: Petrina sets the version and publishes; pull requests and commits to main need no agent.",
    canEdit: false,
    sees: "Every commit since the previous release, with its message.",
    handsBack: "The release notes, in plain language.",
    column: "ready",
    internal: true,
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
  { id: "opus-high", toolId: "claude-code", model: "Opus 5.5", modelId: "opus", effort: "high" },
  { id: "sonnet-medium", toolId: "claude-code", model: "Sonnet 5.5", modelId: "sonnet", effort: "medium" },
  { id: "codex-xhigh", toolId: "codex", model: "sol", modelId: "gpt-6.1-sol", effort: "xhigh" },
  { id: "codex-high", toolId: "codex", model: "sol", modelId: "gpt-6.1-sol", effort: "high" },
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

export const DELIVERY_LABEL: Record<DeliveryMode, string> = {
  "pull-request": "Open a pull request",
  release: "Publish a release",
  local: "Commit to main",
};

/** The end of every plan: the coordinator's check (when asked for), then the delivery step, the Release Manager's (it only works for releases). */
export function deliveryStages(task: Pick<Task, "id" | "delivery" | "approveDelivery">, releaseManagerProfileId: string = "opus-high"): Stage[] {
  const ship: Stage = { id: `${task.id}:ship`, kind: "do", title: DELIVERY_LABEL[task.delivery], roleId: "release-manager", profileIds: [releaseManagerProfileId] };
  if (!task.approveDelivery) return [ship];
  return [{ id: `${task.id}:delivery`, kind: "gate", title: "Your delivery check", roleId: "release-manager", profileIds: [], gate: "delivery" }, ship];
}

/**
 * What the planner proposes for a task. The real planner is an agent; this is the
 * deterministic stand-in the simulator and the tests use.
 */
export function composePlan(task: Pick<Task, "id" | "kind" | "delivery" | "approveDelivery">): Plan {
  const id = task.id;
  const deliveryGate = () => deliveryStages(task, "sonnet-medium");
  switch (task.kind) {
    case "bug":
      return {
        plannerProfileId: PLANNER_PROFILE,
        rationale: "A focused fix: one builder, then two reviewers on different tools, so a miss by one is caught by the other.",
        stages: [
          { id: `${id}:build`, kind: "do", title: "Fix", roleId: "builder", profileIds: ["opus-high"] },
          { id: `${id}:review`, kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["codex-xhigh", "sonnet-medium"], maxRounds: 2 },
          ...deliveryGate(),
        ],
      };
    case "chore":
      return {
        plannerProfileId: PLANNER_PROFILE,
        rationale: "Small and low risk: a quick build and one careful reviewer.",
        stages: [
          { id: `${id}:build`, kind: "do", title: "Build", roleId: "builder", profileIds: ["sonnet-medium"] },
          { id: `${id}:review`, kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["codex-high"], maxRounds: 2 },
          ...deliveryGate(),
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
          ...deliveryGate(),
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
          ...deliveryGate(),
        ],
      };
  }
}
