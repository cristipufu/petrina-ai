import { beginAgentStep, endAgentStep, recordBuilderFindingAnswers, type DeepMutable, type Finding, type Vote } from "@petrina/core";
import { ReviewReports } from "../../src/review-reports.js";
import { pendingReviewPlaces, rememberReviewProfile } from "../../src/review-members.js";
import type { ReviewReport } from "../../src/ports/review-reports.js";
import { reviewRoundsFixture } from "./review-rounds.js";

/** The actual report, ballot and round owners share one task. Replies are normalized observations, not ACP proof. */
export function acceptanceContinuationFixture() {
  const f = reviewRoundsFixture([]), { task, stage } = f;
  task.findings = [];
  const catalog = { roles: () => f.state.roles, profile: f.profile };
  let id = 0;
  const reports = new ReviewReports({ roles: catalog.roles,
    hasPendingReviewers: (current, currentStage) => pendingReviewPlaces(current, currentStage, catalog).length > 0,
    id: () => `continuation-${++id}`, now: f.now, verdict() {},
    note(_current, _tone, words) { f.notes.push(words); },
  });
  function start(round = 1) {
    task.stageIndex = 1; task.rounds[stage.id] = round;
    task.hunt = { stageId: stage.id, round, reported: {}, findings: task.findings.length,
      input: { file: "scripted:continuation", digest: `observed-review-${round}`, heads: { p: f.first }, trees: { p: f.tree } } };
    return beginAgentStep(task, stage.roleId, stage.profileIds[0]!, f.now(), f.state.roles, stage.profileIds, f.scope.work);
  }
  function report(key: string, value: ReviewReport) {
    const place = pendingReviewPlaces(task, stage, catalog).find(place => place.key === key);
    if (!place) throw new Error(`No actual pending review place ${key}`);
    rememberReviewProfile(task, key, place.profileId);
    const step = task.journey!.at(-1)!;
    step.agentResults = [...(step.agentResults ?? []), { roleId: stage.roleId, profileId: place.profileId, at: f.now(), value }];
    reports.apply(task, stage, value, place.profileId, stage.roleId, key);
    task.hunt!.reported[key] = true;
  }
  function settle() { reports.settle(task, stage); }
  function votes(verdict: Vote["verdict"]) {
    const accepted: { toolId: string; ids: string[] }[] = [];
    let pending = f.next();
    if (!pending?.voters.length) throw new Error("No actual ballot needs answers");
    endAgentStep(task, { outcome: "Accepted normalized review reports", reason: "The actual ballot requires independent answers" }, f.now());
    let phases = 0;
    while (pending.voters.length) {
      if (++phases > 3) throw new Error("The supplied answers did not settle a bounded ballot");
      f.voteStep(pending);
      for (const seat of pending.seats) {
        accepted.push({ toolId: seat.toolId, ids: [...seat.findingIds] });
        f.answer(seat, verdict);
      }
      const next = f.next();
      if (!next) throw new Error("An actual active ballot disappeared before completion");
      pending = next;
    }
    return { outcome: f.finish(pending), accepted };
  }
  function builderClaims(findings: readonly DeepMutable<Finding>[] = task.findings) {
    recordBuilderFindingAnswers(task, findings, findings.map(finding => ({ id: finding.id, fixed: true, text: "Fixed it." })), { productId: f.scope.work.productId, shared: false, at: f.now() });
  }
  return { ...f, reports, start, report, settle, votes, builderClaims };
}
