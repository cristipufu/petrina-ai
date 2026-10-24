import { expect, it } from "vitest";
import { BUILT_IN_ROLES, DEFAULT_PROFILES, refreshProofs } from "@petrina/core";
import { checkProofRequests, recordReviewProofs } from "../../../src/index.js";
import { reviewProofFixture } from "../../fixtures/review-proof.js";

it("validates structured requests, deduplicates replay by seat position and reuses only readable exact Tester evidence", () => {
  const { host, task, review, item, versions, passed } = reviewProofFixture();
  expect(checkProofRequests(host, task, [item])).toBeUndefined();
  for (const changed of [{ productIds: [] }, { productIds: ["wrong"] }, { checklistText: "Different wording" }]) expect(checkProofRequests(host, task, [{ ...item, ...changed }])).toBeDefined();
  passed();
  recordReviewProofs(host, task, review, [item], "sol-high", "code-reviewer", "0");
  expect(task.proofRequests).toHaveLength(1); expect(task.proofRequests![0]!.status).toBe("already-current");
  recordReviewProofs(host, task, review, [item], "sol-high", "code-reviewer", "0");
  expect(task.proofRequests).toHaveLength(1);
  recordReviewProofs(host, task, review, [item], "opus-high", "security-reviewer", "1");
  expect(task.proofRequests).toHaveLength(2);
  task.journey = [];
  refreshProofs(task, versions);
  expect(task.proofRequests!.map(item => item.status)).toEqual(["stale", "stale"]);
  task.plan!.stages = task.plan!.stages.filter(stage => stage.id !== "test");
  expect(checkProofRequests(host, task, [item])).toContain("no acceptance testing step");
});

it("does not allocate identity or add a delivery decision for an empty report or a plan without acceptance", () => {
  const { host, task, review, item, identities } = reviewProofFixture();
  task.plan!.stages = task.plan!.stages.filter(stage => stage.gate !== "delivery");
  const before = structuredClone(task);
  expect(checkProofRequests(host, task, [])).toBeUndefined();
  recordReviewProofs(host, task, review, [], "sol-high", "code-reviewer", "0");
  expect(task).toEqual(before); expect(identities()).toBe(0);
  task.plan!.stages = task.plan!.stages.filter(stage => stage.id !== "test");
  recordReviewProofs(host, task, review, [item], "sol-high", "code-reviewer", "0");
  expect(task.proofRequests).toBeUndefined(); expect(identities()).toBe(0);
});

it("rejects missing, repeated or foreign owners and incomplete linked requests without mutating state", () => {
  const { host, task, item } = reviewProofFixture(true);
  for (const change of [{ text: " " }, { reason: " " }, { productIds: [] }, { productIds: ["outside"] },
    { productIds: [task.productId, task.productId] }, { checklistText: "Different wording" }]) {
    const before = structuredClone(task);
    expect(checkProofRequests(host, task, [{ ...item, ...change }])).toBeDefined();
    expect(task).toEqual(before);
  }
  expect(checkProofRequests(host, task, [{ ...item, productIds: ["a", "b"], checklistText: undefined }])).toBeUndefined();
});

it("keeps independently requested identical text and later review executions separate while replay stays idempotent", () => {
  const { host, task, review, item } = reviewProofFixture();
  recordReviewProofs(host, task, review, [item, item], "sol-high", "code-reviewer", "0");
  recordReviewProofs(host, task, review, [item], "opus-high", "code-reviewer", "1");
  const earlier = structuredClone(task.proofRequests!);
  recordReviewProofs(host, task, review, [item, item], "sol-high", "code-reviewer", "0");
  expect(task.proofRequests).toEqual(earlier);
  expect(new Set(earlier.map(request => request.id)).size).toBe(3);
  expect(new Set(earlier.map(request => request.source)).size).toBe(3);
  task.rounds[review.id] = 2;
  task.hunt = { ...task.hunt!, id: undefined, round: 2 };
  recordReviewProofs(host, task, review, [item], "sol-high", "code-reviewer", "0");
  expect(task.proofRequests).toHaveLength(4);
  expect(task.proofRequests![3]!.requestedBy).toMatchObject({ round: 2, seat: "0", profileId: "sol-high" });
  expect(task.proofRequests![3]!.requestedBy.reviewId).not.toBe(earlier[0]!.requestedBy.reviewId);
  expect(task.proofRequests!.slice(0, 3)).toEqual(earlier);
});

for (const invalid of ["running", "cancelled", "wrong stage", "missing evidence", "old version", "unavailable version", "wrong result role"] as const) it(`never treats ${invalid} Tester evidence as current proof`, () => {
  const { host, task, review, item, passed } = reviewProofFixture(); passed();
  const step = task.journey![0]!;
  if (invalid === "running") delete step.endedAt;
  if (invalid === "cancelled") step.end = "cancelled";
  if (invalid === "wrong stage") step.stageId = "another-test";
  if (invalid === "missing evidence") delete step.acceptanceChecks![0]!.evidence;
  if (invalid === "old version") step.agentResults![0]!.versions = { [task.productId]: "old-tree" };
  if (invalid === "unavailable version") step.agentResults![0]!.versions = { [task.productId]: "unavailable" };
  if (invalid === "wrong result role") step.agentResults![0]!.roleId = "builder";
  recordReviewProofs(host, task, review, [item], "sol-high", "code-reviewer", "0");
  expect(task.proofRequests![0]!.status).not.toBe("already-current");
  expect(task.proofRequests![0]!.status).not.toBe("proved");
});

it("uses a saved task-owned acceptance role after removal from the shared catalog", () => {
  const { host, task, review, item, lookups } = reviewProofFixture(false, BUILT_IN_ROLES.filter(role => role.result !== "checks"));
  const role = { ...structuredClone(BUILT_IN_ROLES.find(role => role.result === "checks")!), id: "maintenance-check", name: "Maintenance check" };
  task.maintenance = { routineId: "routine", routineName: "Routine", scheduledAt: 1, queuedAt: 1, zone: "UTC", focus: "Try recovery", input: "Try recovery",
    role, profile: structuredClone(DEFAULT_PROFILES[0]!), product: { id: task.productId, name: "Shop", repo: "local/shop", tone: "blue" } };
  task.plan!.stages.find(stage => stage.id === "test")!.roleId = role.id;
  expect(checkProofRequests(host, task, [item])).toBeUndefined();
  recordReviewProofs(host, task, review, [item], "sol-high", "code-reviewer", "0");
  expect(task.proofRequests![0]!.ownerStageId).toBe("test");
  expect(lookups.every(lookup => lookup.task === task)).toBe(true);
});

it("adds delivery preparation before the delivery role, and rejects proof with no valid review execution", () => {
  const { host, task, review, item } = reviewProofFixture();
  task.plan!.stages = task.plan!.stages.filter(stage => stage.gate !== "delivery");
  recordReviewProofs(host, task, review, [item], "sol-high", "code-reviewer", "0");
  const index = task.plan!.stages.findIndex(stage => stage.gate === "delivery");
  expect(task.plan!.stages[index + 1]!.roleId).toBe("release-manager");
  expect(task.proofDeliveryGate).toBe(task.plan!.stages[index]!.id);
  task.hunt = { ...task.hunt!, stageId: "older-review" };
  expect(() => recordReviewProofs(host, task, review, [item], "sol-high", "code-reviewer", "0")).toThrow("current review execution");
});
