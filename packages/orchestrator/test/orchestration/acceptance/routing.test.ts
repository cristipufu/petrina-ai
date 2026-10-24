import { expect, it } from "vitest";
import { addDeliveryCheck, executionFor, routeAcceptance, type AcceptanceRoutingInput } from "../../../src/index.js";
import { acceptanceFailure, acceptanceHost, acceptanceTask } from "../../fixtures/acceptance.js";

const observed = (input: Partial<AcceptanceRoutingInput> = {}): AcceptanceRoutingInput => ({ failed: 0, requiredGap: false, requiredCount: 0, restored: false, ...input });

it("repairs only the affected owner before remaining reviews, charging and checkpointing its allowance once", () => {
  const task = acceptanceTask(), { host, events, checkpoints } = acceptanceHost();
  task.repositories![0]!.acceptanceReturns = 2;
  acceptanceFailure(task);
  task.retest = true;
  // An engine-added gate cannot make early testing jump over unfinished reviews.
  task.proofDeliveryGate = "delivery-check";
  const rounds = structuredClone(task.rounds);
  expect(routeAcceptance(host, executionFor(task), observed({ failed: 1 }))).toBe("continue");
  expect(task.repair).toEqual({ products: ["b"], index: 0, returnStage: 1, kind: "acceptance" });
  expect(task.repositories!.map(work => work.acceptanceReturns)).toEqual([2, 1]);
  expect(task.stageIndex).toBe(0); expect(task.activeProductId).toBe("b"); expect(task.fixing).toBe(true);
  expect(task.retest).toBeUndefined(); expect(task.rounds).toEqual(rounds);
  expect(task.findings[0]?.status).toBe("open");
  expect(events.map(event => event.kind)).toEqual(["finish", "now"]);
  expect(checkpoints[0]!.repair).toEqual(task.repair);
});

it.each([true, false])("keeps exhausted early acceptance open for one decision after every owed review (planned gate: %s)", planned => {
  const task = acceptanceTask(true, planned), { host, events, checkpoints } = acceptanceHost();
  task.approveDelivery = false;
  task.repositories!.forEach(work => { work.acceptanceReturns = 2; });
  acceptanceFailure(task);
  const findings = structuredClone(task.findings), rounds = structuredClone(task.rounds);
  expect(routeAcceptance(host, executionFor(task), observed({ failed: 1 }))).toBe("continue");
  expect(task.stageIndex).toBe(2); expect(task.plan!.stages[task.stageIndex]!.id).toBe("review");
  expect(task.acceptanceBlocked).toBe(true); expect(task.findings).toEqual(findings); expect(task.rounds).toEqual(rounds);
  expect(task.repositories!.map(work => work.acceptanceReturns)).toEqual([2, 2]);
  expect(task.plan!.stages.filter(stage => stage.gate === "delivery")).toHaveLength(1);
  expect(task.proofDeliveryGate === undefined).toBe(planned);
  expect(events.some(event => event.kind === "decision")).toBe(false);
  expect(events.filter(event => event.kind === "note" && event.tone === "milestone")).toHaveLength(planned ? 0 : 1);
  if (!planned) expect(events.find(event => event.kind === "note" && event.tone === "milestone")?.text).toBe("Added your delivery check: acceptance still fails, so delivery waits for your decision");
  expect(events.find(event => event.kind === "note" && event.tone === "warn")?.text).toContain("The remaining reviews run first");
  expect(checkpoints).toHaveLength(1); expect(checkpoints[0]!.stageIndex).toBe(2);
});

it("returns an exhausted final shared test to its existing delivery decision", () => {
  const task = acceptanceTask(), { host, events } = acceptanceHost();
  task.retest = true; task.repositories!.forEach(work => { work.acceptanceReturns = 2; });
  acceptanceFailure(task);
  expect(routeAcceptance(host, executionFor(task), observed({ failed: 1 }))).toBe("continue");
  expect(task.plan!.stages[task.stageIndex]!.gate).toBe("delivery"); expect(task.acceptanceBlocked).toBe(true);
  expect(task.retest).toBeUndefined(); expect(task.repair).toBeUndefined();
  expect(events.map(event => event.kind)).toEqual(["finish", "note", "now"]);
});

it("opens a decision after checkpointing when no delivery stage can host a gate", () => {
  const task = acceptanceTask(true, false), { host, events } = acceptanceHost();
  task.plan!.stages.pop(); task.repositories!.forEach(work => { work.acceptanceReturns = 2; });
  acceptanceFailure(task);
  expect(routeAcceptance(host, executionFor(task), observed({ failed: 1 }))).toBe("stop");
  expect(task.stageIndex).toBe(task.plan!.stages.length); expect(task.acceptanceBlocked).toBe(true);
  expect(events.map(event => event.kind)).toEqual(["finish", "note", "now", "decision"]);
});

it.each([1, 2])("adds a decision for %s unavailable requirements without sending a successful product to the Builder", requiredCount => {
  const task = acceptanceTask(true, false), { host, events } = acceptanceHost();
  const scope = executionFor(task);
  expect(routeAcceptance(host, scope, observed({ requiredGap: true, requiredCount }))).toBeUndefined();
  expect(task.stageIndex).toBe(1); expect(task.repair).toBeUndefined();
  expect(task.repositories!.every(work => work.acceptanceReturns === undefined)).toBe(true);
  expect(task.plan!.stages.filter(stage => stage.gate === "delivery")).toHaveLength(1);
  expect(events).toHaveLength(1); expect(events[0]?.text).toContain(requiredCount === 1 ? "a required acceptance check" : "2 required acceptance checks");
});

it("records a restored run's missing evidence even when there was no checklist", () => {
  const task = acceptanceTask(true, false), { host, events } = acceptanceHost();
  routeAcceptance(host, executionFor(task), observed({ requiredGap: true, restored: true }));
  expect(events).toHaveLength(1); expect(events[0]!.text).toContain("this acceptance run cannot verify the product");
  expect(task.proofDeliveryGate).toBeDefined(); expect(task.repair).toBeUndefined();
});

it.each([false, true])("keeps a real single-product repair available alongside an unavailable requirement (gap: %s)", requiredGap => {
  const task = acceptanceTask(false), { host, events } = acceptanceHost(), scope = executionFor(task);
  task.retest = true;
  expect(routeAcceptance(host, scope, observed({ failed: 2, requiredGap, requiredCount: requiredGap ? 1 : 0 }))).toBe("continue");
  expect(task.stageIndex).toBe(0); expect(task.fixing).toBe(true); expect(scope.work.acceptanceReturns).toBe(1);
  expect(task.retest).toBeUndefined(); expect(task.acceptanceBlocked).toBeUndefined();
  expect(events.map(event => event.kind)).toEqual(["finish", "note", "deferred"]);
  expect(events.find(event => event.kind === "note")?.text).toContain("2 acceptance checks failed on the final code");
});

it.each(["failed", "unverified", "passed"] as const)("finishes an exhausted single-product final test with the %s outcome", outcome => {
  const task = acceptanceTask(false), { host, events } = acceptanceHost(), scope = executionFor(task);
  scope.work.acceptanceReturns = 2; task.retest = true;
  expect(routeAcceptance(host, scope, observed({ failed: outcome === "failed" ? 1 : 0, requiredGap: outcome === "unverified", requiredCount: outcome === "unverified" ? 1 : 0 }))).toBe("continue");
  expect(task.plan!.stages[task.stageIndex]!.gate).toBe("delivery");
  expect(scope.work.acceptanceReturns).toBe(2); expect(task.fixing).toBe(false); expect(task.retest).toBeUndefined();
  expect(task.acceptanceBlocked).toBe(outcome === "passed" ? undefined : true);
  expect(events.filter(event => event.kind === "decision")).toEqual([]);
  expect(events.at(-1)?.kind).toBe("deferred");
});

it("leaves ordinary successful stage completion and checkpointing to its caller", () => {
  const task = acceptanceTask(), { host, events } = acceptanceHost(), before = structuredClone(task);
  expect(routeAcceptance(host, executionFor(task), observed())).toBeUndefined();
  expect(task).toEqual(before); expect(events).toEqual([]);
});

it("reuses an existing required-evidence gate without changing its approval or moving the stage twice", () => {
  const task = acceptanceTask(true, false), { host, events } = acceptanceHost(), scope = executionFor(task);
  task.approveDelivery = false;
  const input = observed({ requiredGap: true, requiredCount: 1 });
  routeAcceptance(host, scope, input);
  const before = structuredClone(task), records = structuredClone(events);
  routeAcceptance(host, scope, input);
  expect(task).toEqual(before); expect(events).toEqual(records); expect(task.approveDelivery).toBe(false);
  expect(task.plan!.stages.filter(stage => stage.gate === "delivery")).toHaveLength(1);
});

it("finds a custom delivery result and keeps the current action selected when inserting its gate", () => {
  const task = acceptanceTask(true, false), { host } = acceptanceHost();
  const delivery = task.plan!.stages.at(-1)!;
  delivery.roleId = "custom-publisher"; task.stageIndex = task.plan!.stages.length - 1;
  const roles = { role: (id: string, owner: typeof task) => id === "custom-publisher" ? { result: "delivery" as const } : host.role(id, owner) };
  expect(addDeliveryCheck(roles, task)).toBe(true);
  expect(task.plan!.stages[task.stageIndex]).toBe(delivery);
  expect(task.plan!.stages[task.stageIndex - 1]!.gate).toBe("delivery");
  const stages = structuredClone(task.plan!.stages), index = task.stageIndex;
  expect(addDeliveryCheck(roles, task)).toBe(true);
  expect(task.plan!.stages).toEqual(stages); expect(task.stageIndex).toBe(index);
});

it("propagates a checkpoint failure without opening a delivery decision", () => {
  const task = acceptanceTask(true, false), { host, events } = acceptanceHost();
  task.plan!.stages.pop(); task.repositories!.forEach(work => { work.acceptanceReturns = 2; }); acceptanceFailure(task);
  host.commitNow = () => { throw new Error("Checkpoint unavailable"); };
  expect(() => routeAcceptance(host, executionFor(task), observed({ failed: 1 }))).toThrow("Checkpoint unavailable");
  expect(events.some(event => event.kind === "decision")).toBe(false);
});
