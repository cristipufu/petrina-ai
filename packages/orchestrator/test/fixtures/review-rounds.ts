import { beginAgentStep, type DeepMutable, type Finding, type Stage, type Vote, type VerifierSeat } from "@petrina/core";
import { ReviewRoundCompletion } from "../../src/review-round-completion.js";
import type { ReviewRoundCompletionHost } from "../../src/ports/review-round.js";
import type { PendingVerification } from "../../src/index.js";
import { reviewSelectionFixture } from "./review-selection.js";

/** Actual selection, ballot and round owners; supplied code identities are observations, never fake Git results. */
export function reviewRoundsFixture(limited = ["claude-code"], antigravity = false) {
  const f = reviewSelectionFixture(["opus-high", "sol-high", "grok-high", "argon-high"], ["greeting"]);
  f.stage.profileIds = ["opus-high", "sol-high"];
  f.task.plan = { rationale: "A completed code review and its ballot", plannerProfileId: "sol-high", stages: [
    { id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
    { ...f.stage, maxRounds: 2 },
    { id: "delivery", kind: "gate", gate: "delivery", title: "Delivery", roleId: "coordinator", profileIds: [] },
    { id: "ship", kind: "do", title: "Ship", roleId: "release-manager", profileIds: ["opus-high"] },
  ] };
  const stage: DeepMutable<Stage> = f.task.plan.stages[1]!;
  f.task.stageIndex = 1; f.task.state = "running";
  f.task.hunt = { stageId: stage.id, round: 1, reported: { "0": true, "1": true }, profiles: { "0": "opus-high", "1": "sol-high" }, findings: 0,
    input: { file: "owned-input", digest: "captured-review", heads: { p: f.first }, trees: { p: f.tree } } };
  const finding = f.task.findings[0]!;
  finding.text = "The greeting is missing on the welcome page."; finding.raisedBy = "opus-high";
  finding.evidence = "Opened the welcome page";
  f.state.pool.limit = 3;
  for (const tool of f.state.tools) f.state.pool.toolCaps[tool.id] = 1;
  if (!antigravity) {
    f.state.setup!.checks.find(check => check.id === "antigravity")!.status = "logged-out";
  }
  f.limit(...limited);
  const decisions: string[] = [], ended: string[] = [];
  const host: ReviewRoundCompletionHost = {
    roles: () => f.state.roles, role: (id, task) => f.host.role(id, task),
    incrementalReview: () => true,
    async ownChanges(task) { if (task !== f.task) throw new Error("Unexpected review owner"); return { p: "captured-task-patch" }; },
    async anchor() { throw new Error("These policy cases have no native worktree to inspect"); },
    reviewEnd(task, _round, result) { if (task !== f.task) throw new Error("Unexpected review owner"); ended.push(result); },
    releaseInput(task) { if (task !== f.task) throw new Error("Unexpected review owner"); },
    note(task, _tone, text) { if (task !== f.task) throw new Error("Unexpected review owner"); f.notes.push(text); },
    changed(task) { f.checkpoints.push(structuredClone(task)); },
    commitNow(task) { f.checkpoints.push(structuredClone(task)); },
    openDeliveryDecision(task) { decisions.push(task.id); }, now: f.now,
  };
  const rounds = new ReviewRoundCompletion(host);
  function voteStep(pending: PendingVerification) {
    return beginAgentStep(f.task, "verifier", pending.voters[0]!, f.now(), f.state.roles, pending.voters, f.scope.work);
  }
  function answer(seat: VerifierSeat, verdict: Vote["verdict"], ids = seat.findingIds, reason = verdict === "not-a-bug" ? "The welcome page shows the greeting already." : "The welcome page has no greeting: confirmed by opening it.") {
    f.ballots.recordAnswers(f.task, { profileId: seat.profileId, plannedProfileId: seat.profileId, place: seat, findingIds: ids }, ids.map(id => ({ id, verdict, reason })));
  }
  function addFinding(id: string, raisedBy = "opus-high"): DeepMutable<Finding> {
    const value: DeepMutable<Finding> = { id, text: "The second greeting is missing.", severity: "blocking", raisedBy, confirmedBy: [], status: "open", evidence: "Opened the second page" };
    f.task.findings.push(value); return value;
  }
  return { ...f, stage, finding, host, rounds, decisions, ended, voteStep, answer, addFinding,
    next: () => f.ballots.next(f.task, stage),
    finish: (pending: PendingVerification) => f.ballots.finish(f.task, pending),
    close: (outcome: string, round = 1) => rounds.finish(f.task, stage, round, outcome),
  };
}
