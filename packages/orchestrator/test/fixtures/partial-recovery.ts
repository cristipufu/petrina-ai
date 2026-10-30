import { beginAgentStep, changeRuntimeWait, endAgentStep, endOpenStep, finishTaskStep, runtimeWaitHolds, stepKey } from "@petrina/core";
import { executionFor, type RepositoryContext } from "../../src/repository-context.js";
import { StepOwnership } from "../../src/step-ownership.js";
import { WaitSourceRefresh } from "../../src/wait-source-refresh.js";
import { WorkCompletion } from "../../src/work-completion.js";
import { admissionFixture } from "./agent-workflow.js";
import { capacityFixture } from "./capacity-recovery.js";
import { ReleaseEvents } from "./release-events.js";
import { waitDuring } from "./clock.js";

/** Actual admission/recovery/refresh/completion; repository and startup observations are explicit effects. */
export function partialRecoveryFixture() {
  const scheduler = admissionFixture(2, 2, 2), task = scheduler.task(scheduler.ids[0]!)!, prerequisite = scheduler.task(scheduler.ids[1]!)!;
  const turn = capacityFixture(undefined, { selection: scheduler.selection, task, clock: scheduler.clock });
  prerequisite.state = "backlog";
  task.state = "waiting"; task.startedAt = 1; task.stageIndex = 0; task.holdsSlot = false;
  task.plan = { rationale: "Partial attempt recovery", plannerProfileId: "sol-high", stages: [
    { id: "build", title: "Build", kind: "do", roleId: "builder", profileIds: ["sol-high"] },
    { id: "review", title: "Review", kind: "review-chain", roleId: "code-reviewer", profileIds: ["opus-high"] },
  ] };
  const scope = executionFor(task);
  Object.assign(scope.work, { worktree: "supplied:private-copy", base: "main", baseSha: "supplied:initial" });
  const ownership = new StepOwnership({ role: scheduler.catalog.role, group: id => scheduler.ownership.groups.get(id) });
  const code = { clean: true, partial: undefined as string | undefined, latest: "supplied:initial" };
  const calls: string[] = [], attempts: { number: number; base: string | undefined; partial: string | undefined; admitted: boolean }[] = [];
  const reviewed: { base: string | undefined; partial: string | undefined }[] = [];
  const releases = new ReleaseEvents(), outcomes = new Map<number, "fail" | "pass">();
  const bound = (value: RepositoryContext) => { if (value.task !== task || value.work !== scope.work) throw new Error("Wrong partial-recovery execution"); };
  let holdStartup = false, operation: Promise<void> | undefined;
  const source = new WaitSourceRefresh({
    due: current => ownership.refreshDue(current), stepStarted: current => ownership.started(current), checkpoint: () => { calls.push("checkpoint"); },
    note: () => { calls.push("refreshed"); }, aborted: scheduler.errors.aborted,
  }, {
    async clean(value) { bound(value); calls.push("clean"); return code.clean; },
    async clearUnpublishedVersion(value, preserve) { bound(value); if (!preserve) throw new Error("Refresh must preserve its attempt counters"); calls.push("restore"); },
    async update(value, signal) {
      bound(value); signal.throwIfAborted(); calls.push("update");
      if (!code.clean) throw new Error("The supplied repository observation refuses unrelated dirty work");
      const changed = value.work.baseSha !== code.latest; value.work.baseSha = code.latest;
      return changed ? "moved" : "current";
    },
  });
  const completion = new WorkCompletion({
    finishStep(value) { bound(value); finishTaskStep(task, scope.work, scheduler.clock.now()); },
    endStage() {}, rerun: () => false,
    async invalidateAcceptance() { throw new Error("This supplied single-product phase has no acceptance"); },
    checkpoint: () => {}, changed: scheduler.host.changed,
  });
  scheduler.host.schedule = () => {};
  // This recipe supplies known profiles and has no outstanding readiness observation.
  scheduler.readiness.yieldHeld = () => false;
  scheduler.host.stepStarted = current => ownership.started(current);
  scheduler.host.sourceRefreshDue = current => ownership.refreshDue(current);
  scheduler.host.admissionsClosed = current => scheduler.state.pool.paused || runtimeWaitHolds(current);
  turn.host.admissionsClosed = scheduler.host.admissionsClosed;
  turn.host.sourceRefreshDue = scheduler.host.sourceRefreshDue;
  const failed = scheduler.host.failed;
  scheduler.host.failed = (id, error) => {
    if (id !== task.id) throw new Error("Unexpected failed owner");
    ownership.failed(scope);
    endOpenStep(task, { outcome: "Stuck", reason: String(error), end: "failed" }, scheduler.clock.now());
    delete scope.work.conversation;
    failed(id, error);
  };
  scheduler.phases.prepareWorkspace = async (current, _stage, signal) => {
    if (current !== task) throw new Error("Unexpected prepared owner");
    if (await source.run(current, signal)) return { kind: "repeat" };
    return { kind: "ready", scope };
  };
  scheduler.phases.doStage = async (value, stage, signal) => {
    bound(value);
    if (scheduler.catalog.role(stage.roleId, task)?.result !== "build") throw new Error("Unexpected partial-recovery role");
    await turn.recovery.main({ scope, roleId: stage.roleId, plannedId: stage.profileIds[0]!, signal, attempt: async profile => {
      const step = stepKey(task), admission = { task, roleId: stage.roleId, profile, step };
      scheduler.workflow.qualify(admission, signal); scheduler.workflow.activate(admission);
      beginAgentStep(task, stage.roleId, profile.id, scheduler.clock.now(), scheduler.state.roles);
      ownership.admitEditable(scope, step);
      const attempt = { number: attempts.length, base: scope.work.baseSha, partial: code.partial, admitted: false };
      attempts.push(attempt);
      if (holdStartup) { holdStartup = false; await releases.wait(`startup-${attempt.number}`, signal); }
      signal.throwIfAborted(); attempt.admitted = true;
      await releases.wait(`reply-${attempt.number}`, signal);
      signal.throwIfAborted();
      const outcome = outcomes.get(attempt.number);
      if (!outcome) throw new Error("Missing explicit attempt result");
      if (outcome === "fail") throw new Error("Supplied Builder attempt failed before completion");
      // Native commit/file behavior has its own anchors. This effect reports that accepted work settled.
      code.clean = true;
      endAgentStep(task, { outcome: "Accepted supplied Builder result", reason: "Ready for completion" }, scheduler.clock.now());
    } });
    return completion.complete(scope, { stageId: stage.id, canEdit: true });
  };
  scheduler.phases.review = async (current, _stage, signal) => {
    if (current !== task) throw new Error("Unexpected review owner");
    signal.throwIfAborted(); reviewed.push({ base: scope.work.baseSha, partial: code.partial }); return "stop";
  };
  return { scheduler, turn, task, scope, prerequisite, ownership, source, code, calls, attempts, reviewed,
    holdStartup() { holdStartup = true; },
    releaseStartup(number: number) { releases.release(`startup-${number}`); },
    writePartial(text: string) { code.partial = text; code.clean = false; },
    hold() { changeRuntimeWait(task, { after: [prerequisite.id], reason: "The next step needs a new source" }, scheduler.clock.now()); scheduler.workflow.syncRuntimeWaits(); },
    release(how: "clear" | "landed") {
      code.latest = "supplied:latest";
      if (how === "clear") changeRuntimeWait(task, { after: [], reason: "The source is available" }, scheduler.clock.now());
      else {
        prerequisite.state = "done"; executionFor(prerequisite).work.landed = { branch: "main", sha: code.latest };
        scheduler.workflow.syncRuntimeWaits();
      }
    },
    start() {
      if (scheduler.ownership.settling.has(task.id)) throw new Error("A previous partial attempt still owns its driver");
      task.state = "waiting"; delete task.error; // Explicit coordinator Retry input; native command/persistence has retained anchors.
      scheduler.state.pool.paused = false; scheduler.workflow.startDriver(task.id);
      operation = scheduler.ownership.settling.get(task.id);
      if (!operation) throw new Error("The partial attempt has no registered operation");
      return operation;
    },
    entered(number: number, startup = false) {
      if (!operation) throw new Error("Start the owned attempt before observing it");
      return waitDuring(() => attempts[number] && (startup || attempts[number]!.admitted) && attempts[number], operation, "the partial attempt's supplied input");
    },
    reply(number: number, outcome: "fail" | "pass") { outcomes.set(number, outcome); releases.release(`reply-${number}`); },
    async close() { try { await scheduler.close(); } finally { await turn.close(); } },
  };
}
