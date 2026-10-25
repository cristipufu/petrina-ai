import { afterAll, expect, it } from "bun:test";
import { proofRequestFixtures } from "../../fixtures/proof-requests.js";

const { fixture, testerReply, close } = proofRequestFixtures();
afterAll(close);
it("keeps unavailable platform proof unverified, never auto-ships and never retries unchanged", async () => {
  const f = await fixture(); const reply = testerReply(f, ids => ids.map(id => ({ id, result: "blocked", reason: "Ubuntu runner unavailable" })));
  try {
    await f.request(); f.products[0]!.shipLowRisk = true;
    await f.drive(); expect(reply).toHaveBeenCalledTimes(1);
    expect(f.task.proofRequests![0]!.status).toBe("unverified"); expect(f.task.findings).toEqual([]);
    expect(f.scope.work.acceptanceReturns).toBeUndefined(); expect(f.task.stageIndex).toBe(3);
    expect(f.engine.s.inbox.find(item => item.kind === "delivery")!.title).toContain("could not be verified");
    f.engine.s.inbox = []; await f.drive(); expect(reply).toHaveBeenCalledTimes(1);
    expect(f.task.approvedProofDecision).toBeUndefined();
  } finally { reply.mockRestore(); await f.engine.shutdown(); }
});
