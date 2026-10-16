// What each role is told, and the result block it must hand back.
// A stage only counts as done when its block parses and validates.

import { z } from "zod";
import type { AgentProfile, Finding, Objection, Product, Role, StepNote, Task } from "@petrina/core";

export const NeedsInput = z.object({
  needsInput: z.object({
    question: z.string().min(3),
    options: z.array(z.string().min(1)).max(5).default([]),
  }),
});

export const PlanResult = z.object({
  rationale: z.string().min(3),
  stages: z
    .array(
      z.object({
        kind: z.enum(["do", "converge", "review-chain", "gate"]),
        title: z.string().min(1).max(60),
        roleId: z.string(),
        profileIds: z.array(z.string()).default([]),
        reviewerRoleId: z.string().optional(),
        reviewerProfileIds: z.array(z.string()).optional(),
        maxRounds: z.number().int().min(1).max(5).optional(),
        gate: z.enum(["plan", "design"]).optional(),
      }),
    )
    .min(1)
    .max(12),
});

export const BriefResult = z.object({
  summary: z.string().min(3),
  forUsers: z.array(z.string()).default([]),
  areas: z.array(z.string()).default([]),
  acceptance: z.array(z.string()).min(1),
  risks: z.array(z.string()).default([]),
  answers: z.array(z.object({ id: z.string(), status: z.enum(["accepted", "rejected"]), answer: z.string() })).default([]),
});

export const ObjectionsResult = z.object({
  objections: z.array(z.object({ text: z.string().min(3), blocking: z.boolean() })).default([]),
});

export const NotesResult = z.object({
  summary: z.string().min(3),
  notes: z.array(z.string()).default([]),
});

export const BuildResult = z.object({
  summary: z.string().min(3),
  changes: z.array(z.string()).default([]),
  tests: z.string().optional(),
});

export const TestResult = z.object({
  summary: z.string().min(3),
  checks: z.array(z.object({ text: z.string(), pass: z.boolean() })).default([]),
});

export const ReviewResult = z.object({
  verdict: z.enum(["pass", "fail"]),
  findings: z
    .array(
      z.object({
        text: z.string().min(3),
        where: z.string().optional(),
        severity: z.enum(["blocking", "suggestion"]),
        evidence: z.string().optional(),
      }),
    )
    .default([]),
  confirms: z.array(z.string()).default([]),
  disputes: z.array(z.string()).default([]),
});

export const ShipResult = z.object({
  summary: z.string().min(3),
  prNumber: z.number().int().optional(),
  prUrl: z.string().optional(),
  tag: z.string().optional(),
  releaseUrl: z.string().optional(),
  sha: z.string().optional(),
});

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string } | { ok: "input"; question: string; options: string[] };

/** Find the last ```petrina block (or a trailing ```json block) and validate it. */
export function parseResult<T>(text: string, schema: z.ZodType<T>): Parsed<T> {
  const blocks = [...text.matchAll(/```(?:petrina|json)\s*\n([\s\S]*?)```/g)];
  const last = blocks.at(-1)?.[1];
  if (!last) return { ok: false, error: "No ```petrina result block was found at the end of your message." };
  let json: unknown;
  try {
    json = JSON.parse(last);
  } catch (error) {
    return { ok: false, error: `The result block is not valid JSON: ${(error as Error).message}` };
  }
  const input = NeedsInput.safeParse(json);
  if (input.success) return { ok: "input", question: input.data.needsInput.question, options: input.data.needsInput.options };
  const parsed = schema.safeParse(json);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ") };
  return { ok: true, value: parsed.data };
}

/** Text the coordinator sees: the agent's message without its result block. */
export function proseOf(text: string): string {
  return text.replace(/```(?:petrina|json)\s*\n[\s\S]*?```/g, "").trim();
}

export interface PromptContext {
  task: Task;
  product: Product;
  role: Role;
  roles: readonly Role[];
  profiles: readonly AgentProfile[];
  worktree: string;
  branch: string;
  base: string;
  defaultBranch: string;
  /** Extra sections: the brief, objections, findings, review results, notes from the coordinator. */
  sections: readonly { title: string; body: string }[];
}

const RESULT_FOOTER = (shape: string) => `
When you are done, end your final message with exactly one fenced block tagged petrina, holding JSON in this shape:

\`\`\`petrina
${shape}
\`\`\`

If you cannot go on without a decision from the coordinator, end with this instead, and you will get the answer:

\`\`\`petrina
{"needsInput": {"question": "One clear question, in plain language", "options": ["A short option", "Another option"]}}
\`\`\``;

const SHAPES: Record<string, string> = {
  planner: `{"rationale": "Why this plan, in one or two plain sentences", "stages": [
  {"kind": "converge", "title": "Design", "roleId": "architect", "profileIds": ["<profile id>"], "reviewerRoleId": "design-reviewer", "reviewerProfileIds": ["<another tool's profile id>"], "maxRounds": 3},
  {"kind": "gate", "title": "Your design check", "roleId": "architect", "gate": "design"},
  {"kind": "do", "title": "Build", "roleId": "builder", "profileIds": ["<profile id>"]},
  {"kind": "review-chain", "title": "Review", "roleId": "code-reviewer", "profileIds": ["<profile id>", "<profile id on another tool>"], "maxRounds": 2}
]}`,
  researcher: `{"summary": "What you found, in plain language", "notes": ["One finding per line"]}`,
  architect: `{"summary": "How it should work, in plain language", "forUsers": ["What changes for users"], "areas": ["Parts of the product"], "acceptance": ["How the coordinator will know it is done"], "risks": ["What could go wrong"], "answers": [{"id": "<objection id>", "status": "accepted", "answer": "What you changed, or why not"}]}`,
  "design-reviewer": `{"objections": [{"text": "A concrete gap in the design", "blocking": true}]}`,
  "ux-designer": `{"summary": "The screens and words you propose", "notes": ["One note per line"]}`,
  builder: `{"summary": "What you built, in plain language", "changes": ["What changed for users, one per line"], "tests": "What you ran and the result"}`,
  tester: `{"summary": "How it went", "checks": [{"text": "An acceptance item", "pass": true}]}`,
  "code-reviewer": `{"verdict": "pass", "findings": [{"text": "What is wrong, in plain language", "where": "file:line", "severity": "blocking", "evidence": "How you know"}], "confirms": ["<id of an earlier finding you agree with>"], "disputes": ["<id of an earlier finding you think is wrong>"]}`,
  shipper: `{"summary": "What you delivered", "prNumber": 12, "prUrl": "https://github.com/...", "tag": "v1.2.3", "releaseUrl": "https://github.com/...", "sha": "<commit sha on the default branch>"}`,
};

function roleInstructions(ctx: PromptContext): string {
  const { task, role, base, defaultBranch, branch } = ctx;
  switch (role.id) {
    case "planner": {
      const roles = ctx.roles.filter((entry) => entry.id !== "planner" && entry.id !== "shipper").map((entry) => `- ${entry.id}: ${entry.purpose}`).join("\n");
      const profiles = ctx.profiles.map((profile) => `- ${profile.id}: ${profile.toolId === "codex" ? "Codex" : "Claude Code"} running ${profile.model} at ${profile.effort} effort`).join("\n");
      return `Compose the plan for this task: which roles work on it, on which profiles, in what order. Read the repository enough to judge the size of the work, but change nothing.

Roles you can use:
${roles}

Profiles you can use (use only these ids):
${profiles}

Stage kinds:
- "do": one role on one profile (researcher, ux-designer, builder, tester).
- "converge": an architect and a design-reviewer on different tools iterate until no blocking objection is left. Set maxRounds (2 or 3).
- "review-chain": code-reviewers run one after another on the change. Use at least two, on different tools. Set maxRounds (usually 2).
- "gate": the coordinator checks. Use gate "design" after a converge stage when the change affects what users see.

Rules:
- Size the plan to the task. A small fix can be a builder and two reviewers. Something new deserves research, a converge design, a design gate, a builder, maybe a tester, and a review chain.
- Always include exactly one builder stage before the review chain.
- Prefer putting the reviewer of a piece of work on a different tool than its author.
- Do not add delivery stages; Petrina adds them.`;
    }
    case "researcher":
      return "Research what users expect from this and how good products solve it. Look at the repository to understand the current state. Do not change any files.";
    case "architect":
      return `Design how this should work, for users and in the product. Read the code you need. Do not change any files: your output is the design brief.
Write it for a product person: plain language, no code. The acceptance list is what the builder must satisfy and the reviewers will check.
If objections are listed below, answer every one by its id: accept it and change the design, or reject it with a reason.`;
    case "design-reviewer":
      return `Challenge the design brief below. Look for gaps, contradictions, missing edge cases, and things that will not work in this codebase. Do not change any files.
Mark an objection blocking only if building the design as written would be a mistake. If nothing blocking is left, return an empty or non-blocking list.`;
    case "ux-designer":
      return "Shape the screens, layout and words users will see for this change, following the product's existing design. Do not change any files: describe the design in your notes.";
    case "builder":
      return `Implement the task in this working copy. Follow the design brief and acceptance checklist below when there is one.
Keep the code consistent with the codebase, add or update tests, and run the relevant tests and build before you finish.
${task.fixing ? "You are fixing the review findings listed below. Fix every blocking one." : ""}
Do not commit, push or open pull requests: Petrina commits your work.`;
    case "tester":
      return "Run the product and check every acceptance item like a user would. Do not change files. Report each check as pass or fail.";
    case "code-reviewer":
      return `Review the change on branch ${branch}: run \`git diff ${base}...HEAD\` to see it. Your job is to try to prove that it is NOT done.
Check every acceptance item, look for bugs, missing tests, weakened tests and things that break existing behaviour. Run the tests.
Each finding is pass or fail with where it is and the evidence; never give a score. Mark a finding blocking only if the change should not ship with it.
If earlier reviewers' findings are listed below, confirm the ones you agree with and dispute the ones you think are wrong, by id.
Do not change any files.`;
    case "shipper":
      return shipperInstructions(ctx, defaultBranch);
    default:
      return role.purpose;
  }
}

function shipperInstructions(ctx: PromptContext, defaultBranch: string): string {
  const { task, branch } = ctx;
  switch (task.delivery) {
    case "pull-request":
      return `The coordinator approved this work. Deliver it as a pull request:
1. If ${defaultBranch} moved on, merge origin/${defaultBranch} into ${branch} and resolve any conflicts, then run the tests.
2. Push ${branch} to origin.
3. Open a pull request into ${defaultBranch} with \`gh pr create\`: a clear title, and a body in plain language that says what changed for users, the acceptance checklist, and what the reviewers checked.
Never merge the pull request. Return its number and URL.`;
    case "release":
      return `The coordinator approved this work. Deliver it as a release:
1. Merge ${branch} into ${defaultBranch} (merge origin/${defaultBranch} first and resolve conflicts if it moved on), and run the tests.
2. Work out the next version from the latest release or tag (bump the ${ctx.product.releaseBump ?? "patch"} number) and update every version file in the project consistently (package.json, Cargo.toml, tauri.conf.json, and the like), then commit.
3. Push ${defaultBranch}, then publish the release with \`gh release create <tag> --target ${defaultBranch}\`, with plain-language release notes.
Return the tag and the release URL.`;
    case "local":
      return `The coordinator approved this work. Commit it onto ${defaultBranch} locally:
1. Merge ${defaultBranch} into ${branch} first if it moved on and resolve any conflicts, and run the tests.
2. Bring ${defaultBranch} up to ${branch} in the main clone at ${ctx.product.path ?? "the repository root"}: if ${defaultBranch} is checked out there and clean, run \`git merge --ff-only ${branch}\` in that clone; if it is not checked out there, run \`git branch -f ${defaultBranch} ${branch}\`. If the clone has uncommitted changes, stop and ask the coordinator.
Do not push anything. Return the commit sha now on ${defaultBranch}.`;
  }
}

export function buildPrompt(ctx: PromptContext): string {
  const { task, product, role, worktree, branch } = ctx;
  const sections = ctx.sections.map((section) => `## ${section.title}\n${section.body}`).join("\n\n");
  return `You are the ${role.name} in Petrina, a squad of AI agents working on the product "${product.name}" (${product.repo}).
The coordinator who reads your work is a product person, not a developer: everything you write for them is plain language, short, and free of code.

Your working copy is ${worktree}, on branch ${branch}. Stay inside it.

# The task: ${task.title}
${task.description || "(no further description)"}

# Your job
${roleInstructions(ctx)}

${sections}

Keep a short to-do list as you work, written in plain language: the coordinator watches it live.
${RESULT_FOOTER(SHAPES[role.id] ?? SHAPES["researcher"]!)}`;
}

export function repairPrompt(error: string): string {
  return `Your result block could not be used: ${error}
Reply with only the corrected \`\`\`petrina block, nothing else.`;
}

export function formatObjections(objections: readonly Objection[]): string {
  return objections.map((objection) => `- [${objection.id}] ${objection.blocking ? "BLOCKING" : "not blocking"} (${objection.status}): ${objection.text}${objection.answer ? ` | Architect: ${objection.answer}` : ""}`).join("\n");
}

export function formatFindings(findings: readonly Finding[]): string {
  return findings.map((finding) => `- [${finding.id}] ${finding.severity} (${finding.status}): ${finding.text}${finding.where ? ` at ${finding.where}` : ""}`).join("\n");
}

export const EARLIER_ATTEMPT = "What the coordinator said in an earlier attempt at this step";

/** Everything said during a step that started before and was cut short, in order, each marked as earlier. */
export function formatStepNotes(notes: readonly StepNote[]): string {
  const lines = notes.map((note) => {
    switch (note.kind) {
      case "changes":
        return `- (earlier attempt) The change request that started this step: ${note.text}`;
      case "message":
        return `- (earlier attempt) A message from the coordinator: ${note.text}`;
      case "interrupt":
        return `- (earlier attempt) The coordinator interrupted with: ${note.text}`;
      case "answer":
        return `- (earlier attempt) The agent asked: ${note.about ?? "a question"} | The coordinator answered: ${note.text}`;
      case "denied":
        return `- (earlier attempt) The agent wanted to: ${note.about ?? "do something"} | The coordinator said no: ${note.text}`;
    }
  });
  return `This step started before and was cut short (Petrina was closed, stopped or paused). Here is everything the coordinator said during it, in order. Take all of it into account; where two conflict, the later one wins. Permissions allowed in the earlier attempt are not carried over.\n${lines.join("\n")}`;
}
