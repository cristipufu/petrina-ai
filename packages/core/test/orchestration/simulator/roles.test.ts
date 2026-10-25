import { stateFixture } from "../../fixtures/state.js";
import { describe, expect, it } from "vitest";
import { activeRoles, composePlan, draftOf, libraryRoles, journeyProblems, NO_ROLE_CHANGES, ROLE_STARTS, Simulator } from "../../../src/index.js";

const start = (id: string) => ROLE_STARTS.find((entry) => entry.id === id)!.draft;

const builtIn = (id: string) => libraryRoles(NO_ROLE_CHANGES).find((role) => role.id === id)!;

describe("the demo squad's roles", () => {
  it("lets the forms work for the session: added roles join the next plan, edits and removals apply", () => {
    const sim = new Simulator(stateFixture({ now: 1_000_000_000, pool: { limit: 3, paused: false, toolCaps: {} } }));
    const security = sim.addRole(start("security"));
    const copywriter = sim.addRole(start("copywriter"));
    sim.saveRole("builder", { ...draftOf(builtIn("builder")), purpose: "Builds it." });
    expect(sim.getState().roles.find((role) => role.id === "builder")).toMatchObject({ purpose: "Builds it.", edited: true });
    expect(() => sim.saveRole("release-manager", draftOf(builtIn("release-manager")))).toThrow("can't be edited here");

    const plan = composePlan({ id: "t", kind: "feature", delivery: "pull-request", approveDelivery: true }, sim.getState().roles);
    const review = plan.stages.find((stage) => stage.kind === "review-chain")!;
    expect(review.roleIds).toEqual(["code-reviewer", "code-reviewer", security]);
    expect(plan.stages.findIndex((stage) => stage.roleId === copywriter)).toBe(plan.stages.findIndex((stage) => stage.roleId === "builder") - 1);

    sim.removeRole(copywriter);
    sim.resetRole("builder");
    const roles = activeRoles(sim.getState().roles);
    expect(roles.some((role) => role.id === copywriter)).toBe(false);
    expect(roles.find((role) => role.id === "builder")?.edited).toBeUndefined();
  });

  it("runs an added reviewer in the review, with its findings under its name", () => {
    const sim = new Simulator(stateFixture({ now: 1_000_000_000, pool: { limit: 3, paused: false, toolCaps: {} } }), { prMergeAfter: 1000 });
    const security = sim.addRole(start("security"));
    sim.setPoolLimit(12);
    sim.setToolCap("claude-code", 12);
    sim.setToolCap("codex", 12);
    let seenAsHelper = false;
    const taskId = sim.addTask({ productId: "shop", title: "Gift wrap", kind: "bug", position: "top" });
    for (let tick = 0; tick < 200 && !sim.getState().tasks.find((task) => task.id === taskId)!.findings.some((finding) => finding.roleId === security); tick += 1) {
      sim.tick();
      const running = sim.getState().tasks.find((task) => task.id === taskId)!;
      seenAsHelper ||= running.helpers?.some((agent) => agent.roleId === security) ?? false;
      for (const item of sim.getState().inbox.filter((entry) => entry.taskId === taskId)) {
        if (item.kind === "question") sim.answer(item.id, item.options?.[0] ?? "Yes");
        else if (item.kind === "permission") sim.allow(item.id, "once");
        else sim.approve(item.id);
      }
    }
    const task = sim.getState().tasks.find((entry) => entry.id === taskId)!;
    expect(task.findings.find((finding) => finding.roleId === security)?.severity).toBe("suggestion");
    expect(task.timeline.some((entry) => entry.roleId === security && entry.tone === "milestone")).toBe(true);
    expect(seenAsHelper).toBe(true);
    expect(journeyProblems(task)).toEqual([]);
    const reviewStage = task.plan!.stages.find((stage) => stage.kind === "review-chain")!;
    expect(task.journey!.filter((step) => step.kind === "agent" && step.stageId === reviewStage.id && step.round === 1)).toHaveLength(1);
  });
});
