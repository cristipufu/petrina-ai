import { expect, it } from "vitest";
import { beginPetrinaStep } from "@petrina/core";
import { deliveryScenario } from "../../fixtures/delivery-scenarios.js";

for (const variant of ["unchanged", "changed commit", "moved source", "failed checks"] as const)
it(`keeps delivery approval and checks authoritative: ${variant}`, async () => {
  const f = deliveryScenario(), { task, scope } = f;
  f.approve();
  let patches = 0, checks = 0;
  f.hooks.upToDate = async () => variant === "moved source" ? "moved" : "current";
  f.hooks.head = async () => variant === "changed commit" ? "scripted:other-head" : scope.work.approvedSha!;
  f.hooks.patch = async () => { patches++; return "scripted:different-patch"; };
  f.hooks.checksBeforeShipping = async () => { checks++; return variant === "failed checks" ? "returned" : "passed"; };
  const changed = variant === "changed commit" || variant === "moved source";
  expect(await f.workflow.readyToShip(scope, f.signal)).toBe(variant === "unchanged" ? "ready" : "back");
  expect(patches).toBe(changed ? 1 : 0);
  expect(checks).toBe(changed ? 0 : 1);
  if (changed) { expect(task.stageIndex).toBe(0); expect(scope.work.approvedSha).toBeUndefined(); }
  expect(f.published).toEqual([]);
});

for (const started of [false, true]) it(`records the publishing return with ${started ? "an open" : "no open"} publishing step`, async () => {
  const f = deliveryScenario(); f.approve();
  if (started) beginPetrinaStep(f.task, "delivery", f.now());
  // The already-observed changed proof is an input to the return policy. Real proof/commit
  // comparison stays in proof-publishing's native exact-version controls.
  await f.workflow.returnForDecision(f.task, "proof");
  const steps = f.task.journey!.filter(step => step.kind === "petrina" && step.work === "delivery");
  expect(steps).toHaveLength(1); expect(steps[0]!.outcome).toBe("Nothing published; a new delivery decision is needed");
  expect(steps[0]!.endedAt).toBeDefined(); expect(steps[0]!.reason).toContain("differ from your delivery decision");
  expect(f.task.stageIndex).toBe(0); expect(f.task.approvedProofDecision).toBeUndefined();
  expect(f.scope.work.approvedFor).toBeUndefined(); expect(f.restores).toEqual(["shop"]);
  expect(f.published).toEqual([]);
});

for (const choice of [
  { name: "all products opted in and shared acceptance passed", ask: false, secondOptedIn: true, acceptance: true, ships: true },
  { name: "the shared task asks before shipping", ask: true, secondOptedIn: true, acceptance: true, ships: false },
  { name: "one product did not opt in", ask: false, secondOptedIn: false, acceptance: true, ships: false },
  { name: "shared acceptance has not run", ask: false, secondOptedIn: true, acceptance: false, ships: false },
]) it(`${choice.ships ? "ships" : "asks about"} low-risk shared work when ${choice.name}`, async () => {
  const f = deliveryScenario(["shop", "api"], "pull-request"), { task } = f;
  task.approveDelivery = choice.ask; task.risk = { level: "low", why: "A small greeting change" };
  f.declarations[1]!.shipLowRisk = choice.secondOptedIn;
  if (choice.acceptance) await f.recordAcceptance();
  task.stageIndex = 0;
  expect(await f.checkpoint.run(f.scope, f.signal)).toEqual({ kind: choice.ships ? "repeat" : "stop" });
  expect(task.approveDelivery).toBe(choice.ask);
  expect(f.gates).toHaveLength(choice.ships ? 0 : 1);
  if (choice.ships) { task.state = "running"; expect(await f.run(task)).toBe("stop"); }
  expect(task.state).toBe(choice.ships ? "pr-open" : "needs-you");
  expect(f.published.map(row => row.product)).toEqual(choice.ships ? ["shop", "api"] : []);
  if (choice.acceptance) {
    expect(task.acceptancePassed).toBe(true);
    expect(Object.keys(task.brief!.acceptance[0]!.versions!).sort()).toEqual(["api", "shop"]);
  } else expect(task.acceptancePassed).toBeUndefined();
});

for (const optedIn of [true, false]) it(optedIn ? "ships low-risk work without asking where the product opted in" : "still asks about low-risk work where the product did not opt in", async () => {
  const f = deliveryScenario();
  f.task.risk = { level: "low", why: "A small greeting change" }; f.declarations[0]!.shipLowRisk = optedIn;
  f.task.stageIndex = 0;
  expect(await f.checkpoint.run(f.scope, f.signal)).toEqual({ kind: optedIn ? "repeat" : "stop" });
  expect(f.declarations[0]!.shipLowRisk).toBe(optedIn);
  if (optedIn) {
    expect(await f.run(f.task)).toBe("stop");
    expect(f.scope.work.landed).toBeDefined();
    expect(f.gates).toEqual([]);
    expect(f.notes).toContain("Low risk, checks passed and nothing left to fix: shipping without asking you, as this product's settings allow");
    expect(f.notes.some(line => line === "You approved the delivery")).toBe(false);
  } else { expect(f.task.risk.level).toBe("low"); expect(f.gates).toHaveLength(1); expect(f.published).toEqual([]); }
});
