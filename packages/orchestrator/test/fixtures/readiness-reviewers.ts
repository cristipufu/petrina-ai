import { pauseTaskState, reviewConversationScope, slotUses, type ReadinessWait } from "@petrina/core";
import { executionFor, repositoryView } from "../../src/repository-context.js";
import { StepOwnership } from "../../src/step-ownership.js";
import { WaitSourceRefresh } from "../../src/wait-source-refresh.js";
import { participantReadinessFixture } from "./participant-readiness.js";
import { ReleaseEvents } from "./release-events.js";
import { ScriptedAgents, scriptedResult } from "./scripted-agents.js";

/** Actual selection, shared checks, group and scheduler; saved conversations and replies are supplied inputs. */
export function readinessReviewersFixture(limit = 1) {
  const releases = new ReleaseEvents();
  const agents = new ScriptedAgents(async (prompt, signal) => {
    if (prompt.result !== "findings" && prompt.result !== "plan") throw new Error(`Unexpected readiness participant ${prompt.result}`);
    await releases.wait(prompt.result === "plan" ? "planner" : prompt.profileId, signal);
    if (prompt.result === "plan") return scriptedResult({ needsInput: { question: "Supplied planner boundary", options: [] } });
    return scriptedResult({ verdict: "pass", findings: [], confirms: [], disputes: [] });
  });
  const f = participantReadinessFixture(limit, agents), { current, scope } = f;
  current.plan = { rationale: "Return to two supplied review seats", plannerProfileId: "opus-high", stages: [
    { id: "review", title: "Review", kind: "review-chain", roleId: "code-reviewer", profileIds: ["opus-high", "grok-high"], maxRounds: 3 },
    { id: "finished", title: "Finished", kind: "gate", gate: "delivery", roleId: "coordinator", profileIds: [] },
  ] };
  current.stageIndex = 0; current.rounds.review = 2; current.startedAt = f.clock.now();
  current.hunt = { stageId: "review", round: 2, reported: {} };
  scope.work.worktree = "supplied:readiness-review";
  scope.work.delivery = "local";
  const stage = current.plan.stages[0]!, profile = f.catalog.profile("grok-high")!;
  const saved = { readinessWait: undefined as ReadinessWait | undefined, scope: reviewConversationScope(repositoryView(scope), stage.id, "1", f.catalog.role(stage.roleId, current)!, profile, profile, text => f.selection.host.digest(text)),
    round: 1, plannedProfileId: profile.id, profileId: profile.id, toolId: profile.toolId, model: profile.modelId ?? profile.model, sessionId: "supplied:previous-review" };
  current.reviewSessions = { review: { "1": saved } };
  const ownership = new StepOwnership({ role: f.catalog.role, group: id => f.ownership.groups.get(id) });
  f.host.stepStarted = task => ownership.started(task);
  f.host.sourceRefreshDue = task => ownership.refreshDue(task);
  f.groupHost.sourceRefreshDue = f.host.sourceRefreshDue;
  const source = new WaitSourceRefresh({ due: f.host.sourceRefreshDue, stepStarted: f.host.stepStarted,
    checkpoint: f.host.changed, note() {}, aborted: f.errors.aborted,
  }, {
    async clean(value) { if (value.task !== current || value.work !== scope.work) throw new Error("Unexpected readiness source owner"); return true; },
    async clearUnpublishedVersion(value, preserve) { if (value.task !== current || value.work !== scope.work || !preserve) throw new Error("Unexpected readiness source restoration"); },
    async update(value, signal) { if (value.task !== current || value.work !== scope.work) throw new Error("Unexpected readiness source owner"); signal.throwIfAborted(); return "current"; },
  });
  const prepare = f.phases.prepareWorkspace;
  f.phases.prepareWorkspace = async (task, stage, signal) => {
    if (task === current && await source.run(task, signal)) throw new Error("The supplied unchanged source cannot conflict");
    return prepare(task, stage, signal);
  };
  f.uncertain("grok");
  const seen: string[][] = [];
  f.subscribe(() => { seen.push(slotUses(f.snapshot()).filter(use => use.taskId === current.id).map(use => use.toolId).sort()); });
  return { ...f, saved, stage, agents, releases, seen,
    ours: () => slotUses(f.snapshot()).filter(use => use.taskId === current.id),
    start() {
      current.state = "waiting"; current.held = false;
      f.workflow.schedule();
      const work = f.ownership.settling.get(current.id);
      if (!work) throw new Error("Readiness review did not acquire its driver");
      return work;
    },
    enqueue() { f.queued.held = false; f.queued.state = "queued"; f.workflow.schedule(); return f.queued; },
    async pauseQueued() {
      const work = f.ownership.settling.get(f.queued.id);
      pauseTaskState(f.queued, executionFor(f.queued).work, f.clock.now());
      f.ownership.drivers.get(f.queued.id)?.abort(); await work;
    },
  };
}
