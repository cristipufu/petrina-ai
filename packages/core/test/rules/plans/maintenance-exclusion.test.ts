import { expect, it } from "vitest";
import { BUILT_IN_ROLES, MAINTENANCE_ROLES, DEFAULT_PROFILES, normalizePlan, plannerRoles } from "../../../src/index.js";

it("excludes maintenance from the planner catalogue and every ordinary stage position", () => {
      const roles = [...BUILT_IN_ROLES, ...MAINTENANCE_ROLES], maintenance = MAINTENANCE_ROLES[0]!;
      expect(plannerRoles(roles)).not.toContain(maintenance.id);
      const plan = normalizePlan({ task: { id: "attempt", delivery: "local", approveDelivery: true }, roles, profiles: DEFAULT_PROFILES, plannerProfileId: "sol-medium", releaseManagerProfileId: "opus-high", result: { rationale: "Try forbidden roles", stages: [
        { kind: "do", title: "Forbidden standalone", roleId: maintenance.id, profileIds: ["sol-medium"] },
        { kind: "converge", title: "Forbidden author", roleId: maintenance.id, profileIds: ["sol-medium"], reviewerRoleId: "design-reviewer" },
        { kind: "converge", title: "Forbidden design reviewer", roleId: "architect", profileIds: ["sol-medium"], reviewerRoleId: maintenance.id },
        { kind: "review-chain", title: "Forbidden review", roleId: maintenance.id, roleIds: [maintenance.id], profileIds: ["sol-medium"] },
      ] } });
      expect(plan.stages.every(s => s.roleId !== maintenance.id && s.reviewerRoleId !== maintenance.id && !s.roleIds?.includes(maintenance.id))).toBe(true);
      expect(plan.rationale).toContain("maintenance role");
});
