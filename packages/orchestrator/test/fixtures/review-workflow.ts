import { beginAgentStep, checkReviewEvidence, clearTaskStep, finishTaskStep, reviewerAt } from "@petrina/core";
import { ReviewWorkflow } from "../../src/review-workflow.js";
import { ReviewReports } from "../../src/review-reports.js";
import { pendingReviewPlaces } from "../../src/review-members.js";
import { executionFor } from "../../src/repository-context.js";
import type { PreparedReviewInput, ReviewWorkflowEffects } from "../../src/ports/review-workflow.js";
import type { ReviewReport } from "../../src/ports/review-reports.js";
import { reviewRoundsFixture } from "./review-rounds.js";

type Observation =
  | { kind: "prepare"; productId: string; value: boolean }
  | { kind: "checks"; productId: string; value: Awaited<ReturnType<ReviewWorkflowEffects["checks"]>> | Error }
  | { kind: "versions"; value: Record<string, string> }
  | { kind: "input"; productId: string; value: PreparedReviewInput; before?: () => void };
export class PreparationChanged extends Error {}

/** Actual phase/report/ballot/round owners; preflight observations are consumed once in declared order. */
export function reviewWorkflowFixture() {
  const f = reviewRoundsFixture(), { task, scope, stage } = f;
  const observations: Observation[] = [], calls: string[] = [], returned: string[][] = [];
  const controller = new AbortController();
  let sequence = 0, returnToBuilder = false;
  let onReview: ((keys: readonly string[]) => Promise<void>) | undefined;
  const bound = (current: typeof task) => { if (current !== task) throw new Error("Unexpected review owner"); };
  function take<K extends Observation["kind"]>(kind: K, productId?: string): Extract<Observation, { kind: K }> {
    const next = observations.shift(); calls.push(`${kind}${productId ? ":" + productId : ""}`);
    if (!next || next.kind !== kind || ("productId" in next && next.productId !== productId)) throw new Error(`Unexpected ${kind} observation for ${productId}; next ${JSON.stringify(next)}`);
    return next as Extract<Observation, { kind: K }>;
  }
  const catalog = { roles: () => f.state.roles, profile: f.profile };
  const reports = new ReviewReports({
    roles: catalog.roles, hasPendingReviewers: (current, at) => pendingReviewPlaces(current, at, catalog).length > 0,
    id: current => { bound(current); return `finding-${++sequence}`; }, now: f.now,
    verdict: current => bound(current), note: (current, _tone, text) => { bound(current); f.notes.push(text); },
  });
  const workflow = new ReviewWorkflow({
    now: f.now, id: current => { bound(current); return `review-${++sequence}`; },
    checkpoint: current => { bound(current); calls.push("checkpoint"); f.checkpoints.push(structuredClone(current)); },
    changed: current => { bound(current); calls.push("changed"); },
    finishStep: current => { bound(current); calls.push("finish-step"); finishTaskStep(current, executionFor(current).work, f.now()); },
    clearStep: current => { bound(current); calls.push("clear-step"); clearTaskStep(current, executionFor(current).work); },
    rerun: current => { bound(current); calls.push("rerun"); },
  }, {
    prepareChecks: async current => { bound(current.task); return take("prepare", current.work.productId).value; },
    checks: async current => { bound(current.task); const value = take("checks", current.work.productId).value; if (value instanceof Error) throw value; return value; },
    preparationChanged: error => error instanceof PreparationChanged,
    backToBuilder: (current, products) => { bound(current.task); returned.push([...products]); return returnToBuilder; },
    blocked: current => { bound(current); calls.push("blocked"); return "stop"; },
    versions: async current => { bound(current); return take("versions").value; },
    input: async current => { bound(current.task); const next = take("input", current.work.productId); next.before?.(); return next.value; },
    pendingReviewers: (current, at) => { bound(current); return pendingReviewPlaces(current, at, catalog); },
    hunt: async (current, _stage, reviewers) => {
      bound(current); calls.push("reviewers:" + reviewers.map(place => place.key).join(","));
      if (!onReview) throw new Error("No reviewer response was declared");
      await onReview(reviewers.map(place => place.key));
    },
    pendingVote: (current, at) => { bound(current); reports.settle(current, at); return f.ballots.next(current, at); },
    vote: async () => { throw new Error("Use the composed verifier admission fixture for real voter phases"); },
    finishBallot: (current, pending) => { bound(current); return f.ballots.finish(current, pending); },
    closeRound: (...args) => f.rounds.finish(...args),
  });
  return { ...f, reports, workflow, observations, calls, returned, controller,
    run: () => workflow.run(task, stage, controller.signal),
    onReview: (response: NonNullable<typeof onReview>) => { onReview = response; },
    returnsToBuilder: () => { returnToBuilder = true; },
    prepare() {
      observations.push({ kind: "prepare", productId: scope.work.productId, value: true },
        { kind: "checks", productId: scope.work.productId, value: { kind: "passed", productId: scope.work.productId } });
      if (task.proofRequests?.length) observations.push({ kind: "versions", value: { [scope.work.productId]: f.tree } });
      observations.push({ kind: "input", productId: scope.work.productId, value: { file: "supplied-review-packet", digest: "supplied-review-digest", heads: { [scope.work.productId]: f.first }, trees: { [scope.work.productId]: f.tree } } });
    },
    report(key: string, value: ReviewReport) {
      const invalid = checkReviewEvidence(task.findings, value, task);
      if (invalid) return invalid;
      const profileId = stage.profileIds[Number(key)]!, roleId = reviewerAt(stage, Number(key));
      const step = beginAgentStep(task, roleId, profileId, f.now(), f.state.roles, stage.profileIds, scope.work);
      step.agentResults = [...(step.agentResults ?? []), { roleId, profileId, at: f.now(), value }];
      reports.apply(task, stage, value, profileId, roleId, key);
      task.hunt!.reported[key] = true;
    },
    assertConsumed() { if (observations.length) throw new Error(`Unconsumed review observations: ${JSON.stringify(observations)}`); },
  };
}
