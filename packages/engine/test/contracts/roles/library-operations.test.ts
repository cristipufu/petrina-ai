import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { mkdtempSync } from "node:fs";
import { afterAll as closeOwnedCases } from "bun:test";
import { expectRejection } from "@petrina/test-support/rejections";
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { BUILT_IN_ROLES, MAINTENANCE_ROLES, draftOf, ROLE_STARTS, type RoleDraft, type State } from "@petrina/core";
import { dispatch } from "../../../src/server.js";
import { Store } from "@petrina/storage/store";
const cases = engineCaseFixtures();
closeOwnedCases(() => cases.close());


describe("the engine's own rules for roles", () => {
  it("refuses invalid role changes sent straight to it, past the form, in plain words", async () => {
    return cases.use("petrina-engine-case-", async owner => {
      const root = mkdtempSync(join(owner.root, "petrina-role-rules-"));

      const engine = owner.open(join(root, "home"), {});
      const act = (name: string, ...args: unknown[]) => dispatch(engine, { name, args });
      const draft = (id: string, change: Partial<RoleDraft> = {}) => ({ ...draftOf(engine.getState().roles.find((role) => role.id === id)!), ...change });
      try {
        await owner.run(engine, async () => {
          const refused: [string, unknown[], string][] = [
            ["saveRole", ["nobody", draft("builder")], "That role is not in the Library."],
            ["saveRole", ["release-manager", draft("release-manager", { purpose: "Ships faster." })], "The Release Manager writes release notes"],
            ["resetRole", ["release-manager"], "The Release Manager writes release notes"],
            ["saveRole", ["planner", draft("planner", { canEdit: true })], "The Planner is always read-only"],
            ["saveRole", ["builder", draft("builder", { canEdit: false })], "The Builder always makes changes"],
            ["saveRole", ["code-reviewer", draft("code-reviewer", { canEdit: true })], "Reviewers never change the work they judge"],
            ["saveRole", ["tester", draft("tester", { result: "notes" })], "To hand back something else, add a new role."],
            ["saveRole", ["tester", draft("tester", { name: "QA" })], "Built-in roles keep their name, icon and colour"],
            ["saveRole", ["tester", draft("tester", { instructions: "x".repeat(4001) })], "Keep this to 4,000 characters"],
            ["saveRole", ["researcher", draft("researcher", { category: "maintenance" })], "A role keeps its Workflow or Maintenance category"],
            ["saveRole", ["maintenance-bug-finder", draft("maintenance-bug-finder", { category: "workflow" })], "A role keeps its Workflow or Maintenance category"],
            ["addRole", [{ ...ROLE_STARTS[0]!.draft, name: "builder", purpose: "Builds more." }], "There is already a role called “Builder”"],
            ["addRole", [{ ...ROLE_STARTS[1]!.draft, canEdit: true }], "Reviewers never change the work they judge"],
            ["removeRole", ["architect"], "Built-in roles can't be removed"],
          ];
          for (const [name, args, message] of refused) {
            const before = JSON.stringify({ roles: engine.getState().roles, changes: engine.getState().roleChanges });
            await expectRejection(act(name, ...args), message);
            expect(JSON.stringify({ roles: engine.getState().roles, changes: engine.getState().roleChanges })).toBe(before);
          }
          for (let n = 1; n <= 20; n += 1) await act("addRole", { ...ROLE_STARTS[0]!.draft, name: `Helper ${n}`, purpose: "Helps." });
          await expectRejection(act("addRole", { ...ROLE_STARTS[0]!.draft, name: "Helper 21", purpose: "Helps." }), "You can add at most 20 roles");
          const helper = engine.getState().roles.find((role) => role.name === "Helper 1")!;
          await expectRejection(act("saveRole", helper.id, { ...draftOf(helper), result: "findings" }), "add a new role");
          // Nothing refused changed anything.
          expect(engine.getState().roles.filter((role) => !role.added)).toEqual([...BUILT_IN_ROLES, ...MAINTENANCE_ROLES].map((role) => ({ ...role })));

        });
      } finally {

        await owner.stop(engine);

      }

    });
  });

  it("loads data saved before roles were editable with both built-in categories, without duplicating them on restart", async () => {
    return cases.use("petrina-engine-case-", async owner => {
      const root = mkdtempSync(join(owner.root, "petrina-role-upgrade-"));

      const home = join(root, "home");
      const store = new Store(join(home, "petrina.db"));
      const old = BUILT_IN_ROLES.map(({ instructions: _instructions, result: _result, ...role }) => role);
      store.save({ now: 1, seq: 3, products: [], roles: old, tools: [], profiles: [], tasks: [], inbox: [], pool: { limit: 3, paused: false, toolCaps: {} } } as unknown as State);
      store.close();
      let engine = owner.open(home, {});
      try {
        const defaults = [...BUILT_IN_ROLES, ...MAINTENANCE_ROLES].map((role) => ({ ...role }));
        expect(engine.getState().roles).toEqual(defaults);
        expect(engine.getState().roleChanges).toEqual({ edits: {}, added: [] });
        await owner.stop(engine);
        engine = owner.open(home, {});
        expect(engine.getState().roles).toEqual(defaults);
        expect(engine.getState().roleChanges).toEqual({ edits: {}, added: [] });
      } finally {

        await owner.stop(engine);

      }

    });
  });
});
