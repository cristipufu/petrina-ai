import { expect, it } from "vitest";
import { profileSelectionFixture } from "../../fixtures/profile-selection.js";

it("surfaces the planned tool's login problem instead of a usage wait when no tool is usable", () => {
  const { state, task, host, selection, profile, now } = profileSelectionFixture();
  host.awayFromBuilder = () => undefined;
  state.setup = { done: true, platform: "darwin", checks: (["claude-code", "codex", "grok", "antigravity"] as const).map(id => ({ id, status: "logged-out", at: now() })) };
  const planned = profile("opus-high")!;
  expect(host.usableTools()).toEqual([]);
  expect(selection.choose(planned.id, task, "planner")).toEqual({ kind: "planned", profile: planned, reason: expect.stringContaining("No tool passed readiness checks") });
  state.pool.limited = [{ toolId: planned.toolId, until: now() + 60_000, reason: "Usage exhausted" }];
  expect(selection.choose(planned.id, task, "planner")?.kind).toBe("none");
});
