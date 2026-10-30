import { expect, it } from "vitest";
import { recordBuilderFindingAnswers } from "@petrina/core";
import { reviewWorkflowFixture, PreparationChanged } from "../../fixtures/review-workflow.js";
import { report } from "../../fixtures/continued-review.js";

it("prepares checks and immutable inputs before admitting any reviewer, then closes the actual reported round", async () => {
  const f = reviewWorkflowFixture();
  f.task.findings = []; delete f.task.hunt;
  f.prepare();
  expect(await f.run()).toBe("continue");
  expect(f.calls).toEqual(["prepare:p", "checks:p", "changed", "input:p", "changed"]);
  expect(f.task.hunt).toMatchObject({ stageId: f.stage.id, round: 1, reported: {}, input: { heads: { p: f.first }, trees: { p: f.tree } } });
  f.onReview(async keys => { for (const key of keys) expect(f.report(key, report())).toBeUndefined(); });
  expect(await f.run()).toBe("continue");
  expect(f.calls.slice(-3)).toEqual(["reviewers:0,1", "clear-step", "rerun"]);
  expect(f.task.hunt!.reported).toEqual({ "0": true, "1": true });
  expect(await f.run()).toBe("continue");
  expect(f.task.hunt).toBeUndefined(); expect(f.ended).toEqual(["passed"]);
  expect(f.task.stageIndex).toBe(2); f.assertConsumed();
});

it("does not start a round when source preparation returns it to the Builder", async () => {
  const f = reviewWorkflowFixture(); delete f.task.hunt;
  f.observations.push({ kind: "prepare", productId: "p", value: false });
  expect(await f.run()).toBe("continue");
  expect(f.calls).toEqual(["prepare:p"]); expect(f.task.hunt).toBeUndefined(); f.assertConsumed();
});

for (const changed of [true, false]) it(`preserves ${changed ? "preparation changes" : "unexpected check errors"} before a round starts`, async () => {
  const f = reviewWorkflowFixture(); delete f.task.hunt;
  const error = changed ? new PreparationChanged("The admitted source changed") : new Error("Check runner failure");
  f.observations.push({ kind: "prepare", productId: "p", value: true }, { kind: "checks", productId: "p", value: error });
  if (changed) expect(await f.run()).toBe("continue"); else await expect(f.run()).rejects.toBe(error);
  expect(f.calls).toEqual(["prepare:p", "checks:p"]); expect(f.task.hunt).toBeUndefined(); f.assertConsumed();
});

it("records only product failures as eligible repair owners and clears every port after shared check failure", async () => {
  const f = reviewWorkflowFixture(); delete f.task.hunt;
  f.task.repositories = ["p", "q"].map(productId => ({ ...structuredClone(f.scope.work), productId, completedStages: [],
    portReview: { from: "before", head: "feature", onto: "after", files: ["greeting.txt"] }, reviewedTree: "reviewed" }));
  f.task.leadProductId = "p"; delete f.task.repository;
  f.observations.push({ kind: "prepare", productId: "p", value: true }, { kind: "checks", productId: "p", value: { kind: "blocked", productId: "p" } },
    { kind: "prepare", productId: "q", value: true }, { kind: "checks", productId: "q", value: { kind: "product-failed", productId: "q" } });
  expect(await f.run()).toBe("stop"); expect(f.returned).toEqual([["q"]]);
  expect(f.task.repositories!.map(work => [work.portReview, work.reviewedTree])).toEqual([[undefined, undefined], [undefined, undefined]]);
  expect(f.task.rounds[f.stage.id]).toBe(1); expect(f.task.hunt).toBeUndefined(); f.assertConsumed();
});

it("does not publish a new hunt after cancellation during input preparation", async () => {
  const f = reviewWorkflowFixture(); delete f.task.hunt;
  f.prepare();
  const input = f.observations.at(-1)!;
  if (input.kind !== "input") throw new Error("The declared final observation must prepare review inputs");
  const stopped = new Error("Review was stopped"); input.before = () => f.controller.abort(stopped);
  await expect(f.run()).rejects.toBe(stopped);
  expect(f.task.hunt).toBeUndefined(); expect(f.calls.at(-1)).toBe("input:p"); f.assertConsumed();
});

for (const legacy of [true, false]) it(`${legacy ? "discards a legacy port-only conversation before full preparation" : "keeps a genuine port conversation until its actual reviewer runs"}`, async () => {
  const f = reviewWorkflowFixture(); f.stage.profileIds = ["opus-high"];
  f.scope.work.portReview = { from: "old-base", head: "old-feature", onto: "new-base", files: ["greeting.txt"] };
  f.scope.work.reviewedSha = "ordinary-review-head";
  f.scope.work.conversation = { step: "review", roleId: "code-reviewer", profileId: "opus-high", toolId: "claude-code", model: "opus", sessionId: "supplied-port-session", startedAt: f.now(), briefed: true };
  const saved = structuredClone(f.scope.work.conversation);
  f.task.hunt!.reported = {};
  if (legacy) {
    f.prepare(); expect(await f.run()).toBe("continue");
    expect(f.scope.work.conversation).toBeUndefined(); expect(f.scope.work.portReview).toBeUndefined(); expect(f.scope.work.reviewedSha).toBeUndefined();
    expect(f.calls[0]).toBe("checkpoint"); expect(f.task.hunt!.input!.file).toBe("supplied-review-packet");
  } else {
    f.scope.work.reviewedTree = "ordinary-review-tree";
    f.onReview(async keys => {
      expect(keys).toEqual(["0"]); expect(f.scope.work.conversation).toEqual(saved);
      expect(f.scope.work.portReview?.files).toEqual(["greeting.txt"]); expect(f.report("0", report())).toBeUndefined();
    });
    expect(await f.run()).toBe("continue");
    expect(f.calls).toEqual(["reviewers:0", "finish-step", "rerun"]);
    expect(f.scope.work.reviewedTree).toBe("ordinary-review-tree");
  }
  f.assertConsumed();
});

for (const kind of ["parallel", "security", "added"] as const) it(`requires current reopening evidence in a ${kind} findings stage and accepts omission without consuming another round`, async () => {
  const f = reviewWorkflowFixture();
  if (kind !== "parallel") {
    f.stage.profileIds = ["opus-high"]; f.stage.roleId = kind === "security" ? "security-reviewer" : "privacy-reviewer";
    if (kind === "added") f.state.roles.push({ ...f.state.roles.find(role => role.id === "security-reviewer")!, id: "privacy-reviewer", name: "Privacy reviewer", added: true });
  }
  f.task.hunt!.reported = {}; f.task.hunt!.findings = 1;
  recordBuilderFindingAnswers(f.task, [f.finding], [{ id: f.finding.id, fixed: true, text: "The greeting is repaired" }], { productId: "p", shared: false, at: f.now() });
  const corrected: string[] = [];
  f.onReview(async keys => {
    for (const key of keys) {
      const before = structuredClone(f.finding);
      expect(f.report(key, report({ confirms: [f.finding.id] }))).toContain("Current evidence is required");
      expect(f.finding).toEqual(before); expect(f.task.hunt!.reported[key]).toBeUndefined();
      expect(f.report(key, report())).toBeUndefined(); corrected.push(key);
    }
  });
  expect(await f.run()).toBe("continue"); expect(await f.run()).toBe("continue");
  expect(corrected).toHaveLength(kind === "parallel" ? 2 : 1);
  expect(f.finding.status).toBe("fixed"); expect(f.finding.answer?.fixed).toBe(true); expect(f.finding.earlierReviews).toBeUndefined();
  expect(f.ended).toEqual(["passed"]); expect(f.task.rounds[f.stage.id]).toBe(1); expect(f.decisions).toEqual([]); f.assertConsumed();
});

for (const requests of [undefined, []]) it(`prepares the real review packet without unused proof observations for ${requests ? "empty" : "absent"} requests`, async () => {
  const f = reviewWorkflowFixture(); delete f.task.hunt;
  f.task.proofRequests = requests;
  f.prepare(); // No version effect is declared: calling it consumes the wrong effect and rejects.
  expect(await f.run()).toBe("continue");
  f.assertConsumed();
  expect(f.calls).toEqual(["prepare:p", "checks:p", "changed", "input:p", "changed"]);
  expect(f.task.hunt!.input).toMatchObject({ heads: { p: f.first }, trees: { p: f.tree } });
});

it("refreshes existing proof against a fresh version before capturing the review input", async () => {
  const f = reviewWorkflowFixture(); delete f.task.hunt;
  const versions = { p: "earlier-tree" };
  f.task.journey = [{ id: "tester", kind: "agent", stageId: "acceptance", round: 1, sub: 0, roleId: "tester", profileId: "sol-high", startedAt: 1, endedAt: 2, end: "done",
    agentResults: [{ roleId: "tester", profileId: "sol-high", at: 2, value: {}, versions }],
    proofChecks: [{ id: "proof", result: "pass", evidence: "The supplied accepted Tester observation" }] }];
  f.task.proofRequests = [{ id: "proof", text: "Verify the greeting", reason: "Needs confirmation", productIds: ["p"],
    requestedBy: { stageId: "review", round: 1, seat: "0", roleId: "code-reviewer", profileId: "opus-high" },
    reviewedVersions: versions, ownerStageId: "acceptance", source: "supplied-proof", status: "proved", proof: { stepId: "tester", versions, result: "pass" } }];
  f.prepare();
  const input = f.observations.at(-1)!;
  if (input.kind !== "input") throw new Error("Expected a declared review input");
  input.before = () => { expect(f.task.proofRequests![0]!.status).toBe("stale"); };
  expect(await f.run()).toBe("continue"); f.assertConsumed();
  expect(f.calls).toEqual(["prepare:p", "checks:p", "versions", "changed", "input:p", "changed"]);
  expect(f.task.hunt!.input!.trees).toEqual({ p: f.tree });
});
