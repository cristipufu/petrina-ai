import { describe, expect, it } from "bun:test";
import { addRole, libraryRoles, NO_ROLE_CHANGES, ROLE_STARTS, type RoleChanges, type Stage } from "@petrina/core";
import { normalizePlan } from "../src/plan.js";
import type { PlanResult } from "../src/roles.js";
import { ENGINE_PROFILES } from "../src/tools.js";
import type { z } from "zod";

type Raw = z.input<typeof PlanResult>["stages"][number];

const start = (id: string) => ROLE_STARTS.find((entry) => entry.id === id)!.draft;
let changes: RoleChanges = NO_ROLE_CHANGES;
for (const draft of [start("security"), { ...start("copywriter"), canEdit: true }, { ...start("blank"), name: "Fact checker", purpose: "Checks claims." }]) changes = addRole(changes, draft).changes;
const roles = libraryRoles(changes);
const [SECURITY, COPYWRITER, FACTS] = ["added-security-specialist", "added-copywriter", "added-fact-checker"];

const build: Raw = { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] };
const review: Raw = { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high", "sol-high"], maxRounds: 2 };

function plan(stages: Raw[], approveDelivery = true) {
  const result = { rationale: "The planner's reason.", stages: stages.map((stage) => ({ profileIds: [], ...stage })) } as z.infer<typeof PlanResult>;
  return normalizePlan({ task: { id: "t", delivery: "pull-request", approveDelivery }, result, roles, profiles: ENGINE_PROFILES, plannerProfileId: "opus-high", releaseManagerProfileId: "opus-high" });
}
const shape = (stages: readonly Stage[]) => stages.map((stage) => (stage.kind === "review-chain" ? `review: ${stage.profileIds.map((_, at) => stage.roleIds?.[at] ?? stage.roleId).join(", ")}` : `${stage.kind}: ${stage.roleId}`));

describe("the planner's plan, made safe to run", () => {
  for (const roleId of ["security-reviewer", "verifier", "check-finder", "guide-keeper"]) {
    it(`explains that Petrina brings in the ${roleId} itself, wherever the planner names it`, () => {
      const named = roles.find((role) => role.id === roleId)!;
      const stages: Raw[][] = [
        [build, { kind: "do", title: "Extra work", roleId, profileIds: ["opus-high"] }, review],
        [build, { ...review, roleIds: [roleId, "code-reviewer"] }],
        [build, { ...review, roleId, roleIds: ["code-reviewer", "code-reviewer"] }],
        [build, { ...review, roleIds: ["code-reviewer", "code-reviewer", roleId] }],
      ];
      for (const raw of stages) {
        const made = plan(raw);
        expect(made.rationale).toContain(`Petrina brings in the ${named.name} itself when it is needed`);
        expect(made.rationale).not.toContain("removed from the Library");
        expect(made.rationale).not.toContain("only makes the plan");
      }
    });
  }
  it("keeps a plan that is already right as it is, with the Release Manager added last", () => {
    const made = plan([build, { ...review, roleIds: ["code-reviewer", SECURITY] }], false);
    expect(shape(made.stages)).toEqual(["do: builder", `review: code-reviewer, ${SECURITY}`, "do: release-manager"]);
    expect(made.rationale).toBe("The planner's reason.");
  });

  it("moves a step that may change the product to just before the final review, and says so", () => {
    const made = plan([build, review, { kind: "do", title: "Copy", roleId: COPYWRITER, profileIds: ["opus-high"] }, { kind: "do", title: "Fact check", roleId: FACTS, profileIds: ["opus-high"] }]);
    expect(shape(made.stages)).toEqual(["do: builder", `do: ${COPYWRITER}`, "review: code-reviewer, code-reviewer", `do: ${FACTS}`, "gate: release-manager", "do: release-manager"]);
    expect(made.rationale).toBe("The planner's reason. Petrina moved “Copy” before the final review: the Copywriter changes the product, and every planned step that changes the product must run before it.");
  });

  it("moves a builder planned after the final review before it", () => {
    expect(shape(plan([review, build], false).stages)).toEqual(["do: builder", "review: code-reviewer, code-reviewer", "do: release-manager"]);
  });

  it("puts a findings role in a normal step into the final review, next to the code reviewers", () => {
    const made = plan([build, { kind: "do", title: "Security", roleId: SECURITY, profileIds: ["opus-high"] }, review], false);
    expect(shape(made.stages)).toEqual(["do: builder", `review: code-reviewer, code-reviewer, ${SECURITY}`, "do: release-manager"]);
    expect(made.rationale).toContain("Petrina moved the Security specialist into the final review");
  });

  it("gives a notes role in the review a step of its own before it", () => {
    const made = plan([build, { ...review, roleIds: ["code-reviewer", FACTS] }], false);
    expect(shape(made.stages)).toEqual(["do: builder", `do: ${FACTS}`, "review: code-reviewer", "do: release-manager"]);
    expect(made.rationale).toContain("Petrina gave the Fact checker a step of its own");
  });

  it("gives a notes role set as the review's own role a step of its own, and keeps the review's code reviewers", () => {
    const made = plan([build, { ...review, roleId: FACTS }], false);
    expect(shape(made.stages)).toEqual(["do: builder", `do: ${FACTS}`, "review: code-reviewer, code-reviewer", "do: release-manager"]);
    expect(made.rationale).toBe("The planner's reason. Petrina gave the Fact checker a step of its own: it hands back notes, not pass-or-fail findings, so it works before the review.");
    const builder = plan([build, { ...review, roleId: "builder" }], false);
    expect(shape(builder.stages)).toEqual(["do: builder", "review: code-reviewer, code-reviewer", "do: release-manager"]);
    expect(builder.rationale).toContain("Petrina put a Code reviewer in the review where the plan had the Builder.");
  });

  it("never lets a role set as the review's own role disappear without saying so, even when the plan names every reviewer", () => {
    const named = plan([build, { ...review, roleId: FACTS, roleIds: ["code-reviewer", SECURITY] }], false);
    expect(shape(named.stages)).toEqual(["do: builder", `do: ${FACTS}`, `review: code-reviewer, ${SECURITY}`, "do: release-manager"]);
    expect(named.rationale).toBe("The planner's reason. Petrina gave the Fact checker a step of its own: it hands back notes, not pass-or-fail findings, so it works before the review.");
    // Named again as a reviewer, it still gets one step, not two.
    const twice = plan([build, { ...review, roleId: FACTS, roleIds: [FACTS, "code-reviewer"] }], false);
    expect(shape(twice.stages)).toEqual(["do: builder", `do: ${FACTS}`, "review: code-reviewer", "do: release-manager"]);
    const tester = plan([build, { ...review, roleId: "tester", roleIds: ["code-reviewer", "code-reviewer"] }], false);
    expect(shape(tester.stages)).toEqual(["do: builder", "do: tester", "review: code-reviewer, code-reviewer", "do: release-manager"]);
    expect(tester.rationale).toContain("Petrina gave the Tester a step of its own: it checks the acceptance list, not the change, so it works before the review.");
    const builder = plan([build, { ...review, roleId: "builder", roleIds: ["code-reviewer", SECURITY] }], false);
    expect(shape(builder.stages)).toEqual(["do: builder", `review: code-reviewer, ${SECURITY}`, "do: release-manager"]);
    expect(builder.rationale).toBe("The planner's reason. Petrina didn't use the Builder in “Review”: it doesn't review changes, and the plan named every reviewer there.");
  });

  it("keeps added roles out of the design pair", () => {
    const made = plan([{ kind: "converge", title: "Design", roleId: "architect", profileIds: ["opus-high"], reviewerRoleId: SECURITY, reviewerProfileIds: ["sol-high"] }, { kind: "converge", title: "Words", roleId: COPYWRITER, profileIds: ["opus-high"] }, build, review], false);
    expect(shape(made.stages)).toEqual(["converge: architect", `do: ${COPYWRITER}`, "do: builder", "review: code-reviewer, code-reviewer", "do: release-manager"]);
    expect(made.stages[0]!.reviewerRoleId).toBe("design-reviewer");
    expect(made.rationale).toContain("Petrina put the Design reviewer in the design pair instead of the Security specialist.");
    expect(made.rationale).toContain("Petrina gave the Copywriter a step of its own: only the Architect writes a design.");
  });

  it("explains an added reviewer left unused when every reviewer is named", () => {
    const made = plan([build, { ...review, roleId: SECURITY, roleIds: ["code-reviewer", "code-reviewer"] }], false);
    expect(shape(made.stages)).toEqual(["do: builder", "review: code-reviewer, code-reviewer", "do: release-manager"]);
    expect(made.rationale).toBe("The planner's reason. Petrina didn't use the Security specialist in “Review”: the plan named every reviewer there.");
    const used = plan([build, { ...review, roleId: SECURITY, roleIds: ["code-reviewer", SECURITY] }], false);
    expect(used.rationale).toBe("The planner's reason.");
  });

  it("accounts for extra roles named beyond the chosen reviewers", () => {
    const extra = plan([build, { ...review, roleIds: ["code-reviewer", "code-reviewer", SECURITY] }], false);
    expect(shape(extra.stages)).toEqual(["do: builder", "review: code-reviewer, code-reviewer", "do: release-manager"]);
    expect(extra.rationale).toContain("Petrina left an extra place for the Security specialist out of “Review”: the plan didn't say who would run it.");
    const notes = plan([build, { ...review, roleIds: ["code-reviewer", "code-reviewer", FACTS, FACTS] }], false);
    expect(shape(notes.stages)).toEqual(["do: builder", `do: ${FACTS}`, "review: code-reviewer, code-reviewer", "do: release-manager"]);
    expect(notes.rationale).toBe("The planner's reason. Petrina gave the Fact checker a step of its own: it hands back notes, not pass-or-fail findings, so it works before the review.");
  });

  it("joins a review right after the code review into it, and always keeps a code reviewer in the final review", () => {
    const joined = plan([build, review, { kind: "review-chain", title: "Security", roleId: SECURITY, profileIds: ["opus-high"] }], false);
    expect(shape(joined.stages)).toEqual(["do: builder", `review: code-reviewer, code-reviewer, ${SECURITY}`, "do: release-manager"]);
    const alone = plan([build, { kind: "review-chain", title: "Security", roleId: SECURITY, profileIds: ["opus-high"] }], false);
    expect(shape(alone.stages)).toEqual(["do: builder", `review: code-reviewer, ${SECURITY}`, "do: release-manager"]);
    expect(alone.rationale).toContain("Petrina added a Code reviewer to the final review");
  });

  it("never lets the planner place, move or add the Release Manager: Petrina adds it once, last, after the delivery check", () => {
    const made = plan([{ kind: "do", title: "Ship early", roleId: "release-manager", profileIds: ["opus-high"] }, build, { ...review, roleIds: ["release-manager", "code-reviewer"] }, { kind: "do", title: "Ship again", roleId: "release-manager", profileIds: ["opus-high"] }]);
    expect(shape(made.stages)).toEqual(["do: builder", "review: code-reviewer", "gate: release-manager", "do: release-manager"]);
    expect(made.stages.filter((stage) => stage.roleId === "release-manager" && stage.kind === "do")).toHaveLength(1);
    expect(made.rationale).toBe("The planner's reason. Petrina handles delivery itself, so it left the Release Manager out of the planned steps.");
  });

  it("leaves out roles that were removed while the planner planned, like unknown ones, and says so", () => {
    const removed = libraryRoles({ ...changes, added: changes.added.map((role) => (role.id === FACTS || role.id === SECURITY ? { ...role, removed: true } : role)) });
    const stages: Raw[] = [
      build,
      { kind: "do", title: "Facts", roleId: FACTS, profileIds: [] },
      { kind: "do", title: "Guess", roleId: "added-mystery", profileIds: [] },
      { kind: "do", title: "Plan again", roleId: "planner", profileIds: [] },
      { ...review, roleIds: ["code-reviewer", SECURITY] },
      { kind: "review-chain", title: "Security", roleId: SECURITY, profileIds: ["opus-high"] },
    ];
    const result = { rationale: "Why.", stages: stages.map((stage) => ({ profileIds: [], ...stage })) } as z.infer<typeof PlanResult>;
    const made = normalizePlan({ task: { id: "t", delivery: "local", approveDelivery: false }, result, roles: removed, profiles: ENGINE_PROFILES, plannerProfileId: "opus-high", releaseManagerProfileId: "opus-high" });
    expect(shape(made.stages)).toEqual(["do: builder", "review: code-reviewer, code-reviewer", "review: code-reviewer", "do: release-manager"]);
    expect(made.rationale).toBe(
      [
        "Why.",
        "Petrina left out “Facts”: the Fact checker was removed from the Library.",
        "Petrina left out “Guess”: the plan named a role Petrina doesn't have.",
        "Petrina left out “Plan again”: the Planner only makes the plan.",
        "Petrina put a Code reviewer in the review instead of the Security specialist, which was removed from the Library.",
      ].join(" "),
    );
  });
});
