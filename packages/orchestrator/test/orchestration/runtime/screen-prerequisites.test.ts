import { describe, expect, it } from "vitest";
import { screenFixture, screenGroup } from "../../fixtures/screen.js";

describe.concurrent("screen ownership while a review closes", () => {
  it("returns a held member's settled grant even while its live group and driver remain", () => {
    const f = screenFixture(), task = f.task(), other = f.task(1);
    f.state.pool.screen = { mode: "on" };
    task.screen = { reason: "Inspect the window", at: 30, roleId: "code-reviewer", profileId: "sol-xhigh", member: "review-0", granted: true };
    // The driver still owns work; its live group's settled member is authoritative for the grant.
    f.owned.add(task.id);
    f.controller.groups.set(task.id, screenGroup(new Set()));
    task.runtimeWait = { after: ["prerequisite"], reason: "Wait for the required screen fix", changes: [] };
    f.controller.syncScreen();
    expect(task.screen.granted).toBe(false);
    expect(f.controller.askScreen(other, "builder", "sol-high", "Check another window")).toBe(true);
    f.controller.stop();
  });
});
