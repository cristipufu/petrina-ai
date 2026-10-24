import { expect, it } from "vitest";
import { acceptanceSummary } from "../../../src/acceptance.js";
import { createDemoState, createPortfolioDemo } from "../../../src/demo.js";
import { displayTask } from "../../../src/repositories.js";

it.each(["default", "portfolio"])("the %s demo records acceptance on each completed Tester and retains current examples", (demo) => {
  const state = demo === "default" ? createDemoState(1_000_000_000_000) : createPortfolioDemo(1_000_000_000_000).state;
  const findRole = (id?: string) => state.roles.find((role) => role.id === id);
  const tested = state.tasks.filter((task) => task.journey?.some((step) => step.kind === "agent" && step.endedAt !== undefined && findRole(step.roleId)?.result === "checks" && task.brief?.acceptance.length));
  expect(tested.length).toBeGreaterThan(0);
  for (const task of tested) {
    for (const step of task.journey!.filter((step) => step.kind === "agent" && step.endedAt !== undefined && findRole(step.roleId)?.result === "checks")) {
      expect(step.acceptanceChecks?.length).toBe(task.brief!.acceptance.length);
      expect(step.acceptanceChecks!.every((check) => check.evidence?.startsWith("Demo scenario:"))).toBe(true);
      expect(step.agentResults![0]!.versions).toBeDefined();
    }
    expect(task.journey!.filter((step) => step.work === "checks").every((step) => step.acceptanceChecks === undefined)).toBe(true);
  }
  expect(tested.some((task) => acceptanceSummary(displayTask(task), findRole).current)).toBe(true);
});
