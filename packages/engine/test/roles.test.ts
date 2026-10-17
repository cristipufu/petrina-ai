import { describe, expect, it } from "bun:test";
import { BUILT_IN_ROLES, createDemoState } from "@petrina/core";
import type { PromptContext } from "../src/prompts.js";
import { contractFor, ROLE_CONTRACTS, shapeFor } from "../src/roles.js";

const state = createDemoState(1_000_000_000);
const task = state.tasks[0]!;
const ctx = (overrides: Partial<PromptContext["task"]> = {}): PromptContext => ({ task: { ...task, ...overrides }, product: state.products[0]!, role: BUILT_IN_ROLES[0]!, roles: BUILT_IN_ROLES, profiles: state.profiles, worktree: "/w", branch: "b", base: "origin/main", defaultBranch: "main", sections: [] });

describe("every role's contract", () => {
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
    const contract = contractFor({ ...BUILT_IN_ROLES[0]!, id: "copy-editor", purpose: "Tighten the wording of every screen." });
    expect(contract.instructions(ctx())).toBe("Tighten the wording of every screen.");
    expect(contract.reads).toEqual(["notes", "brief"]);
    expect(contract.result.safeParse({ summary: "Done.", notes: [] }).success).toBe(true);
  });
});
