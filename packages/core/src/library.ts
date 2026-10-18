import type { AgentProfile, DeliveryMode, Plan, Role, Stage, Task, Tool } from "./model.js";

/**
 * The roles every product starts with. They are data: the coordinator can change their wording and,
 * where the squad allows it, their permission, and reset them to these defaults. Their name, icon and
 * kind of result never change, because Petrina depends on them. `instructions` is how each one works:
 * Petrina adds the task, the notes and its own fixed rules around it.
 */
export const BUILT_IN_ROLES: readonly Role[] = [
  {
    id: "planner",
    name: "Planner",
    icon: "map",
    tone: "indigo",
    purpose: "Reads the task and composes the plan: which roles, on which tools, in what order.",
    instructions: "Compose the plan for this task: which roles work on it, on which profiles, in what order. Read the repository enough to judge the size of the work, but change nothing.",
    canEdit: false,
    sees: "The task, an overview of the product, the role library and the tools on this machine.",
    handsBack: "A plan, with a reason for every stage.",
    result: "plan",
    column: "planning",
    internal: true,
  },
  {
    id: "researcher",
    name: "Researcher",
    icon: "book",
    tone: "orange",
    purpose: "Finds out what users expect and how others solved it before anything is designed.",
    instructions: "Research what users expect from this and how good products solve it. Look at the repository to understand the current state. Do not change any files.",
    canEdit: false,
    sees: "The task and the product.",
    handsBack: "Research notes with sources.",
    result: "notes",
    column: "designing",
  },
  {
    id: "architect",
    name: "Architect",
    icon: "compass",
    tone: "violet",
    purpose: "Designs how the change should work for users and in the product.",
    instructions: `Design how this should work, for users and in the product. Read the code you need. Do not change any files: your output is the design brief.
Write it for a product person: plain language, no code. The acceptance list is what the builder must satisfy and the reviewers will check.
Keep the design as small as the task allows. Do not add mechanisms the task did not ask for (new security layers, sandboxes, settings, background services): if you see a need, put it in risks as a follow-up instead.`,
    canEdit: false,
    sees: "The task, research notes and the product.",
    handsBack: "A design brief: what changes for users, which parts change, acceptance checklist, risks.",
    result: "brief",
    column: "designing",
  },
  {
    id: "design-reviewer",
    name: "Design reviewer",
    icon: "scale",
    tone: "purple",
    purpose: "Challenges the design until nothing blocking is left.",
    instructions: `Challenge the design brief below. Look for gaps, contradictions, missing edge cases, and things that will not work in this codebase. Do not change any files.
Mark an objection blocking only if building the design as written would be a mistake. Rare, recoverable edge cases and ideas that would grow the task beyond what was asked (new security layers, sandboxes, settings) are non-blocking: list them for follow-up. Prefer objections that make the design simpler.
If nothing blocking is left, return an empty or non-blocking list.`,
    canEdit: false,
    sees: "The design brief and the product. Never the architect's transcript.",
    handsBack: "Objections, each blocking or not.",
    result: "objections",
    column: "designing",
  },
  {
    id: "ux-designer",
    name: "UX designer",
    icon: "palette",
    tone: "pink",
    purpose: "Shapes the screens and the words users will see.",
    instructions: "Shape the screens, layout and words users will see for this change, following the product's existing design. Do not change any files: describe the design in your notes.",
    canEdit: false,
    sees: "The design brief and the product's current screens.",
    handsBack: "UI notes and screen sketches.",
    result: "notes",
    column: "designing",
  },
  {
    id: "builder",
    name: "Builder",
    icon: "hammer",
    tone: "blue",
    purpose: "Implements the design in its own working copy and keeps the tests green.",
    instructions: `Implement the task in this working copy. Follow the design brief and acceptance checklist below when there is one.
Keep the code consistent with the codebase and add or update tests.`,
    canEdit: true,
    sees: "The design brief, the acceptance checklist and review findings.",
    handsBack: "A change ready for review and a plain-language summary of it.",
    result: "build",
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
    result: "check-discovery",
    instructions: `Work out which commands prove this product works, so Petrina can run them itself on every task. Read the repository the way a careful developer joining the team would: its CI workflows first (for example .github/workflows, azure-pipelines.yml, .gitlab-ci.yml), then build files (package.json, Cargo.toml, *.csproj or *.sln, go.mod, pyproject.toml, Package.swift, *.xcodeproj, build.gradle, pom.xml, Makefile) and the README.
Pick the checks CI relies on that run on this machine without secrets, deploy keys or cloud access: usually type check, lint, unit tests and a build. Prefer the exact commands CI runs. Skip deploys, releases, publishing and anything needing credentials.
Give each command as a list of its words, exactly as it should run from the repository root. Never use a shell or combine commands. If a check needs a different folder, use the tool's own option for choosing that folder.
You may run a command to confirm it works, but keep it quick, and do not change files. Hand back between one and eight checks, fastest first.`,
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
    result: "findings",
    instructions: `Review the change for security problems only: who can reach what (access checks, sign-in, permissions), secrets and credentials, input from outside (injection, paths, URLs), data that could be exposed or lost, and unsafe defaults. Other reviewers cover everything else.
Each finding says where it is and how someone could misuse it. Tag it "important" only if the change should not ship with it, "nit" for hardening that can wait, and "pre-existing" for a problem the change did not cause. Report a whole class of problem once, listing every place. Never repeat a finding listed below: confirm or dispute it by id instead.`,
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
    result: "guide",
    instructions: `The coordinator sent back work that every reviewer had passed, with the note below. Decide whether the reviewers missed something they should have caught. If they did, write one point for the product's review guide (REVIEW.md) so reviewers catch that whole class of problem next time.
The point is a check a reviewer can make on any change, in plain words, not about this task alone (for example "Every page behind sign-in handles an expired session"). Do not repeat a point the guide already has.
If the note is a change of mind or a new wish rather than a miss, say nothing was missed and offer no review point.
Do not change any files.`,
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
    result: "votes",
    instructions: `Before an Important finding can send the work back to the builder, check it yourself, with fresh eyes: read the code, and run a single test when that is the quickest proof. For each finding, by id, give your verdict:
- "real": the change should not ship with it;
- "not-a-bug": it is wrong, and say why;
- "nit": real but small, it should not hold the work back;
- "pre-existing": the problem was already there before this change (check the starting version), so it is a follow-up.
Be strict both ways: a finding without real evidence is not real, and a real one stays real however it was worded.`,
  },
  {
    id: "tester",
    name: "Tester",
    icon: "flask",
    tone: "green",
    purpose: "Runs the product like a user and checks every acceptance item.",
    instructions: "Run the product and check every acceptance item like a user would. Do not change files. Report each check as pass or fail.",
    canEdit: false,
    sees: "The acceptance checklist and the running product.",
    handsBack: "Pass or fail per acceptance item, with screenshots.",
    result: "checks",
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
    result: "delivery",
    instructions: "Writes a release's notes, across everything on the default branch since the previous release. The only agent at delivery, and only for releases: Petrina sets the version and publishes; pull requests and commits to main need no agent.",
  },
  {
    id: "code-reviewer",
    name: "Code reviewer",
    icon: "search",
    tone: "teal",
    purpose: "Tries to prove the change is not done. Pass or fail, never a score.",
    instructions: `Each finding says where it is and the evidence; never give a score. Tag it "important" only if the change should not ship with it, "nit" for anything smaller, and "pre-existing" for a problem the change did not cause: that becomes a follow-up and never holds the work back.
When you find a bug, look for the whole class of it in the change and report one finding per root cause. Give a minimal reproduction and a nearby control that distinguishes the bug. Include other affected places when they share the same cause, but do not enumerate paraphrases, synonyms, or permutations unless they exercise a distinct code path or reveal a separate regression. For open-ended inputs such as natural language, review the defined behavior and representative syntax classes; do not try to exhaust every possible wording. Never repeat a finding listed below, whether open, fixed or dismissed: confirm or dispute it by id instead.
If earlier reviewers' findings are listed below, confirm the ones you agree with by id. Dispute the ones you think are wrong by id, always with the reason and your evidence: the coordinator reads it. A finding another reviewer confirmed stays open whatever you say, so make your case.`,
    canEdit: false,
    sees: "The design, the acceptance checklist, the change and earlier verdicts. Never the builder's transcript.",
    handsBack: "Findings, each pass or fail with where it is and the evidence.",
    result: "findings",
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
 * deterministic stand-in the simulator and the tests use. Roles the coordinator added join:
 * reviewers in the review, and on features and new things, notes roles get a step of their own
 * (read-only ones before the build, ones that change the product after it), always before the review.
 */
export function composePlan(task: Pick<Task, "id" | "kind" | "delivery" | "approveDelivery">, roles: readonly Role[] = BUILT_IN_ROLES): Plan {
  const plan = basePlan(task);
  const added = roles.filter((role) => role.added && !role.removed);
  if (!added.length) return plan;
  const stages = [...plan.stages];
  const review = stages.findIndex((stage) => stage.kind === "review-chain");
  const reviewers = added.filter((role) => role.result === "findings");
  if (review >= 0 && reviewers.length) {
    const stage = stages[review]!;
    stages[review] = {
      ...stage,
      profileIds: [...stage.profileIds, ...reviewers.map(() => "sonnet-medium")],
      roleIds: [...stage.profileIds.map((_, position) => stage.roleIds?.[position] ?? stage.roleId), ...reviewers.map((role) => role.id)],
    };
  }
  if (task.kind === "new" || task.kind === "feature") {
    for (const role of added.filter((entry) => entry.result === "notes")) {
      const build = stages.findIndex((stage) => stage.roleId === "builder");
      const step: Stage = { id: `${task.id}:${role.id}`, kind: "do", title: role.name, roleId: role.id, profileIds: ["sonnet-medium"] };
      if (build >= 0) stages.splice(role.canEdit ? build + 1 : build, 0, step);
    }
  }
  const names = added.filter((role) => stages.some((stage) => stage.roleId === role.id || stage.roleIds?.includes(role.id) || stage.reviewerRoleId === role.id)).map((role) => role.name);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
  return { ...plan, stages, rationale: names.length ? `${plan.rationale} With the ${list} you added.` : plan.rationale };
}

function basePlan(task: Pick<Task, "id" | "kind" | "delivery" | "approveDelivery">): Plan {
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
