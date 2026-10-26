import { expect, it } from "vitest";
import { Simulator } from "../../../src/sim.js";
import { checkSetupOutcome, recordedCheckBatch, sameCheckExecutorFacts } from "../../../src/check-environment.js";
import { stateFixture, taskFixture } from "../../fixtures/state.js";
import { simVersions } from "../../../src/sim-script.js";
import { setupAttempt } from "../../fixtures/check-setup.js";

const requirement = { id: "compiler", name: "Compiler version", argv: ["compiler", "--version"] };

it("really saves setup in the Simulator without inventing an observation", () => {
  const state = stateFixture(); state.tasks.push(taskFixture(state, { checkReturns: 2 }));
  const sim = new Simulator(state);
  sim.setProductCheckSetup("shop", [requirement]);
  const saved = sim.getState(), task = saved.tasks[0]!;
  expect(saved.products[0]?.checkSetup?.requirements).toEqual([requirement]);
  expect(saved.products[0]?.checkSetup?.revision).toBeTruthy();
  expect(task.checkSetupInvalidated?.kind).toBe("requirements-changed");
  expect(task.checkSetup).toBeUndefined(); expect(task.checkReturns).toBe(2);
  expect(checkSetupOutcome(task.checkSetup).kind).toBe("unobserved");
  expect(task.journey?.some(step => step.checkSetups?.length)).not.toBe(true);
});

it("updates shared unpublished work while retaining historical observations and other companions", () => {
  const state = stateFixture(), observed = setupAttempt();
  const task = taskFixture(state, { repositories: [
    { productId: "shop", delivery: "local", completedStages: [], checkSetup: observed, checkReturns: 1, approvedSha: "old approval" },
    { productId: "billing", delivery: "local", completedStages: [], approvedSha: "companion approval" },
  ] }); state.tasks.push(task);
  const sim = new Simulator(state); sim.setProductCheckSetup("shop", [requirement]);
  const [shop, billing] = sim.getState().tasks[0]!.repositories!;
  expect(shop!.checkSetup).toEqual(observed); expect(shop!.checkSetupInvalidated?.kind).toBe("requirements-changed");
  expect(shop!.approvedSha).toBeUndefined(); expect(shop!.checkReturns).toBe(1);
  expect(billing!.approvedSha).toBe("companion approval"); expect(billing!.checkSetupInvalidated).toBeUndefined();
});

it("rejects invalid saves atomically and allocates nothing for a no-op", () => {
  const sim = new Simulator(stateFixture()); sim.setProductCheckSetup("shop", [requirement]);
  const before = sim.getState(); sim.setProductCheckSetup("shop", [requirement]); expect(sim.getState()).toEqual(before);
  expect(() => sim.setProductCheckSetup("shop", [{ ...requirement, name: "" }])).toThrow();
  expect(sim.getState()).toEqual(before);
});

function checkRunSimulator() {
  const state = stateFixture({ pool: { limit: 1, paused: false, toolCaps: {} } });
  state.tasks.push(taskFixture(state, { state: "waiting", column: "reviewing", stageIndex: 0, checkReturns: 2,
    plan: { rationale: "", plannerProfileId: "sol-high", stages: [
      { id: "test", kind: "do", title: "Test", roleId: "tester", profileIds: ["sol-high"] },
      { id: "delivery", kind: "gate", title: "Delivery check", roleId: "release-manager", profileIds: [], gate: "delivery" },
    ] } }));
  return new Simulator(state);
}

it("records complete explicitly simulated setup only when the demo actually runs its checks", () => {
  const sim = checkRunSimulator();
  expect(sim.getState().tasks[0]!.checkSetup).toBeUndefined();
  sim.tick();
  const task = sim.getState().tasks[0]!, observations = task.journey!.find(step => step.work === "checks")!.checkSetups!;
  expect(recordedCheckBatch(task).kind).toBe("passed");
  expect(observations.map(attempt => attempt.position)).toEqual(["before-checks", "after-checks"]);
  expect(observations[0]!.id).not.toBe(observations[1]!.id);
  expect(task.checkSetup).toEqual(observations[1]);
  expect(task.checkSetup!.requirements).toEqual([]);
  expect(task.checkSetup!.identity!.prerequisites).toEqual({ kind: "none" });
  expect(task.checks!.tree).toBe(simVersions(task)[task.productId]);
  expect(task.checks!.environment!.setupAttempts).toEqual({ before: observations[0]!.id, after: observations[1]!.id });
  expect(task.checkSetup!.executor).toEqual({ version: 1, adapter: "offline-demo-simulation", contract: 1, launchPolicy: 1,
    platform: "simulated", architecture: "simulated", osRelease: "simulated", runtime: { name: "simulated", version: "1" } });
  expect(sameCheckExecutorFacts(task.checkSetup!.executor, { ...task.checkSetup!.executor!, adapter: "local-product-checks" })).toBe(false);
  expect(task.checks!.results.every(run => sameCheckExecutorFacts(run.executor, task.checkSetup!.executor))).toBe(true);
});

it("models configured demo requirements with empty output, while saving and later editing remain unverified", () => {
  const sim = checkRunSimulator(); sim.setProductCheckSetup("shop", [requirement]);
  const before = sim.getState().tasks[0]!;
  expect(before.checkSetup).toBeUndefined(); expect(before.checkSetupInvalidated!.kind).toBe("requirements-changed");
  sim.tick();
  const task = sim.getState().tasks[0]!, attempt = task.checkSetup!;
  expect(recordedCheckBatch(task).kind).toBe("passed");
  expect(attempt.requirements).toEqual([requirement]);
  expect(attempt.input.invalidationId).toBe(before.checkSetupInvalidated!.id);
  expect(attempt.identity!.prerequisites.kind).toBe("declared");
  expect(attempt.results[0]!.run.command).toBe("compiler --version");
  expect(attempt.results[0]!.run.output).toBe("");
  expect(attempt.results[0]!.run.outputIdentity).toEqual({ stdout: { algorithm: "sha256", bytes: 0, digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
    stderr: { algorithm: "sha256", bytes: 0, digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" } });
  expect(task.checkSetupInvalidated).toBeUndefined();
  sim.setProductCheckSetup("shop", [{ ...requirement, argv: ["compiler", "--version", "new"] }]);
  const edited = sim.getState().tasks[0]!;
  expect(edited.checkSetup).toEqual(attempt);
  expect(recordedCheckBatch(edited).kind).toBe("blocked");
  expect(checkSetupOutcome(edited.checkSetup, undefined, edited.checkSetupInvalidated).kind).toBe("outdated");
  expect(edited.checkReturns).toBe(2);
});

it("keeps modeled build identities stable and distinct without upgrading historical missing setup", () => {
  const state = stateFixture(), task = taskFixture(state, { checks: { at: 1, current: true, results: [] } });
  state.tasks.push(task); const sim = new Simulator(state);
  expect(sim.getState().tasks[0]!.checkSetup).toBeUndefined();
  expect(recordedCheckBatch(sim.getState().tasks[0]!).kind).toBe("blocked");
  const initial = simVersions(task), built = simVersions(task, "build-one");
  expect(initial.shop).toMatch(/^[a-f0-9]{64}$/); expect(built.shop).toMatch(/^[a-f0-9]{64}$/);
  expect(built).not.toEqual(initial); expect(simVersions(task, "build-one")).toEqual(built);
  expect(simVersions({ ...task, id: "other-task" })).not.toEqual(initial);
  const recorded = { ...task, journey: [{ id: "build-one", kind: "agent" as const, round: 1, sub: 0, startedAt: 1, buildVersions: built }] };
  expect(simVersions(recorded)).toEqual(built);
  const old = { ...recorded, journey: [{ ...recorded.journey[0]!, buildVersions: { shop: "demo:old:shop:build" } }] };
  expect(simVersions(old).shop).toMatch(/^[a-f0-9]{64}$/); expect(simVersions(JSON.parse(JSON.stringify(old)))).toEqual(simVersions(old));
});
