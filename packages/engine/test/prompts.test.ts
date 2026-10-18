import { describe, expect, it } from "bun:test";
import { BUILT_IN_ROLES, createDemoState, DEFAULT_PROFILES, DEMO_PRODUCTS } from "@petrina/core";
import { ASK_FOR_SCREEN, BACKGROUND, buildPrompt, continuePrompt, formatFindings, LOGINS, mayAskScreen, parseResult, screenRules } from "../src/prompts.js";
import { NotesResult } from "../src/roles.js";

const task = createDemoState(1_000_000_000).tasks[0]!;
const context = (role: (typeof BUILT_IN_ROLES)[number], screen?: "ask" | { reason: string }) => ({
  task,
  product: DEMO_PRODUCTS[0]!,
  role,
  roles: BUILT_IN_ROLES,
  profiles: DEFAULT_PROFILES,
  worktree: "/tmp/worktree",
  branch: "petrina/task",
  base: "main",
  defaultBranch: "main",
  sections: [],
  ...(screen ? { screen } : {}),
});
const promptFor = (role: (typeof BUILT_IN_ROLES)[number], screen?: "ask" | { reason: string }) => buildPrompt(context(role, screen));

describe("prompts", () => {
  it("hands a reviewer's reproduction to builders and voters, while keeping settled history concise", () => {
    const finding = { id: "finding-1", text: "The greeting disappears", where: "greeting.txt:1", evidence: "Open the welcome page with an empty name; the heading disappears.", severity: "blocking" as const, raisedBy: "sol-high", confirmedBy: [], status: "open" as const };
    expect(formatFindings([finding])).toContain(finding.evidence);
    expect(formatFindings([{ ...finding, status: "fixed" }])).not.toContain(finding.evidence);
    expect(formatFindings([{ ...finding, evidence: "x".repeat(10_000) }]).length).toBeLessThan(1600);
  });
  it("tells every role to put its recommended answer first when it asks the coordinator", () => {
    for (const role of BUILT_IN_ROLES) {
      const prompt = promptFor(role);
      expect(prompt).toContain("put the answer you recommend first");
      expect(prompt).toContain('"options": ["The answer you recommend", "Another option"]');
      // Every agent reads with the coordinator's logins and publishes nothing, in the background.
      expect(prompt).toContain(LOGINS);
      expect(prompt).toContain(BACKGROUND);
    }
  });
  it("keeps code review bounded for open-ended behavior without weakening regression checks", () => {
    const role = BUILT_IN_ROLES.find((entry) => entry.id === "code-reviewer")!;
    const prompt = promptFor(role);
    expect(prompt).toContain("one finding per root cause");
    expect(prompt).toContain("do not enumerate paraphrases, synonyms, or permutations");
    expect(prompt).toContain("representative syntax classes");
    expect(prompt).toContain("look for bugs, missing tests, weakened tests");
  });

  it("tells every role except the Release Manager how to ask, without granting the screen", () => {
    for (const role of BUILT_IN_ROLES) {
      expect(mayAskScreen(role)).toBe(role.id !== "release-manager");
      const prompt = promptFor(role);
      expect(prompt).toContain(BACKGROUND);
      if (role.id === "release-manager") {
        expect(prompt).toContain("list it in your result as a check that needs the screen");
        expect(prompt).not.toContain("needsScreen");
      } else {
        expect(prompt).toContain(ASK_FOR_SCREEN);
        expect(prompt).toContain('{"needsScreen": {"reason": "What you need to check on screen, in plain language"}}');
        expect(prompt).not.toContain("You may now use the screen");
        expect(promptFor(role, { reason: "Check the menu bar" })).toContain(screenRules("Check the menu bar"));
      }
    }
  });

  it("tells an agent back in its own conversation that it does not have the screen now", () => {
    const builder = BUILT_IN_ROLES.find((role) => role.id === "builder")!;
    const back = continuePrompt(context(builder, "ask"));
    expect(back).toContain("You do not have the screen now, even if you had it earlier in this conversation.");
    expect(back).toContain('{"needsScreen"');
    expect(back).not.toContain("You may now use the screen");
    expect(continuePrompt(context(builder))).toContain("You do not have the screen now");
  });

  it("reads a screen request as its own kind of result, with the reason", () => {
    expect(parseResult('Done in the background.\n\n```petrina\n{"needsScreen": {"reason": "Click through the menu bar"}}\n```', NotesResult)).toEqual({ ok: "screen", reason: "Click through the menu bar" });
    expect(parseResult('```petrina\n{"needsScreen": {"reason": ""}}\n```', NotesResult).ok).toBe(false);
  });
});

import { addRole, draftOf, editRole, libraryRoles, NO_ROLE_CHANGES, ROLE_STARTS } from "@petrina/core";
import { MAY_CHANGE, roleCard } from "../src/prompts.js";
import { contractFor, plannerRoles } from "../src/roles.js";
import { promptContexts } from "./prompt-contexts.js";
import before from "./today-prompts.json";

describe("saved role wording", () => {
  const contexts = promptContexts();
  it("keeps main's default instructions apart from asking for the screen, and the Release Manager unchanged", () => {
    for (const [name, context] of Object.entries(contexts)) {
      const now = buildPrompt(context).replace(roleCard(context), "").replace(ASK_FOR_SCREEN, "If a check truly needs the running app on screen, don't do it: list it in your result as a check that needs the screen.");
      const was = (before as Record<string, string>)[name]!;
      if (context.role.id === "planner") {
        const job = (text: string) => text.slice(text.indexOf("# Your job"), text.indexOf("## Design brief") > 0 ? text.indexOf("## Design brief") : text.length);
        // Only the richer role list and the placement rules change for the planner.
        expect(now.replace(job(now), "")).toBe(was.replace(job(was), ""));
        expect(now).toContain(plannerRoles(context.roles));
      } else if (context.role.id !== "builder") expect(now).toBe(was);
    }
  });
  it("leaves the product's full check run to Petrina after the Builder finishes", () => {
    for (const name of ["builder", "builder fixing review findings"]) {
      const job = contractFor(contexts[name]!.role).instructions(contexts[name]!);
      expect(job).toContain("Run focused tests that cover the behavior you changed while you work.");
      expect(job).toContain("Petrina runs them on the finished work before review");
      expect(job).toContain("Run a broader check only when needed to diagnose a failure.");
      expect(job).not.toContain("run the product's full checks");
    }
  });
  it("uses saved wording and keeps fixed planner rules after it", () => {
    const changes = editRole(NO_ROLE_CHANGES, "planner", { ...draftOf(contexts.planner!.role), instructions: "Make a short plan." });
    const roles = libraryRoles(changes);
    const text = buildPrompt({ ...contexts.planner!, roles, role: roles.find((role) => role.id === "planner")! });
    expect(text).toContain("# Your job\nMake a short plan.\n\nRoles you can use:");
    expect(text).toContain("Always include exactly one builder stage before the review chain.");
    expect(text).toContain("Put every stage that may change the product before the final review chain.");
  });
  for (const [id, guidance] of [
    ["check-finder", "Hand back between one and eight checks, fastest first."],
    ["guide-keeper", "Do not repeat a point the guide already has."],
    ["verifier", '"not-a-bug": it is wrong, and say why;'],
    ["security-reviewer", "Report a whole class of problem once, listing every place."],
  ]) {
    it(`shows and uses the ${id}'s full saved job, preserving context and the result contract`, () => {
      const ctx = contexts[id!]!;
      expect(ctx.role.instructions).toContain(guidance!);
      expect(ctx.role.instructions).not.toBe(ctx.role.purpose);
      const instructions = `${ctx.role.instructions}\nCheck the welcome page carefully.`;
      const changes = editRole(NO_ROLE_CHANGES, id!, { ...draftOf(ctx.role), instructions });
      const roles = libraryRoles(changes);
      const role = roles.find((entry) => entry.id === id)!;
      const updated = { ...ctx, roles, role };
      const prompt = buildPrompt(updated);
      const job = contractFor(role).instructions(updated);
      expect(job).toContain(instructions);
      expect(job).toContain(guidance!);
      expect(prompt).toContain(MAY_CHANGE.readOnly);
      expect(contractFor(role).result).toBe(contractFor(ctx.role).result);
      expect(contractFor(role).reads).toEqual(contractFor(ctx.role).reads);
      expect(prompt).toContain('```petrina');
      if (id === "verifier" || id === "security-reviewer") {
        expect(job).toContain(ctx.branch);
        expect(job).toContain(ctx.base);
      }
      if (id === "security-reviewer") expect(job).toContain("Petrina already ran the product's checks");
    });
  }
  it("gives added reviewers the review contract and requires reasons for disputes", () => {
    const added = addRole(NO_ROLE_CHANGES, ROLE_STARTS[1]!.draft);
    const roles = libraryRoles(added.changes);
    const role = roles.find((entry) => entry.id === added.roleId)!;
    const ctx = { ...contexts["code-reviewer"]!, role, roles };
    const text = buildPrompt(ctx);
    expect(text).toContain(role.instructions);
    expect(text).toContain(role.purpose);
    expect(text).toContain(MAY_CHANGE.readOnly);
    expect(text).toContain("always with the reason and your evidence");
    expect(text).toContain('"disputes": [{"id":');
    expect(contractFor(role).result.safeParse({ verdict: "pass", disputes: ["missing reason"] }).success).toBe(false);
    expect(contractFor(role).reads).toContain("findings");
    expect(plannerRoles(roles)).toContain(`${role.id} (${role.name})`);
  });
  it("tells a reviewer with edited wording, or an added one, to review only the port after main moved", () => {
    const portReview = { from: "1111111aaaa", head: "2222222bbbb", onto: "3333333cccc", files: ["src/app.ts"] };
    const added = addRole(NO_ROLE_CHANGES, ROLE_STARTS[1]!.draft);
    let changes = added.changes;
    for (const id of ["code-reviewer", "security-reviewer"]) changes = editRole(changes, id, { ...draftOf(contexts[id]!.role), instructions: "Look hard at the welcome page." });
    const roles = libraryRoles(changes);
    for (const id of ["code-reviewer", "security-reviewer", added.roleId]) {
      const role = roles.find((entry) => entry.id === id)!;
      const ctx = { ...contexts["code-reviewer"]!, task: { ...contexts["code-reviewer"]!.task, portReview }, roles, role };
      const text = buildPrompt(ctx);
      expect(text).toContain(role.instructions);
      expect(text).toContain("Review only the port: run `git range-diff 1111111aaaa..2222222bbbb 3333333cccc..HEAD`");
      expect(text).toContain("resolving conflicts in: src/app.ts");
    }
  });
  it("uses the permission of the step and the saved purpose and hands-back description", () => {
    const added = addRole(NO_ROLE_CHANGES, { ...ROLE_STARTS[2]!.draft, canEdit: true });
    const roles = libraryRoles(added.changes);
    const role = roles.find((entry) => entry.id === added.roleId)!;
    const ctx = { ...contexts.researcher!, roles, role };
    const text = buildPrompt(ctx);
    expect(text).toContain(role.instructions);
    expect(text).toContain(`Your role: ${role.purpose}`);
    expect(text).toContain(`What you hand back: ${role.handsBack}`);
    expect(text).toContain(MAY_CHANGE.canEdit);
    expect(buildPrompt({ ...ctx, access: { canEdit: false, afterReview: true } })).toContain(MAY_CHANGE.afterReview);
    for (const id of ["researcher", "architect", "ux-designer", "tester"]) {
      const changes = editRole(NO_ROLE_CHANGES, id, { ...draftOf(contexts[id]!.role), canEdit: true });
      const role = libraryRoles(changes).find((entry) => entry.id === id)!;
      const text = buildPrompt({ ...contexts[id]!, role });
      expect(text).toContain(MAY_CHANGE.canEdit);
      expect(text).not.toContain("Do not change any files");
      expect(text).not.toContain("Do not change files");
    }
  });
});
