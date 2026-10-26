import { expect, it } from "vitest";
import { deliveryCheckProblem, deliveryDecisionProblem, checkDecisionLabel } from "../../../src/check-evidence.js";
import { recordedCheckBatch } from "../../../src/check-environment.js";
import { beginPetrinaStep, endPetrinaStep, beginYouStep } from "../../../src/journey.js";
import { decisionEvidence } from "../../../src/check-evidence.js";
import type { Task, TaskRepository } from "../../../src/model.js";
import type { DeepMutable } from "../../../src/flow.js";
import { setupRun, setupWork, setupAttempt, setupRequirement } from "../../fixtures/check-setup.js";
import { stateFixture, taskFixture } from "../../fixtures/state.js";

/** Explicit modeled native observations for pure decision rules; no live checks are claimed. */
function ready(shared = false) {
  const state = stateFixture(), task = taskFixture(state);
  const works = (shared ? state.products : state.products.slice(0, 1)).map((product, index) => {
    const work: DeepMutable<TaskRepository> = { productId: product.id, delivery: "local", completedStages: [], ...setupWork([setupRun()]) };
    work.checkSetup!.productId = product.id;
    const node = beginPetrinaStep(task, "checks", index + 1, work), attemptId = `actual-modeled-attempt-${index}`;
    const run = work.checks!.results[0]!;
    run.source = { stepId: node.id, attemptId, checkId: `check-${index}` };
    work.checks!.provenance = { nodeId: node.id, attemptId };
    node.checkAttempts = [{ id: attemptId, productId: product.id, sha: work.checks!.sha, tree: work.checks!.tree,
      definition: work.checks!.definition!, commands: [run.command], passed: true, environment: JSON.parse(JSON.stringify(work.checks!.environment!)) }];
    node.productChecks = [{ id: run.source.checkId, attemptId, productId: product.id, name: run.name, result: "pass", run: JSON.parse(JSON.stringify(run)) }];
    endPetrinaStep(task, { outcome: "The check passes", reason: "checks passed" }, index + 2);
    work.checkedSha = work.checks!.sha; work.checkedPatch = "the-displayed-patch";
    return work;
  });
  if (shared) task.repositories = works;
  else Object.assign(task, works[0]);
  const decision = beginYouStep(task, "delivery", 5);
  decision.productChecks = decisionEvidence(task);
  return { task, works: shared ? task.repositories! : [task] };
}

for (const shared of [false, true]) it(`keeps coordinator intent separate from outdated current proof (${shared ? "shared" : "single"})`, () => {
  const { task, works } = ready(shared);
  for (const work of works) work.checks!.current = false;
  const before = JSON.stringify(task);
  expect(deliveryCheckProblem(task)).toBe("unverified");
  expect(deliveryDecisionProblem(task)).toBeUndefined();
  expect(checkDecisionLabel(task)).toBeUndefined();
  expect(works.map(work => recordedCheckBatch(work).kind)).toEqual(shared ? ["blocked", "blocked"] : ["blocked"]);
  expect(JSON.stringify(task)).toBe(before);
});

it.each([
  ["missing ready version", (task: DeepMutable<Task>) => { delete task.checkedSha; }],
  ["unrelated ready version", (task: DeepMutable<Task>) => { task.checkedSha = "9".repeat(40); }],
  ["missing ready patch", (task: DeepMutable<Task>) => { delete task.checkedPatch; }],
  ["missing provenance", (task: DeepMutable<Task>) => { delete task.checks!.provenance; }],
  ["unknown producer", (task: DeepMutable<Task>) => { task.checks!.provenance!.nodeId = "another-producer"; }],
  ["unperformed passing attempt", (task: DeepMutable<Task>) => { delete task.journey![0]!.checkAttempts![0]!.passed; }],
  ["different attempt environment", (task: DeepMutable<Task>) => { task.journey![0]!.checkAttempts![0]!.environment!.executor = "e".repeat(64); }],
  ["missing decision snapshot", (task: DeepMutable<Task>) => { delete task.journey!.at(-1)!.productChecks; }],
  ["different displayed producer", (task: DeepMutable<Task>) => { const entry = task.journey!.at(-1)!.productChecks![0]!; entry.run = { ...entry.run!, source: { ...entry.run!.source!, stepId: "other-source" } }; }],
  ["closed earlier decision", (task: DeepMutable<Task>) => { task.journey!.at(-1)!.endedAt = 6; }],
  ["missing definition", (task: DeepMutable<Task>) => { delete task.checks!.definition; }],
  ["missing native observations", (task: DeepMutable<Task>) => { delete task.checks!.results[0]!.execution; }],
  ["unknown output cleanup", (task: DeepMutable<Task>) => { task.checks!.results[0]!.execution!.outputCleanup = "unconfirmed"; }],
  ["missing binding", (task: DeepMutable<Task>) => { delete task.checks!.environment; }],
  ["running latest setup", (task: DeepMutable<Task>) => { task.checkSetup!.lifecycle = "running"; }],
  ["unmet latest setup", (task: DeepMutable<Task>) => { task.checkSetup = JSON.parse(JSON.stringify({ ...setupAttempt([setupRequirement]), results: [{ requirementId: setupRequirement.id, run: setupRun(7) }] })); }],
  ["explicit new setup intent", (task: DeepMutable<Task>) => { task.checkSetupInvalidated = { id: "new-rerun", kind: "explicit-rerun", at: 8 }; }],
] as const)("does not let %s turn prior intent into unverified approval", (_name, change) => {
  const { task } = ready(); task.checks!.current = false; change(task);
  const before = JSON.stringify(task);
  expect(deliveryDecisionProblem(task)).toBeDefined();
  expect(recordedCheckBatch(task).kind).toBe("blocked");
  expect(JSON.stringify(task)).toBe(before);
});

it("does not grant a stale peer intent from a different product's passed decision", () => {
  const { task, works } = ready(true);
  for (const work of works) work.checks!.current = false;
  task.journey!.at(-1)!.productChecks = task.journey!.at(-1)!.productChecks!.filter(check => check.productId === works[0]!.productId);
  expect(deliveryDecisionProblem(task)).toBe("unverified");
});

it("keeps intent for the actually observed same-tree squash without granting current proof", () => {
  const { task } = ready(); task.checks!.current = false;
  task.checkSetup!.input.sha = "4".repeat(40);
  task.checkSetup!.afterInput!.sha = "4".repeat(40);
  task.checkedSha = "4".repeat(40);
  const before = JSON.stringify(task);
  expect(deliveryDecisionProblem(task)).toBeUndefined();
  expect(deliveryCheckProblem(task)).toBe("unverified");
  expect(recordedCheckBatch(task).kind).toBe("blocked");
  expect(JSON.stringify(task)).toBe(before);
});
