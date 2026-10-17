// What each role is told, and the result block it must hand back.
// A stage only counts as done when its block parses and validates.

import { z } from "zod";
import { followingCall, type AgentProfile, type Finding, type Objection, type Product, type Role, type StepNote, type Task } from "@petrina/core";

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
  risk: z.object({ level: z.enum(["low", "medium", "high"]), why: z.string().trim().min(3).max(300) }).optional(),
});

export const BriefResult = z.object({
  summary: z.string().min(3),
  forUsers: z.array(z.string()).default([]),
  areas: z.array(z.string()).default([]),
  acceptance: z.array(z.string()).min(1),
  risks: z.array(z.string()).default([]),
  // A blank answer is no answer: it goes back to the architect to fill in.
  answers: z.array(z.object({ id: z.string(), status: z.enum(["accepted", "rejected"]), answer: z.string().trim().min(1), byCall: z.boolean().default(false) })).default([]),
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
  // In a fix round: one answer per finding, by id.
  answers: z.array(z.object({ id: z.string(), fixed: z.boolean(), text: z.string().min(3) })).default([]),
});

export const CheckFinderResult = z.object({
  summary: z.string().min(3),
  checks: z
    .array(z.object({ name: z.string().trim().min(2).max(40), argv: z.array(z.string().min(1)).min(1).max(40), why: z.string().trim().min(3).max(200) }))
    .min(1)
    .max(8),
});

export const GuideResult = z.object({
  missed: z.boolean(),
  line: z.string().trim().max(240).default(""),
  why: z.string().trim().min(3).max(400),
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
        severity: z.enum(["important", "nit", "pre-existing"]),
        evidence: z.string().optional(),
      }),
    )
    .default([]),
  confirms: z.array(z.string()).default([]),
  // A dispute always says why: the coordinator reads it next to the finding.
  disputes: z.array(z.object({ id: z.string(), reason: z.string().min(10) })).default([]),
});

export const VerifyResult = z.object({
  verdicts: z.array(z.object({ id: z.string(), verdict: z.enum(["real", "not-a-bug", "nit", "pre-existing"]), reason: z.string().min(10) })).min(1),
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
{"needsInput": {"question": "One clear question, in plain language", "options": ["The answer you recommend", "Another option"]}}
\`\`\`

When you offer options, put the answer you recommend first: the coordinator sees it as your suggestion, and "Decide for me" picks it.`;

const SHAPES: Record<string, string> = {
  planner: `{"rationale": "Why this plan, in one or two plain sentences", "stages": [
  {"kind": "converge", "title": "Design", "roleId": "architect", "profileIds": ["<profile id>"], "reviewerRoleId": "design-reviewer", "reviewerProfileIds": ["<another tool's profile id>"], "maxRounds": 3},
  {"kind": "gate", "title": "Your design check", "roleId": "architect", "gate": "design"},
  {"kind": "do", "title": "Build", "roleId": "builder", "profileIds": ["<profile id>"]},
  {"kind": "review-chain", "title": "Review", "roleId": "code-reviewer", "profileIds": ["<profile id>", "<profile id on another tool>"], "maxRounds": 2}
], "risk": {"level": "medium", "why": "What it touches, in plain words"}}`,
  researcher: `{"summary": "What you found, in plain language", "notes": ["One finding per line"]}`,
  architect: `{"summary": "How it should work, in plain language", "forUsers": ["What changes for users"], "areas": ["Parts of the product"], "acceptance": ["How the coordinator will know it is done"], "risks": ["What could go wrong"], "answers": [{"id": "<objection id>", "status": "accepted", "answer": "What you changed, or why not"}]}`,
  "architect-call": `{"summary": "How it should work, in plain language", "forUsers": ["What changes for users"], "areas": ["Parts of the product"], "acceptance": ["How the coordinator will know it is done"], "risks": ["What could go wrong"], "answers": [{"id": "<objection id the call decides>", "status": "accepted", "byCall": true, "answer": "What you changed in the brief to follow the call"}, {"id": "<objection id the call does not speak to>", "status": "rejected", "byCall": false, "answer": "What you changed, or why not"}]}`,
  "design-reviewer": `{"objections": [{"text": "A concrete gap in the design", "blocking": true}]}`,
  "ux-designer": `{"summary": "The screens and words you propose", "notes": ["One note per line"]}`,
  builder: `{"summary": "What you built, in plain language", "changes": ["What changed for users, one per line"], "tests": "What you ran and the result", "answers": [{"id": "<finding id, in a fix round>", "fixed": true, "text": "What you changed, or why you did not"}]}`,
  tester: `{"summary": "How it went", "checks": [{"text": "An acceptance item", "pass": true}]}`,
  "check-finder": `{"summary": "How this product is checked, in one sentence", "checks": [{"name": "Tests", "argv": ["dotnet", "test"], "why": "CI runs it on every pull request"}]}`,
  "code-reviewer": `{"verdict": "pass", "findings": [{"text": "What is wrong, in plain language", "where": "file:line", "severity": "important", "evidence": "How you know"}], "confirms": ["<id of an earlier finding you agree with>"], "disputes": [{"id": "<id of an earlier finding you think is wrong>", "reason": "Why it is wrong, with evidence"}]}`,
  "security-reviewer": `{"verdict": "pass", "findings": [{"text": "What is unsafe, in plain language", "where": "file:line", "severity": "important", "evidence": "How someone could misuse it"}], "confirms": [], "disputes": []}`,
  "guide-keeper": `{"missed": true, "line": "One point a reviewer can check on any change, in plain words", "why": "What was missed, and how this point would have caught it"}`,
  verifier: `{"verdicts": [{"id": "<finding id>", "verdict": "real", "reason": "What you checked and what it showed"}]}`,
  shipper: `{"summary": "What you delivered", "prNumber": 12, "prUrl": "https://github.com/...", "tag": "v1.2.3", "releaseUrl": "https://github.com/...", "sha": "<commit sha on the default branch>"}`,
};

function roleInstructions(ctx: PromptContext): string {
  const { task, role, base, defaultBranch, branch } = ctx;
  switch (role.id) {
    case "planner": {
      const roles = ctx.roles.filter((entry) => !entry.internal).map((entry) => `- ${entry.id}: ${entry.purpose}`).join("\n");
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
- Do not add delivery stages; Petrina adds them.
- Rate the task's risk from what it touches, and say why in plain words:
  - "low": words, styles, docs, tests, or a small change inside one screen that cannot lose data or open access;
  - "medium": new behaviour or logic in one part of the product;
  - "high": sign-in and access, payments, secrets and credentials, data that could be lost or exposed (migrations, deletion, sync), shipping and release machinery, or anything most of the product shares.
  When unsure, rate it higher.`;
    }
    case "researcher":
      return "Research what users expect from this and how good products solve it. Look at the repository to understand the current state. Do not change any files.";
    case "architect":
      if (followingCall(task)) return CALL_INSTRUCTIONS;
      return `Design how this should work, for users and in the product. Read the code you need. Do not change any files: your output is the design brief.
Write it for a product person: plain language, no code. The acceptance list is what the builder must satisfy and the reviewers will check.
Keep the design as small as the task allows. Do not add mechanisms the task did not ask for (new security layers, sandboxes, settings, background services): if you see a need, put it in risks as a follow-up instead.
If objections are listed below, answer every one by its id: accept it and change the design, or reject it with a reason. Rejecting an objection that would grow the task beyond what was asked is a good reason.`;
    case "design-reviewer":
      return `Challenge the design brief below. Look for gaps, contradictions, missing edge cases, and things that will not work in this codebase. Do not change any files.
Mark an objection blocking only if building the design as written would be a mistake. Rare, recoverable edge cases and ideas that would grow the task beyond what was asked (new security layers, sandboxes, settings) are non-blocking: list them for follow-up. Prefer objections that make the design simpler.
If nothing blocking is left, return an empty or non-blocking list.${task.objections.some((objection) => objection.call !== undefined) ? "\nObjections settled by the coordinator's call are final: do not raise them again." : ""}`;
    case "ux-designer":
      return "Shape the screens, layout and words users will see for this change, following the product's existing design. Do not change any files: describe the design in your notes.";
    case "builder":
      return `Implement the task in this working copy. Follow the design brief and acceptance checklist below when there is one.
Keep the code consistent with the codebase and add or update tests.
Before you finish, run the product's full checks (every one listed below, or else its whole type check, lint, test suite and build), not just the tests you touched, and fix whatever fails. ${task.fixing ? "This holds after fixing review findings too: the work goes back to review only with every check passing." : "The work goes to review only with every check passing."} Petrina runs them again itself after you finish, and failures come straight back to you.
${task.fixing ? `You are fixing the review findings listed below. Fix every Important one, unless you can show it is wrong. Answer every finding by id in "answers": fixed and what you changed, or not fixed and why.${stepBack(task) ? `\nThis is fix round ${reviewRound(task) - 1} and the findings keep coming. Step back before patching again: reconsider the approach, and if a simpler design removes the whole class of problem, take it.` : ""}` : ""}
Do not commit, push or open pull requests: Petrina commits your work.`;
    case "tester":
      return "Run the product and check every acceptance item like a user would. Do not change files. Report each check as pass or fail.";
    case "check-finder":
      return `Work out which commands prove this product works, so Petrina can run them itself on every task. Read the repository the way a careful developer joining the team would: its CI workflows first (for example .github/workflows, azure-pipelines.yml, .gitlab-ci.yml), then build files (package.json, Cargo.toml, *.csproj or *.sln, go.mod, pyproject.toml, Package.swift, *.xcodeproj, build.gradle, pom.xml, Makefile) and the README.
Pick the checks CI relies on that run on this machine without secrets, deploy keys or cloud access: usually type check, lint, unit tests and a build. Prefer the exact commands CI runs. Skip deploys, releases, publishing and anything needing credentials.
Give each command as an argument array, exactly as it should run from the repository root (no shell, no pipes, no "&&"). If a check needs a different folder, use the tool's own option for it (for example "--cwd", "-C", "--project").
You may run a command to confirm it works, but keep it quick, and do not change files. Hand back between one and eight checks, fastest first.`;
    case "code-reviewer":
      return `Review the change on branch ${branch}: run \`git diff ${base}...HEAD\` to see it. Your job is to try to prove that it is NOT done.${
        reviewRound(task) > 1 && task.reviewedSha
          ? `\nThis is review round ${reviewRound(task)}: the rest was reviewed already. Review only what changed since the last round (\`git diff ${task.reviewedSha}..HEAD\`) and whether the findings below were really fixed. Raise nothing about code that did not change since.`
          : ""
      }
Check every acceptance item, look for bugs, missing tests, weakened tests and things that break existing behaviour.
Petrina already ran the product's checks on this exact commit (results below): do not run the full test suite or build again. Run a single test only when you need it to prove a finding.
Each finding says where it is and the evidence; never give a score. Tag it "important" only if the change should not ship with it, "nit" for anything smaller, and "pre-existing" for a problem the change did not cause: that becomes a follow-up and never holds the work back.
When you find a bug, look for the whole class of it in the change and report it once, listing every place. Never repeat a finding listed below, whether open, fixed or dismissed: confirm or dispute it by id instead.
If earlier reviewers' findings are listed below, confirm the ones you agree with by id. Dispute the ones you think are wrong by id, always with the reason and your evidence: the coordinator reads it. A finding another reviewer confirmed stays open whatever you say, so make your case.
Do not change any files.`;
    case "security-reviewer":
      return `This change was rated high risk${task.risk ? ` (${task.risk.why})` : ""}. Review the change on branch ${branch} (\`git diff ${base}...HEAD\`) for security problems only: who can reach what (access checks, sign-in, permissions), secrets and credentials, input from outside (injection, paths, URLs), data that could be exposed or lost, and unsafe defaults. Other reviewers cover everything else.
Petrina already ran the product's checks on this exact commit (results below): do not run the full test suite or build again.
Each finding says where it is and how someone could misuse it. Tag it "important" only if the change should not ship with it, "nit" for hardening that can wait, and "pre-existing" for a problem the change did not cause. Report a whole class of problem once, listing every place. Never repeat a finding listed below: confirm or dispute it by id instead.
Do not change any files.`;
    case "guide-keeper":
      return `The coordinator sent back work that every reviewer had passed, with the note below. Decide whether the reviewers missed something they should have caught. If they did, write one point for the product's review guide (REVIEW.md) so reviewers catch that whole class of problem next time.
The point is a check a reviewer can make on any change, in plain words, not about this task alone (for example "Every page behind sign-in handles an expired session"). Do not repeat a point the guide already has.
If the note is a change of mind or a new wish rather than a miss, set "missed" to false and leave "line" empty.
Do not change any files.`;
    case "verifier":
      return `Reviewers raised the Important findings below about the change on branch ${branch} (see \`git diff ${base}...HEAD\`). Before any of them can send the work back to the builder, check each one yourself, with fresh eyes: read the code, and run a single test when that is the quickest proof. For each finding, by id, give your verdict:
- "real": the change should not ship with it;
- "not-a-bug": it is wrong, and say why;
- "nit": real but small, it should not hold the work back;
- "pre-existing": the problem was already there before this change (check ${base}), so it is a follow-up.
Be strict both ways: a finding without real evidence is not real, and a real one stays real however it was worded. Do not change any files.`;
    case "shipper":
      return shipperInstructions(ctx, defaultBranch);
    default:
      return role.purpose;
  }
}

const CALL_INSTRUCTIONS = `The architects disagreed and the coordinator made the call below. The call is final: do not reopen it, argue with it or ask for another review. Nobody reviews the design again; the coordinator checks the brief before anything is built.
Update the design brief so it follows the call. Read the code you need. Do not change any files: your output is the design brief. Write it for a product person: plain language, no code.
Answer every objection listed as still open, or as answered after the call, by its id. Leave none out:
- If the call decides it, set "byCall" to true, set "status" to what the call says (accepted or rejected), and in "answer" say what you changed in the brief to follow the call.
- If the call does not speak to it, set "byCall" to false and answer it yourself: accept it and change the brief, or reject it with a reason.
If objections are listed as answered after the call, the coordinator checked the brief that follows the call and asked for changes in their latest note: change the brief to cover it too, still following the call. Then answer every objection answered after the call again: keep or correct its status and "byCall" (the notes may say you read the call wrong), and make "answer" match the updated brief. Your new answers replace the old ones.`;

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

/** The coordinator works on this computer while the squad does: agents never take over the screen. */
export const BACKGROUND = `Work in the background: the coordinator is using this computer while you work. Never open windows or apps on their screen. That means no open, xdg-open or start, no visible browser, no desktop app window and no terminal window. In tests, use stand-ins for anything that would open one. Stop every server and browser you start before you finish.
Check what you build without windows:
- Web UIs, including Tauri and Electron front ends: in a headless browser (Playwright with headless: true, or headless Chrome) on a free port.
- Native Mac app screens (SwiftUI, AppKit): render views offscreen to images in snapshot tests, never by launching the app.
If a check truly needs the running app on screen, don't do it: list it in your result as a check that needs the screen.`;

export function buildPrompt(ctx: PromptContext): string {
  const { task, product, role, worktree, branch } = ctx;
  const sections = ctx.sections.map((section) => `## ${section.title}\n${section.body}`).join("\n\n");
  return `You are the ${role.name} in Petrina, a squad of AI agents working on the product "${product.name}" (${product.repo}).
The coordinator who reads your work is a product person, not a developer: everything you write for them is plain language, short, and free of code.

Your working copy is ${worktree}, on branch ${branch}. Stay inside it.

${BACKGROUND}

# The task: ${task.title}
${task.description || "(no further description)"}

# Your job
${roleInstructions(ctx)}

${sections}

Keep a short to-do list as you work, written in plain language: the coordinator watches it live.
${RESULT_FOOTER(SHAPES[role.id === "architect" && followingCall(task) ? "architect-call" : role.id] ?? SHAPES["researcher"]!)}`;
}

export function repairPrompt(error: string): string {
  return `Your result block could not be used: ${error}
Reply with only the corrected \`\`\`petrina block, nothing else.`;
}

export function formatObjections(objections: readonly Objection[]): string {
  return objections
    .map((objection) => `- [${objection.id}] ${objection.blocking ? "BLOCKING" : "not blocking"} (${objection.status}${objection.call ? " by the coordinator's call" : ""}): ${objection.text}${objection.answer ? ` | Architect: ${objection.answer}` : ""}`)
    .join("\n");
}

/** The review round the task is in (1 for the first). */
export function reviewRound(task: Task): number {
  const stage = task.plan?.stages.find((entry, index) => entry.kind === "review-chain" && index >= task.stageIndex) ?? task.plan?.stages.findLast((entry) => entry.kind === "review-chain");
  return (stage && task.rounds[stage.id]) || 1;
}

/** After three rounds of review the builder is asked to step back instead of patching again. */
function stepBack(task: Task): boolean {
  return reviewRound(task) > 3;
}

/** The words agents and the coordinator use for a finding's severity. */
export const FINDING_TAG: Record<Finding["severity"], string> = { blocking: "important", suggestion: "nit", "pre-existing": "pre-existing" };

export function formatFindings(findings: readonly Finding[]): string {
  return findings
    .map((finding) => {
      const line = [
        `- [${finding.id}] ${FINDING_TAG[finding.severity]} (${finding.status}): ${finding.text}${finding.where ? ` at ${finding.where}` : ""}`,
        finding.verification ? `  Verified by a fresh agent: ${finding.verification.verdict}. ${finding.verification.reason}` : "",
        finding.answer ? `  The builder: ${finding.answer.fixed ? "fixed" : "not fixed"}. ${finding.answer.text}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      // Evidence matters most where Petrina itself found the problem (a failing check): the builder sees the output.
      const evidence = finding.evidence && finding.raisedBy === "petrina" && finding.status === "open" ? `\n  Evidence:\n${finding.evidence.slice(-1200).replace(/^/gm, "    ")}` : "";
      return line + evidence;
    })
    .join("\n");
}

/** Where an agent was in a step when Petrina restarted: for the restart line and the fresh start's summary. */
export interface WhereYouWere {
  /** The stage, in the coordinator's words ("Build", "Design, round 2"). */
  stage: string;
  role: string;
  /** What the agent did in this step, oldest first. */
  done: readonly string[];
  /** Files added, changed or removed in the working copy since the step started. */
  files?: readonly { change: string; file: string }[];
}

export const MAX_DONE = 10;
export const MAX_FILES = 30;

/** The one line a reopened conversation gets, followed by what it has not heard yet. */
export function restartPrompt(where: WhereYouWere, unheard: { answer?: { question: string; text: string }; messages: readonly string[] }): string {
  const last = where.done.at(-1);
  const parts = [
    `Petrina restarted while you were on “${where.stage}” as the ${where.role}. ${last ? `The last thing you were doing: ${last}.` : "You had just started this step."} Your last action may not have finished, so check the working copy, then continue where you left off.`,
  ];
  if (unheard.answer) parts.push(`The coordinator answered your question “${unheard.answer.question}”: ${unheard.answer.text}`);
  if (unheard.messages.length) parts.push(`Messages from the coordinator you have not seen yet, in order:\n${unheard.messages.map((text) => `- ${text}`).join("\n")}`);
  parts.push(`${unheard.answer || unheard.messages.length ? "Take them into account. " : ""}When you are done, end with the result block.`);
  return parts.join("\n\n");
}

export const WHERE_YOU_WERE = "Where you were when Petrina restarted";

/** For a fresh conversation on a step whose conversation could not be reopened. */
export function formatWhereYouWere(where: WhereYouWere, reason: string): string {
  const files = where.files ?? [];
  const lines = [
    `Petrina restarted while you were on “${where.stage}” as the ${where.role}, and your conversation could not be reopened (${reason}), so this one is fresh. The working copy keeps what you did: build on it instead of redoing it. Your last action may not have finished, so check the working copy first.`,
    where.done.length ? `What you did last in this step, oldest first:\n${where.done.map((line) => `- ${line}`).join("\n")}` : "Nothing was recorded of what you did in this step.",
    files.length
      ? `Files added, changed or removed in the working copy since this step started:\n${files
          .slice(0, MAX_FILES)
          .map((entry) => `- ${entry.change}: ${entry.file}`)
          .join("\n")}${files.length > MAX_FILES ? `\n- and ${files.length - MAX_FILES} more` : ""}`
      : "No files were added, changed or removed in the working copy since this step started.",
  ];
  return lines.join("\n\n");
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

/** What changed while the coordinator drove a step by hand. */
export interface HandBack {
  /** The role the coordinator drove, e.g. "Builder". */
  role: string;
  tool: string;
  /** How long they drove, in milliseconds. */
  took: number;
  /** The files of the agent's unfinished work Petrina saved before the take-over. */
  saved?: readonly string[];
  /** Commits made while driving. */
  commits: number;
  /** Files added, changed or removed while driving, committed or not. */
  files: readonly { change: string; file: string }[];
  /** Petrina saved what was left unsaved as one commit marked as made by hand. */
  leftovers: boolean;
  /** The coordinator's own note. */
  note?: string;
}

export const MAX_HANDBACK_FILES = 10;

function spent(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** The short note of a hand back: in the session, the timeline, the task's notes, and for the agent that carries on. */
export function handBackNote(back: HandBack): string {
  const lines = [`Handed back after driving the ${back.role} by hand in the terminal (${back.tool}) for ${spent(back.took)}.`];
  const saved = back.saved ?? [];
  if (saved.length) lines.push(`- Before the take-over, Petrina saved the ${back.role}'s unfinished work as one commit: ${plural(saved.length, "file")} (${saved.slice(0, 3).join(", ")}${saved.length > 3 ? ` and ${saved.length - 3} more` : ""}).`);
  lines.push(back.commits ? `- Commits made while driving: ${back.commits}.` : "- No commits were made while driving.");
  if (back.files.length) {
    lines.push(`- Files added, changed or removed while driving: ${back.files.length}.`);
    for (const entry of back.files.slice(0, MAX_HANDBACK_FILES)) lines.push(`  - ${entry.change}: ${entry.file}`);
    if (back.files.length > MAX_HANDBACK_FILES) lines.push(`  - and ${back.files.length - MAX_HANDBACK_FILES} more`);
  } else {
    lines.push("- No files changed while driving.");
  }
  if (back.leftovers) lines.push("- Petrina saved what was left unsaved as one commit, marked as made by hand.");
  const note = back.note?.trim();
  if (note) lines.push(`- Note: ${note}`);
  return lines.join("\n");
}

/** What a reopened conversation hears after a hand back, then any messages that waited for it. */
export function handBackPrompt(note: string, messages: readonly string[]): string {
  const parts = [`The coordinator took over this step in their own terminal, on this same conversation, and has handed it back to you. What changed:\n${note}`];
  if (messages.length) parts.push(`Messages from the coordinator that waited for the hand back, in order:\n${messages.map((text) => `- ${text}`).join("\n")}`);
  parts.push("Check the working copy, then carry on with this step. When you are done, end with the result block.");
  return parts.join("\n\n");
}

export const HANDED_BACK = "The coordinator drove this step by hand and handed it back";

/** For a fresh conversation, when the one the coordinator drove could not be reopened. */
export function formatHandBack(note: string, reason: string): string {
  return `The coordinator took over this step in their own terminal and handed it back. That conversation could not be reopened (${reason}), so this one is fresh. The working copy keeps everything that was done: build on it instead of redoing it, and check it first.\n\nWhat changed:\n${note}`;
}
