import { expect, it } from "vitest";
import { completeCheckExecution } from "@petrina/test-support/check-execution-facts";
import type { CheckRun } from "../../../src/model.js";
import { shipsUnasked } from "../../../src/delivery-policy.js";
import { stateFixture, taskFixture } from "../../fixtures/state.js";

function request() {
  const state = stateFixture();
  state.products.forEach(product => { product.shipLowRisk = true; });
  const task = taskFixture(state, { risk: { level: "low", why: "A small copy change" }, approveDelivery: false, acceptancePassed: true,
    repositories: state.products.map(product => ({ productId: product.id, delivery: "pull-request", completedStages: [], checks: { at: 1, current: true, results: [{ name: "Tests", command: "tests", ok: true, execution: completeCheckExecution(0), ms: 1, output: "Passed" }] } })),
  });
  const allowed = () => shipsUnasked(task, { products: state.products, product: state.products[0], checks: task.repositories![0]!.checks });
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
  task.repositories![1]!.checks!.results = [];
  expect(allowed()).toBe(false);
  task.repositories![1]!.checks!.results = [{ name: "Tests", command: "tests", ok: false, execution: completeCheckExecution(7), ms: 1, output: "Failed" }];
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
  const allowed = () => shipsUnasked(task, { products: state.products, product: state.products[0], checks: undefined });
  expect(allowed()).toBe(true);
  task.acceptanceUnverified = true;
  expect(allowed()).toBe(false);
});

for (const shared of [false, true]) for (const proofDeliveryGate of [false, true]) it(`blocks ${shared ? "shared" : "single-product"} automatic delivery with incomplete evidence (proof gate: ${proofDeliveryGate})`, () => {
  const { state, task } = request();
  if (!shared) delete task.repositories;
  task.proofDeliveryGate = proofDeliveryGate ? "proof-decision" : undefined;
  const checks: { at: number; current: boolean; results: CheckRun[] } = { at: 1, current: true, results: [{ name: "Tests", command: "tests", ok: true, ms: 1, output: "Passed", execution: completeCheckExecution(0) }] };
  const allowed = () => shipsUnasked(task, { products: state.products, product: state.products[0], checks });
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
