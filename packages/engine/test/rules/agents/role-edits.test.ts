import { describe, expect, it } from "bun:test";
import { addRole, draftOf, editRole, libraryRoles, NO_ROLE_CHANGES, ROLE_STARTS, DESIGN_OBJECTION_RULE } from "@petrina/core";
import { ASK_FOR_SCREEN, MAY_CHANGE, buildPrompt, continuePrompt, roleCard } from "../../../src/prompts.js";
import { contractFor, plannerRoles, ROLE_CONTRACTS } from "../../../src/roles.js";
import { promptContexts } from "../../fixtures/prompt-contexts.js";
import before from "../../fixtures/role-contracts.json";

describe("saved role wording", () => {
  const contexts = promptContexts();
  it("preserves default role contracts alongside the approved planning, screen and shared policy changes", () => {
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
          .replace('{"worksOn": [{"productId": "<registered product id>", "startFrom": {"kind": "default"}, "delivery": "pull-request"}], "rationale":', '{"worksOn": [{"productId": "<registered product id>", "startFrom": {"kind": "default"}, "delivery": "pull-request", "reason": "Why this product is involved", "builderProfileId": "<profile id>"}], "leadProductId": "<product id for shared repairs>", "rationale":');
        expect(now.replace(job(now), "")).toBe(expected.replace(job(expected), ""));
        expect(now).toContain(plannerRoles(context.roles));
      } else expect(now).toBe(was);
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
  it("keeps required extra full validations in the shared queue for default and edited Builders", () => {
    const base = contexts.builder!;
    const changes = editRole(NO_ROLE_CHANGES, base.role.id, { ...draftOf(base.role), instructions: "Build the approved change." });
    const roles = libraryRoles(changes);
    const edited = roles.find((role) => role.id === base.role.id)!;
    for (const role of [base.role, edited]) for (const fixing of [false, true]) for (const render of [buildPrompt, continuePrompt]) {
      const prompt = render({ ...base, roles, role, task: { ...base.task, fixing } });
      expect(prompt.split("Required EXTRA full-suite validation")).toHaveLength(2);
      expect(prompt).toContain("Petrina's validation.run request with a durable reference and a prepared local Linux image");
      expect(prompt).toContain("never poll other runs, pause the pool to reserve room or start a competing full suite");
      expect(prompt).toContain("tests Petrina's last saved commit/tree and excludes working edits");
      expect(prompt).toContain("hand new work back first, without committing or publishing it yourself");
      expect(prompt).toContain("Without Petrina's command tools, ask the coordinator to arrange it");
      expect(prompt).toContain("Focused tests (including Linux/container regressions) and preparing a local image stay allowed under existing cleanup and tool permissions");
      expect(prompt).toContain("Extra evidence never replaces the full configured delivery checks or permits lower worker counts, concealed failures or retries to manufacture a pass");
      expect(prompt).toContain("Petrina runs them on the finished work before review");
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
  it("uses the contract's incremental scope for prompts as well as review baselines", () => {
    const contract = ROLE_CONTRACTS["code-reviewer"]!, saved = contract.incrementalReview;
    const ctx = contexts["code-reviewer-fix"] ?? contexts["code-reviewer"]!;
    const task = { ...ctx.task, reviewedSha: "previous-review", rounds: { review: 2 }, stageIndex: 0,
      plan: { rationale: "Review the fixes", plannerProfileId: "sol-high", stages: [{ id: "review", title: "Review", kind: "review-chain" as const, roleId: "code-reviewer", profileIds: ["sol-high"], maxRounds: 3 }] } };
    try {
      contract.incrementalReview = true;
      expect(buildPrompt({ ...ctx, task })).toContain("review what changed since the last round");
      expect(buildPrompt({ ...ctx, task })).toContain("If your saved base advanced, follow the base-update section as well, including the complete comparison and relevant incoming changes");
      contract.incrementalReview = false;
      expect(buildPrompt({ ...ctx, task })).not.toContain("review what changed since the last round");
    } finally { contract.incrementalReview = saved; }
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
