import { expect, it } from "vitest";
import { configureProductCheckSetup } from "../../../src/products.js";
import { stateFixture, taskFixture } from "../../fixtures/state.js";

const requirement = { id: "compiler", name: "Compiler version", argv: ["compiler", "--version", ""] };

it("validates the whole declaration before ids, execution iteration or product mutation", () => {
  const state = stateFixture(), product = state.products[0]!, before = JSON.parse(JSON.stringify(product)), effects = { id() { throw new Error("No id should be allocated"); }, now() { throw new Error("No time should be requested"); } };
  const executions = { *[Symbol.iterator]() { throw new Error("No execution should be visited"); } };
  expect(() => configureProductCheckSetup(product, [requirement, { ...requirement, id: "second" }], executions, effects)).toThrow("unique, nonempty name");
  expect(product).toEqual(before);
  expect(() => configureProductCheckSetup(undefined, [{ ...requirement, argv: [] }], executions, effects)).toThrow("literal arguments");
  expect(() => configureProductCheckSetup(undefined, [], executions, effects)).toThrow("no longer in Petrina");
});

it("establishes an explicit empty declaration and leaves an identical declaration entirely alone", () => {
  const state = stateFixture(), product = state.products[0]!;
  let ids = 0, visited = 0;
  const effects = { id: (prefix: string) => `${prefix}-${++ids}`, now: () => 123 };
  const executions = { *[Symbol.iterator]() { visited++; } };
  expect(configureProductCheckSetup(product, [], executions, effects)).toBe(true);
  expect(product.checkSetup).toEqual({ revision: "shop-1", requirements: [] });
  expect(configureProductCheckSetup(product, [], executions, effects)).toBe(false);
  expect(ids).toBe(1); expect(visited).toBe(1);
});

it("invalidates only matching unpublished executions, preserving raw evidence and repair allowance", () => {
  const state = stateFixture(), product = state.products[0]!;
  const task = taskFixture(state, { checkReturns: 2, checks: { current: true, at: 42, results: [] }, approvedSha: "saved-approval", approvedPatch: "saved-patch", approvedFor: { by: "coordinator", mode: "local", destination: "shop/main" } });
  const other = taskFixture(state, { id: "other", productId: "billing", approvedSha: "other-approval" });
  const published = taskFixture(state, { id: "landed", landed: { branch: "main", sha: "already-recorded" }, approvedSha: "landed-approval" });
  const checks = task.checks, events: string[] = [];
  const effects = { id(prefix: string) { events.push(`id:${prefix}`); return `${prefix}-revision`; }, now() { events.push("now"); return 123; } };
  const executions = { *[Symbol.iterator]() { expect(product.checkSetup?.revision).toBe("shop-revision"); yield { taskId: task.id, work: task }; yield { taskId: other.id, work: other }; yield { taskId: published.id, work: published }; } };
  expect(configureProductCheckSetup(product, [{ ...requirement, name: " Compiler version " }], executions, effects)).toBe(true);
  expect(product.checkSetup).toEqual({ revision: "shop-revision", requirements: [requirement] });
  expect(task.checkSetupInvalidated).toEqual({ id: "task-revision", kind: "requirements-changed", at: 123, revision: "shop-revision" });
  expect(task.checks).toBe(checks); expect(task.checks?.current).toBe(false); expect(task.checkReturns).toBe(2);
  expect(task.checkSetup).toBeUndefined(); expect(task.approvedSha).toBeUndefined(); expect(task.approvedPatch).toBeUndefined(); expect(task.approvedFor).toBeUndefined();
  expect(other.approvedSha).toBe("other-approval"); expect(other.checkSetupInvalidated).toBeUndefined();
  expect(published.approvedSha).toBe("landed-approval"); expect(published.checkSetupInvalidated).toBeUndefined();
  expect(events).toEqual(["id:shop", "id:task", "now"]);
});

it("copies literal input arguments and treats order and labels as real changes", () => {
  const state = stateFixture(), product = state.products[0]!, input = { ...requirement, argv: [...requirement.argv] };
  let seq = 0; const effects = { id: () => `revision-${++seq}`, now: () => 0 };
  configureProductCheckSetup(product, [input], [], effects); input.argv[0] = "changed outside";
  expect(product.checkSetup?.requirements[0]?.argv).toEqual(requirement.argv);
  expect(configureProductCheckSetup(product, [{ ...requirement, name: "Another label" }], [], effects)).toBe(true);
  expect(seq).toBe(2);
});
