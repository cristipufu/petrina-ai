import { describe, expect, it } from "vitest";
import type { Stage } from "../../../src/index.js";
import { currentStepAssignment } from "../../../src/step-assignment.js";

const RESEARCH = "Research how agent hosts handle long waits";
const stage = { id: "research", kind: "do", title: RESEARCH, roleId: "researcher", profileIds: ["opus-high"], assignments: [{ profileId: "opus-high", by: "planner", reason: "PRIVATE-SELECTION-REASON", changeReason: "PRIVATE-READINESS-REASON" }] } satisfies Stage;

const assignment = (current: Stage | undefined, roleId = "researcher") => currentStepAssignment({ plan: current ? { stages: [current], rationale: "PRIVATE-PLAN-RATIONALE", plannerProfileId: "opus-high" } : undefined, stageIndex: 0 }, roleId);

describe("current planned contribution", () => {
it("uses only the stage title for built-in and custom roles, including generic labels", () => {
    for (const roleId of ["researcher", "added-specialist", "builder"]) {
      for (const title of [RESEARCH, "Build"]) {
        const sections = assignment({ ...stage, roleId, title }, roleId);
        expect(sections).toHaveLength(1);
        expect(sections[0]!.body).toContain(`Planned step: ${title}`);
        expect(sections[0]!.body).toContain("full task and approved brief remain authoritative");
        expect(sections[0]!.body).toContain("your role's duties");
        expect(JSON.stringify(sections)).not.toContain("PRIVATE-");
      }
    }
  });
});

describe("current planned contribution", () => {
it("addresses both design participants and each review role without assigning the step to side errands", () => {
    const design: Stage = { ...stage, kind: "converge", roleId: "architect", title: "Design", reviewerProfileIds: ["sol-high"] };
    for (const roleId of ["architect", "design-reviewer"]) expect(assignment(design, roleId)).toHaveLength(1);
    const review: Stage = { ...stage, kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["sol-high", "opus-high"], roleIds: ["code-reviewer", "added-reviewer"] };
    for (const roleId of ["code-reviewer", "added-reviewer"]) expect(assignment(review, roleId)[0]!.body).toContain("Planned step: Review");
    for (const roleId of ["researcher", "check-finder", "guide-keeper", "verifier"]) expect(assignment(review, roleId)).toEqual([]);
    expect(assignment({ ...stage, kind: "gate" })).toEqual([]);
  });
});

describe("current planned contribution", () => {
it("leaves absent historical metadata unknown instead of reconstructing an assignment", () => {
    expect(assignment(undefined)).toEqual([]);
    expect(assignment({ ...stage, title: "  " })[0]!.body.startsWith("No planned step title was recorded.")).toBe(true);
    expect(assignment({ ...stage, title: undefined as unknown as string })[0]!.body.startsWith("No planned step title was recorded.")).toBe(true);
    expect(currentStepAssignment({ plan: { stages: [stage], rationale: "", plannerProfileId: "opus-high" }, stageIndex: -1 }, "planner")).toEqual([]);
  });
});
