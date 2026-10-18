import { describe, expect, it } from "vitest";
import {
  activeRoles,
  addRole,
  BUILT_IN_ROLES,
  composePlan,
  createDemoState,
  draftOf,
  editRole,
  libraryRoles,
  journeyProblems,
  NO_ROLE_CHANGES,
  permissionLock,
  removeRole,
  resetRole,
  ROLE_LIMITS,
  ROLE_STARTS,
  Simulator,
  stepMayChange,
  type Role,
  type RoleChanges,
  type RoleDraft,
  type Stage,
  type TaskSource,
} from "../src/index.js";

const start = (id: string) => ROLE_STARTS.find((entry) => entry.id === id)!.draft;
const builtIn = (id: string) => libraryRoles(NO_ROLE_CHANGES).find((role) => role.id === id)!;
const roleIn = (changes: RoleChanges, id: string) => libraryRoles(changes).find((role) => role.id === id)!;
const refuses = (change: () => unknown, message: string | RegExp) => expect(change).toThrow(message);

describe("the role library", () => {
  it("starts with Petrina's built-in roles, each with its wording and fixed kind of result", () => {
    const roles = libraryRoles(undefined);
    expect(roles.map((role) => role.id)).toEqual(BUILT_IN_ROLES.map((role) => role.id));
    expect(roles.every((role) => role.instructions && role.result && !role.edited && !role.added)).toBe(true);
  });

  it("loads data saved before roles were editable, and ignores what is not a role change", () => {
    const junk = { edits: { builder: { canEdit: false, name: "Bob" }, nobody: { purpose: "x" }, __proto__: { purpose: "y" } }, added: [{ id: "builder", name: "Fake" }, { id: "added-x", name: 3 }, null] } as unknown as RoleChanges;
    expect(libraryRoles(junk)).toEqual(libraryRoles(undefined));
  });

  it("keeps only the fields the coordinator changed, so the others follow Petrina's defaults", () => {
    const architect = builtIn("architect");
    const changes = editRole(NO_ROLE_CHANGES, "architect", { ...draftOf(architect), purpose: "Designs it, briefly.", canEdit: true });
    expect(changes.edits.architect).toEqual({ purpose: "Designs it, briefly.", canEdit: true });
    expect(roleIn(changes, "architect")).toMatchObject({ purpose: "Designs it, briefly.", canEdit: true, instructions: architect.instructions, edited: true });
    // Saving Petrina's own wording again keeps nothing: the role is not edited.
    expect(editRole(changes, "architect", draftOf(architect)).edits.architect).toBeUndefined();
  });

  it("resets a built-in role to Petrina's wording and settings", () => {
    const tester = builtIn("tester");
    const changes = editRole(NO_ROLE_CHANGES, "tester", { ...draftOf(tester), instructions: "Click everything.", handsBack: "A list.", canEdit: true });
    const reset = resetRole(changes, "tester");
    expect(roleIn(reset, "tester")).toEqual(tester);
    refuses(() => resetRole(reset, "release-manager"), "can't be edited here");
  });

  it("refuses what the squad does not allow, in plain words", () => {
    const draft = (id: string, change: Partial<RoleDraft> = {}) => ({ ...draftOf(builtIn(id)), ...change });
    refuses(() => editRole(NO_ROLE_CHANGES, "nobody", draft("builder")), "not in the Library");
    refuses(() => editRole(NO_ROLE_CHANGES, "release-manager", draft("release-manager", { purpose: "Ships." })), "The Release Manager writes release notes");
    refuses(() => editRole(NO_ROLE_CHANGES, "planner", draft("planner", { canEdit: true })), "The Planner is always read-only");
    refuses(() => editRole(NO_ROLE_CHANGES, "design-reviewer", draft("design-reviewer", { canEdit: true })), "Reviewers never change the work they judge");
    refuses(() => editRole(NO_ROLE_CHANGES, "code-reviewer", draft("code-reviewer", { canEdit: true })), "Reviewers never change the work they judge");
    refuses(() => editRole(NO_ROLE_CHANGES, "builder", draft("builder", { canEdit: false })), "The Builder always makes changes");
    refuses(() => editRole(NO_ROLE_CHANGES, "researcher", draft("researcher", { result: "findings" })), "To hand back something else, add a new role");
    refuses(() => editRole(NO_ROLE_CHANGES, "researcher", draft("researcher", { name: "Scout" })), "keep their name, icon and colour");
    refuses(() => editRole(NO_ROLE_CHANGES, "researcher", draft("researcher", { icon: "globe" })), "keep their name, icon and colour");
    refuses(() => editRole(NO_ROLE_CHANGES, "researcher", draft("researcher", { purpose: " " })), "Say what the role is for");
    refuses(() => editRole(NO_ROLE_CHANGES, "researcher", draft("researcher", { purpose: "x".repeat(201) })), "Keep this to 200 characters");
    refuses(() => editRole(NO_ROLE_CHANGES, "researcher", draft("researcher", { instructions: "x".repeat(4001) })), "Keep this to 4,000 characters");
    refuses(() => editRole(NO_ROLE_CHANGES, "researcher", draft("researcher", { handsBack: "x".repeat(301) })), "Keep this to 300 characters");
    // Within the limits, all of it is fine.
    expect(() => editRole(NO_ROLE_CHANGES, "researcher", draft("researcher", { purpose: "x".repeat(200), instructions: "x".repeat(4000), handsBack: "x".repeat(300) }))).not.toThrow();
  });

  it("adds roles from blank and from the two starting points, with a kind of result chosen once", () => {
    let changes: RoleChanges = NO_ROLE_CHANGES;
    const ids: string[] = [];
    for (const draft of [start("security"), start("copywriter"), { ...start("blank"), name: "Translator", purpose: "Translates the words people see." }]) {
      const added = addRole(changes, draft);
      changes = added.changes;
      ids.push(added.roleId);
    }
    expect(ids).toEqual(["added-security-specialist", "added-copywriter", "added-translator"]);
    const security = roleIn(changes, ids[0]!);
    expect(security).toMatchObject({ name: "Security specialist", result: "findings", canEdit: false, column: "reviewing", added: true });
    expect(permissionLock(security)).toContain("Reviewers never change the work they judge");
    expect(roleIn(changes, ids[2]!)).toMatchObject({ result: "notes", column: "designing", instructions: "" });
    // The kind of result never changes, and a reviewer never changes the work.
    refuses(() => editRole(changes, ids[1]!, { ...draftOf(roleIn(changes, ids[1]!)), result: "findings" }), "add a new role");
    refuses(() => editRole(changes, ids[0]!, { ...draftOf(security), canEdit: true }), "Reviewers never change");
    refuses(() => addRole(changes, { ...start("security"), name: "Pen tester", canEdit: true }), "Reviewers never change");
    refuses(() => addRole(changes, { ...start("blank"), name: "Planner 2", purpose: "Plans.", result: "plan" }), "notes, or pass-or-fail findings");
    // An added role can change its name, icon and colour, and may change the product.
    const renamed = editRole(changes, ids[1]!, { ...draftOf(roleIn(changes, ids[1]!)), name: "Writer", icon: "megaphone", tone: "orange", canEdit: true });
    expect(roleIn(renamed, ids[1]!)).toMatchObject({ name: "Writer", icon: "megaphone", tone: "orange", canEdit: true, column: "building" });
  });

  it("wants a unique name, ignoring capitals and counting the built-in names, and at most 20 added roles", () => {
    const blank = (name: string) => ({ ...start("blank"), name, purpose: "Helps." });
    refuses(() => addRole(NO_ROLE_CHANGES, blank("")), "Give the role a name");
    refuses(() => addRole(NO_ROLE_CHANGES, blank("x".repeat(41))), "Keep the name to 40 characters");
    refuses(() => addRole(NO_ROLE_CHANGES, blank("code REVIEWER")), "There is already a role called “Code reviewer”");
    let changes = addRole(NO_ROLE_CHANGES, blank("Helper")).changes;
    refuses(() => addRole(changes, blank("  helper ")), "There is already a role called “Helper”");
    for (let n = 2; n <= ROLE_LIMITS.added; n += 1) changes = addRole(changes, blank(`Helper ${n}`)).changes;
    refuses(() => addRole(changes, blank("One too many")), "at most 20 roles");
  });

  it("removes an added role from the Library and the planner, keeping it for tasks that use it", () => {
    const { changes, roleId } = addRole(NO_ROLE_CHANGES, start("copywriter"));
    const kept = removeRole(changes, roleId, true);
    expect(roleIn(kept, roleId)).toMatchObject({ name: "Copywriter", removed: true });
    expect(activeRoles(libraryRoles(kept)).some((role) => role.id === roleId)).toBe(false);
    refuses(() => editRole(kept, roleId, draftOf(roleIn(changes, roleId))), "not in the Library");
    // Its name is free again, and a role no task used is gone for good.
    expect(addRole(kept, start("copywriter")).roleId).toBe("added-copywriter-2");
    expect(removeRole(changes, roleId, false).added).toHaveLength(0);
    refuses(() => removeRole(changes, "builder", false), "Built-in roles can't be removed");
  });
});

describe("what a step may change", () => {
  const stages: Stage[] = [
    { id: "b", kind: "do", title: "Build", roleId: "builder", profileIds: ["p"] },
    { id: "r", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["p"] },
    { id: "c", kind: "do", title: "Copy", roleId: "added-copywriter", profileIds: ["p"] },
    { id: "s", kind: "do", title: "Ship", roleId: "release-manager", profileIds: ["p"] },
  ];
  const writer: Role = { ...builtIn("researcher"), id: "added-copywriter", canEdit: true, added: true };

  it("is the role's permission before the final review, read-only after it, and the Release Manager's always", () => {
    expect(stepMayChange(writer, stages, 0)).toEqual({ canEdit: true, afterReview: false });
    expect(stepMayChange(writer, stages, 2)).toEqual({ canEdit: false, afterReview: true });
    expect(stepMayChange({ ...writer, canEdit: false }, stages, 2)).toEqual({ canEdit: false, afterReview: false });
    expect(stepMayChange(builtIn("release-manager"), stages, 3)).toEqual({ canEdit: false, afterReview: false });
  });
});

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

  it("lets the forms work for the session: added roles join the next plan, edits and removals apply", () => {
    const sim = new Simulator(createDemoState(1_000_000_000));
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
    const sim = new Simulator(createDemoState(1_000_000_000), { prMergeAfter: 1000 });
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
