import { afterAll, expect, it } from "bun:test";
import { join } from "node:path";
import { executionFor } from "@petrina/orchestrator";
import { Store } from "@petrina/storage/store";
import { proofRequestFixtures } from "../../fixtures/proof-requests.js";
import { readRef } from "../../fixtures/shared-preparation.js";
import { privateAgentToolProbe } from "../../scripted-probes.js";

const { signal, fixture, close } = proofRequestFixtures();
afterAll(close);
it("binds an explicit decision about A's proof on version B to B, blocks publishing C, and keeps the refresh limit after restart", async () => {
  const f = await fixture(); await f.request(); await f.recordPass();
  try {
    await f.body(async () => {
    f.task.proofRefreshes = 2; await f.advance(); await f.drive();
    const viewed = structuredClone(f.task.checkedProofDecision)!;
    expect(Object.values(viewed.statuses)).toEqual(["stale"]);
    f.engine.approve(f.engine.s.inbox.find(item => item.kind === "delivery")!.id);
    expect(f.task.approvedProofDecision).toEqual(viewed); expect(f.task.stageIndex).toBe(4);
    f.engine.setPoolPaused(true); await f.stop(f.engine);
    const saved = new Store(join(f.engine.dataDir, "petrina.db"));
    try { expect(saved.load()!.tasks.find(task => task.id === f.task.id)!.approvedProofDecision).toEqual(viewed); }
    finally { saved.close(); }
    f.engine = f.open(f.engine.dataDir, { agentCommand: () => undefined, toolProbe: privateAgentToolProbe(), terminals: () => [] }); f.engine.schedule = () => {};
    await f.engine.waitUntilReady(); f.task = f.engine.task(f.task.id)!; f.scope = executionFor(f.task);
    f.engine.setPoolPaused(false); await f.advance();
    const destinationBefore = readRef(join(f.products[0]!.path!, ".git"), "refs/heads/main")!;
    expect(await f.engine["shipping"]["readyToShip"](f.scope, signal())).toBe("back");
    expect(f.task.stageIndex).toBe(3); expect(f.task.approvedProofDecision).toBeUndefined(); expect(f.task.proofRefreshes).toBe(2);
    expect(readRef(join(f.products[0]!.path!, ".git"), "refs/heads/main")).toBe(destinationBefore);
    f.task.state = "running"; await f.run(f.engine, () => f.engine["driver"].workflow["drive"](f.task.id)); expect(f.task.proofRefreshes).toBe(2); expect(f.task.checkedProofDecision).not.toEqual(viewed);
    expect(f.engine.s.inbox.find(item => item.kind === "delivery")!.title).toContain("earlier version");
    f.engine.requestChanges(f.engine.s.inbox.find(item => item.kind === "delivery")!.id, "Obtain the required proof after the next fix");
    expect(f.task.proofRefreshes).toBeUndefined();
      });
  } finally { await f.close(); }
});
