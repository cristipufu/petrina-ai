import { expect, it } from "vitest";
import { createDemoState } from "../src/demo.js";
import { gateStatus, gateTitle } from "../src/flow.js";
import { nextLine } from "../src/summary.js";
import { proofDecision, proofStatus, refreshProofs, sameProofDecision } from "../src/proof-requests.js";
import type { DeepMutable } from "../src/flow.js";
import type { Task, ProofRequest } from "../src/model.js";

function fixture() {
  const state = createDemoState(1_000_000_000_000);
  const task = state.tasks[0]! as DeepMutable<Task>;
  task.state = "running"; task.stageIndex = 0; task.sub = 0; task.findings = [];
  task.plan = { rationale: "Proof", plannerProfileId: "sol-high", stages: [
    { id: "review", title: "Review", kind: "review-chain", roleId: "code-reviewer", profileIds: ["sol-high"] },
    { id: "test", title: "Acceptance", kind: "do", roleId: "tester", profileIds: ["sol-high"] },
    { id: "gate", title: "Delivery", kind: "gate", gate: "delivery", roleId: "release-manager", profileIds: [] },
  ] };
  task.testedPatch = "same-patch"; task.acceptancePassed = true;
  delete task.repositories; task.repository = { productId: task.productId, delivery: "local" }; task.delivery = "local";
  const request: DeepMutable<ProofRequest> = { id: "proof", source: "review:1:0:0", text: "Ubuntu capacity and recovery", reason: "Required final version proof", productIds: [task.productId], ownerStageId: "test", reviewedVersions: { [task.productId]: "A" }, status: "pending", requestedBy: { stageId: "review", round: 1, seat: "0", roleId: "code-reviewer", profileId: "sol-high" } };
  task.proofRequests = [request];
  return { state, task, request };
}

it("names final requested acceptance as certain in Next, with truthful coordinator gap wording", () => {
  const { state, task } = fixture();
  expect(nextLine(state, task)).toContain("final acceptance testing for requested proof");
  expect(nextLine(state, task)).not.toContain("if the code changed");
  expect(gateTitle(task, "delivery")).toContain("proof is still pending");
  task.proofRequests![0]!.status = "unverified";
  expect(gateStatus(task, "delivery")).toBe("Requested proof could not be verified. Your call");
  task.repository!.delivery = "release";
  expect(gateTitle(task, "delivery")).toContain("release version Petrina will create");
});

it("cannot turn an unfinished or missing Tester record, arbitrary reports or missing ownership into proof", () => {
  const { task, request } = fixture(); const versions = { [task.productId]: "A" };
  request.proof = { stepId: "test-run", versions, result: "pass", evidence: "Pasted output claims a pass" };
  expect(proofStatus(task, request, versions)).toBe("stale");
  task.journey = [{ id: "test-run", kind: "agent", stageId: "test", roleId: "tester", round: 1, sub: 0, startedAt: 1, proofChecks: [{ id: "proof", result: "pass", evidence: "Capacity passed" }], agentResults: [{ roleId: "tester", profileId: "sol-high", at: 2, value: {}, versions }] }];
  expect(proofStatus(task, request, versions)).toBe("stale");
  task.journey[0]!.endedAt = 3; task.journey[0]!.end = "done";
  expect(proofStatus(task, request, versions)).toBe("proved");
  expect(proofStatus(task, request, { [task.productId]: "B" })).toBe("stale");
  request.productIds = [];
  expect(proofStatus(task, request, versions)).toBe("unverified");
});

it("binds decisions to every product and request status, including explicitly accepted stale proof", () => {
  const { task } = fixture(); const a = proofDecision(task, { one: "A", two: "B" });
  expect(sameProofDecision(a, proofDecision(task, { one: "A", two: "B" }))).toBe(true);
  expect(sameProofDecision(a, proofDecision(task, { one: "A", two: "C" }))).toBe(false);
  task.proofRequests![0]!.status = "stale";
  expect(sameProofDecision(a, proofDecision(task, { one: "A", two: "B" }))).toBe(false);
  refreshProofs(task, { [task.productId]: "unavailable" });
  expect(task.proofRequests![0]!.status).toBe("unverified");
});

it("keeps an unavailable platform unverified after versions move and names both it and a release gap", () => {
  const { task, request } = fixture(); const versions = { [task.productId]: "A" };
  const reason = "Ubuntu runner unavailable";
  request.proof = { stepId: "test-run", versions, result: "blocked", reason };
  task.journey = [{ id: "test-run", kind: "agent", stageId: "test", roleId: "tester", round: 1, sub: 0, startedAt: 1, endedAt: 3, end: "done", proofChecks: [{ id: "proof", result: "blocked", reason }], agentResults: [{ roleId: "tester", profileId: "sol-high", at: 2, value: {}, versions }] }];
  for (const version of ["A", "B"]) {
    refreshProofs(task, { [task.productId]: version });
    expect(request.status).toBe("unverified");
    for (const delivery of ["local", "release"] as const) {
      task.repository!.delivery = delivery;
      expect(gateTitle(task, "delivery")).toContain("could not be verified");
      expect(gateStatus(task, "delivery")).toContain("could not be verified");
      expect(gateTitle(task, "delivery")).not.toContain("earlier version");
      if (delivery === "release") expect(gateStatus(task, "delivery")).toContain("release version Petrina will create");
    }
  }
  task.journey[0]!.proofChecks = [{ id: "proof", result: "fail", evidence: "Recovery lost a message" }];
  request.proof = { stepId: "test-run", versions, result: "fail", evidence: "Recovery lost a message" };
  refreshProofs(task, versions);
  expect(gateTitle(task, "delivery")).toContain("requested proof failed");
  expect(gateStatus(task, "delivery")).toContain("release version Petrina will create");
});
