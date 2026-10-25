import { beginAgentStep, beginYouStep, columnOf, createTaskState, endAgentStep, finishTaskStep, normalizePlan, roleForTask, startClock, stepKey,  type Id, type PlanDraftStage, type Role, type State } from "@petrina/core";
import { waitForProgress, type ProgressClock } from "@petrina/test-support/progress-wait";
import { AgentWorkflow } from "../../src/agent-workflow.js";
import { ParallelAdmissionGroup } from "../../src/parallel-admission-group.js";
import { pauseAgentStep, releaseAgentForDecision, resumeAgentAfterReply, waitForAgentUsage } from "../../src/index.js";
import { rememberReviewProfile, nextReviewPlace, pendingReviewPlaces } from "../../src/review-members.js";
import { executionFor, repositoryView, restoreRepositoryState, taskView, type RepositoryContext } from "../../src/repository-context.js";
import { ReviewReports } from "../../src/review-reports.js";
import { ReviewRoundCompletion } from "../../src/review-round-completion.js";
import type { RuntimeTask } from "../../src/model.js";
import type { AgentAdmissionCatalog, AgentAdmissionErrors, AgentAdmissionReadiness, AgentOwnership, AgentWorkflowHost, AgentWorkflowPhases } from "../../src/ports/agent-workflow.js";
import type { ParallelAdmissionHost } from "../../src/ports/parallel-admission.js";
import type { AgentSession } from "../../src/ports/agents.js";
import { profileSelectionFixture } from "./profile-selection.js";
import { deferred } from "./tool-checks.js";
import { ControlledClock } from "./clock.js";
import { slotAgents } from "./slot-agents.js";

class UsageWait extends Error { constructor(readonly words: string, readonly capacity = false) { super(words); } }
class Aborted extends Error {}
class SourceRefresh extends Error {}
class ScreenWait extends Error {}

interface Reply {
  needsInput?: { question: string; options: string[] };
  rationale?: string;
  stages?: PlanDraftStage[];
  summary?: string;
  forUsers?: string[];
  areas?: string[];
  acceptance?: string[];
  risks?: string[];
  answers?: { id: Id; status: "accepted" | "rejected"; answer: string }[];
  objections?: { text: string; blocking: boolean }[];
  verdict?: "pass" | "fail";
  findings?: [];
}

/** Decode this fixture's own canonical scriptedResult records; this makes no provider/schema validation claim. */
function fixtureReply(text: string): Reply {
  if (!text.startsWith("```petrina\n") || !text.endsWith("\n```")) throw new Error("The slot recipe returned an unexpected fixture record");
  return JSON.parse(text.slice("```petrina\n".length, -"\n```".length));
}

/** The real admission/group/selection owners; every remaining effect is explicit, private and process-free. */
export function admissionFixture(limit: number, toolCap: number, taskCount = 9) {
  const selection = profileSelectionFixture(), { state, profile } = selection;
  state.tasks.length = 0;
  state.pool.limit = limit;
  state.pool.toolCaps = { "claude-code": toolCap, codex: 2 };
  const clock = new ControlledClock(); clock.at = state.now;
  selection.host.now = clock.now;
  selection.host.awayFromBuilder = () => undefined;
  const observations: { kind: string; taskId?: Id; stageId?: Id }[] = [];
  const writes: string[] = [];
  const { agents, release } = slotAgents(cwd => { writes.push(cwd); });
  const ownership: AgentOwnership = { drivers: new Map(), settling: new Map(), pendingAdmissions: new Map(), groups: new Map() };
  const listeners = new Set<() => void>();
  const background = new Set<Promise<void>>(), trackedWork: Promise<void>[] = [];
  const driverErrors: { taskId: Id; error: unknown }[] = [];
  const sessions = new Set<AgentSession>(), savedSessions = new Map<string, string>();
  const questions = new Map<Id, { task: RuntimeTask; resolve(answer: string): void }>();
  const authors = new Map<string, { toolId: Id; modelRan: string }>();
  let stopped = false, sequence = 0;
  const unexpected = (what: string): never => { throw new Error("Unexpected agent-admission fixture effect: " + what); };
  const task = (id: Id) => state.tasks.find(task => task.id === id);
  const snapshot = (): State => ({ ...state, now: clock.now(), tasks: state.tasks.map(taskView) });
  const changed = () => { state.now = clock.now(); for (const listener of [...listeners]) listener(); };
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  const catalog: AgentAdmissionCatalog = { profile, role: (id, task) => roleForTask(state.roles, id, task), onUsable: selection.host.onUsable,
    choose: (request, task, room) => selection.selection.choose(request.profileId, task, request.roleId, room, request.reviewerKey),
  };
  selection.host.completedDesignAuthor = (taskId, stageId, round, roleId) => authors.get(JSON.stringify([taskId, stageId, round, roleId]));
  selection.host.reportedReviewerTools = () => unexpected("legacy reviewer lookup");
  const readiness: AgentAdmissionReadiness = {
    hold: () => unexpected("readiness hold"), open: () => unexpected("readiness open"), resolve: () => unexpected("readiness probe"),
    resolveHeld: () => unexpected("held readiness probe"), yieldHeld: () => unexpected("readiness yield"), charge: () => unexpected("readiness charge"),
  };
  const errors: AgentAdmissionErrors = {
    aborted: () => new Aborted(), sourceRefresh: () => new SourceRefresh(), screenWait: () => new ScreenWait(), usage: words => new UsageWait(words),
    classify: error => error instanceof UsageWait ? { kind: "usage", error, words: error.words, capacity: error.capacity }
      : error instanceof Aborted ? { kind: "abort" } : error instanceof ScreenWait ? { kind: "screen" } : error instanceof SourceRefresh ? { kind: "source-refresh" } : { kind: "failure" },
    waitingFor: words => { const error = new UsageWait(words); return { error, words, capacity: false }; },
  };
  const admissionClosed = () => stopped || state.pool.paused;
  const column = (task: RuntimeTask) => columnOf(taskView(task), state.roles);
  const gate = (task: RuntimeTask, kind: "plan" | "design" | "delivery") => {
    if (kind !== "delivery") unexpected("unplanned checkpoint " + kind);
    releaseAgentForDecision(task);
    beginYouStep(task, kind, clock.now());
    task.state = "needs-you"; task.column = "ready"; task.statusLine = "Ready for your delivery check";
    state.inbox.push({ id: `decision-${++sequence}`, taskId: task.id, kind, title: "Review this delivery", at: clock.now(), blocking: false });
    changed();
  };
  const host: AgentWorkflowHost = {
    state: () => state, activeState: () => state, task, taskDetails: id => { const current = task(id); return current && taskView(current); }, now: clock.now,
    stopped: () => stopped, draining: () => false, drainLine: () => unexpected("drain"), admissionsClosed: admissionClosed, admissionWait: () => "Waiting for the pool to resume", sourceRefreshDue: () => false, stepStarted: () => false,
    blockers: () => [], column, pauseStep: task => pauseAgentStep(task, clock.now()), waitForUsage: (task, words) => { waitForAgentUsage(task, words, clock.now(), () => column(task)); changed(); },
    syncScreen: () => {}, syncDeliveryTurns: () => {}, waitingForDelivery: () => undefined, expireLimits: () => {}, armLimitTimer: () => {},
    changed, checkpoint: changed, note: () => {}, gate,
    failed: (id, error) => { const current = task(id)!; releaseAgentForDecision(current); current.state = "failed"; current.error = error instanceof Error ? error.message : String(error); failures.push(error); changed(); },
    beginStage: scope => { observations.push({ kind: "stage", taskId: scope.task.id, stageId: scope.task.plan?.stages[scope.task.stageIndex]?.id }); },
    tidy: () => {}, schedule: () => workflow.schedule(), idleChanged: () => {},
    trackWork(work) {
      trackedWork.push(work);
      const tracked = work.then(() => { background.delete(tracked); }, () => { background.delete(tracked); });
      background.add(tracked);
      return work;
    },
    reportDriverError: (taskId, error) => { driverErrors.push({ taskId, error }); },
  };
  const failures: unknown[] = [];
  const groupHost: ParallelAdmissionHost = {
    state: () => state, activeState: () => state, now: clock.now, draining: () => false, admissionsClosed: admissionClosed, admissionWait: host.admissionWait, sourceRefreshDue: host.sourceRefreshDue,
    selectScreen: () => {}, syncScreen: () => {}, showReviewWork: () => {},
    finishStep: task => finishTaskStep(task, executionFor(task).work, clock.now()),
    waitForUsage: host.waitForUsage, rememberReviewer: (task, key, id) => { rememberReviewProfile(task, key, id); changed(); }, changed, checkpoint: changed, schedule: host.schedule,
  };
  const reviewCatalog = { roles: () => state.roles, profile, pendingVoter: (task: RuntimeTask) => task.findings.length ? unexpected("unplanned ballot") : undefined };
  const reports = new ReviewReports({ roles: () => state.roles, hasPendingReviewers: (task, stage) => pendingReviewPlaces(task, stage, reviewCatalog).length > 0,
    id: () => unexpected("new finding"), now: clock.now, verdict: () => {}, note: () => {},
  });
  const rounds = new ReviewRoundCompletion({ role: catalog.role, roles: () => state.roles, incrementalReview: () => true,
    ownChanges: () => unexpected("review decision changes"),
    // Explicitly unavailable version observation: no Git SHA/tree or passing native evidence is invented.
    anchor: async () => ({}), reviewEnd: () => {}, releaseInput: () => {}, note: () => {},
    commitNow: changed, changed, openDeliveryDecision: task => gate(task, "delivery"), now: clock.now,
  });
  const finishPhase = (scope: RepositoryContext, outcome: string) => { endAgentStep(scope.task, { outcome, reason: outcome }, clock.now()); finishTaskStep(scope.task, scope.work, clock.now()); };
  const perform = async (scope: RepositoryContext, role: Role, signal: AbortSignal, text: string, parallel?: { key: string; seat: Id; used(profileId: Id): void }): Promise<Reply> => {
    const { task } = scope;
    const selected = profile(parallel?.seat ?? task.agent?.profileId ?? "") ?? unexpected("missing selected profile");
    const admission = { task, profile: selected, roleId: role.id, step: stepKey(task) };
    if (!parallel) {
      workflow.qualify(admission, signal);
      task.stepClock = startClock(repositoryView(scope), role.id, clock.now());
      workflow.activate(admission);
      beginAgentStep(task, role.id, selected.id, clock.now(), state.roles);
    } else parallel.used(selected.id);
    changed();
    const key = JSON.stringify([task.id, task.plan?.stages[task.stageIndex]?.id ?? "plan", role.id, parallel?.key]);
    const session = await agents.start({ profile: selected, cwd: scope.work.worktree ?? `scripted:planning:${task.id}`, callbacks: {
      onActivity: changed, onPlanStep: changed, onPermission: () => unexpected("permission"),
    }, signal, ...(savedSessions.has(key) ? { reopen: savedSessions.get(key) } : {}) }, role);
    savedSessions.set(key, session.sessionId); sessions.add(session); session.onPromptStarted = changed;
    try {
      let value = fixtureReply((await session.prompt(text)).text);
      if (value.needsInput) {
        const id = `question-${++sequence}`;
        task.state = "needs-you"; task.statusLine = "Waiting for your answer";
        const answerCleanup = deferred<void>();
        const answer = new Promise<string>((resolve, reject) => {
          questions.set(id, { task, resolve });
          const abort = () => { questions.delete(id); reject(errors.aborted()); };
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
          void answerCleanup.promise.then(() => signal.removeEventListener("abort", abort));
        });
        state.inbox.push({ id, taskId: task.id, kind: "question", title: value.needsInput.question, options: value.needsInput.options, at: clock.now(), blocking: true });
        changed();
        try { value = fixtureReply((await session.prompt(await answer)).text); }
        finally { answerCleanup.resolve(); questions.delete(id); }
      }
      return value;
    } finally {
      if (!await session.stop()) throw new Error("A scripted session did not confirm its own completion");
      sessions.delete(session);
    }
  };
  const phases: AgentWorkflowPhases = {
    prepareWorkspace: async (task, _stage, signal) => {
      if (signal.aborted) throw errors.aborted();
      const scope = executionFor(task);
      if (task.plan && !scope.work.worktree) scope.work.worktree = `scripted:workspace:${task.id}`;
      return { kind: "ready", scope };
    },
    prepareAcceptance: () => unexpected("acceptance phase"),
    deliveryCheckpoint: async scope => { gate(scope.task, "delivery"); return { kind: "stop" }; },
    planner: async (task, signal) => {
      const scope = executionFor(task), role = catalog.role("planner", task)!;
      const reply = await perform(scope, role, signal, "Plan the greeting");
      if (!reply.rationale || !reply.stages) unexpected("invalid planned fixture response");
      scope.work.source = { product: { id: state.products[0]!.id, name: state.products[0]!.name, repo: state.products[0]!.repo }, start: { kind: "default", branch: "main" }, destination: { kind: "branch", mode: "local", repo: state.products[0]!.repo, branch: "main" }, confirmed: true };
      task.plan = JSON.parse(JSON.stringify(normalizePlan({ task: taskView(task), result: { rationale: reply.rationale!, stages: reply.stages! }, roles: state.roles, profiles: state.profiles, plannerProfileId: task.agent!.profileId, releaseManagerProfileId: "opus-high", onUsable: catalog.onUsable })));
      finishPhase(scope, "Plan ready"); changed();
    },
    doStage: async (scope, stage, signal) => {
      const role = catalog.role(stage.roleId, scope.task)!;
      if (role.result !== "notes" && role.result !== "build") unexpected("do-stage " + role.result);
      await perform(scope, role, signal, "Complete this fixture stage");
      finishPhase(scope, "Stage complete"); scope.task.stageIndex += 1; scope.task.sub = 0; changed(); return "continue";
    },
    // These are scripted phase completions, not a replacement Design controller. Native composition retains actual design parsing/convergence.
    converge: async (scope, stage, signal) => {
      const { task } = scope, round = task.rounds[stage.id] ?? 1;
      const role = catalog.role(task.sub === 0 ? stage.roleId : stage.reviewerRoleId!, task)!;
      const text = task.objections.length ? "## Objections so far\n" + task.objections.map(item => `- [${item.id}] ${item.text}`).join("\n") : "Write or inspect the greeting design";
      const reply = await perform(scope, role, signal, text);
      if (task.sub === 0) {
        if (role.result !== "brief") unexpected("converge author result");
        task.brief = { summary: reply.summary!, forUsers: reply.forUsers!, areas: reply.areas!, acceptance: (reply.acceptance ?? []).map(text => ({ text })), risks: reply.risks! };
        for (const answer of reply.answers ?? []) { const objection = task.objections.find(item => item.id === answer.id)!; objection.status = answer.status; objection.answer = answer.answer; }
        const actual = profile(task.agent!.profileId)!; authors.set(JSON.stringify([task.id, stage.id, round, role.id]), { toolId: actual.toolId, modelRan: actual.modelId ?? actual.model });
        task.sub = 1;
      } else {
        if (role.result !== "objections") unexpected("converge reviewer result");
        for (const objection of reply.objections ?? []) task.objections.push({ id: `${task.id}-objection-${++sequence}`, round, ...objection, raisedBy: task.agent!.profileId, status: "open" });
        if (round === 1) { if (reply.objections?.length !== 1) unexpected("first design phase completion"); task.rounds[stage.id] = 2; task.sub = 0; }
        else { if (round !== 2 || reply.objections?.length !== 0) unexpected("settled design phase completion"); task.stageIndex += 1; task.sub = 0; }
      }
      finishPhase(scope, "Design phase complete"); changed(); return "continue";
    },
    review: async (task, stage, signal) => {
      const scope = executionFor(task), round = task.rounds[stage.id] ?? 1;
      if (task.hunt?.stageId !== stage.id || task.hunt.round !== round) {
        // Native check/snapshot preparation is an explicit phase result, with no native evidence record or invented identity.
        task.hunt = { stageId: stage.id, round, reported: {}, findings: 0 }; changed(); return "continue";
      }
      const pending = pendingReviewPlaces(task, stage, reviewCatalog);
      if (pending.length) {
        beginAgentStep(task, stage.roleId, task.agent!.profileId, clock.now(), state.roles, stage.profileIds);
        const group = new ParallelAdmissionGroup(groupHost, { ownership, catalog, readiness, errors });
        await group.run({ scope, signal, status: (running, waiting) => `${running} reviewers working; ${waiting} waiting`, members: pending.map(({ key, profileId }) => ({
          key: `review-${key}`, reviewKey: `reviewer:${key}`, roleId: stage.roleIds?.[Number(key)] ?? stage.roleId, profileId, reviewerKey: key,
          work: async (_copy, _room, seat, used, _agent, _continuing, signal) => {
            const role = catalog.role(stage.roleIds?.[Number(key)] ?? stage.roleId, task)!;
            const reply = await perform(scope, role, signal, "Review the greeting", { key, seat, used });
            if (reply.verdict !== "pass" || reply.findings?.length) unexpected("slot fixture finding response");
            reports.apply(task, stage, { verdict: reply.verdict!, findings: [], confirms: [], disputes: [], resolves: [], confirmationEvidence: {} }, seat, role.id, key);
            ownership.groups.get(task.id)!.finished(`review-${key}`);
            task.hunt!.reported[key] = true; changed();
          },
        })), workspaces: {
          reference: member => `scripted:review:${task.id}:${member}`,
          prepare: async () => ({ activate() {}, finish() {} }), stopHelpers() {}, closeTaskRun() {}, releasedStops: async () => {}, finish: async () => {},
        } });
        finishTaskStep(task, scope.work, clock.now()); reports.settle(task, stage); changed(); return "continue";
      }
      return rounds.finish(task, stage, round, "Review passed");
    },
    delivery: () => unexpected("publication"), nextReviewer: (task, stage) => nextReviewPlace(task, stage, reviewCatalog),
    deliveryNeedsAgent: scope => scope.work.delivery === "local" ? false : unexpected("release-note admission"), carriedOver: () => unexpected("carried-over delivery"),
    clearUnpublishedOnFailure: async () => {}, finish: async id => { observations.push({ kind: "finished", taskId: id }); },
  };
  const workflow = new AgentWorkflow(host, { ownership, catalog, readiness, errors, phases, plannerProfileId: "opus-high", checkPreparation: {
    // This is an explicitly available preparation effect; the separate native/check-admission lane has its own contracts.
    claim: () => !admissionClosed(), release: () => {},
  } });
  const ids = Array.from({ length: taskCount }, (_, index) => {
    const task = createTaskState({ productId: state.products[0]!.id, title: `Change ${index}`, approveDelivery: true }, state.products, { id: `slot-${index}`, timelineId: `created-${index}`, now: clock.now(), priority: index });
    restoreRepositoryState(task); state.tasks.push(task); return task.id;
  });
  const progress: ProgressClock = { now: clock.now, slow: () => 1, arm: (expired, ms) => clock.after(ms, () => { expired(); return undefined; }), sleep: async ms => { clock.advance(ms); await Promise.resolve(); } };
  return { workflow, ownership, agents, release, ids, snapshot, subscribe, phases, observations, writes, failures, background, trackedWork, driverErrors, clock, errors, catalog, state, task, host, groupHost, readiness,
    waitFor: <T>(check: () => T | undefined | false | Promise<T | undefined | false>, what: string, ms = 30_000, during?: PromiseLike<unknown>) => waitForProgress(check, what, ms, { during }, progress),
    answer(id: Id, answer: string) { const waiting = questions.get(id) ?? unexpected("answer to an unregistered question"); state.inbox = state.inbox.filter(item => item.id !== id); resumeAgentAfterReply(waiting.task, state.inbox.some(item => item.taskId === waiting.task.id && item.blocking), clock.now()); changed(); waiting.resolve(answer); questions.delete(id); },
    allow(_id: Id, _how: "once") { unexpected("permission approval"); },
    async close() {
      stopped = true; for (const controller of ownership.drivers.values()) controller.abort();
      const results = await Promise.allSettled([...ownership.settling.values(), ...background, ...[...sessions].map(session => session.stop())]);
      const failed = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      listeners.clear();
      if (failed.length) throw new AggregateError(failed, "Portable admission ownership did not settle");
      if (ownership.drivers.size || ownership.settling.size || ownership.groups.size || sessions.size) throw new Error("Portable admission retained an active owner");
    },
  };
}
