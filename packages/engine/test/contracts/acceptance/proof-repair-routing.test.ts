import { afterAll, expect, it, spyOn } from "bun:test";
import { commandInputText } from "../../../src/checks.js";
import { proofRequestFixtures } from "../../fixtures/proof-requests.js";

const { fixture, testerReply, passes, close } = proofRequestFixtures();
afterAll(close);
it("never starts a Tester while configured checks fail and preserves the existing Builder return", async () => {
  const f = await fixture(); const reply = testerReply(f, passes);
  try {
    await f.body(async () => {
    await f.request(); f.engine.setProductChecks(f.task.productId, [{ name: "Tests", command: commandInputText([process.execPath, "-e", "console.error('reproduced check failure');process.exit(1)"]) }]);
    const admit = spyOn(f.engine["driver"].workflow as unknown as { admitNext: () => Promise<boolean> }, "admitNext").mockResolvedValue(false);
    await f.run(f.engine, () => f.engine["driver"].workflow["drive"](f.task.id)); admit.mockRestore();
    expect(reply).not.toHaveBeenCalled(); expect(f.task.stageIndex).toBe(0); expect(f.scope.work.checkReturns).toBe(1);
    expect(f.task.findings[0]!.raisedBy).toBe("petrina"); expect(f.task.proofRequests![0]!.status).toBe("pending");
      });
  } finally { reply.mockRestore(); await f.close(); }
});
