import { stateFixture } from "../../fixtures/state.js";
import { describe, expect, it } from "vitest";
import { createTaskState, DEFAULT_PROFILES, draftOf, addRole, editRole, libraryRoles, MAINTENANCE_ROLES, NO_ROLE_CHANGES, prepareMaintenanceTask, saveRoutine, workflowRoles, composePlan, type RoutineDraft, type State, type DeepMutable, type Task } from "../../../src/index.js";
import { historyItem, journeyView, landingOf } from "../../../src/index.js";

const at = (date: string) => Date.parse(date);

const now = at("2026-01-01T00:00:00Z");

const base = (): DeepMutable<State> => ({ ...JSON.parse(JSON.stringify(stateFixture({ now }))), tasks: [], inbox: [], roles: libraryRoles(NO_ROLE_CHANGES), routines: [] });

const draft = (state: State): RoutineDraft => ({ name: "Find confirmed bugs", productId: state.products[0]!.id, roleId: "maintenance-bug-finder", profileId: "sol-medium", focus: "Checkout", zone: "UTC", schedule: { kind: "daily", time: "09:00" }, enabled: true });

describe("maintenance roles and durable admission", () => {
  it("keeps legitimate overdue work when only a valid routine's wording is edited", () => {
    const state = base(), routine = saveRoutine(draft(state), state, "r", now);
    const edited = saveRoutine({ ...routine, focus: "New bounded focus" }, state, "r", at("2026-01-10T12:00Z"), routine);
    expect(edited.nextAt).toBe(routine.nextAt); expect(edited.handledThrough).toBe(routine.handledThrough);
  });

  it("shows successful empty investigations as completed in both the journey and compact History", () => {
    const state = base();
    const routine = saveRoutine(draft(state), state, "r", now);
    const task = createTaskState({ title: routine.name, productId: routine.productId }, state.products, { id: "investigation", timelineId: "t", now, priority: 0 });
    prepareMaintenanceTask(task, routine, state, now, now);
    task.state = "done"; task.maintenance!.noProductChanges = true;
    expect(landingOf(task as Task)).toBe("no-changes");
    expect(landingOf(historyItem(task as Task))).toBe("no-changes");
    expect(journeyView(task as Task, { ...state, roles: state.roles }).end).toEqual({ text: "Completed · No product changes", state: "done" });
  });

  it("keeps permanent categories and result permissions, without entering ordinary example plans", () => {
    const state = base(), roles = state.roles;
    expect(workflowRoles(roles).every(role => role.category !== "maintenance")).toBe(true);
    const result = addRole(NO_ROLE_CHANGES, { ...draftOf(MAINTENANCE_ROLES[0]!), name: "Bounded cleaner" });
    const added = libraryRoles(result.changes).find(role => role.id === result.roleId)!;
    expect(added.result).toBe("build"); expect(added.canEdit).toBe(true);
    expect(() => editRole(result.changes, added.id, { ...draftOf(added), category: "workflow" })).toThrow("category");
    expect(() => editRole(result.changes, added.id, { ...draftOf(added), canEdit: false })).toThrow();
    const task = createTaskState({ title: "Ordinary work", productId: state.products[0]!.id }, state.products, { id: "ordinary", timelineId: "t", now, priority: 0 });
    expect(composePlan(task, libraryRoles(result.changes)).stages.some(stage => stage.roleId === added.id)).toBe(false);
    for (const workflow of workflowRoles(roles)) expect(() => saveRoutine({ ...draft(state), roleId: workflow.id }, state, "r", now)).toThrow("maintenance role");
    expect(DEFAULT_PROFILES.filter(p => ["astra-ultra", "sol-ultra", "sol-medium"].includes(p.id)).map(p => [p.modelId, p.effort])).toEqual([["gpt-6-astra", "ultra"], ["gpt-6.1-sol", "ultra"], ["gpt-6.1-sol", "medium"]]);
  });
});
