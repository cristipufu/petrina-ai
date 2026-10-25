import { afterAll, expect, it, spyOn } from "bun:test";
import { join } from "node:path";
import { sameVersions } from "@petrina/core";
import { git } from "../../fixtures.js";
import { executionFor } from "@petrina/orchestrator";
import { versionsOf } from "../../../src/repositories.js";
import { Store } from "@petrina/storage/store";
import { proofRequestFixtures } from "../../fixtures/proof-requests.js";

const { signal, fixture, testerReply, passes, close } = proofRequestFixtures();
afterAll(close);
it("requires every affected shared product version and bounds main-only shared refreshes", async () => {
  const f = await fixture(true); const request = await f.request(); const reply = testerReply(f, passes);
  try {
    await f.recordPass();
    for (let i = 0; i < 3; i++) {
      f.engine.s.inbox = []; await f.advance(i % 2); await f.drive();
      expect(f.task.stageIndex).toBe(3);
    }
    expect(reply).toHaveBeenCalledTimes(2); expect(f.task.proofRefreshes).toBe(2); expect(request.status).toBe("stale");
    expect(sameVersions(request.proof!.versions, await versionsOf(f.task), request.productIds)).toBe(false);
    expect(f.task.repair).toBeUndefined(); expect(f.task.findings).toEqual([]);
  } finally { reply.mockRestore(); await f.close(); }
});

it("binds an explicit decision about A's proof on version B to B, blocks publishing C, and keeps the refresh limit after restart", async () => {
  const f = await fixture(); await f.request(); await f.recordPass();
  try {
    f.task.proofRefreshes = 2; await f.advance(); await f.drive();
    const viewed = structuredClone(f.task.checkedProofDecision)!;
    expect(Object.values(viewed.statuses)).toEqual(["stale"]);
    f.engine.approve(f.engine.s.inbox.find(item => item.kind === "delivery")!.id);
    expect(f.task.approvedProofDecision).toEqual(viewed); expect(f.task.stageIndex).toBe(4);
    f.engine.setPoolPaused(true); await f.stop(f.engine);
    const saved = new Store(join(f.engine.dataDir, "petrina.db")); expect(saved.load()!.tasks.find(task => task.id === f.task.id)!.approvedProofDecision).toEqual(viewed); saved.close();
    f.engine = f.open(f.engine.dataDir, { agentCommand: () => undefined, terminals: () => [] }); f.engine.schedule = () => {};
    await f.engine.waitUntilReady(); f.task = f.engine.task(f.task.id)!; f.scope = executionFor(f.task);
    f.engine.setPoolPaused(false); await f.advance();
    const destinationBefore = await git(f.products[0]!.path!, "rev-parse", "main");
    expect(await f.engine["shipping"]["readyToShip"](f.scope, signal())).toBe("back");
    expect(f.task.stageIndex).toBe(3); expect(f.task.approvedProofDecision).toBeUndefined(); expect(f.task.proofRefreshes).toBe(2);
    expect(await git(f.products[0]!.path!, "rev-parse", "main")).toBe(destinationBefore);
    f.task.state = "running"; await f.run(f.engine, () => f.engine["driver"].workflow["drive"](f.task.id)); expect(f.task.proofRefreshes).toBe(2); expect(f.task.checkedProofDecision).not.toEqual(viewed);
    expect(f.engine.s.inbox.find(item => item.kind === "delivery")!.title).toContain("earlier version");
    f.engine.requestChanges(f.engine.s.inbox.find(item => item.kind === "delivery")!.id, "Obtain the required proof after the next fix");
    expect(f.task.proofRefreshes).toBeUndefined();
  } finally { await f.close(); }
});

it("asks after the shared refresh limit even when main moved only outside a request's product subset", async () => {
  const f = await fixture(true); const request = await f.request("Prove only the first product", [f.products[0]!.id]); await f.recordPass();
  const reply = testerReply(f, passes); const publish = spyOn(f.engine["shipping"], "deliver").mockResolvedValue("stop");
  try {
    for (let move = 0; move < 3; move++) {
      f.engine.s.inbox = []; await f.advance(1);
      if (move === 2) { f.task.proofDeliveryGate = "gate"; f.task.approveDelivery = false; }
      await f.drive();
    }
    expect(reply).toHaveBeenCalledTimes(2); expect(publish).not.toHaveBeenCalled();
    expect(request.status).toBe("proved"); expect(f.task.proofRefreshBlocked).toBe(true);
    expect(f.task.stageIndex).toBe(3); expect(f.task.approvedProofDecision).toBeUndefined();
    expect(f.engine.s.inbox.find(item => item.kind === "delivery")!.title).toContain("two refreshes from main");
  } finally { reply.mockRestore(); publish.mockRestore(); await f.close(); }
});
