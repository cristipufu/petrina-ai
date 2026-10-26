import { expect, it } from "vitest";
import { checkOutcome, checkResult, decisionEvidence } from "@petrina/core";
import { executionFor } from "../../../src/repository-context.js";
import { checkRepairs, findingText, observedCheck } from "../../fixtures/check-repairs.js";

const state = { sha: "supplied:checked-commit", definition: "declared-checks" };

it("restores a historical spent allowance only at the next applicable pass", async () => {
  const f = checkRepairs(), pass = observedCheck(0);
  // Accepted historical state is input, not a claim that a native check ran here.
  f.scope.work.checkReturns = 2;
  f.scope.work.checks = { at: 100, results: [pass] };
  expect(f.controller.settleFindings(f.scope, [pass], new Set([findingText(pass)]))).toEqual([]);
  await f.controller.closeEpisode(f.scope, state, () => true);
  expect(f.scope.work.checkReturns).toBeUndefined();
  expect(f.scope.work.checks.results).toEqual([pass]);
  expect(f.calls).toEqual(["definition:a:supplied:checked-commit"]);
  // Retained native restart and read-only reuse journeys prove SQL durability and no extra execution.
});

it("ends one product's failure episode on its own pass while its peer keeps spent repairs", async () => {
  const f = checkRepairs(true), first = f.scope, second = executionFor(f.task, "b");
  second.work.worktree = "modeled:second-working-copy";
  const pass = observedCheck(0), fail = { ...observedCheck(), name: "Welcome page" };
  first.work.checkReturns = 2; second.work.checkReturns = 1;
  expect(f.controller.settleFindings(first, [pass, fail], new Set([findingText(pass), findingText(fail)]))).toEqual([fail]);
  f.controller.settleFindings(second, [pass], new Set([findingText(pass)]));
  await f.controller.closeEpisode(first, state, () => true);
  await f.controller.closeEpisode(second, state, () => true);
  expect(first.work.checkReturns).toBe(2); expect(second.work.checkReturns).toBeUndefined();
  // A reread does not create another repair, and an applicable recorded pass closes only its owner.
  second.work.checkReturns = 1;
  f.controller.settleFindings(first, [pass, fail], new Set([findingText(pass), findingText(fail)]));
  await f.controller.closeEpisode(first, state, () => true);
  await f.controller.closeEpisode(second, state, () => true);
  expect(first.work.checkReturns).toBe(2); expect(second.work.checkReturns).toBeUndefined();
  expect(f.task.findings).toHaveLength(1);
  expect(f.task.findings[0]).toMatchObject({ productIds: ["a"], status: "open" });
});

it("keeps confirmed interruption unverified without a repair or an allowance charge", () => {
  const f = checkRepairs(true), second = executionFor(f.task, "b");
  const failed = observedCheck(), pass = observedCheck(0);
  failed.source = { stepId: "recorded-checks", attemptId: "first-run", checkId: "first-check" };
  pass.source = { stepId: "recorded-checks", attemptId: "second-run", checkId: "second-check" };
  f.scope.work.checks = { at: 101, results: [failed] }; second.work.checks = { at: 101, results: [pass] };
  f.task.journey = [{ id: "recorded-checks", kind: "petrina", work: "checks", round: 1, sub: 0, startedAt: 100, endedAt: 101, end: "done",
    productChecks: [{ id: "first-check", attemptId: "first-run", productId: "a", name: failed.name, result: "fail", run: failed },
      { id: "second-check", attemptId: "second-run", productId: "b", name: pass.name, result: "pass", run: pass }] }];
  f.controller.settleFindings(f.scope, [failed], new Set([findingText(failed)]));
  expect(checkOutcome(failed).kind).toBe("failed");
  const original = { output: failed.output, source: { ...failed.source } };
  failed.interruption = { source: "macOS power log", at: 100, event: "Entering Sleep state due to Clamshell Sleep" };
  f.scope.work.checkReturns = 2; second.work.checkReturns = 1;
  expect(f.controller.settleFindings(f.scope, [failed], new Set([findingText(failed)]))).toEqual([]);
  expect(checkOutcome(failed).kind).toBe("incomplete"); expect(checkResult(failed)).toBe("stopped");
  expect(f.controller.backToBuilder(f.scope, "before review", new Set(["a", "b"]))).toBe(false);
  expect(f.task.repositories!.map(work => work.checkReturns)).toEqual([2, 1]);
  expect(f.task.findings.filter(finding => finding.status === "open")).toEqual([]);
  expect(f.task.findings[0]!.status).toBe("unverified");
  const decision = decisionEvidence(f.task);
  expect(decision.map(check => [check.productId, check.result])).toEqual([["a", "stopped"], ["b", "pass"]]);
  expect(decision[0]!.run!.output).toBe(original.output); expect(decision[0]!.run!.source).toEqual(original.source);
  // The actual blocked Inbox/status and native producer pairing stay in setup-environment/outcome-recording.
});

it("does not repair a passing product for a deleted test, and bounds a real failure there", () => {
  const f = checkRepairs(true), first = f.scope, second = executionFor(f.task, "b"), fail = observedCheck();
  f.task.findings.push({ id: "deleted", text: "A test file was deleted: greeting.test.ts", productIds: ["a"], severity: "blocking", raisedBy: "petrina", confirmedBy: [], status: "open" });
  f.controller.recordFailedFindings(second, [fail]); second.work.checkReturns = 2;
  expect(f.controller.backToBuilder(second, "before review", new Set(["a", "b"]))).toBe(false);
  expect(f.task.findings.find(finding => finding.id === "deleted")!.status).toBe("open");
  f.controller.recordFailedFindings(first, [fail]);
  const turns = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const returned = f.controller.backToBuilder(second, "before review", new Set(["a", "b"]));
    turns.push(returned ? [f.task.repair!.products, first.work.checkReturns] : "blocked");
    delete f.task.repair; f.task.stageIndex = 2;
  }
  expect(turns).toEqual([[["a"], 1], [["a"], 2], "blocked"]);
  expect(second.work.checkReturns).toBe(2);
});

it("ends an episode only after every still-declared check failure is settled", async () => {
  const f = checkRepairs(true), pass = observedCheck(0);
  const hook = { ...observedCheck(), name: "Pre-commit hook", command: "git hook run --ignore-missing pre-commit" };
  f.controller.recordFailedFindings(f.scope, [hook]); f.scope.work.checkReturns = 1;
  expect(f.controller.settleFindings(f.scope, [pass], new Set([findingText(pass), findingText(hook)]))).toEqual([]);
  await f.controller.closeEpisode(f.scope, state, () => true);
  expect(f.task.findings.find(finding => finding.text === findingText(hook))!.status).toBe("open");
  expect(f.scope.work.checkReturns).toBe(1); expect(f.calls).toEqual([]);
});
