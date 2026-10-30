import { sameModel, type AgentProfile } from "@petrina/core";
import type { RuntimeTask } from "./model.js";
import type { SessionSettings } from "./ports/agents.js";
import type { MaintenanceDecisionHost, MaintenanceSettingsEffects, MaintenanceSettingsHost, MaintenanceSettingsInput } from "./ports/maintenance-settings.js";

/** The frozen maintenance profile is checked before instructions and before any reply advances. */
export class MaintenanceSettings {
  constructor(private readonly host: MaintenanceSettingsHost, private readonly effects: MaintenanceSettingsEffects) {}

  confirm(profile: AgentProfile, confirmed: SessionSettings): void {
    if (confirmed.model !== (profile.modelId ?? profile.model) || confirmed.effort !== profile.effort)
      throw this.host.unconfirmed(`The maintenance profile could not be confirmed. Requested ${profile.model} at ${profile.effort}; reported ${confirmed.model ?? "no model"} at ${confirmed.effort ?? "no effort"}. Check the tool settings, then retry this run. No maintenance instructions were sent.`);
  }

  async check(task: RuntimeTask, input: MaintenanceSettingsInput): Promise<void> {
    const { role, profile, settings, lastTurn: notes, worktree, headBefore, reply, result } = input;
    const maintenance = task.maintenance;
    if (maintenance?.role.id !== role.id || !notes) return;
    const model = notes.changed.model ?? notes.modelSeen ?? settings.model;
    const effort = notes.changed.effort ?? settings.effort;
    if (sameModel(profile.toolId, profile.modelId ?? profile.model, model) && effort === profile.effort && !notes.rerouted) return;
    if (!role.canEdit && headBefore) {
      const status = await this.effects.readOnlyStatus(worktree);
      if (status.head !== headBefore || !status.clean) maintenance.readOnlyWrites = true;
    }
    const requested = `${profile.model} · ${profile.effort} effort`;
    const actual = `${model ?? "unconfirmed model"} · ${effort ?? "unconfirmed effort"} effort`;
    const stageId = task.plan!.stages[task.stageIndex]!.id;
    if (reply) {
      maintenance.pendingReply = { stageId, text: reply.text, stopReason: reply.stopReason, ...(reply.streamed ? { streamed: true } : {}) };
      delete maintenance.pendingResult;
    } else maintenance.pendingResult = { stageId, value: result };
    maintenance.settingsDecision = { requested, actual, at: this.host.now() };
    this.host.pauseStep(task);
    task.state = "needs-you";
    task.holdsSlot = false;
    delete task.agent;
    task.statusLine = "The tool reported different settings. Choose whether to keep or stop this run.";
    this.host.addDecision({
      id: `maintenance-settings-${task.id}`,
      taskId: task.id,
      kind: "maintenance-settings",
      title: "Unexpected maintenance agent settings",
      body: `Requested: ${requested}\nReported: ${actual}\nKeeping this run accepts the work as produced. Delivery still needs its usual checks and approval. The routine keeps its saved profile.`,
      at: this.host.now(),
      blocking: true
    });
    this.host.checkpoint(task);
    throw this.host.aborted();
  }
}

/** The coordinator's decision is saved with ordinary cancellation or before scheduling a kept reply. */
export function resolveMaintenanceSettings(host: MaintenanceDecisionHost, task: RuntimeTask | undefined, choice: "keep" | "stop"): void {
  const decision = task?.maintenance?.settingsDecision;
  if (!task || !decision || decision.choice) return;
  decision.choice = choice;
  host.note(
    task,
    choice === "keep" ? `You kept this maintenance turn with its reported settings: ${decision.actual}. Future turns still request ${decision.requested}.` : "You stopped this maintenance run after its tool reported different settings"
  );
  host.removeDecision(task.id);
  if (choice === "stop") {
    host.cancel(task.id);
    host.checkpoint(task);
    return;
  }
  task.state = "waiting";
  task.statusLine = "Continuing with the reported settings you accepted";
  host.checkpoint(task);
  host.schedule();
}
