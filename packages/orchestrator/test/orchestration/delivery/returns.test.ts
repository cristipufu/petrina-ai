import { expect, it } from "vitest";
import { beginRepair, clearDeliveryPreparation, prepareDeliveryReturn, type RuntimeTask } from "../../../src/index.js";
import { deliveryReturnTask, importantFor } from "../../fixtures/delivery.js";
import { repairHost } from "../../fixtures/tasks.js";

it.each([false, true])("invalidates accepted evidence and renews acceptance without changing check/review budgets (shared: %s)", shared => {
  const f = deliveryReturnTask(shared), { host, checkpoints } = repairHost();
  Object.assign(f.task, {
    proofRefreshes: 2, proofRefreshBlocked: true, proofRetestReason: "requested",
    checkedProofDecision: { versions: { a: "old" }, statuses: { proof: "unverified" } },
    approvedProofDecision: { versions: { a: "old" }, statuses: { proof: "unverified" } },
    approvedAcceptanceGap: { stepId: "tester", items: [{ text: "Try the guest view", reason: "Unavailable" }] },
    acceptanceRun: { versions: { a: "old" }, changes: { a: "patch" }, requestIds: ["proof"] },
    acceptanceBlocked: true, acceptanceUnverified: true, acceptancePassed: false, proofDeliveryGate: "delivery-check",
  } satisfies Partial<RuntimeTask>);
  const owners = f.task.repositories ?? [f.scope.work];
  owners.forEach((work, index) => { work.acceptanceReturns = index + 1; work.checkReturns = 2; });
  f.task.rounds = { review: 3 };
  f.scope.work.shipping = { moves: 3, failures: 2, start: "previous", base: "base" };
  f.transition();
  expect(prepareDeliveryReturn(host, f.scope, f.input)).toBe("waiting");
  expect(owners.map(work => work.acceptanceReturns)).toEqual(owners.map(() => undefined));
  expect(owners.map(work => work.checkReturns)).toEqual(owners.map(() => 2));
  expect(f.task.rounds).toEqual({ review: 3 });
  expect(f.task.acceptancePassed).toBe(false);
  expect(f.task.proofDeliveryGate).toBe("delivery-check");
  for (const field of ["proofRefreshes", "proofRefreshBlocked", "proofRetestReason", "checkedProofDecision", "approvedProofDecision", "approvedAcceptanceGap", "acceptanceRun", "acceptanceBlocked", "acceptanceUnverified"] as const) expect(f.task[field]).toBeUndefined();
  expect(f.scope.work.shipping).toEqual({ moves: 0, failures: 2 });
  expect(f.task.miss).toEqual({ note: f.input.note, at: f.input.now });
  expect(f.task.stageIndex).toBe(0); expect(f.task.fixing).toBe(true);
  expect(f.task.repair).toEqual(shared ? { products: ["a", "b"], index: 0, returnStage: 1, kind: "review" } : undefined);
  expect(checkpoints).toEqual([]);
});

it("renews asymmetric saved allowances for exactly two more affected-owner returns", () => {
  const f = deliveryReturnTask(), { host, checkpoints } = repairHost();
  f.task.repositories![0]!.acceptanceReturns = 2; f.task.repositories![1]!.acceptanceReturns = 1;
  f.task.acceptanceBlocked = true;
  f.transition();
  expect(prepareDeliveryReturn(host, f.scope, f.input)).toBe("waiting");
  f.task.findings = [{ id: "acceptance", text: "Failed acceptance check: The greeting appears", productIds: ["a", "b"], severity: "blocking", raisedBy: "tester", confirmedBy: [], status: "open" }];
  for (const used of [1, 2]) {
    f.task.stageIndex = 1;
    expect(beginRepair(host, f.task, "acceptance", 1)).toBe(true);
    expect(f.task.repositories!.map(work => work.acceptanceReturns)).toEqual([used, used]);
  }
  expect(beginRepair(host, f.task, "acceptance", 1)).toBe(false);
  expect(checkpoints).toHaveLength(2);
  expect(checkpoints.map(task => task.repositories!.map(work => work.acceptanceReturns))).toEqual([[1, 1], [2, 2]]);
});

it.each([1, 4])("repairs only the finding's owner and returns to the owed stage after checkpoint %s", fromCheck => {
  const f = deliveryReturnTask(true, fromCheck), { host, checkpoints } = repairHost();
  importantFor(f.task, ["b"]);
  f.task.repositories!.forEach(work => { work.acceptanceReturns = 2; });
  f.transition();
  expect(prepareDeliveryReturn(host, f.scope, f.input)).toBe("waiting");
  expect(f.task.repair).toEqual({ products: ["b"], index: 0, returnStage: fromCheck === 1 ? 1 : 2, kind: "review" });
  expect(f.task.activeProductId).toBe("b"); expect(f.scope.work.productId).toBe("a");
  expect(f.task.miss).toBeUndefined();
  expect(f.task.findings[0]!.status).toBe("open");
  expect(checkpoints).toHaveLength(1);
  expect(checkpoints[0]!.repositories!.every(work => work.acceptanceReturns === undefined)).toBe(true);
});

it.each(["unknown owner", "published owner", "no builder"])("returns an unrepairable %s to the same decision", reason => {
  const f = deliveryReturnTask(), { host, checkpoints } = repairHost();
  importantFor(f.task, reason === "unknown owner" ? ["foreign"] : ["b"]);
  if (reason === "published owner") f.task.repositories![1]!.landed = { branch: "main", sha: "published" };
  if (reason === "no builder") f.task.plan!.stages[0]!.roleId = "tester";
  f.transition();
  expect(prepareDeliveryReturn(host, f.scope, f.input)).toBe("decision");
  expect(f.task.stageIndex).toBe(f.input.fromCheck);
  expect(f.task.repair).toBeUndefined(); expect(checkpoints).toEqual([]);
});

it.each([false, true])("preserves already published owners' allowances (all published: %s)", all => {
  const f = deliveryReturnTask(), { host } = repairHost();
  const [a, b] = f.task.repositories!;
  a!.landed = { branch: "main", sha: "already-published" }; a!.acceptanceReturns = 2; b!.acceptanceReturns = 1;
  if (all) b!.pr = { number: 1, url: "https://github.com/acme/api/pull/1", state: "open", openedAt: 1 };
  f.transition();
  expect(prepareDeliveryReturn(host, f.scope, f.input)).toBe(all ? "decision" : "waiting");
  expect(a!.acceptanceReturns).toBe(2);
  expect(b!.acceptanceReturns).toBe(all ? 1 : undefined);
  expect(f.task.repair?.products).toEqual(all ? undefined : ["b"]);
  if (all) expect(f.task.stageIndex).toBe(f.input.fromCheck);
});

it("visits an unpublished lead first and records only a genuine review miss", () => {
  const f = deliveryReturnTask(), { host } = repairHost();
  f.task.leadProductId = "b";
  importantFor(f.task, ["a"]); f.task.findings[0]!.status = "fixed";
  f.transition();
  expect(prepareDeliveryReturn(host, f.scope, f.input)).toBe("waiting");
  expect(f.task.repair?.products).toEqual(["b", "a"]);
  expect(f.task.activeProductId).toBe("b");
  expect(f.task.miss).toEqual({ note: f.input.note, at: 200 });
});

it("clears only the bound owner's temporary preparation and retains delivery failure counts", () => {
  const f = deliveryReturnTask();
  const peer = { moves: 3, failures: 4, start: "peer" };
  f.task.repositories![1]!.shipping = peer;
  clearDeliveryPreparation(f.scope);
  expect(f.scope.work.shipping).toBeUndefined();
  expect(f.task.repositories![1]!.shipping).toBe(peer);
  f.scope.work.shipping = { moves: 2, failures: 1, base: "old", start: "before" };
  clearDeliveryPreparation(f.scope); clearDeliveryPreparation(f.scope);
  expect(f.scope.work.shipping).toEqual({ moves: 0, failures: 1 });
  expect(f.task.repositories![1]!.shipping).toBe(peer);
});
