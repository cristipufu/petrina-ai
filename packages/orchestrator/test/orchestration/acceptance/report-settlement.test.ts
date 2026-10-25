import { expect, it } from "vitest";
import { ACCEPTANCE_RESTORED } from "@petrina/core";
import { routeAcceptance } from "../../../src/acceptance-routing.js";
import { acceptanceHost } from "../../fixtures/acceptance.js";
import { acceptanceResultsFixture } from "../../fixtures/acceptance-results.js";

it("keeps an invalidated run's reported failures as history, without a defect, a Builder return or changed check evidence", async () => {
  const f = acceptanceResultsFixture(), request = f.request();
  const earlier = { id: "earlier-failure", text: "Failed acceptance check: A greeting file exists", severity: "blocking" as const, raisedBy: "opus-high", confirmedBy: [], status: "fixed" as const, answer: { fixed: true, text: "Added the greeting", at: 1 } };
  f.task.findings.push(structuredClone(earlier));
  f.scope.work.checks = { at: 1, sha: "observed-head", tree: f.versions[f.task.productId]!, current: true, results: [{ name: "Test", command: "test", ok: true, output: "passed", ms: 1 }] };
  const checks = structuredClone(f.scope.work.checks);
  f.task.retest = true; f.task.stageIndex = 1;
  f.run.restored = { at: 120, products: [{ productId: f.task.productId, edits: true, files: ["tester-edit.txt"] }] };
  const failing = { id: request.id, result: "fail" as const, evidence: "The recovery scenario lost the saved message; the nearby case passed" };
  const value = { summary: "The check failed", checks: [{ text: "A greeting file exists", result: "fail" as const, evidence: "The greeting was missing" }], proofAnswers: [failing], learnings: [] };
  const recorded = await f.record(value);
  routeAcceptance(acceptanceHost().host, f.scope, recorded);
  const final = f.task.journey!.at(-1)!, report = final.agentResults!.at(-1)!.value as { checks: { result: string }[]; proofAnswers: unknown[] };
  expect(report.checks.map(check => check.result)).toEqual(["fail"]); expect(report.proofAnswers).toEqual([failing]);
  expect(final.acceptanceChecks!.map(check => check.result)).toEqual(["blocked", "blocked"]);
  expect(request.status).toBe("unverified"); expect(request.proof).toMatchObject({ result: "blocked", evidence: failing.evidence, reason: ACCEPTANCE_RESTORED });
  expect(f.task.findings).toEqual([earlier]);
  expect(f.scope.work.acceptanceReturns).toBeUndefined(); expect(f.task.fixing).toBeFalsy(); expect(f.task.stageIndex).toBe(3);
  expect(f.task.acceptanceBlocked).toBe(true); expect(f.scope.work.checks).toEqual(checks);
});
