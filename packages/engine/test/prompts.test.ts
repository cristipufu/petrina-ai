import { describe, expect, it } from "bun:test";
import { BUILT_IN_ROLES, createDemoState, DEFAULT_PROFILES, DEMO_PRODUCTS } from "@petrina/core";
import { buildPrompt } from "../src/prompts.js";

describe("prompts", () => {
  it("tells every role to put its recommended answer first when it asks the coordinator", () => {
    const task = createDemoState(1_000_000_000).tasks[0]!;
    for (const role of BUILT_IN_ROLES) {
      const prompt = buildPrompt({
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
      });
      expect(prompt).toContain("put the answer you recommend first");
      expect(prompt).toContain('"options": ["The answer you recommend", "Another option"]');
    }
  });
});
