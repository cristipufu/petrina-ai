import { describe, expect, it } from "bun:test";
import { BUILT_IN_ROLES, createDemoState, DEFAULT_PROFILES, DEMO_PRODUCTS, DESIGN_OBJECTION_RULE, FINDING_CONFIRMATION_RULE, FINDING_REVIEW_RULES, REPAIR_RULE } from "@petrina/core";
import { ASK_FOR_SCREEN, BACKGROUND, buildPrompt, continuePrompt, FOCUSED_VERIFICATION, formatFindings, formatWhereYouWere, LOGINS, mayAskScreen, parseResult, restartPrompt, screenRules } from "../src/prompts.js";
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
  it("requires an external execution deadline for focused probes on fresh and continued turns", () => {
    for (const role of BUILT_IN_ROLES) {
      expect(promptFor(role)).toContain(FOCUSED_VERIFICATION);
      expect(continuePrompt(context(role))).toContain(FOCUSED_VERIFICATION);
    }
  });
  it("explains fresh browser storage after restart and failed reopening, including a screen continuation", () => {
    const where = { stage: "Build", role: "Builder", done: ["Checked the page"] };
    const reopened = restartPrompt(where, { messages: [] });
    const fresh = formatWhereYouWere(where, "the tool could not reopen it");
    const screen = formatWhereYouWere(where, "the tool could not reopen it", "screen");
    for (const text of [reopened, fresh, screen]) {
      expect(text).toContain("Earlier pages and browser logins are gone");
      expect(text).toContain("starts with empty storage");
    }
    expect(screen).toStartWith("You asked for the screen");
    expect(screen).not.toContain("Petrina restarted");
  });
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
      expect(prompt).toContain('Word each item as what you are doing for the product, the way you would tell the coordinator ("Working out what changes for users"), never with file, function or command names.');
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

  it("defines confirmations as current bugs in code and security review prompts", () => {
    const meaning = '"Confirms" means "still broken now"';
    for (const id of ["code-reviewer", "security-reviewer"]) {
      const role = BUILT_IN_ROLES.find((entry) => entry.id === id)!;
      const prompt = promptFor(role);
      expect(prompt).toContain(meaning);
      expect(prompt).toContain("only if that specific");
      expect(prompt).toContain("current code");
      expect(prompt).toContain("omit if fixed");
    }
  });

  it("keeps current-code confirmations alongside affected products in shared review prompts", () => {
    const added = addRole(NO_ROLE_CHANGES, ROLE_STARTS.find((entry) => entry.id === "security")!.draft);
    const roles = libraryRoles(added.changes);
    const products = DEMO_PRODUCTS.slice(0, 2);
    const shared = { ...task, repositories: products.map((product, index) => ({ productId: product.id, delivery: "pull-request" as const, completedStages: [], baseSha: `base-${index}`, reviewedSha: `review-${index}` })) };
    for (const id of ["code-reviewer", "security-reviewer", added.roleId]) {
      const role = roles.find((entry) => entry.id === id)!;
      const prompt = buildPrompt({ ...context(role), task: shared, roles });
      expect(prompt).toContain('"productIds": ["<every affected product id>"]');
      expect(prompt).toContain('"Confirms" means "still broken now"');
      expect(prompt).toContain("only if that specific problem is still present in the current code; omit if fixed");
      expect(prompt).toContain('"confirms": [{"id":');
      expect(prompt).toContain('"evidence": "The exact current failing case');
      expect(prompt).not.toContain("<id of an earlier finding you agree with>");
      expect(prompt).toContain("Review all repositories in the complete approved product map together.");
      for (let index = 0; index < products.length; index += 1) {
        if (id !== "security-reviewer") {
          expect(prompt).toContain(`git diff review-${index}..HEAD`);
          expect(prompt).not.toContain(`git diff base-${index}...HEAD`);
        } else {
          expect(prompt).toContain(`git diff base-${index}...HEAD`);
          expect(prompt).not.toContain(`git diff review-${index}..HEAD`);
        }
        expect(prompt).toContain(`git show base-${index}:REVIEW.md`);
      }
    }
  });

  it("keeps security reviews on full saved-base diffs after a code review baseline advances", () => {
    const security = BUILT_IN_ROLES.find((entry) => entry.id === "security-reviewer")!;
    const products = DEMO_PRODUCTS.slice(0, 2);
    const shared = {
      ...task,
      repositories: products.map((product, index) => ({
        productId: product.id,
        delivery: "pull-request" as const,
        completedStages: [],
        baseSha: `base-${index}`,
        reviewedSha: `reviewed-${index}`,
      })),
    };
    const sharedPrompt = buildPrompt({ ...context(security), task: shared, base: "lead-base" });
    for (let index = 0; index < products.length; index += 1) {
      expect(sharedPrompt).toContain(`git diff base-${index}...HEAD`);
      expect(sharedPrompt).not.toContain(`git diff reviewed-${index}..HEAD`);
      expect(sharedPrompt).toContain(`git show base-${index}:REVIEW.md`);
    }

    const singlePrompt = buildPrompt({
      ...context(security),
      task: { ...task, baseSha: "single-base", reviewedSha: "single-reviewed" },
      base: "single-base",
    });
    expect(singlePrompt).toContain("git diff single-base...HEAD");
    expect(singlePrompt).not.toContain("git diff single-reviewed..HEAD");

    const changes = editRole(NO_ROLE_CHANGES, "security-reviewer", {
      ...draftOf(security),
      instructions: "Check the access boundary for each product.",
    });
    const roles = libraryRoles(changes);
    const custom = roles.find((entry) => entry.id === "security-reviewer")!;
    const customPrompt = buildPrompt({ ...context(custom), task: shared, role: custom, roles, base: "lead-base" });
    expect(customPrompt).toContain("Check the access boundary for each product.");
    expect(customPrompt).toContain("git diff base-0...HEAD");
    expect(customPrompt).not.toContain("git diff reviewed-0..HEAD");
  });

  it("gives every findings role one canonical evidence rule, including saved wording overrides", () => {
    const added = addRole(NO_ROLE_CHANGES, ROLE_STARTS.find((entry) => entry.id === "security")!.draft);
    let changes = added.changes;
    for (const id of ["code-reviewer", "security-reviewer"]) changes = editRole(changes, id, { ...draftOf(BUILT_IN_ROLES.find((role) => role.id === id)!), instructions: "Review the current welcome page." });
    const roles = libraryRoles(changes);
    for (const role of roles.filter((entry) => entry.result === "findings")) {
      const prompt = buildPrompt({ ...context(role), roles });
      expect(prompt).toContain(role.instructions);
      expect(prompt.split(FINDING_CONFIRMATION_RULE)).toHaveLength(2);
      expect(prompt).toContain('"confirms": [{"id":');
      expect(prompt).toContain('"evidence": "The exact current failing case');
    }
  });

  it("asks for one cause with its affected paths in every findings role, including partial saved rules", () => {
    const added = addRole(NO_ROLE_CHANGES, ROLE_STARTS.find((entry) => entry.id === "security")!.draft);
    for (const wording of [undefined, "Review the current welcome page.", `Review our checkout.\n${FINDING_CONFIRMATION_RULE}`, `Review our checkout.\n${FINDING_REVIEW_RULES.join("\n")}`]) {
      let changes = added.changes;
      if (wording) for (const id of ["code-reviewer", "security-reviewer", added.roleId]) {
        const role = libraryRoles(changes).find((entry) => entry.id === id)!;
        changes = editRole(changes, id, { ...draftOf(role), instructions: wording });
      }
      const roles = libraryRoles(changes);
      for (const role of roles.filter((entry) => entry.result === "findings")) for (const prompt of [buildPrompt, continuePrompt]) {
        const text = prompt({ ...context(role), roles });
        expect(text).toContain(role.instructions);
        for (const rule of FINDING_REVIEW_RULES) expect(text.split(rule)).toHaveLength(2);
        expect(text).toContain("all observed affected paths together");
        expect(text).toContain("use that finding's id and include the variant in fresh confirmation evidence");
        expect(text).toContain("reserve new findings for distinct root causes");
        expect(text).toContain("representative syntax classes");
        expect(text).toContain("pre-existing");
        expect(text).toContain("do not run the full test suite or build again");
      }
    }
  });

  it("gives default and edited Builders whole-cause repair guidance on their first return and later repairs", () => {
    const builder = BUILT_IN_ROLES.find((role) => role.id === "builder")!;
    for (const instructions of [builder.instructions, "Keep the checkout simple.", `Keep the checkout simple.\n${REPAIR_RULE}`]) {
      const changes = editRole(NO_ROLE_CHANGES, builder.id, { ...draftOf(builder), instructions });
      const roles = libraryRoles(changes);
      const role = roles.find((entry) => entry.id === builder.id)!;
      for (const round of [1, 5]) for (const prompt of [buildPrompt, continuePrompt]) {
        const review = { id: "review", kind: "review-chain" as const, title: "Review", roleId: "code-reviewer", profileIds: ["sol-high"] };
        const repairing = { ...task, fixing: true, plan: { stages: [review], rationale: "Review the repair.", plannerProfileId: "sol-high" }, stageIndex: 0, rounds: { [review.id]: round } };
        const text = prompt({ ...context(role), task: repairing, roles });
        expect(text).toContain(instructions);
        expect(text.split(REPAIR_RULE)).toHaveLength(2);
        expect(text).toContain("from the first return, identify the underlying rule");
        expect(text).toContain("normal, failure and recovery paths");
        expect(text).toContain("failing variants and nearby passing controls");
        expect(text).toContain("distinguish cases inspected from cases executed");
        expect(text).toContain("fast focused static or type check for the changed code and typed tests");
        expect(text).toContain("Do not assume a passing runtime test proves a separate static or type check will pass.");
        expect(text).toContain("no focused command was available");
        expect(text).toContain("Petrina runs them on the finished work before review");
        expect(text).toContain('Answer every finding by id in "answers"');
        expect(text).toContain("Do not commit, push or open pull requests");
      }
    }
  });

  it("checks nearby cases for regressions on every product without needing a local review guide", () => {
    const roles = libraryRoles({ edits: { "code-reviewer": { purpose: "Review the changed checkout." } }, added: [] });
    const role = roles.find((entry) => entry.id === "code-reviewer")!;
    const rule = "A confirmed regression caused by the change is Important, even when the intended case now works.";
    expect(role.instructions).toContain(rule);
    for (const product of [DEMO_PRODUCTS[0]!, { ...DEMO_PRODUCTS[0]!, id: "another-product", name: "Another product" }]) {
      const text = buildPrompt({ ...context(role), product, roles, sections: [] });
      expect(text).toContain("check nearby cases affected by the same code or rule");
      expect(text).toContain("Compare with the starting version.");
      expect(text.split(rule)).toHaveLength(2);
      expect(text).toContain("do not run the full test suite or build again");
    }
    // A deliberate instructions override stays the coordinator's own wording.
    const custom = libraryRoles({ edits: { "code-reviewer": { instructions: "Review checkout compatibility." } }, added: [] }).find((entry) => entry.id === "code-reviewer")!;
    expect(custom.instructions).toBe("Review checkout compatibility.");
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
  it("keeps main's default instructions apart from confirmed-source planning and screen instructions, and the Release Manager unchanged", () => {
    const multipleReports = "Several independent reports may describe the same underlying bug: fix it once and reuse that explanation, but answer every related finding id. ";
    for (const [name, context] of Object.entries(contexts)) {
      const text = buildPrompt(context);
      if (context.role.id === "builder") expect(text.includes(multipleReports)).toBe(!!context.task.fixing);
      const now = text.replace(multipleReports, "").replace(roleCard(context), "").replace(`\n${DESIGN_OBJECTION_RULE}`, "").replace(ASK_FOR_SCREEN, "If a check truly needs the running app on screen, don't do it: list it in your result as a check that needs the screen.");
      const was = (before as Record<string, string>)[name]!;
      if (context.role.id === "planner") {
        const job = (text: string) => text.slice(text.indexOf("# Your job"), text.indexOf("## Design brief") > 0 ? text.indexOf("## Design brief") : text.length);
        // The planner works before setup and proposes the product list, reasons and ownership. Everything outside those changes,
        // the richer role list and main's placement rules keeps its earlier wording.
        const expected = was
          .replace(`Your working copy is ${context.worktree}, on branch ${context.branch}. Stay inside it.`, `Your planning folder is ${context.worktree}. No task working copy exists yet. Investigate GitHub and the registered products’ existing local copies read-only; preserve all uncommitted work.`)
          .replace('Keep a short to-do list as you work, written in plain language: the coordinator watches it live.', 'Keep a short to-do list as you work, written in plain language: the coordinator watches it live. Word each item as what you are doing for the product, the way you would tell the coordinator ("Working out what changes for users"), never with file, function or command names.')
          .replace('{"worksOn": [{"productId": "<registered product id>", "startFrom": {"kind": "default"}, "delivery": "pull-request"}], "rationale":', '{"worksOn": [{"productId": "<registered product id>", "startFrom": {"kind": "default"}, "delivery": "pull-request", "reason": "Why this product is involved", "builderProfileId": "<profile id>"}], "leadProductId": "<product id for shared repairs>", "rationale":');
        expect(now.replace(job(now), "")).toBe(expected.replace(job(expected), ""));
        expect(now).toContain(plannerRoles(context.roles));
      } else expect(now).toBe(was.replace('Keep a short to-do list as you work, written in plain language: the coordinator watches it live.', 'Keep a short to-do list as you work, written in plain language: the coordinator watches it live. Word each item as what you are doing for the product, the way you would tell the coordinator ("Working out what changes for users"), never with file, function or command names.'));
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
    ["security-reviewer", "one finding per root cause, with all observed affected paths together"],
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
