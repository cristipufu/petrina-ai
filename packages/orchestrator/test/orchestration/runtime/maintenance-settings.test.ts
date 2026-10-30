import { expect, it } from "vitest";
import { resolveMaintenanceSettings } from "../../../src/maintenance-settings.js";
import { maintenanceSettingsFixture } from "../../fixtures/maintenance-settings.js";

const replies = {
  question: { text: "Should I investigate the guest view?", stopReason: "end_turn", streamed: true },
  screen: { text: "Please allow the screen", stopReason: "end_turn" },
  invalid: { text: "An unfinished result block", stopReason: "end_turn" },
  validation: { text: "A result that needs a correction", stopReason: "end_turn" },
  cancelled: { text: "The interrupted public reply", stopReason: "cancelled" },
} as const;

for (const kind of Object.keys(replies) as (keyof typeof replies)[]) it(`holds a changed-settings ${kind} reply before progression and retains the frozen requested profile`, async () => {
  const f = maintenanceSettingsFixture(), profile = structuredClone(f.task.maintenance!.profile);
  f.input.reply = { ...replies[kind], changed: {}, rerouted: false, helpers: 0 };
  if (kind === "invalid") f.input.lastTurn = { changed: { model: "gpt-6-astra" }, rerouted: false, helpers: 0 };
  f.task.maintenance!.pendingResult = { stageId: "older", value: { obsolete: true } };
  f.statuses.push({ head: f.input.headBefore!, clean: true });
  await expect(f.check()).rejects.toBe(f.held);
  expect(f.task.state).toBe("needs-you"); expect(f.task.holdsSlot).toBe(false); expect(f.task.agent).toBeUndefined();
  expect(f.task.stepClock?.since).toBeUndefined(); expect(f.task.screen).toBeUndefined();
  expect(f.task.maintenance!.settingsDecision!.actual).toContain(kind === "invalid" ? "gpt-6-astra" : "high");
  expect(f.task.maintenance!.pendingReply).toEqual({ stageId: f.task.plan!.stages[f.task.stageIndex]!.id, ...replies[kind] });
  expect(f.task.maintenance!.pendingResult).toBeUndefined();
  expect(f.state.inbox.map(item => item.kind)).toEqual(["maintenance-settings"]);
  expect(f.calls).toEqual(["read-only-status", "pause", "inbox", "save"]);
  expect(f.saved[0]!.maintenance!.pendingReply).toEqual(f.task.maintenance!.pendingReply);
  f.decide(kind === "screen" ? "stop" : "keep");
  expect(f.task.state).toBe(kind === "screen" ? "cancelled" : "waiting");
  expect(f.task.maintenance!.settingsDecision!.choice).toBe(kind === "screen" ? "stop" : "keep");
  expect(f.task.maintenance!.profile).toEqual(profile); expect(f.routine.profileId).toBe(profile.id);
  expect(f.calls.slice(4)).toEqual(kind === "screen" ? ["note", "remove", "cancel", "save"] : ["note", "remove", "save", "schedule"]);
  f.assertConsumed();
});

for (const choice of ["keep", "stop"] as const) it(`keeps a completed normalized result separate from intermediate replies when the coordinator chooses ${choice}`, async () => {
  const f = maintenanceSettingsFixture(); f.input.result = { complete: true, summary: "Investigated", notes: [] };
  f.statuses.push({ head: f.input.headBefore!, clean: true });
  await expect(f.check()).rejects.toBe(f.held);
  expect(f.task.maintenance!.pendingReply).toBeUndefined();
  expect(f.task.maintenance!.pendingResult).toEqual({ stageId: f.task.plan!.stages[0]!.id, value: f.input.result });
  f.decide(choice);
  expect(f.task.maintenance!.pendingResult!.value).toBe(f.input.result);
  expect(f.task.state).toBe(choice === "keep" ? "waiting" : "cancelled");
  f.assertConsumed();
});

for (const status of [{ head: "supplied:original-head", clean: false }, { head: "supplied:changed-head", clean: true }, { head: "supplied:original-head", clean: true }])
  it(`records read-only changes from the supplied head/clean observation (${status.head}, ${status.clean}) before saving the hold`, async () => {
    const f = maintenanceSettingsFixture(); f.statuses.push(status);
    await expect(f.check()).rejects.toBe(f.held);
    expect(f.task.maintenance!.readOnlyWrites).toBe(status.head !== f.input.headBefore || !status.clean ? true : undefined);
    expect(f.saved[0]!.maintenance!.readOnlyWrites).toBe(f.task.maintenance!.readOnlyWrites); f.assertConsumed();
  });

for (const exempt of ["editable", "no starting head", "another role", "no turn", "matching"] as const) it(`requires no repository observation for ${exempt}`, async () => {
  const f = maintenanceSettingsFixture();
  if (exempt === "editable") f.input.role = { ...f.role, canEdit: true };
  if (exempt === "no starting head") delete f.input.headBefore;
  if (exempt === "another role") f.input.role = { ...f.role, id: "unrelated-role" };
  if (exempt === "no turn") f.input.lastTurn = undefined;
  if (exempt === "matching") f.input.lastTurn = { changed: {}, rerouted: false, helpers: 0 };
  if (exempt === "editable" || exempt === "no starting head") await expect(f.check()).rejects.toBe(f.held);
  else { await f.check(); expect(f.calls).toEqual([]); expect(f.task.state).toBe("running"); }
  expect(f.calls).not.toContain("read-only-status"); f.assertConsumed();
});

for (const observation of ["model seen", "changed model", "changed effort", "rerouted", "unconfirmed"] as const) it(`holds the reported ${observation} without altering requested settings`, async () => {
  const f = maintenanceSettingsFixture(); f.statuses.push({ head: f.input.headBefore!, clean: true });
  f.input.lastTurn = { changed: {}, rerouted: false, helpers: 0 };
  if (observation === "model seen") f.input.lastTurn.modelSeen = "unexpected";
  if (observation === "changed model") { f.input.lastTurn.changed.model = "changed"; f.input.lastTurn.modelSeen = "seen"; }
  if (observation === "changed effort") f.input.lastTurn.changed.effort = "high";
  if (observation === "rerouted") f.input.lastTurn.rerouted = true;
  if (observation === "unconfirmed") f.input.settings = {};
  await expect(f.check()).rejects.toBe(f.held);
  const actual = f.task.maintenance!.settingsDecision!.actual;
  if (observation === "model seen") expect(actual).toContain("unexpected");
  if (observation === "changed model") { expect(actual).toContain("changed"); expect(actual).not.toContain("seen"); }
  if (observation === "unconfirmed") expect(actual).toBe("unconfirmed model · unconfirmed effort effort");
  expect(f.task.maintenance!.profile).toEqual(f.profile); f.assertConsumed();
});

it("propagates a failed read-only observation before publishing any settings decision", async () => {
  const f = maintenanceSettingsFixture(), error = new Error("Supplied observation failed"); f.statuses.push(error);
  await expect(f.check()).rejects.toBe(error);
  expect(f.calls).toEqual(["read-only-status"]); expect(f.saved).toEqual([]); expect(f.state.inbox).toEqual([]);
  expect(f.task.maintenance!.settingsDecision).toBeUndefined(); f.assertConsumed();
});

for (const choice of ["keep", "stop"] as const) it(`does not schedule or repeat ${choice} after a failed decision save`, async () => {
  const f = maintenanceSettingsFixture(); f.input.role = { ...f.role, canEdit: true };
  await expect(f.check()).rejects.toBe(f.held); f.calls.length = 0; f.failSave();
  expect(() => f.decide(choice)).toThrow(f.interrupted);
  expect(f.task.maintenance!.settingsDecision!.choice).toBe(choice);
  expect(f.calls).toEqual(choice === "stop" ? ["note", "remove", "cancel", "save"] : ["note", "remove", "save"]);
  f.calls.length = 0; f.decide(choice); expect(f.calls).toEqual([]);
});

it("ignores missing decisions and confirms exact startup settings before any maintenance instructions", () => {
  const f = maintenanceSettingsFixture();
  resolveMaintenanceSettings(f.decisions, undefined, "keep"); f.decide("stop"); expect(f.calls).toEqual([]);
  f.settings.confirm(f.profile, f.input.settings);
  for (const confirmed of [{}, { ...f.input.settings, model: "other" }, { ...f.input.settings, effort: "low" }])
    expect(() => f.settings.confirm(f.profile, confirmed)).toThrow("No maintenance instructions were sent");
  expect(f.calls).toEqual([]);
});
