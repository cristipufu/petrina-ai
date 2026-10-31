import { describe, expect, it } from "bun:test";
import { setupFixtures } from "../../fixtures/setup.js";
import { checkOf } from "@petrina/core";
import type { Engine } from "../../engine.js";
import { privateAgentToolProbe } from "../../scripted-probes.js";

const { until, status, taskOf, toolsUsed, run } = setupFixtures();

/** These existing native login journeys also calibrate the explicit one-tool workflow recipes. */
async function calibrated(engine: Engine, only: "claude-code" | "codex" | "grok") {
  const expected = privateAgentToolProbe([only]);
  for (const id of ["claude-code", "codex", "grok", "antigravity", "opencode", "pi", "git"] as const) {
    const { status, account, detail } = checkOf(engine.s.setup?.checks, id);
    expect({ status, ...(account ? { account } : {}), ...(detail ? { detail } : {}) })
      .toEqual(await expected.run(id, { signal: engine.stopRequested.signal, onGone: () => {} }));
  }
}

describe("The squad uses tools that are ready", () => {
for (const [only, other] of [
    ["claude-code", "codex"],
    ["codex", "claude-code"],
  ] as const) {
    it(`plans, designs, builds, reviews and ships entirely on ${only} when ${other} is not logged in`, async () => {
      // Each logged out the way its tool is: Claude Code still opens conversations, Codex refuses them.
      await run({ [other]: other === "claude-code" ? "not-logged-in" : "logged-out" }, async ({ engine, taskId }) => {
      try {
        await calibrated(engine, only);
        expect(status(engine, other)).toBe("logged-out");
        const state = await until(engine, (current) => ["done", "failed"].includes(taskOf(current, taskId).state));
        const task = taskOf(state, taskId);
        expect(task.error).toBeUndefined();
        expect(task.state).toBe("done");
        expect(task.release?.tag).toMatch(/^v\d+\.\d+\.\d+$/);
        expect([...toolsUsed(engine, task)]).toEqual([only]);
        for (const role of ["planner", "architect", "design-reviewer", "builder", "code-reviewer", "release-manager"]) {
          expect(task.timeline.some((entry) => entry.roleId === role)).toBe(true);
        }
        // Journey records the tools that actually worked, rather than the planner's original choices.
        const steps = task.journey!.filter((step) => step.kind === "agent");
        expect(steps.some((step) => step.roleId === "planner")).toBe(true);
        for (const step of steps) {
          for (const profileId of step.team ?? [step.profileId!]) {
            expect(state.profiles.find((profile) => profile.id === profileId)?.toolId).toBe(only);
          }
        }
      } finally {
        await engine.shutdown();
      }
    });
    });
  }
it("keeps main's third tool available through planning, review and delivery", async () => {
    await run({ "claude-code": "logged-out", codex: "logged-out", grok: "ok" }, async ({ engine, taskId }) => {
    try {
      await calibrated(engine, "grok");
      const state = await until(engine, (current) => ["done", "failed"].includes(taskOf(current, taskId).state));
      const task = taskOf(state, taskId);
      expect(task.error).toBeUndefined();
      expect(task.state).toBe("done");
      expect([...toolsUsed(engine, task)]).toEqual(["grok"]);
    } finally {
      await engine.shutdown();
    }
    });
  });
});
