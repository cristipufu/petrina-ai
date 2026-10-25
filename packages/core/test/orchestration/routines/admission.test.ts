import { stateFixture } from "../../fixtures/state.js";
import { describe, expect, it } from "vitest";
import { admitRoutines, createTaskState, libraryRoles, NO_ROLE_CHANGES, nextOccurrence, prepareMaintenanceTask, saveRoutine, type RoutineDraft, type State, type DeepMutable, type Task } from "../../../src/index.js";

const at = (date: string) => Date.parse(date);

const now = at("2026-01-01T00:00:00Z");

const base = (): DeepMutable<State> => ({ ...JSON.parse(JSON.stringify(stateFixture({ now }))), tasks: [], inbox: [], roles: libraryRoles(NO_ROLE_CHANGES), routines: [] });

const draft = (state: State): RoutineDraft => ({ name: "Find confirmed bugs", productId: state.products[0]!.id, roleId: "maintenance-bug-finder", profileId: "sol-medium", focus: "Checkout", zone: "UTC", schedule: { kind: "daily", time: "09:00" }, enabled: true });

describe("maintenance calendars", () => {
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
