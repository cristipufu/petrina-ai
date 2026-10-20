import { describe, expect, it } from "vitest";
import { admitRoutines, createTaskState, DEFAULT_PROFILES, draftOf, addRole, editRole, libraryRoles, MAINTENANCE_ROLES, NO_ROLE_CHANGES, nextOccurrence, latestOccurrence, prepareMaintenanceTask, routinePreview, saveRoutine, workflowRoles, composePlan, createDemoState, type RoutineDraft, type State, type DeepMutable, type Task } from "../src/index.js";
import { historyItem, journeyView, landingOf } from "../src/index.js";

const at = (date: string) => Date.parse(date);
const now = at("2026-01-01T00:00:00Z");
const base = (): DeepMutable<State> => ({ ...JSON.parse(JSON.stringify(createDemoState(now))), tasks: [], inbox: [], roles: libraryRoles(NO_ROLE_CHANGES), routines: [] });
const draft = (state: State): RoutineDraft => ({ name: "Find confirmed bugs", productId: state.products[0]!.id, roleId: "maintenance-bug-finder", profileId: "sol-medium", focus: "Checkout", zone: "UTC", schedule: { kind: "daily", time: "09:00" }, enabled: true });

describe("maintenance calendars", () => {
  it.each([
    ["0 0 */2 * *", ["2026-01-03", "2026-01-05", "2026-01-07"]],
    ["0 0 */2 * 1", ["2026-01-03", "2026-01-05", "2026-01-07"]],
    ["0 0 1 * */2", ["2026-01-03", "2026-01-04", "2026-01-06"]],
    ["0 0 */2 * */2", ["2026-01-03", "2026-01-04", "2026-01-05"]],
    ["0 0 1-31/2 * *", ["2026-01-03", "2026-01-05", "2026-01-07"]],
    ["0 0 * * */2", ["2026-01-03", "2026-01-04", "2026-01-06"]],
    ["0 0 * * *", ["2026-01-02", "2026-01-03", "2026-01-04"]],
    ["*/15 * * * *", ["2026-01-01T00:15", "2026-01-01T00:30", "2026-01-01T00:45"]],
    ["0 */2 * * *", ["2026-01-01T02:00", "2026-01-01T04:00", "2026-01-01T06:00"]],
    ["0 0 1 */2 *", ["2026-03-01", "2026-05-01", "2026-07-01"]],
  ] as const)("preserves field steps and either-day matching in %s", (expression, dates) => {
    const schedule = { kind: "cron", expression } as const;
    const expected = dates.map(date => at(date.includes("T") ? `${date}Z` : `${date}T00:00Z`));
    expect(routinePreview(schedule, "UTC", now)).toEqual(expected);
    for (const occurrence of expected) expect(latestOccurrence(schedule, "UTC", occurrence + 60_000)).toBe(occurrence);
  });
  it("includes a weekday outside the stepped dates and admits only matching queue times", () => {
    expect(nextOccurrence({ kind: "cron", expression: "0 0 */2 * 1" }, "UTC", at("2026-01-11T00:00Z"))).toBe(at("2026-01-12T00:00Z"));
    const state = base();
    const routine = saveRoutine({ ...draft(state), schedule: { kind: "cron", expression: "0 9 */2 * *" } }, state, "r", at("2026-01-01T10:00Z"));
    state.routines!.push(routine);
    const queued: number[] = [];
    admitRoutines(state, at("2026-01-02T09:00Z"), (_routine, scheduledAt) => { queued.push(scheduledAt); return "run"; });
    expect(queued).toEqual([]);
    admitRoutines(state, at("2026-01-03T09:00Z"), (_routine, scheduledAt) => { queued.push(scheduledAt); return "run"; });
    expect(queued).toEqual([at("2026-01-03T09:00Z")]);
    expect(routine.nextAt).toBe(at("2026-01-05T09:00Z"));
  });
  it("calculates daily, several weekdays, numeric cron ranges, lists and steps", () => {
    expect(nextOccurrence({ kind: "daily", time: "09:15" }, "UTC", now)).toBe(at("2026-01-01T09:15Z"));
    expect(routinePreview({ kind: "weekly", weekdays: [1, 4], time: "10:00" }, "UTC", now)).toEqual([at("2026-01-01T10:00Z"), at("2026-01-05T10:00Z"), at("2026-01-08T10:00Z")]);
    expect(nextOccurrence({ kind: "cron", expression: "5,20-40/10 8-10 * 1,2 1-5" }, "UTC", now)).toBe(at("2026-01-01T08:05Z"));
    expect(latestOccurrence({ kind: "cron", expression: "*/15 * * * *" }, "UTC", at("2026-01-01T09:43Z"))).toBe(at("2026-01-01T09:30Z"));
  });
  it("uses either restricted day and accepts infrequent leap-century dates", () => {
    expect(nextOccurrence({ kind: "cron", expression: "0 0 31 2 1" }, "UTC", now)).toBe(at("2026-02-02T00:00Z"));
    expect(nextOccurrence({ kind: "cron", expression: "0 0 29 2 *" }, "UTC", at("2096-03-01T00:00Z"))).toBe(at("2104-02-29T00:00Z"));
  });
  it("rejects impossible dates, malformed fields, empty weekdays, bad times and unknown zones", () => {
    for (const expression of ["0 0 31 2 *", "60 0 * * *", "0 24 * * *", "0 0 * 13 *", "0 0 * * 8", "*/0 * * * *", "1-0 * * * *", "0 9 * *", "a 0 * * *"]) expect(() => nextOccurrence({ kind: "cron", expression }, "UTC", now)).toThrow();
    expect(() => nextOccurrence({ kind: "daily", time: "24:00" }, "UTC", now)).toThrow("Choose a time");
    expect(() => nextOccurrence({ kind: "weekly", time: "09:00", weekdays: [] }, "UTC", now)).toThrow("weekday");
    expect(() => nextOccurrence({ kind: "daily", time: "09:00" }, "Missing/Zone", now)).toThrow("time zone");
  });
  it("skips spring gaps and only uses the first instant of a repeated local time", () => {
    const daily = { kind: "daily", time: "02:30" } as const;
    expect(nextOccurrence(daily, "America/New_York", at("2026-03-08T00:00Z"))).toBe(at("2026-03-09T06:30Z"));
    const repeated = { kind: "daily", time: "01:30" } as const;
    expect(nextOccurrence(repeated, "America/New_York", at("2026-11-01T00:00Z"))).toBe(at("2026-11-01T05:30Z"));
    expect(nextOccurrence(repeated, "America/New_York", at("2026-11-01T05:31Z"))).toBe(at("2026-11-02T06:30Z"));
    expect(latestOccurrence(repeated, "America/New_York", at("2026-11-01T06:45Z"))).toBe(at("2026-11-01T05:30Z"));
  });
});

describe("maintenance roles and durable admission", () => {
  it.each(["product", "role", "profile"] as const)("starts in the future when a missing %s is repaired", (missing) => {
    const state = base(), initial = draft(state);
    const routine = saveRoutine(initial, state, "r", now); state.routines!.push(routine);
    if (missing === "product") state.products = state.products.filter(p => p.id !== initial.productId);
    if (missing === "role") state.roles = state.roles.filter(r => r.id !== initial.roleId);
    if (missing === "profile") state.profiles = state.profiles.filter(p => p.id !== initial.profileId);
    const repairedAt = at("2026-01-10T12:00Z");
    const replacement = { ...initial, productId: state.products[0]!.id, roleId: state.roles.find(r => r.category === "maintenance" && r.result === "notes")!.id, profileId: state.profiles[0]!.id };
    expect(saveRoutine(replacement, state, "r", repairedAt, routine).nextAt).toBe(at("2026-01-11T09:00Z"));
    admitRoutines(state, repairedAt, () => { throw new Error("missing reference"); });
    expect(routine.attention).toBeTruthy();
    const repaired = saveRoutine(replacement, state, "r", repairedAt, routine); state.routines = [repaired];
    expect(repaired.attention).toBeUndefined(); expect(repaired.message).toBeUndefined();
    expect(repaired.nextAt).toBe(at("2026-01-11T09:00Z"));
    admitRoutines(state, repairedAt, () => { throw new Error("false catch-up"); });
    let queued = 0;
    admitRoutines(state, repaired.nextAt, (_routine, scheduledAt) => { expect(scheduledAt).toBe(at("2026-01-11T09:00Z")); queued++; return "new-run"; });
    expect(queued).toBe(1); expect(repaired.message).not.toContain("catch-up");
  });
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
  it("coalesces long absences, freezes intent and never replays duplicate or backward ticks", () => {
    const state = base(); state.routines!.push(saveRoutine(draft(state), state, "r", now));
    const enqueue = (routine: Parameters<typeof prepareMaintenanceTask>[1], scheduledAt: number) => {
      const id = `run-${state.tasks.length}`;
      const task = createTaskState({ title: routine.name, productId: routine.productId }, state.products, { id, timelineId: id, now, priority: 0 });
      prepareMaintenanceTask(task, routine, state, scheduledAt, at("2026-01-10T12:00Z")); state.tasks.push(task as DeepMutable<Task>); return id;
    };
    admitRoutines(state, at("2026-01-10T12:00Z"), enqueue);
    expect(state.tasks).toHaveLength(1); expect(state.tasks[0]!.maintenance!.scheduledAt).toBe(at("2026-01-10T09:00Z"));
    const restarted = JSON.parse(JSON.stringify(state)) as DeepMutable<State>;
    admitRoutines(restarted, at("2026-01-10T12:00Z"), () => { throw new Error("duplicate"); });
    admitRoutines(state, now, enqueue); expect(state.tasks).toHaveLength(1);
    const saved = JSON.stringify(state.tasks[0]!.maintenance);
    state.routines![0] = saveRoutine({ ...state.routines![0]!, zone: "Asia/Tokyo", focus: "Changed focus" }, state, "r", at("2026-01-10T12:00Z"), state.routines![0]);
    state.roles.find(r => r.id === draft(state).roleId)!.instructions = "Changed wording";
    expect(JSON.stringify(state.tasks[0]!.maintenance)).toBe(saved);
    expect(state.tasks[0]!.plan!.stages[0]!.profileIds).toEqual(["sol-medium"]);
    expect(restarted.tasks[0]!.plan!.stages[0]!.assignments).toEqual([{ profileId: "sol-medium", by: "coordinator", reason: "Chosen in the saved maintenance routine." }]);
    expect(state.tasks[0]!.plan!.stages.filter(stage => stage.kind !== "gate").every(stage => stage.assignments?.length === stage.profileIds.length)).toBe(true);
    expect(state.tasks[0]!.plan!.stages.some(stage => stage.roleId === "planner" || stage.roleId === "builder")).toBe(false);
  });
  it("blocks every unfinished state, consumes skipped times, and starts re-enabled routines in the future", () => {
    for (const status of ["queued", "waiting", "running", "needs-you", "paused", "failed", "pr-open"] as const) {
      const state = base(); const routine = saveRoutine(draft(state), state, "r", now); state.routines!.push(routine);
      const task = createTaskState({ title: "Earlier", productId: routine.productId }, state.products, { id: "earlier", timelineId: "t", now, priority: 0 });
      prepareMaintenanceTask(task, routine, state, now, now); task.state = status; state.tasks.push(task as DeepMutable<Task>);
      const due = at("2026-01-02T12:00Z");
      admitRoutines(state, due, () => { throw new Error("overlap"); }); expect(routine.blockingTaskId).toBe("earlier"); expect(routine.message).toContain("Skipped");
      task.state = "done"; admitRoutines(state, due, () => { throw new Error("replay"); });
      routine.enabled = false; admitRoutines(state, due + 86_400_000, () => { throw new Error("disabled"); });
      const enabled = saveRoutine({ ...routine, enabled: true }, state, "r", due + 86_400_000, routine); expect(enabled.nextAt).toBeGreaterThan(due + 86_400_000);
      state.routines = []; admitRoutines(state, due + 1e9, () => { throw new Error("deleted"); });
    }
  });
  it("leaves missing references actionable without creating tasks", () => {
    const state = base(); state.routines!.push(saveRoutine(draft(state), state, "r", now)); state.products = [];
    admitRoutines(state, now + 1e9, () => { throw new Error("wrong product"); });
    expect(state.routines![0]!.attention).toContain("removed");
  });
});
