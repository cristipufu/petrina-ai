import { describe, expect, it } from "vitest";
import { activeRoles, addRole, BUILT_IN_ROLES, MAINTENANCE_ROLES, draftOf, editRole, FINDING_REVIEW_RULES, FINDING_REQUIREMENT_RULE, libraryRoles, NO_ROLE_CHANGES, NOTES_HANDOFF_RULE, permissionLock, removeRole, resetRole, ROLE_LIMITS, ROLE_STARTS, REPAIR_RULE, VERIFIER_RULES, stepMayChange, type Role, type RoleChanges, type RoleDraft, type Stage } from "../../../src/index.js";

const start = (id: string) => ROLE_STARTS.find((entry) => entry.id === id)!.draft;

const builtIn = (id: string) => libraryRoles(NO_ROLE_CHANGES).find((role) => role.id === id)!;

const roleIn = (changes: RoleChanges, id: string) => libraryRoles(changes).find((role) => role.id === id)!;

const refuses = (change: () => unknown, message: string | RegExp) => expect(change).toThrow(message);

describe("the role library", () => {
  it("starts with Petrina's built-in roles, each with its wording and fixed kind of result", () => {
    const roles = libraryRoles(undefined);
    expect(roles.map((role) => role.id)).toEqual([...BUILT_IN_ROLES, ...MAINTENANCE_ROLES].map((role) => role.id));
    expect(roles.every((role) => role.instructions && role.result && !role.edited && !role.added)).toBe(true);
  });

  it("shows the canonical repair, review and notes handoff rules in editable defaults without replacing saved wording", () => {
    expect(builtIn("builder").instructions).toContain(REPAIR_RULE);
    for (const id of ["code-reviewer", "security-reviewer"]) {
      const role = builtIn(id);
      for (const rule of FINDING_REVIEW_RULES) expect(role.instructions.split(rule)).toHaveLength(2);
    }
    for (const rule of VERIFIER_RULES) expect(builtIn("verifier").instructions.split(rule)).toHaveLength(2);
    expect(builtIn("verifier").handsBack).toContain("unrelated older bug");
    for (const id of ["code-reviewer", "security-reviewer", "verifier"]) {
      expect(builtIn(id).instructions).toContain(FINDING_REQUIREMENT_RULE);
      expect(builtIn(id).instructions).not.toContain('"pre-existing": the problem was already there before this change');
    }
    // Every built-in notes role shows the handoff rule once, after its own job.
    const notes = BUILT_IN_ROLES.filter((role) => role.result === "notes");
    expect(notes.map((role) => role.id)).toEqual(["researcher", "ux-designer"]);
    for (const role of notes) expect(role.instructions.split(NOTES_HANDOFF_RULE)).toEqual([expect.stringMatching(/\S\n$/), ""]);
    expect(builtIn("ux-designer").instructions).toContain("describe the design in your notes");
    for (const id of ["builder", "code-reviewer", "security-reviewer", "verifier", "researcher", "ux-designer"]) {
      const role = builtIn(id);
      // The defaults fit the same editor limits as coordinator-authored wording.
      expect(() => editRole(NO_ROLE_CHANGES, id, draftOf(role))).not.toThrow();
      const changes = editRole(NO_ROLE_CHANGES, id, { ...draftOf(role), instructions: "Follow our product's conventions." });
      expect(roleIn(changes, id).instructions).toBe("Follow our product's conventions.");
      expect(roleIn(resetRole(changes, id), id).instructions).toBe(role.instructions);
    }
  });

  it("preserves older saved classification wording verbatim rather than migrating custom instructions", () => {
    const wording = 'A problem the change did not cause is "pre-existing" and never blocks.';
    const changes = {
      edits: Object.fromEntries(["code-reviewer", "security-reviewer", "verifier"].map((id) => [id, { instructions: wording }])),
      added: [{ ...builtIn("code-reviewer"), id: "added-compatibility", name: "Compatibility", instructions: wording, added: true }],
    };
    const before = JSON.stringify(changes);
    for (const id of [...Object.keys(changes.edits), "added-compatibility"]) expect(roleIn(changes, id).instructions).toBe(wording);
    expect(JSON.stringify(changes)).toBe(before);
    expect(builtIn("verifier").instructions).toContain("explicitly requested repair");
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
