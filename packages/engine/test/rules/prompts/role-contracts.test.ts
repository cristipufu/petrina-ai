import { describe, expect, it } from "bun:test";
import { BUILT_IN_ROLES, DEFAULT_PROFILES, DEMO_PRODUCTS, KNOWN_TOOLS, DESIGN_OBJECTION_RULE, NOTES_HANDOFF_RULE } from "@petrina/core";
import { type PromptContext } from "../../../src/prompts.js";
import { contractFor, ROLE_CONTRACTS, shapeFor } from "../../../src/roles.js";
import { promptTask } from "../../fixtures/prompt-context.js";
const state = { products: DEMO_PRODUCTS, profiles: DEFAULT_PROFILES, tools: KNOWN_TOOLS };
const task = promptTask();
const ctx = (overrides: Partial<PromptContext["task"]> = {}): PromptContext => ({ task: { ...task, ...overrides }, product: state.products[0]!, role: BUILT_IN_ROLES[0]!, roles: BUILT_IN_ROLES, profiles: state.profiles, tools: state.tools, worktree: "/w", branch: "b", base: "origin/main", defaultBranch: "main", sections: [] });
describe("every role's contract", () => {
it("grounds design blockers for built-in and edited roles, with revision-focused later rounds", () => {
    const reviewer = BUILT_IN_ROLES.find((role) => role.id === "design-reviewer")!;
    const stage = { id: "design", kind: "converge" as const, title: "Design", roleId: "architect", profileIds: ["opus-xhigh"], maxRounds: 3 };
    const later = ctx({ plan: { stages: [stage], rationale: "Design", plannerProfileId: "opus-high" }, stageIndex: 0, rounds: { design: 2 } });
    for (const role of [reviewer, { ...reviewer, instructions: "Review the scheduling behavior." }, { ...reviewer, id: "added-design-reviewer", added: true, instructions: "Review the scheduling behavior." }]) {
      expect(contractFor(role).instructions(later)).toContain(DESIGN_OBJECTION_RULE);
      expect(contractFor(role).instructions(later)).toContain("first check the Architect's answers");
      expect(contractFor(role).reads).toEqual(["notes", "brief", "objections"]);
    }
    expect(contractFor(reviewer).instructions(later)).toContain("Design review round 2 of 3");
    expect(contractFor(reviewer).instructions(ctx())).not.toContain("Design review round 2");
  });

it("covers every built-in role, and its example result passes its own schema", () => {
    for (const role of BUILT_IN_ROLES) expect(ROLE_CONTRACTS[role.id]).toBeDefined();
    for (const [id, contract] of Object.entries(ROLE_CONTRACTS)) {
      for (const shape of new Set([shapeFor(contract, ctx()), shapeFor(contract, ctx({ call: { text: "Do it this way", at: 1, stageIndex: 0, open: [] } as never }))])) {
        const parsed = contract.result.safeParse(JSON.parse(shape));
        expect(parsed.success ? id : `${id}: ${parsed.error.message}`).toBe(id);
      }
    }
  });

it("tells a role the coordinator made its purpose, and has it hand back notes", () => {
    const contract = contractFor({ ...BUILT_IN_ROLES[1]!, id: "added-copy-editor", added: true, purpose: "Tighten the wording of every screen.", instructions: "Tighten the wording of every screen." });
    expect(contract.instructions(ctx())).toBe(`Tighten the wording of every screen.\n${NOTES_HANDOFF_RULE}`);
    expect(contract.reads).toEqual(["notes", "brief"]);
    expect(contract.result.safeParse({ summary: "Done.", notes: [] }).success).toBe(true);
  });
});
