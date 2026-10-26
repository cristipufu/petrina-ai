import { beginAgentStep, DEFAULT_PROFILES, endAgentStep, findingCount, openStep, roleForTask, WorkflowObserver, type Stage, type WorkflowEventDraft } from "@petrina/core";
import { ReviewReports } from "../../src/review-reports.js";
import { ReviewRoundCompletion } from "../../src/review-round-completion.js";
import { VerifierBallots } from "../../src/verifier-ballots.js";
import { pendingReviewPlaces, rememberReviewProfile } from "../../src/review-members.js";
import { executionFor } from "../../src/repository-context.js";
import type { ReviewReport } from "../../src/ports/review-reports.js";
import { acceptanceRepairFixture, GREETING } from "./acceptance-repair.js";

export const reviewReply = (findings: ReviewReport["findings"] = []): ReviewReport => ({
  verdict: findings.some(finding => finding.severity === "important") ? "fail" : "pass", findings,
  confirms: [], confirmationEvidence: {}, disputes: [], resolves: [],
});

/** Named calls to the real result/ballot/round owners, on the acceptance controller's canonical task. */
export function acceptanceReviewFixture(checklist: readonly string[] = [GREETING], gate = true) {
  const f = acceptanceRepairFixture(checklist, gate), { task, roles } = f;
  const [build, test, review, security] = task.plan!.stages;
  build!.profileIds = ["sol-high"]; test!.profileIds = ["opus-high"];
  review!.profileIds = ["sol-high", "opus-high"]; review!.maxRounds = 2;
  security!.profileIds = ["opus-high"]; security!.maxRounds = 2;
  for (const work of task.repositories!) work.delivery = "local";
  task.approveDelivery = false;
  const profile = (id: string) => DEFAULT_PROFILES.find(profile => profile.id === id);
  const catalog = { roles: () => roles, profile };
  const context = () => ({ roles, profiles: DEFAULT_PROFILES, inbox: [],
    products: [{ id: "a", name: "Product 1" }, { id: "b", name: "Product 2" }], now: f.now() });
  const observer = new WorkflowObserver(), events: WorkflowEventDraft[] = [];
  observer.baseline(task, context());
  const observe = () => { events.push(...observer.observe(task, context())); };
  const checkpoints: unknown[] = [];
  const reports = new ReviewReports({
    roles: catalog.roles, hasPendingReviewers: (current, stage) => pendingReviewPlaces(current, stage, catalog).length > 0,
    id: f.id, now: f.now, verdict() {}, note(_task, _tone, text) { f.notes.push(text); },
  });
  const ballots = new VerifierBallots({ profile, profileName: id => id, toolName: id => id,
    roleResult: (id, current) => roleForTask(roles, id, current)?.result,
  }, {
    // Explicit catalog availability: these cases test ballot/routing, never native quota or readiness.
    candidates: () => ["sol-high", "opus-high"],
    resolve(_task, id) { const selected = profile(id); if (!selected) throw new Error(`Unexpected verifier ${id}`); return { kind: "selected", profile: selected }; },
    admissionsClosed: () => false,
  }, { checkpoint(current) { checkpoints.push(structuredClone(current)); }, changed: observe,
    note(_task, _tone, text) { f.notes.push(text); }, now: f.now,
  });
  const rounds = new ReviewRoundCompletion({
    roles: catalog.roles, role: (id, current) => roleForTask(roles, id, current), incrementalReview: () => true,
    ownChanges: async current => { if (current !== task) throw new Error("Unexpected review owner"); return { a: "a-observed-task-change", b: "b-observed-task-change" }; },
    anchor: async () => { throw new Error("These controller cases have no native worktree"); },
    reviewEnd() {}, releaseInput() {}, note(_task, _tone, text) { f.notes.push(text); },
    changed: observe, commitNow: observe, now: f.now,
    openDeliveryDecision() { throw new Error("This case stops at the actual gate, before native Inbox creation"); },
  });
  function startReview() {
    const stage = task.plan!.stages[task.stageIndex]!;
    if (stage.kind !== "review-chain") throw new Error("No review stage is selected");
    const round = task.rounds[stage.id] ?? 1;
    task.hunt = { stageId: stage.id, round, reported: {}, findings: task.findings.length,
      input: { file: "scripted:review-material", digest: "opaque-review-observation", heads: {} } };
    const step = beginAgentStep(task, stage.roleId, stage.profileIds[0]!, f.now(), roles, stage.profileIds, executionFor(task).work);
    observe();
    return { stage, step };
  }
  function acceptReview(stage: Stage, key: string, reply: ReviewReport) {
    const place = pendingReviewPlaces(task, stage, catalog).find(place => place.key === key);
    if (!place) throw new Error(`No pending reviewer at ${key}`);
    rememberReviewProfile(task, key, place.profileId);
    const step = openStep(task);
    if (!step || step.stageId !== stage.id) throw new Error("No actual review step to receive this report");
    step.agentResults = [...(step.agentResults ?? []), { roleId: stage.roleId, profileId: place.profileId, at: f.now(), value: reply }];
    reports.apply(task, stage, reply, place.profileId, stage.roleId, key);
    task.hunt!.reported[key] = true;
    observe();
  }
  function settleReview(stage: Stage) { reports.settle(task, stage); observe(); }
  function verifyReal(stage: Stage) {
    const pending = ballots.next(task, stage);
    if (!pending?.voters.length) throw new Error("No Important finding is awaiting actual ballot answers");
    const before = openStep(task)!;
    endAgentStep(task, { outcome: findingCount(before.result?.findings ?? []), reason: "Important findings need independent answers" }, f.now());
    beginAgentStep(task, "verifier", pending.voters[0]!, f.now(), roles, pending.voters, executionFor(task).work);
    observe();
    for (const place of pending.seats) ballots.recordAnswers(task, { place, profileId: place.profileId, plannedProfileId: place.profileId, findingIds: place.findingIds },
      place.findingIds.map(id => ({ id, verdict: "real", reason: "The supplied normalized verifier report reproduced the missing greeting." })));
    const remaining = ballots.next(task, stage);
    if (!remaining || remaining.voters.length) throw new Error("The supplied real answers did not complete this ballot");
    const outcome = ballots.finish(task, remaining); observe(); return outcome;
  }
  async function finishReview(stage: Stage, outcome = findingCount((openStep(task)?.result?.findings ?? []).filter(finding => finding.status === "open"))) {
    if (pendingReviewPlaces(task, stage, catalog).length) throw new Error("A reviewer has not yet handed back");
    const round = task.rounds[stage.id] ?? 1;
    delete task.hunt;
    const next = await rounds.finish(task, stage, round, outcome);
    observe(); return next;
  }
  return { ...f, reports, ballots, rounds, events,
    get seats() { return task.journey!.filter(step => step.kind === "agent" && (step.stageId === review!.id || step.stageId === security!.id))
      .flatMap(step => (step.agentResults ?? []).filter(result => result.roleId === "code-reviewer" || result.roleId === "security-reviewer")
        .map(result => `${step.stageId}:${step.round}:${result.roleId}:${result.profileId}`)); },
    async report(...args: Parameters<typeof f.report>) { const result = await f.report(...args); observe(); return result; },
    async returned(...args: Parameters<typeof f.returned>) { await f.returned(...args); observe(); },
    startReview, acceptReview, settleReview, verifyReal, finishReview,
    finishedReviews: () => events.filter(event => event.kind === "review.finished"),
  };
}
