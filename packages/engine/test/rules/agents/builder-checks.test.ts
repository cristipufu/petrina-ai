import { expect, it } from "bun:test";
import { BUILT_IN_ROLES, draftOf, editRole, libraryRoles, NO_ROLE_CHANGES } from "@petrina/core";
import { buildPrompt } from "../../../src/prompts.js";
import { promptContext } from "../../fixtures/prompt-context.js";

for (const builderInstructions of [undefined, "Use a focused test for the changed behavior."]) it(`gives ${builderInstructions ? "edited" : "built-in"} builders the check commands without telling them to rerun the full suite`, () => {
  const builder = BUILT_IN_ROLES.find(role => role.id === "builder")!;
  const roles = builderInstructions ? libraryRoles(editRole(NO_ROLE_CHANGES, builder.id, { ...draftOf(builder), instructions: builderInstructions })) : BUILT_IN_ROLES;
  const role = roles.find(role => role.id === builder.id)!;
  const command = "bun checks/welcome.ts runs.txt --pass";
  const opening = buildPrompt({ ...promptContext(role), roles, sections: [{ title: "Product checks", body: `- Welcome: ${command}` }] });
  expect(opening).toContain("## Product checks\n");
  expect(opening).toContain(command);
  expect(opening).not.toContain("run every one in full before you finish");
  expect(opening).not.toContain("Run every check in full");
  expect(opening).toContain("Run focused tests that cover the behavior you changed while you work.");
  expect(opening).toContain("Before handoff, do not rerun the full product checks or test suite");
  if (builderInstructions) expect(opening).toContain(builderInstructions);
});

it("names planner tools from its supplied catalog without requiring native provider registration", () => {
  const planner = BUILT_IN_ROLES.find(role => role.result === "plan")!;
  const ctx = promptContext(planner), profile = ctx.profiles.find(profile => profile.toolId === "codex")!;
  const opening = buildPrompt({ ...ctx, profiles: [profile], tools: [{ id: "codex", name: "Workspace coding tool" }] });
  expect(opening).toContain(`- ${profile.id}: Workspace coding tool running ${profile.model}`);
  expect(opening).toContain("Only Workspace coding tool is set up on this machine");
});
