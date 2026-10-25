import { afterAll, expect, it, spyOn } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beginAgentStep, proofContext } from "@petrina/core";
import { git } from "../../fixtures.js";
import { scopesFor } from "@petrina/orchestrator";
import { commandText } from "../../../src/checks.js";
import { proofRequestFixtures } from "../../fixtures/proof-requests.js";

const { signal, fixture, testerReply, passes, close } = proofRequestFixtures();
afterAll(close);
it("routes reproduced proof failures by request id even with identical text and an unavailable peer", async () => {
  const f = await fixture(true); const a = await f.request("Same wording", [f.products[0]!.id]); const b = await f.request("Same wording", [f.products[1]!.id]); const c = await f.request("Unavailable platform");
  const reply = testerReply(f, ids => ids.map(id => ({ id, result: id === a.id ? "fail" : id === b.id ? "pass" : "blocked", evidence: id === c.id ? undefined : "The failing scenario reproduced; the passing control worked", reason: id === c.id ? "Runner unavailable" : undefined })));
  try {
    f.task.retest = true; f.task.stageIndex = 1;
    await f.engine["work"].runDo(f.scope, f.tester, signal());
    expect(f.task.stageIndex).toBe(0); expect(f.task.repair?.products).toEqual([f.products[0]!.id]);
    expect(scopesFor(f.task).map(({ work }) => work.acceptanceReturns)).toEqual([1, undefined]);
    expect(f.task.findings).toHaveLength(1); expect(f.task.findings[0]!.proofRequestId).toBe(a.id); expect(f.task.findings[0]!.status).toBe("open");
    expect(b.status).toBe("proved"); expect(c.status).toBe("unverified");
    // The completed Builder/reviewer repair rejoins final preparation; the failed request must be tried again.
    delete f.task.repair; f.task.fixing = false; f.task.stageIndex = 3;
    const stop = spyOn(f.engine["work"], "runDo").mockImplementation(async () => { f.task.state = "paused"; return "stop"; });
    await f.drive();
    expect(stop).toHaveBeenCalled(); expect(f.task.retest).toBe(true);
    stop.mockRestore();
  } finally { reply.mockRestore(); await f.close(); }
});

it("never starts a Tester while configured checks fail and preserves the existing Builder return", async () => {
  const f = await fixture(); const reply = testerReply(f, passes);
  try {
    await f.request(); f.engine.setProductChecks(f.task.productId, [{ name: "Tests", command: commandText([process.execPath, "-e", "console.error('reproduced check failure');process.exit(1)"]) }]);
    const admit = spyOn(f.engine["driver"].workflow as unknown as { admitNext: () => Promise<boolean> }, "admitNext").mockResolvedValue(false);
    await f.run(f.engine, () => f.engine["driver"].workflow["drive"](f.task.id)); admit.mockRestore();
    expect(reply).not.toHaveBeenCalled(); expect(f.task.stageIndex).toBe(0); expect(f.scope.work.checkReturns).toBe(1);
    expect(f.task.findings[0]!.raisedBy).toBe("petrina"); expect(f.task.proofRequests![0]!.status).toBe("pending");
  } finally { reply.mockRestore(); await f.close(); }
});

it("keeps real and mixed code findings on their normal review repair route", async () => {
  for (const mixed of [false, true]) {
    const f = await fixture();
    try {
      if (mixed) await f.request();
      f.task.stageIndex = 2;
      f.task.findings.push({ id: "defect", text: "Current recovery loses the saved message", severity: "blocking", raisedBy: "sol-high", confirmedBy: ["opus-high"], status: "open" });
      beginAgentStep(f.task, "code-reviewer", "sol-high", 1, f.engine.s.roles, undefined, f.scope.work);
      await f.engine["reviews"]["closeReviewRound"](f.task, f.review, 1, "One Important finding");
      expect(f.task.stageIndex).toBe(0); expect(f.task.fixing).toBe(true); expect(f.task.rounds.review).toBe(2);
      expect(f.task.findings[0]!.status).toBe("open");
      if (mixed) { expect(f.task.proofRequests![0]!.status).toBe("pending"); expect(proofContext(f.task.proofRequests!)).toContain("final acceptance"); }
    } finally { await f.close(); }
  }
});

it("retains acceptance failure limits and does not charge main-only refreshes for actual task edits", async () => {
  const f = await fixture(); await f.request(); await f.recordPass(); f.task.proofRefreshes = 2;
  const reply = testerReply(f, ids => ids.map(id => ({ id, result: "fail", evidence: "Recovery reproduced a lost message on this code; nearby recovery succeeded" })));
  try {
    writeFileSync(join(f.scope.work.worktree!, "feature.txt"), "a changed task patch\n"); await git(f.scope.work.worktree!, "add", "."); await git(f.scope.work.worktree!, "commit", "-q", "-m", "Change the implementation");
    const stop = spyOn(f.engine["work"], "runDo").mockResolvedValue("stop");
    await f.drive(); expect(f.task.stageIndex).toBe(1); expect(f.task.retest).toBe(true); expect(f.task.proofRefreshes).toBe(2); stop.mockRestore();
    for (let turn = 1; turn <= 3; turn++) {
      f.task.retest = true; f.task.stageIndex = 1;
      await f.engine["work"].runDo(f.scope, f.tester, signal());
      expect(f.scope.work.acceptanceReturns).toBe(Math.min(turn, 2));
      expect(f.task.stageIndex).toBe(turn < 3 ? 0 : 3);
    }
    expect(reply).toHaveBeenCalledTimes(3); expect(f.task.findings).toHaveLength(1); expect(f.task.acceptanceBlocked).toBe(true);
  } finally { reply.mockRestore(); await f.close(); }
});

it("tries a newly pending request despite an earlier unavailable acceptance result", async () => {
  const f = await fixture();
  const reply = testerReply(f, passes);
  try {
    const earlier = await f.recordPass([]); earlier.acceptanceChecks = [{ text: "An unavailable account", result: "blocked", reason: "Account unavailable" }];
    f.task.acceptancePassed = false; f.task.acceptanceUnverified = true;
    await f.request(); await f.drive();
    expect(reply).toHaveBeenCalledTimes(1); expect(f.task.proofRequests![0]!.status).toBe("proved");
    expect(f.scope.work.acceptanceReturns).toBeUndefined();
  } finally { reply.mockRestore(); await f.close(); }
});

it("keeps an ordinary reproduced checklist failure's Builder retries when requested platform proof is unavailable", async () => {
  const f = await fixture(false, true); await f.request(); f.task.retest = true; f.task.stageIndex = 1;
  const reply = testerReply(f, ids => ids.map(id => ({ id, result: "blocked", reason: "Ubuntu runner unavailable" })), undefined, [{ text: "Linux recovery works", result: "fail", evidence: "The recovery scenario lost the saved message, while the nearby case passed" }]);
  try {
    await f.engine["work"].runDo(f.scope, f.tester, signal());
    expect(f.task.stageIndex).toBe(0); expect(f.scope.work.acceptanceReturns).toBe(1);
    expect(f.task.findings).toHaveLength(1); expect(f.task.findings[0]!.proofRequestId).toBeUndefined();
    expect(f.task.proofRequests![0]!.proof!.reason).toBe("Ubuntu runner unavailable");
    f.task.stageIndex = 3; f.task.fixing = false;
    const boundary = spyOn(f.engine["work"], "runDo").mockResolvedValue("stop");
    await f.drive(); expect(f.task.stageIndex).toBe(1); expect(f.task.retest).toBe(true); boundary.mockRestore();
    for (let turn = 2; turn <= 3; turn++) {
      f.task.stageIndex = 1; f.task.retest = true;
      await f.engine["work"].runDo(f.scope, f.tester, signal());
      expect(f.scope.work.acceptanceReturns).toBe(2); expect(f.task.stageIndex).toBe(turn === 2 ? 0 : 3);
    }
  } finally { reply.mockRestore(); await f.close(); }
});
