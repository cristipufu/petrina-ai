import { expect, it } from "vitest";
import { setupWork, setupExecutor } from "../../fixtures/check-setup.js";
import { completeCheckExecution } from "@petrina/test-support/check-execution-facts";
import { shipsUnasked } from "../../../src/delivery-policy.js";
import { stateFixture, taskFixture } from "../../fixtures/state.js";

function request() {
  const state = stateFixture();
  state.products.forEach(product => { product.shipLowRisk = true; });
  const task = taskFixture(state, { risk: { level: "low", why: "A small copy change" }, approveDelivery: false, acceptancePassed: true,
    repositories: state.products.map(product => ({ productId: product.id, delivery: "pull-request", completedStages: [], ...setupWork([{ name: "Tests", command: "tests", ok: true, execution: completeCheckExecution(0), executor: setupExecutor, ms: 1, output: "Passed" }]) })),
  });
  const allowed = () => shipsUnasked(task, { products: state.products, product: state.products[0], ...task.repositories![0]!, checks: task.repositories![0]!.checks });
  return { state, task, allowed };
}

for (const choice of [
  { name: "all owners opted in with combined acceptance", ask: false, optedIn: true, acceptance: true, expected: true },
  { name: "the task asks for approval", ask: true, optedIn: true, acceptance: true, expected: false },
  { name: "one owner did not opt in", ask: false, optedIn: false, acceptance: true, expected: false },
  { name: "combined acceptance did not run", ask: false, optedIn: true, acceptance: false, expected: false },
]) it(`decides shared delivery eligibility when ${choice.name}`, () => {
  const { state, task, allowed } = request();
  state.products[1]!.shipLowRisk = choice.optedIn;
  task.approveDelivery = choice.ask;
  task.acceptancePassed = choice.acceptance ? true : undefined;
  expect(allowed()).toBe(choice.expected);
});

it("requires a real pass from every shared owner, including owners absent from the current catalog", () => {
  const { state, task, allowed } = request();
  const work = task.repositories![1]!, baseline = work.checkSetup, original = work.checks!.results;
  work.checks!.results = [];
  // A real empty baseline still does not satisfy the existing shared opt-in policy.
  expect(allowed()).toBe(false);
  work.checks!.results = original;
  work.checkSetup = undefined;
  expect(allowed()).toBe(false);
  work.checkSetup = baseline;
  work.checks!.results = [{ ...original[0]!, ok: false, execution: completeCheckExecution(7), output: "Failed" }];
  expect(allowed()).toBe(false);
  task.repositories![1]!.checks!.results[0]!.ok = true;
  task.repositories![1]!.checks!.results[0]!.execution = completeCheckExecution(0);
  state.products.pop();
  expect(allowed()).toBe(false);
});

it("keeps the existing single-product opt-in independent of the shared task approval choice", () => {
  const { state, task } = request();
  delete task.repositories;
  task.approveDelivery = true;
  const allowed = () => shipsUnasked(task, { products: state.products, product: state.products[0], ...setupWork(), checks: setupWork().checks });
  expect(allowed()).toBe(true);
  task.acceptanceUnverified = true;
  expect(allowed()).toBe(false);
});

for (const shared of [false, true]) for (const proofDeliveryGate of [false, true]) it(`blocks ${shared ? "shared" : "single-product"} automatic delivery with incomplete evidence (proof gate: ${proofDeliveryGate})`, () => {
  const { state, task } = request();
  if (!shared) delete task.repositories;
  task.proofDeliveryGate = proofDeliveryGate ? "proof-decision" : undefined;
  const recorded = shared ? task.repositories![0]! : setupWork([{ name: "Tests", command: "tests", ok: true, execution: completeCheckExecution(0), executor: setupExecutor, ms: 1, output: "Passed" }]);
  const checks = recorded.checks!;
  const allowed = () => shipsUnasked(task, { products: state.products, product: state.products[0], ...recorded, checks });
  expect(allowed()).toBe(true);
  const original = checks.results[0]!;
  checks.results = [{ ...original, execution: undefined }];
  expect(allowed()).toBe(false);
  expect(checks.results[0]!.ok).toBe(true);
  checks.results = [{ ...original, execution: { ...completeCheckExecution(0), stderr: "incomplete" } }];
  expect(allowed()).toBe(false);
  checks.results = [original];
  if (shared) {
    task.repositories![1]!.checks!.results[0]!.execution = undefined;
    expect(allowed()).toBe(false);
  }
});


it("requires fresh shared authority only for unfinished owners even when the selected published owner becomes stale", () => {
  const { task, allowed } = request();
  const published = task.repositories![0]!, unfinished = task.repositories![1]!;
  published.landed = { branch: "main", sha: "already-published" };
  published.checks!.current = false;
  const history = JSON.stringify(published);
  expect(allowed()).toBe(true);
  expect(JSON.stringify(published)).toBe(history);
  unfinished.checks!.current = false;
  expect(allowed()).toBe(false);
  unfinished.checks!.current = true;
  unfinished.checks!.results = [];
  expect(allowed()).toBe(false);
});


it("keeps the original added-proof gate exception for a bound empty batch without weakening ordinary shared opt-in", () => {
  const { task, allowed } = request();
  for (const work of task.repositories!) work.checks!.results = [];
  expect(allowed()).toBe(false);
  task.proofDeliveryGate = "required-proof-decision";
  expect(allowed()).toBe(true);
  task.repositories![1]!.checkSetup = undefined;
  expect(allowed()).toBe(false);
});
