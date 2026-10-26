import { reviewConversationScope, slotWait, type AgentProfile, type CheckId } from "@petrina/core";
import { executionFor, repositoryView } from "../../src/repository-context.js";
import { participantConversation } from "../../src/participant-conversation.js";
import { profileSelectionFixture } from "./profile-selection.js";

/** The actual selector consumes explicit prior-session observations; this fixture makes no native reopen claim. */
export function reviewParticipantFixture(pair = false, awayFromBuilder = false) {
  const f = profileSelectionFixture(), { state, task } = f, scope = executionFor(task);
  f.host.awayFromBuilder = () => awayFromBuilder;
  f.host.onUsable = id => state.profiles.some(profile => profile.id === id) ? id : "sol-high";
  state.pool.paused = false; state.pool.limit = 3; state.pool.toolCaps = { codex: 1, grok: 1 };
  state.setup!.checks = state.tools.map(tool => ({ id: tool.id as CheckId, status: "ready" }));
  state.profiles.push({ ...f.profile("astra-xhigh")!, id: "astra-high", effort: "high" });
  task.description = "ORIGINAL-SEAT-REQUEST";
  task.brief = { summary: "UNCHANGED-BRIEF", forUsers: [], areas: [], acceptance: [], risks: [] };
  Object.assign(scope.work, { worktree: "scripted:review", branch: "main", baseSha: "a".repeat(40), base: "main", report: { summary: "First report", changes: [] } });
  const stage = { id: "review", title: "Review the greeting", kind: "review-chain" as const,
    roleId: awayFromBuilder ? "security-reviewer" : "code-reviewer", profileIds: pair ? ["opus-high", "sol-high"] : ["opus-high"] };
  task.plan = { rationale: "Saved review participant selection", plannerProfileId: "sol-high", stages: [stage] };
  task.stageIndex = 0; task.rounds[stage.id] = 1;
  const room = (toolId: string, profile: AgentProfile) => !slotWait(state, { ...profile, taskId: task.id, toolId });
  state.pool.limited = [{ toolId: "claude-code", until: f.now() + 3_600_000, reason: "Explicit account observation" }];
  const planned = f.profile("opus-high")!, role = f.host.role(stage.roleId, task)!;
  const first = f.selection.choose(planned.id, scope, role.id, room, "0");
  if (!first || first.kind === "none" || first.profile.id === planned.id) throw new Error("The actual selector did not choose a stand-in");
  const actual = first.profile;
  const saved = { scope: reviewConversationScope(repositoryView(scope), stage.id, "0", role, planned, actual, text => f.host.digest(text)),
    round: 1, plannedProfileId: planned.id, profileId: actual.id, toolId: actual.toolId, model: actual.modelId ?? actual.model,
    sessionId: "observed-prior-review-session" };
  task.reviewSessions = { [stage.id]: { "0": saved } };
  state.pool.limited = []; task.rounds[stage.id] = 2; scope.work.report!.summary = "CHANGED-BUILDER-REPORT";
  const choose = () => f.selection.choose(stage.profileIds[0]!, scope, stage.roleId, room, "0");
  const prior = () => participantConversation({ profiles: state.profiles, digest: text => f.host.digest(text) }, scope,
    f.host.role(stage.roleId, task)!, f.profile(stage.profileIds[0]!)!, "0");
  const rebindObservation = () => {
    saved.scope = reviewConversationScope(repositoryView(scope), stage.id, "0", f.host.role(stage.roleId, task)!,
      f.profile("opus-high")!, f.profile(saved.profileId)!, text => f.host.digest(text));
  };
  return { ...f, scope, stage, saved, first, choose, prior, rebindObservation };
}
