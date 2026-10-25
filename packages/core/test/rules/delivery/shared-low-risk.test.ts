import { expect, it } from "vitest";
import { shipsUnasked } from "../../../src/delivery-policy.js";
import { stateFixture, taskFixture } from "../../fixtures/state.js";

function request() {
  const state = stateFixture();
  state.products.forEach(product => { product.shipLowRisk = true; });
  const task = taskFixture(state, { risk: { level: "low", why: "A small copy change" }, approveDelivery: false, acceptancePassed: true,
    repositories: state.products.map(product => ({ productId: product.id, delivery: "pull-request", completedStages: [], checks: { at: 1, current: true, results: [{ name: "Tests", command: "tests", ok: true, ms: 1, output: "Passed" }] } })),
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
  task.repositories![1]!.checks!.results = [{ name: "Tests", command: "tests", ok: false, ms: 1, output: "Failed" }];
  expect(allowed()).toBe(false);
  task.repositories![1]!.checks!.results[0]!.ok = true;
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
