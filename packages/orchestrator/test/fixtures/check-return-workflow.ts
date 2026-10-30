import { assignedCheckFailures, finishTaskStep, type Finding } from "@petrina/core";
import { AcceptancePreflight } from "../../src/acceptance-preflight.js";
import { ReviewWorkflow } from "../../src/review-workflow.js";
import { WorkCompletion } from "../../src/work-completion.js";
import { executionFor } from "../../src/repository-context.js";
import { admissionFixture } from "./agent-workflow.js";
import { checkEvidence } from "./check-evidence.js";
import { buildCompletionFixture } from "./build-completion.js";

/** Real admission, check recording/reuse, repair, Builder completion and preflight owners. */
export async function checkReturnWorkflow(before: "acceptance" | "review", answer: { fixed: boolean; text: string }) {
  const f = admissionFixture(2, 2, 1), task = f.task(f.ids[0]!)!, scope = executionFor(task);
  task.title = "Repair the failed check"; task.approveDelivery = true;
  task.plan = { rationale: "A supplied built candidate awaiting its check boundary", plannerProfileId: "sol-high", stages: [
    { id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-high"] },
    ...(before === "acceptance" ? [{ id: "test", kind: "do" as const, title: "Test", roleId: "tester", profileIds: ["sol-high"] }] : []),
    { id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high"] },
    { id: "delivery", kind: "gate", gate: "delivery", title: "Delivery", roleId: "coordinator", profileIds: [] },
  ] };
  task.stageIndex = 1;
  const now = () => ++f.clock.at;
  const evidence = await checkEvidence(task, now), builds = buildCompletionFixture(task, now);
  await evidence.record([evidence.run(1)]);
  const checks = structuredClone(scope.work.checks!);
  const dispatches: string[] = [], assignments: Finding[][] = [], preflightCalls: string[] = [];
  const unexpected = (name: string): never => { throw new Error(`Unexpected check return effect: ${name}`); };
  const own = (current: typeof task) => { if (current !== task) unexpected("foreign task"); };
  const bound = (current: typeof scope) => { own(current.task); if (current.work !== scope.work) unexpected("foreign product"); };
  const blocked = (current: typeof task) => { own(current); f.host.gate(current, "delivery"); };
  const verification = async (current: typeof scope) => { bound(current); preflightCalls.push("verify"); return evidence.verify(); };
  const acceptance = new AcceptancePreflight({
    role: (id, current) => f.catalog.role(id, current), blocked,
    backToBuilder: (current, eligible) => evidence.repairs.backToBuilder(current, "before acceptance testing", eligible),
  }, {
    upToDate: async current => { bound(current); preflightCalls.push("source"); return "current"; },
    ensureChecks: async current => { bound(current); preflightCalls.push("definitions"); return [{ name: "Tests", argv: ["test-product"] }]; },
    failing: verification, preparationChanged: () => false,
  });
  const review = new ReviewWorkflow({
    now: builds.now, id: () => unexpected("review input"), checkpoint: () => unexpected("review checkpoint"), changed: () => unexpected("review preparation"),
    finishStep: () => unexpected("review completion"), clearStep: () => unexpected("review clear"), rerun: () => unexpected("review rerun"),
  }, {
    prepareChecks: async current => { bound(current); preflightCalls.push("prepare-review"); return true; }, checks: verification,
    preparationChanged: () => false, backToBuilder: (current, eligible) => evidence.repairs.backToBuilder(current, "before the review", eligible),
    blocked: current => { blocked(current); return "stop"; }, versions: async () => unexpected("review version"), input: async () => unexpected("review input"),
    pendingReviewers: () => unexpected("reviewer admission"), hunt: async () => unexpected("reviewer execution"), pendingVote: () => unexpected("verifier admission"),
    vote: async () => unexpected("verifier execution"), finishBallot: () => unexpected("ballot"), closeRound: async () => unexpected("review round"),
  });
  const completion = new WorkCompletion({ finishStep: current => finishTaskStep(current.task, current.work, builds.now()),
    endStage() {}, rerun: () => false, invalidateAcceptance: async () => unexpected("shared completion"), checkpoint: () => f.host.checkpoint(task), changed: () => f.host.changed() });
  f.phases.prepareWorkspace = async current => ({ kind: "ready", scope: executionFor(current) });
  f.phases.prepareAcceptance = (current, signal) => acceptance.run(current, signal);
  f.phases.review = (current, stage, signal) => { own(current); return review.run(current, stage, signal); };
  f.phases.doStage = async (current, stage) => {
    bound(current); dispatches.push(stage.roleId);
    if (f.catalog.role(stage.roleId, task)?.result !== "build") unexpected("acceptance participant");
    const checkFailures = assignedCheckFailures(current);
    const turn = builds.begin({ answers: task.findings.map(finding => ({ id: finding.id, ...answer })) },
      { stageId: stage.id, plannedProfileId: task.agent!.profileId, actualProfileId: task.agent!.profileId, startingTree: evidence.state.tree, checkFailures });
    assignments.push(structuredClone(turn.input.given));
    builds.saved(evidence.state.tree);
    if (checkFailures.length) builds.observe({ kind: "repairVersion", value: { sha: evidence.state.sha, tree: evidence.state.tree, definition: evidence.state.definition, commands: [...evidence.declaration.commands] } });
    await turn.run(); builds.consumed();
    return completion.complete(current, { stageId: stage.id, canEdit: true });
  };
  return { task, scope, checks, evidence, builds, dispatches, assignments, preflightCalls, state: f.state,
    async run() {
      f.state.pool.paused = false;
      f.workflow.startDriver(task.id);
      const running = f.ownership.settling.get(task.id);
      if (!running) throw new Error("The real admission driver did not own this operation");
      await running;
      if (f.failures.length) throw new AggregateError(f.failures, "Check return workflow failed");
      return task;
    }, close: () => f.close(),
  };
}
