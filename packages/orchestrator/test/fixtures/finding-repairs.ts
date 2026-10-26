import { beginAgentStep, builderFindings, checkReviewEvidence, endAgentStep, findingCount, recordBuilderFindingAnswers, roleForTask, startClock, stepKey, type Finding, type Stage } from "@petrina/core";
import { ReviewReports } from "../../src/review-reports.js";
import { ReviewRoundCompletion } from "../../src/review-round-completion.js";
import { VerifierBallots } from "../../src/verifier-ballots.js";
import { WorkCompletion } from "../../src/work-completion.js";
import { executionFor, repositoryView } from "../../src/repository-context.js";
import { nextReviewPlace, pendingReviewPlaces, rememberReviewProfile } from "../../src/review-members.js";
import type { ReviewReport } from "../../src/ports/review-reports.js";
import { admissionFixture } from "./agent-workflow.js";
import { report } from "./review-reports.js";

/** Accepted normalized replies; production dispatch, answer application, ballots and round completion own the transitions. */
export function findingRepairFixture(kind: "new-reports" | "confirmation") {
  const f = admissionFixture(2, 2, 1), task = f.task(f.ids[0]!)!, scope = executionFor(task);
  task.title = "Repair the greeting"; task.stageIndex = 0; task.approveDelivery = false;
  task.plan = { rationale: "Findings across actual repair dispatches", plannerProfileId: "sol-high", stages: [
    { id: "build", title: "Build", kind: "do", roleId: "builder", profileIds: ["sol-high"] },
    { id: "review", title: "Review", kind: "review-chain", roleId: "code-reviewer", profileIds: ["opus-high", "sol-high"], maxRounds: kind === "new-reports" ? 3 : 2 },
    { id: "delivery", title: "Delivery", kind: "gate", gate: "delivery", roleId: "coordinator", profileIds: [] },
  ] };
  scope.work.delivery = "local";
  const now = () => ++f.clock.at;
  const notes: string[] = [], builderDispatches: { round: number; findings: Finding[] }[] = [];
  const reviewInputs: { findings: Finding[]; report: ReviewReport; error: string | undefined }[] = [];
  let sequence = 0;
  const catalog = { roles: () => f.state.roles, profile: (id: string) => f.catalog.profile(id) };
  const reports = new ReviewReports({
    roles: catalog.roles, hasPendingReviewers: (current, stage) => pendingReviewPlaces(current, stage, catalog).length > 0,
    id: () => `repair-finding-${++sequence}`, now, verdict() {}, note(_task, _tone, text) { notes.push(text); },
  });
  const ballots = new VerifierBallots({
    profile: catalog.profile, profileName: id => id, toolName: id => id,
    roleResult: (id, current) => roleForTask(f.state.roles, id, current)?.result,
  }, {
    candidates: () => ["opus-high", "sol-high"],
    resolve(_task, id) { const profile = catalog.profile(id); if (!profile) throw new Error(`Unknown supplied voter ${id}`); return { kind: "selected", profile }; },
    admissionsClosed: current => f.host.admissionsClosed(current),
  }, { checkpoint: current => f.host.checkpoint(current), changed: () => f.host.changed(),
    note(_task, _tone, text) { notes.push(text); }, now });
  const rounds = new ReviewRoundCompletion({
    roles: catalog.roles, role: (id, current) => f.catalog.role(id, current), incrementalReview: () => true,
    // This state-only composition has no native source observation or worktree.
    ownChanges: async () => ({}), anchor: async () => { throw new Error("Unexpected native review anchor"); },
    reviewEnd() {}, releaseInput() {}, note(_task, _tone, text) { notes.push(text); },
    changed: () => f.host.changed(), commitNow: current => f.host.checkpoint(current), now,
    openDeliveryDecision: current => f.host.gate(current, "delivery"),
  });
  const completion = new WorkCompletion({
    finishStep: bound => f.groupHost.finishStep(bound.task), endStage() {}, rerun: () => false,
    invalidateAcceptance: async () => { throw new Error("Unexpected shared acceptance mutation"); },
    checkpoint: () => f.host.checkpoint(task), changed: () => f.host.changed(),
  });
  function start(roleId: string, stage: Stage, signal: AbortSignal) {
    const profile = catalog.profile(task.agent!.profileId)!;
    const request = { task, profile, roleId, step: stepKey(task) };
    f.workflow.qualify(request, signal);
    task.stepClock = startClock(repositoryView(scope), roleId, now());
    f.workflow.activate(request);
    return beginAgentStep(task, roleId, profile.id, now(), f.state.roles, stage.kind === "review-chain" ? stage.profileIds : undefined, scope.work);
  }
  function suppliedReview(round: number, key: string, input: readonly Finding[]): ReviewReport {
    if (round === 1 || kind === "new-reports") return report({ verdict: "fail", findings: [{
      text: key === "0" && round === 1 ? "The greeting is missing on the welcome page." : "The GREETING is missing on the welcome page!",
      severity: "important", ...(round === 1 ? { evidence: "Opened the welcome page" } : {}),
    }] });
    return report({ verdict: "fail", confirms: input.map(finding => finding.id),
      confirmationEvidence: Object.fromEntries(input.map(finding => [finding.id, "On current code, the guest welcome page still omits the greeting; the signed-in control shows it."])) });
  }
  f.phases.prepareWorkspace = async current => ({ kind: "ready", scope: executionFor(current) });
  f.phases.nextReviewer = (current, stage) => nextReviewPlace(current, stage, {
    ...catalog, pendingVoter: () => ballots.next(current, stage)?.voters[0],
  });
  f.phases.doStage = async (bound, stage, signal) => {
    if (f.catalog.role(stage.roleId, task)?.result !== "build") throw new Error("Unexpected do-stage in the finding fixture");
    const given = task.fixing ? builderFindings(task, bound.work.productId) : [];
    builderDispatches.push({ round: task.rounds.review ?? 1, findings: structuredClone(given) });
    start(stage.roleId, stage, signal);
    if (task.fixing) recordBuilderFindingAnswers(task, given, given.map(finding => ({ id: finding.id, fixed: true, text: "The supplied Builder report claims the greeting is fixed." })),
      { productId: bound.work.productId, shared: !!task.repositories, at: now() });
    endAgentStep(task, { outcome: "Accepted Builder report", reason: "The supplied normalized reply is ready for completion" }, now());
    return completion.complete(bound, { stageId: stage.id, canEdit: true });
  };
  f.phases.review = async (_current, stage, signal) => {
    const round = task.rounds[stage.id] ?? 1;
    // The review adapter supplies the round input. No Git/version/check proof is synthesized.
    if (task.hunt?.stageId !== stage.id || task.hunt.round !== round) {
      task.hunt = { stageId: stage.id, round, reported: {}, findings: task.findings.length,
        input: { file: `scripted:review-${round}`, digest: `supplied-review-${round}`, heads: {} } };
      return "continue";
    }
    const input = structuredClone(task.findings);
    const step = start(stage.roleId, stage, signal);
    for (const { key, profileId } of pendingReviewPlaces(task, stage, catalog)) {
      const reply = suppliedReview(round, key, input), error = checkReviewEvidence(input, reply, task);
      reviewInputs.push({ findings: structuredClone(input), report: structuredClone(reply), error });
      if (error !== undefined) throw new Error(error);
      rememberReviewProfile(task, key, profileId);
      step.agentResults = [...(step.agentResults ?? []), { roleId: stage.roleId, profileId, at: now(), value: reply }];
      reports.apply(task, stage, reply, profileId, stage.roleId, key);
      task.hunt.reported[key] = true;
    }
    reports.settle(task, stage);
    const pending = ballots.next(task, stage);
    let outcome = findingCount(task.findings.filter(finding => finding.status === "open"));
    if (pending?.voters.length) {
      endAgentStep(task, { outcome, reason: "The accepted reports need independent ballot answers" }, now());
      beginAgentStep(task, "verifier", pending.voters[0]!, now(), f.state.roles, pending.voters, scope.work);
      for (const seat of pending.seats) ballots.recordAnswers(task, { place: seat, profileId: seat.profileId, plannedProfileId: seat.profileId, findingIds: seat.findingIds },
        seat.findingIds.map(id => ({ id, verdict: "real", reason: "The supplied normalized answer confirms the missing greeting." })));
      const completed = ballots.next(task, stage);
      if (!completed || completed.voters.length) throw new Error("The supplied real answers did not settle the actual panel");
      outcome = ballots.finish(task, completed);
    }
    delete task.hunt;
    return rounds.finish(task, stage, round, outcome);
  };
  return { task, notes, builderDispatches, reviewInputs, rounds, reports, ballots,
    async run() {
      f.state.pool.paused = false;
      f.workflow.startDriver(task.id);
      const running = f.ownership.settling.get(task.id);
      if (!running) throw new Error("The actual AgentWorkflow did not register its driver");
      await running;
      if (f.failures.length) throw f.failures.length === 1 ? f.failures[0] : new AggregateError(f.failures, "Finding repair dispatch failed");
      return task;
    }, close: () => f.close(),
  };
}
