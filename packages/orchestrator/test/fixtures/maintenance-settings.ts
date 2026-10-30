import { beginAgentStep, cancelTaskState, libraryRoles, NO_ROLE_CHANGES, prepareMaintenanceTask, saveRoutine } from "@petrina/core";
import { MaintenanceSettings, resolveMaintenanceSettings } from "../../src/maintenance-settings.js";
import { pauseAgentStep } from "../../src/agent-step-state.js";
import { executionFor } from "../../src/repository-context.js";
import type { MaintenanceDecisionHost, MaintenanceSettingsInput } from "../../src/ports/maintenance-settings.js";
import { profileSelectionFixture } from "./profile-selection.js";

/** Actual maintenance admission, settings decisions and state transitions; no native session or disk is simulated. */
export function maintenanceSettingsFixture() {
  const f = profileSelectionFixture(), { task, state } = f;
  state.roles = libraryRoles(NO_ROLE_CHANGES);
  const routine = saveRoutine({ name: "Inspect checkout", productId: task.productId, roleId: "maintenance-bug-finder", profileId: "sol-medium",
    focus: "Inspect checkout behavior", zone: "UTC", schedule: { kind: "daily", time: "09:00" }, enabled: true }, state, "routine", f.now());
  state.routines = [routine];
  prepareMaintenanceTask(task, routine, state, f.now(), f.now());
  const { role, profile } = task.maintenance!;
  task.state = "running"; task.holdsSlot = true;
  task.agent = { roleId: role.id, profileId: profile.id, since: f.now(), step: task.stageIndex };
  beginAgentStep(task, role.id, profile.id, f.now(), state.roles);
  const scope = executionFor(task), calls: string[] = [], saved: typeof task[] = [], notes: string[] = [];
  const statuses: ({ head: string; clean: boolean } | Error)[] = [];
  const interrupted = new Error("Supplied save interruption"), held = new Error("Maintenance reply held"), unconfirmed = new Error("Unconfirmed settings");
  let failSave = false;
  const bound = (value: typeof task) => { if (value !== task) throw new Error("Wrong maintenance decision owner"); };
  const checkpoint = (value: typeof task) => { bound(value); calls.push("save"); if (failSave) throw interrupted; saved.push(structuredClone(value)); };
  const settings = new MaintenanceSettings({ now: f.now,
    pauseStep: value => { bound(value); calls.push("pause"); pauseAgentStep(value, f.now()); },
    addDecision: item => { if (item.taskId !== task.id) throw new Error("Wrong maintenance inbox owner"); calls.push("inbox"); state.inbox.push(item); },
    checkpoint, aborted: () => held, unconfirmed: message => { unconfirmed.message = message; return unconfirmed; },
  }, { readOnlyStatus: async path => {
    if (path !== "supplied:maintenance-copy") throw new Error("Wrong maintenance copy");
    calls.push("read-only-status"); const next = statuses.shift();
    if (!next) throw new Error("No native repository observation was supplied");
    if (next instanceof Error) throw next;
    return next;
  } });
  const decisions: MaintenanceDecisionHost = {
    note: (value, text) => { bound(value); calls.push("note"); notes.push(text); },
    removeDecision: id => { if (id !== task.id) throw new Error("Wrong maintenance inbox removal"); calls.push("remove"); state.inbox = state.inbox.filter(item => !(item.taskId === id && item.kind === "maintenance-settings")); },
    cancel: id => { if (id !== task.id) throw new Error("Wrong cancellation owner"); calls.push("cancel"); cancelTaskState(task, scope.work, f.now()); },
    checkpoint, schedule: () => { calls.push("schedule"); },
  };
  const input: MaintenanceSettingsInput = { role, profile, settings: { model: profile.modelId ?? profile.model, effort: profile.effort },
    lastTurn: { changed: { effort: "high" }, rerouted: false, helpers: 0 }, worktree: "supplied:maintenance-copy", headBefore: "supplied:original-head" };
  return { ...f, scope, role, profile, routine, settings, input, calls, saved, notes, statuses, held, interrupted, unconfirmed, decisions,
    check: () => settings.check(task, input), decide: (choice: "keep" | "stop") => resolveMaintenanceSettings(decisions, task, choice),
    failSave: () => { failSave = true; }, assertConsumed: () => { if (statuses.length) throw new Error("Unconsumed repository observations"); },
  };
}
