import { afterAll } from "bun:test";
import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { expect, it } from "bun:test";
import { join } from "node:path";
import { waitFor } from "../../fixtures.js";
import { antigravitySession } from "../../../../agent-runtime/test/fixtures/antigravity-session.js";
const engineCases = engineCaseFixtures();
afterAll(() => engineCases.close());


  it("shares account refreshes with Analytics and keeps the reported model scopes", async () => {
  return engineCases.use("petrina-antigravity-reader-", async caseOwner => {
    const dir = caseOwner.root;
    const peer = antigravitySession(dir);
    const command = peer.command;
    const engine = caseOwner.open(join(dir, "data"), { agentCommand: () => [], usageCommands: { antigravity: command }, toolPath: () => "/fake/tool" });
    try {
      await waitFor(() => engine.windowState().pool.usageReads?.antigravity?.state === "reported", "Antigravity's account reading");
      const before = engine.windowState().pool.usage!.filter(r => r.toolId === "antigravity");
      for (let n = 0; n < 3; n++) engine.usage({ view: "analytics", period: "today" });
      await caseOwner.run(engine, async () => { await engine.usageCoordinator.readers.get("antigravity")!.refresh(60_000); });
      expect(peer.accountRequests()).toHaveLength(1);
      expect(before).toHaveLength(3);
      expect(engine.usage({ view: "analytics", period: "today" }).limits.tools.some(t => t.toolId === "antigravity")).toBe(true);
    } finally { await caseOwner.stop(engine);  }

  });
});
