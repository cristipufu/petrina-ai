import { expect, it } from "vitest";
import { beginAgentStep, BUILT_IN_ROLES, proofContext } from "@petrina/core";
import { scopesFor } from "../../../src/repository-context.js";
import { proofFreshnessFixture, PROOF_ITEM } from "../../fixtures/proof-freshness.js";

it("routes reproduced proof failures by request identity beside identical wording and an unavailable peer", async () => {
  const f = proofFreshnessFixture(true), a = f.request("Same wording", [f.ids[0]!]), b = f.request("Same wording", [f.ids[1]!]), c = f.request("Unavailable platform");
  await f.report({ answers: [
    { id: a.id, result: "fail", evidence: "The recovery scenario reproduced a lost message." },
    { id: b.id, result: "pass", evidence: "The same scenario worked on the second product." },
    { id: c.id, result: "blocked", reason: "Runner unavailable" },
  ] });
  expect(f.task.stageIndex).toBe(0); expect(f.task.repair?.products).toEqual([f.ids[0]]);
  expect(scopesFor(f.task).map(({ work }) => work.acceptanceReturns)).toEqual([1, undefined]);
  expect(f.task.findings).toHaveLength(1); expect(f.task.findings[0]).toMatchObject({ proofRequestId: a.id, status: "open" });
  expect(b.status).toBe("proved"); expect(c.status).toBe("unverified");
  delete f.task.repair; f.task.fixing = false;
  expect((await f.final()).kind).toBe("repeat"); expect(f.task.retest).toBe(true); expect(f.task.stageIndex).toBe(1);
});

for (const mixed of [false, true]) it(`keeps real code findings on the review repair route with requested proof ${mixed}`, async () => {
  const f = proofFreshnessFixture(); if (mixed) f.request();
  f.task.stageIndex = 2;
  f.task.findings.push({ id: "defect", text: "Current recovery loses the saved message", severity: "blocking", raisedBy: "sol-high", confirmedBy: ["opus-high"], status: "open" });
  beginAgentStep(f.task, "code-reviewer", "sol-high", 1_000, BUILT_IN_ROLES, undefined, f.scope.work);
  await f.rounds.finish(f.task, f.review, 1, "One Important finding");
  expect(f.task.stageIndex).toBe(0); expect(f.task.fixing).toBe(true); expect(f.task.rounds.review).toBe(2);
  expect(f.task.findings[0]!.status).toBe("open");
  if (mixed) { expect(f.task.proofRequests![0]!.status).toBe("pending"); expect(proofContext(f.task.proofRequests!)).toContain("final acceptance"); }
});

it("retains the acceptance repair limit without charging main-only refreshes for actual task edits", async () => {
  const f = proofFreshnessFixture(), request = f.request(); await f.report(); f.task.proofRefreshes = 2;
  f.observe(0, true); expect((await f.final()).kind).toBe("repeat");
  expect(f.task.stageIndex).toBe(1); expect(f.task.retest).toBe(true); expect(f.task.proofRefreshes).toBe(2);
  for (let turn = 1; turn <= 3; turn++) {
    await f.report({ answers: [{ id: request.id, result: "fail", evidence: "Recovery reproduced a lost message; the nearby case passed." }] });
    expect(f.scope.work.acceptanceReturns).toBe(Math.min(turn, 2)); expect(f.task.stageIndex).toBe(turn < 3 ? 0 : 3);
  }
  expect(f.reports).toHaveLength(4); expect(f.task.findings).toHaveLength(1); expect(f.task.acceptanceBlocked).toBe(true);
});

it("tries a newly pending request despite an earlier unavailable acceptance result", async () => {
  const f = proofFreshnessFixture(false, true);
  await f.report({ final: false, checks: [{ text: PROOF_ITEM, result: "blocked", reason: "Account unavailable" }] });
  expect(f.task.acceptancePassed).toBe(false); expect(f.task.acceptanceUnverified).toBe(true);
  expect(f.task.acceptanceBlocked).toBeUndefined();
  f.request(); expect((await f.final()).kind).toBe("repeat"); await f.report();
  expect(f.reports).toHaveLength(2); expect(f.task.proofRequests![0]!.status).toBe("proved"); expect(f.scope.work.acceptanceReturns).toBeUndefined();
});

it("keeps reproduced checklist failures on bounded repair while requested platform proof remains unavailable", async () => {
  const f = proofFreshnessFixture(false, true), request = f.request();
  for (let turn = 1; turn <= 3; turn++) {
    await f.report({ checks: [{ text: PROOF_ITEM, result: "fail", evidence: "Recovery lost the saved message; the nearby control passed." }],
      answers: [{ id: request.id, result: "blocked", reason: "Ubuntu runner unavailable" }] });
    expect(f.scope.work.acceptanceReturns).toBe(Math.min(turn, 2)); expect(f.task.stageIndex).toBe(turn < 3 ? 0 : 3);
    if (turn === 1) {
      expect(f.task.findings).toHaveLength(1); expect(f.task.findings[0]!.proofRequestId).toBeUndefined();
      expect(request.proof!.reason).toBe("Ubuntu runner unavailable"); f.task.fixing = false;
      expect((await f.final()).kind).toBe("repeat"); expect(f.task.retest).toBe(true); expect(f.task.stageIndex).toBe(1);
    }
  }
  expect(f.task.findings).toHaveLength(1); expect(f.task.acceptanceBlocked).toBe(true);
});
