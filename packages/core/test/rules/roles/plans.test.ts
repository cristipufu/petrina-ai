import { describe, expect, it } from "vitest";
import { addRole, composePlan, libraryRoles, NO_ROLE_CHANGES, ROLE_STARTS, type TaskSource } from "../../../src/index.js";

const start = (id: string) => ROLE_STARTS.find((entry) => entry.id === id)!.draft;

describe("the demo squad's roles", () => {
  for (const pr of [false, true]) it(`keeps the ${pr ? "PR" : "branch"} destination when added roles join the demo plan`, () => {
    let changes = addRole(NO_ROLE_CHANGES, { ...start("copywriter"), canEdit: true }).changes;
    changes = addRole(changes, start("security")).changes;
    const source: TaskSource = {
      product: { id: "shop", name: "Shop", repo: "acme/shop" },
      start: pr ? { kind: "pull-request", number: 7, url: "https://github.com/acme/shop/pull/7", headRepo: "contributor/shop", branch: "review-work" } : { kind: "branch", branch: "release-2.x" },
      destination: { mode: pr ? "pull-request" : "local", kind: pr ? "update-pr" : "branch", repo: pr ? "contributor/shop" : "acme/shop", branch: pr ? "review-work" : "release-2.x" },
      confirmed: true,
    };
    const plan = composePlan({ id: "t", kind: "feature", delivery: source.destination.mode, approveDelivery: true, source }, libraryRoles(changes));
    const review = plan.stages.findIndex((stage) => stage.kind === "review-chain");
    expect(plan.stages.findIndex((stage) => stage.roleId === "added-copywriter")).toBeLessThan(review);
    expect(plan.stages[review]!.roleIds).toContain("added-security-specialist");
    expect(plan.stages.at(-1)!.title).toBe(pr ? "Update PR #7" : "Commit to release-2.x");
  });

  for (const kind of ["bug", "chore", "feature", "new"] as const) {
    for (const starts of [["copywriter"], ["security"], ["copywriter", "security"]]) {
      it(`explains only the roles used in a ${kind} plan with ${starts.join(" and ")} added`, () => {
        let changes = NO_ROLE_CHANGES;
        for (const id of starts) changes = addRole(changes, start(id)).changes;
        const task = { id: "t", kind, delivery: "pull-request" as const, approveDelivery: true };
        const plan = composePlan(task, libraryRoles(changes));
        const hasNotes = starts.includes("copywriter") && (kind === "feature" || kind === "new");
        const hasFindings = starts.includes("security");
        expect(plan.stages.some((stage) => stage.roleId === "added-copywriter")).toBe(hasNotes);
        expect(plan.stages.some((stage) => stage.roleIds?.includes("added-security-specialist"))).toBe(hasFindings);
        const names = [hasNotes && "Copywriter", hasFindings && "Security specialist"].filter(Boolean);
        const base = composePlan(task).rationale;
        expect(plan.rationale).toBe(names.length ? `${base} With the ${names.join(" and ")} you added.` : base);
      });
    }
  }
});
