import { expect, it } from "vitest";
import { BUILT_IN_ROLES, DEFAULT_PROFILES } from "@petrina/core";
import { scopesFor } from "../../../src/repository-context.js";
import { DeliveryObservationFailure } from "../../fixtures/delivery-workflow.js";
import { deliveryScenario } from "../../fixtures/delivery-scenarios.js";

it("stops after three new preparations when main keeps moving", async () => {
  const f = deliveryScenario(["shop"], "release"); f.approve();
  f.hooks.prepareAgain = (scope, why) => f.workflow.prepareAgain(scope, why);
  f.hooks.publish = async () => { throw new DeliveryObservationFailure("source-moved", "main moved on GitHub"); };
  for (let move = 1; move <= 3; move++) {
    expect(await f.run(f.task)).toBe("continue");
    expect(f.scope.work.shipping?.moves).toBe(move);
    expect(f.notes).toContain(`main moved on GitHub, so Petrina gets it ready again (${move} of 3)`);
  }
  await expect(f.run(f.task)).rejects.toThrow("main kept moving while Petrina was delivering, so it stopped after 3 new preparations");
  expect(f.events.filter(event => event.startsWith("prepare:"))).toHaveLength(4);
  expect(f.scope.work.shipping?.moves).toBe(0);
  expect(f.published).toEqual([]);
});

it("publishes nothing when the checks fail with the version set, goes back to the builder, and stops after the second time", async () => {
  const f = deliveryScenario(["shop"], "release"), { task, scope } = f;
  task.plan!.stages.unshift({ id: "build", title: "Build", kind: "do", roleId: "builder", profileIds: ["sol-high"] });
  for (let attempt = 1; attempt <= 2; attempt++) {
    task.stageIndex = 2; f.approve(); f.prepareObservation(scope);
    scope.work.shipping!.failures = attempt - 1;
    expect(await f.workflow.preparationFailed(scope, "Release checks failed", f.signal)).toBe(attempt === 1 ? "continue" : "stop");
    expect(scope.work.shipping).toEqual({ moves: 0, failures: attempt });
    expect(scope.work.approvedSha).toBeUndefined(); expect(task.stageIndex).toBe(0); expect(task.fixing).toBe(true);
    expect(task.findings).toHaveLength(attempt); expect(task.findings.every(item => item.status === "open" && item.severity === "blocking")).toBe(true);
    expect(f.published).toEqual([]);
  }
  expect(task.state).toBe("failed"); expect(task.error).toContain("failed 2 times");
  expect(f.restores).toEqual(["shop", "shop"]);
});

it("keeps shared approval and offers retry when release-version checks fail", async () => {
  const f = deliveryScenario(["shop", "api"], "release"), { task } = f;
  const [shop] = scopesFor(task); shop!.work.delivery = "pull-request"; shop!.work.source!.destination.mode = "pull-request"; shop!.work.source!.destination.kind = "new-pr";
  f.approve();
  const approval = task.repositories!.map(work => ({ sha: work.approvedSha, patch: work.approvedPatch, destination: { ...work.approvedFor! } }));
  let allowed = false;
  f.hooks.prepare = async bound => {
    f.prepareObservation(bound);
    if (bound.work.productId === "api" && !allowed) return f.workflow.preparationFailed(bound, "Release version checks failed", f.signal);
    return "ready";
  };
  expect(await f.run(task)).toBe("stop");
  expect(task.state).toBe("needs-you"); expect(task.error).toBeUndefined();
  expect(f.events.find(event => event.startsWith("gate:"))).toContain("api: getting the release ready failed");
  expect(f.events.find(event => event.startsWith("gate:"))).toContain("send it back with a note");
  expect(task.repositories!.map(work => ({ sha: work.approvedSha, patch: work.approvedPatch, destination: { ...work.approvedFor! } }))).toEqual(approval);
  expect(task.plan!.stages[task.stageIndex]!.gate).toBe("delivery");
  expect(task.repositories!.every(work => !work.shipping?.prepared)).toBe(true);
  expect(task.findings.filter(item => item.status === "open" && item.severity === "blocking")).toEqual([]);
  expect(task.repositories!.every(work => work.checkReturns === undefined)).toBe(true);
  expect(f.published).toEqual([]);
  expect(f.events.filter(event => event.startsWith("restored-checks:"))).toEqual(["restored-checks:delivery:api"]);
  allowed = true; task.stageIndex = 1; task.state = "running";
  expect(await f.run(task)).toBe("stop");
  expect(f.published.map(row => row.product)).toEqual(["shop", "api"]);
  expect(f.events.filter(event => event.startsWith("prepare:"))).toHaveLength(4);
});

for (const route of ["failed preparation", "shared needs-you", "shared paused", "shared failed", "delivery retry", "proof decision", "acceptance decision"] as const)
it(`pins the restored saved work after ${route}`, async () => {
  const f = deliveryScenario(route.startsWith("shared ") ? ["shop", "api"] : ["shop"], "release"), { task, scope } = f;
  task.plan!.stages.unshift({ id: "build", title: "Build", kind: "do", roleId: "builder", profileIds: ["sol-high"] }); task.stageIndex = 2;
  f.approve(); f.prepareObservation(scope);
  const saved = { commit: "scripted:accepted-work", tree: "scripted:accepted-tree" };
  scope.work.savedVersion = { ...saved };
  if (route.startsWith("shared ")) {
    const state = route.slice("shared ".length) as "needs-you" | "paused" | "failed";
    f.hooks.checkDelivery = async () => { task.state = state; if (state === "failed") throw new Error("Delivery stopped before publication"); return "stop"; };
    const result = await f.run(task).then(value => value, (error: Error) => error.message);
    expect(result).toBe(state === "failed" ? "Delivery stopped before publication" : "stop");
    expect(task.state).toBe(state);
    expect(f.restores).toContain("shop");
  } else if (route === "failed preparation") {
    expect(await f.workflow.preparationFailed(scope, "Release checks failed", f.signal)).toBe("continue");
  } else if (route === "delivery retry") {
    expect(await f.workflow.prepareAgain(scope, "Main moved before publication")).toBe("again");
  } else {
    await f.workflow.returnForDecision(task, route === "proof decision" ? "proof" : "acceptance");
    expect(task.stageIndex).toBe(1);
  }
  expect(f.restores).toContain("shop"); expect(scope.work.savedVersion).toEqual(saved);
  expect(f.published).toEqual([]);
  // Real HEAD/tree/SQLite and frozen validation snapshots remain in saved-release-version's
  // no-version-change, working-edits and already-queued native adapter conjunctions.
});

for (const operation of ["preparationFailed", "prepareAgain"] as const) for (const failure of [new Error("Restoration did not settle"), undefined])
it(`preserves ${failure === undefined ? "undefined" : "Error"} restoration failure during ${operation}`, async () => {
  const f = deliveryScenario(["shop"], "release"); f.prepareObservation(f.scope); f.approve();
  const before = structuredClone(f.task);
  f.hooks.backToWork = async () => { throw failure; };
  let rejected = false, caught: unknown;
  try {
    if (operation === "preparationFailed") await f.workflow.preparationFailed(f.scope, "Checks failed", f.signal);
    else await f.workflow.prepareAgain(f.scope, "Main moved");
  } catch (error) { rejected = true; caught = error; }
  expect(rejected).toBe(true); expect(caught).toBe(failure);
  expect(f.task).toEqual(before); expect(f.published).toEqual([]); expect(f.events.filter(event => event === "checkpoint")).toEqual([]);
});

it("keeps a restored-setup hold separate from a failed release preparation", async () => {
  const f = deliveryScenario(["shop", "api"], "release"); f.approve();
  for (const scope of scopesFor(f.task)) f.prepareObservation(scope);
  f.hooks.restoredChecks = async () => ({ kind: "blocked" });
  expect(await f.workflow.preparationFailed(f.scope, "The version check failed", f.signal)).toBe("stop");
  expect(f.events).toContain("checks-blocked:delivery");
  expect(f.events.some(event => event.startsWith("gate:"))).toBe(false);
  expect(f.task.findings).toEqual([]); expect(f.task.repositories!.every(work => work.checkReturns === undefined)).toBe(true);
  expect(f.published).toEqual([]);
});

it("returns failed release preparation to the task-owned maintenance Builder after its role leaves the library", async () => {
  const f = deliveryScenario(["shop"], "release"), { task } = f;
  const role = { ...BUILT_IN_ROLES.find(role => role.result === "build")!, id: "saved-maintenance", name: "Saved upkeep" };
  task.maintenance = { role, routineId: "routine", routineName: "Routine", scheduledAt: 0, queuedAt: 0, zone: "UTC", focus: "Inspect", input: "Inspect",
    profile: DEFAULT_PROFILES[0]!, product: f.declarations[0]! };
  task.plan!.stages.unshift({ id: "maintenance", title: "Upkeep", kind: "do", roleId: role.id, profileIds: ["sol-high"] });
  task.stageIndex = 2; f.approve(); f.prepareObservation(f.scope);
  expect(BUILT_IN_ROLES.some(entry => entry.id === role.id)).toBe(false);
  expect(await f.workflow.preparationFailed(f.scope, "The release version check failed", f.signal)).toBe("continue");
  expect(task.stageIndex).toBe(0); expect(task.fixing).toBe(true); expect(task.error).toBeUndefined();
  expect(f.scope.work.shipping).toEqual({ moves: 0, failures: 1 }); expect(f.scope.work.approvedSha).toBeUndefined();
  expect(f.published).toEqual([]);
});
