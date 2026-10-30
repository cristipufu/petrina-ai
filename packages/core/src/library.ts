import { deliveryLabel } from "./source.js";
import type { DeliveryMode, Plan, Role, Stage, Task, Tool } from "./model.js";

/** Acceptance evidence is the same requirement in the role library and the engine contract. */
export const ACCEPTANCE_EVIDENCE_RULE = `For every pass or failure, include short "evidence": the specific scenario, expected and observed result, with the relevant failure/recovery variant and a nearby passing control when needed. Distinguish what you executed from what you only inspected. A passing suite, test name or demo picture does not prove an untried concurrency, interruption or restart condition. Reuse Petrina's current checks when they cover the item; several items may cite one applicable result or focused probe, without rerunning a full suite or repeating logs.`;

/** Applied to built-in, edited and added design reviewers, across products. */
export const DESIGN_OBJECTION_RULE = `Before calling a rule missing, read the complete current brief, including its product behavior and acceptance list. For each blocking objection, identify the governing request or brief rule (or say precisely which decision is absent), the unresolved gap or contradiction, and why building it as written would fail. A workable rule already written in another section is not missing; a wording preference or a restatement of that rule is not a blocker. A genuinely absent decision or conflicting rules may still block: explain the concrete consequence. Keep independent judgment and investigate the code needed to establish the issue.`;

/** A result rule shared by built-in, edited and added reviewers. */
export const FINDING_CONFIRMATION_RULE = `For earlier findings, confirm an id only if that specific problem is still present in the current code you reviewed. "Confirms" means "still broken now"; it never means that you agree the earlier report was valid at the time. Use {"id": "<finding id>", "evidence": "<current reproduction, expected and observed result>"} in "confirms". A dismissed finding, claimed fix or previously reopened finding requires current evidence: state the exact failing case on this version, including a nearby passing control when it distinguishes the regression. The earlier report, verdict and builder's answer are history, not evidence that it still fails. Fresh proof reopens the same id for a new check; its earlier dismissal is preserved. If it now works, leave its id out and do not report it again.`;

/** Repair guidance also reaches a Builder whose editable wording has been replaced. */
export const REPAIR_RULE = `When repairing a reported problem, from the first return, identify the underlying rule before changing code. Select the relevant normal, failure and recovery paths, or state and input variants, and inspect the affected callers or sibling operations. Fix the shared cause, add or update meaningful regressions for the failing variants and nearby passing controls, and run them. Keep this within the task and the observed cause: no exhaustive permutations or unrelated redesign. In your report, name the cause, the affected cases addressed and the checks you actually ran; distinguish cases inspected from cases executed.`;

/** A role's result reaches later agents, never its conversation: built-in, edited, added and maintenance notes roles all get this. */
export const NOTES_HANDOFF_RULE = `Your saved report is your result's summary and notes: later agents on this task receive it, never this conversation, so anything needed later must be there, not only in your messages. Keep the notes concise and specific: your actual findings or proposals and the facts that distinguish them, rather than a restatement of the task. Plain-language notes can still name exact sources where relevant and available: a link, a repository location, or a check you ran and what it showed, with the version or platform when the conclusion depends on it. Do not invent sources or do extra research only to add one. When relevant, say in the notes what you inspected, what you ran, what remains uncertain or open, and what you could not check. Keep suggested approaches separate from observed facts and established constraints.`;

/** Age and task obligations are separate judgments for both findings and votes. */
export const FINDING_REQUIREMENT_RULE = `Judge each finding against the approved request, brief and coordinator decisions, the current code and the starting version. An older defect that leaves an explicitly requested repair or concrete acceptance outcome unmet is "important" for reviewers and "real" for Verifiers: explain the governing requirement and current reproduction. Age alone is no exemption. A confirmed older bug unrelated to the task is "pre-existing", a follow-up that never blocks. Do not grow scope from nearby code, a general wish for quality or speculation; investigate an unclear requirement rather than invent an obligation. Missing or unavailable proof is not a reproduced code defect; keep it separate under the existing proof-request rules. These classification rules govern even when saved role wording says otherwise.`;

/** Shared editable defaults and fixed contract rules for every votes result. */
export const VERIFIER_RULES: readonly string[] = [
  `Before an Important finding can send the work back to the builder, check it yourself, with fresh eyes: read the code, and run a single test when that is the quickest proof. For each finding, by id, give your verdict:\n- "real": the change should not ship with it;\n- "not-a-bug": it is wrong, and say why;\n- "nit": real but small, it should not hold the work back;\n- "pre-existing": a confirmed older bug unrelated to the approved task, checked against the starting version, so it is a follow-up.\nBe strict both ways: a finding without real evidence is not real, and a real one stays real however it was worded.`,
  FINDING_REQUIREMENT_RULE,
];

/** The same review rules apply to built-in, edited and added findings roles. Keep each once. */
export const FINDING_REVIEW_RULES: readonly string[] = [
  `When a change fixes or alters one case, check nearby cases affected by the same code or rule: sibling operations or inputs, relevant normal, failure and recovery paths, themes and window sizes, and other ways into and out of the flow. Compare with the starting version. A confirmed regression caused by the change is Important, even when the intended case now works.`,
  FINDING_REQUIREMENT_RULE,
  `Each finding says where it is and the evidence; never give a score. Tag it "important" if it must be repaired in this task, "nit" for anything smaller, and "pre-existing" for a confirmed older bug unrelated to the task.`,
  `When you find a bug, look for the whole class of it in the change and report one finding per root cause, with all observed affected paths together. Give a minimal reproduction and a nearby passing control that distinguishes the bug. For a variant of an earlier finding's cause, use that finding's id and include the variant in fresh confirmation evidence; reserve new findings for distinct root causes. Never repeat a finding listed below, whether open, fixed or dismissed: confirm or dispute it by id instead. Select relevant cases; do not enumerate paraphrases, synonyms, or permutations unless they exercise a distinct code path or reveal a separate regression. For open-ended inputs such as natural language, review the defined behavior and representative syntax classes; do not try to exhaust every possible wording or grow the task.`,
  `For a "pre-existing" follow-up, give "steps" for how to see it again, and put in "evidence" how you checked that this change neither caused it nor made it worse and the approved task does not require its repair. When open follow-up cards are listed, set "sameBug" to that card's id if this is the same bug, or "none" if it is none of those cards. If no cards are listed, leave "sameBug" out.`,
  FINDING_CONFIRMATION_RULE,
  `Dispute findings you think are wrong by id, always with the reason and your evidence: the coordinator reads it. A finding another reviewer confirmed stays open whatever you say, so make your case.`,
];

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
    instructions: `Research what users expect from this and how good products solve it. Look at the repository to understand the current state. Do not change any files.
${NOTES_HANDOFF_RULE}`,
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
If nothing blocking is left, return an empty or non-blocking list.
${DESIGN_OBJECTION_RULE}`,
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
    instructions: `Shape the screens, layout and words users will see for this change, following the product's existing design. Do not change any files: describe the design in your notes.
${NOTES_HANDOFF_RULE}`,
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
Keep the code consistent with the codebase and add or update tests.
${REPAIR_RULE}`,
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
For each security finding, explain how someone could misuse it.
${FINDING_REVIEW_RULES.join("\n")}`,
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
    purpose: "Votes on Important review findings with fresh eyes, one actual tool per answer, before they can send work back.",
    canEdit: false,
    sees: "The change, the findings to check and the reviewers' evidence.",
    handsBack: "For each finding: real, not a bug, only a nit, or an unrelated older bug, with why.",
    column: "reviewing",
    internal: true,
    result: "votes",
    instructions: VERIFIER_RULES.join("\n"),
  },
  {
    id: "tester",
    name: "Tester",
    icon: "flask",
    tone: "green",
    purpose: "Runs the product like a user and checks every acceptance item.",
    instructions: `Run the product and check every acceptance item like a user would. Do not change files. Report each check as pass, fail, or could not verify. ${ACCEPTANCE_EVIDENCE_RULE} For anything you could not verify, give a short reason. Do not guess that it passes or report an unavailable check as a product defect.`,
    canEdit: false,
    sees: "The acceptance checklist and the running product.",
    handsBack: "A result per acceptance item, with the scenario and observed evidence, or a reason it could not be verified.",
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
    instructions: FINDING_REVIEW_RULES.join("\n"),
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

export { DEFAULT_PROFILES } from "./profiles.js";


const PLANNER_PROFILE = "sonnet-medium";

const designStages = (taskId: string): Stage[] => [
  {
    id: `${taskId}:design`,
    kind: "converge",
    title: "Design",
    roleId: "architect",
    profileIds: ["opus-high"],
    reviewerRoleId: "design-reviewer",
    reviewerProfileIds: ["sol-xhigh"],
    maxRounds: 3,
  },
  { id: `${taskId}:design-ok`, kind: "gate", title: "Your design check", roleId: "planner", profileIds: [], gate: "design" },
];

export const DELIVERY_LABEL: Record<DeliveryMode, string> = {
  "pull-request": "Open a pull request",
  release: "Publish a release",
  local: "Commit to main",
};

/** The end of every plan: the coordinator's check (when asked for), then the delivery step. The Release Manager only writes a release's notes. */
export function deliveryStages(task: Pick<Task, "id" | "delivery" | "approveDelivery" | "source">, releaseManagerProfileId: string = "opus-high"): Stage[] {
  const ship: Stage = {
    id: `${task.id}:ship`,
    kind: "do",
    title: task.source ? deliveryLabel(task) : DELIVERY_LABEL[task.delivery],
    roleId: "release-manager",
    profileIds: [releaseManagerProfileId]
  };
  if (!task.approveDelivery) return [ship];
  return [{ id: `${task.id}:delivery`, kind: "gate", title: "Your delivery check", roleId: "release-manager", profileIds: [], gate: "delivery" }, ship];
}

/**
 * What the planner proposes for a task. The real planner is an agent; this is the
 * deterministic stand-in the simulator and the tests use. Roles the coordinator added join:
 * reviewers in the review, and on features and new things, notes roles get a step of their own
 * (read-only ones before the build, ones that change the product after it), always before the review.
 */
export function composePlan(task: Pick<Task, "id" | "kind" | "delivery" | "approveDelivery" | "source">, roles: readonly Role[] = BUILT_IN_ROLES): Plan {
  const plan = basePlan(task);
  const added = roles.filter((role) => role.added && !role.removed && role.category !== "maintenance");
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
      const build = stages.findIndex((stage) => roles.find(role => role.id === stage.roleId)?.result === "build");
      const step: Stage = { id: `${task.id}:${role.id}`, kind: "do", title: role.name, roleId: role.id, profileIds: ["sonnet-medium"] };
      if (build >= 0) stages.splice(role.canEdit ? build + 1 : build, 0, step);
    }
  }
  const names = added.filter((role) => stages.some((stage) => stage.roleId === role.id || stage.roleIds?.includes(role.id) || stage.reviewerRoleId === role.id)).map((role) => role.name);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
  return { ...plan, stages, rationale: names.length ? `${plan.rationale} With the ${list} you added.` : plan.rationale };
}

function basePlan(task: Pick<Task, "id" | "kind" | "delivery" | "approveDelivery" | "source">): Plan {
  const id = task.id;
  const deliveryGate = () => deliveryStages(task, "sonnet-medium");
  switch (task.kind) {
    case "bug":
      return {
        plannerProfileId: PLANNER_PROFILE,
        rationale: "A focused fix: one builder, then two reviewers on different tools, so a miss by one is caught by the other.",
        stages: [
          { id: `${id}:build`, kind: "do", title: "Fix", roleId: "builder", profileIds: ["opus-high"] },
          { id: `${id}:review`, kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["sol-xhigh", "sonnet-medium"], maxRounds: 2 },
          ...deliveryGate(),
        ],
      };
    case "chore":
      return {
        plannerProfileId: PLANNER_PROFILE,
        rationale: "Small and low risk: a quick build and one careful reviewer.",
        stages: [
          { id: `${id}:build`, kind: "do", title: "Build", roleId: "builder", profileIds: ["sonnet-medium"] },
          { id: `${id}:review`, kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["sol-high"], maxRounds: 2 },
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
          {
            id: `${id}:review`,
            kind: "review-chain",
            title: "Review",
            roleId: "code-reviewer",
            profileIds: [
            "opus-high",
            "sonnet-medium",
            "sol-xhigh"
          ],
            maxRounds: 2
          },
          ...deliveryGate(),
        ],
      };
    case "feature":
      return {
        plannerProfileId: PLANNER_PROFILE,
        rationale: "A feature users will see: the architects agree on a design before anyone builds, then two reviewers on different tools check it.",
        stages: [
          ...designStages(id),
          { id: `${id}:build`, kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-high"] },
          { id: `${id}:review`, kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high", "sol-xhigh"], maxRounds: 2 },
          ...deliveryGate(),
        ],
      };
  }
}
