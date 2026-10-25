import { expect, it } from "bun:test";
import { join } from "node:path";
import { Engine } from "../../engine.js";
import { removeDir, tempDir, waitFor } from "../../fixtures.js";
import { antigravitySession } from "../../../../agent-runtime/test/fixtures/antigravity-session.js";

  it("shares account refreshes with Analytics and keeps the reported model scopes", async () => {
    const dir = tempDir("petrina-antigravity-reader-");
    const peer = antigravitySession(dir);
    const command = peer.command;
    const engine = new Engine(join(dir, "data"), { agentCommand: () => [], usageCommands: { antigravity: command }, toolPath: () => "/fake/tool" });
    try {
      await waitFor(() => engine.windowState().pool.usageReads?.antigravity?.state === "reported", "Antigravity's account reading");
      const before = engine.windowState().pool.usage!.filter(r => r.toolId === "antigravity");
      for (let n = 0; n < 3; n++) engine.usage({ view: "analytics", period: "today" });
      await engine.usageCoordinator.readers.get("antigravity")!.refresh(60_000);
      expect(peer.accountRequests()).toHaveLength(1);
      expect(before).toHaveLength(3);
      expect(engine.usage({ view: "analytics", period: "today" }).limits.tools.some(t => t.toolId === "antigravity")).toBe(true);
    } finally { await engine.shutdown(); removeDir(dir); }
  });
