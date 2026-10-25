import { afterAll, describe, expect, it } from "bun:test";
import { participantConversationFixtures } from "../../fixtures/participant-conversation.js";

const { fixture, close } = participantConversationFixtures();
afterAll(close);
describe.concurrent("eligible saved review stand-ins", () => {
it("retains reviewer policy near a limit and gives voters no saved-seat preference", async () => {
    const f = await fixture();
    try {
      const saved = (await f.first())["0"]!;
      f.engine.s.pool.usage = [{ toolId: saved.toolId, kind: "seven_day", utilization: 0.9, status: "allowed", at: Date.now(), resetsAt: Date.now() + 3_600_000 }];
      expect(f.choose()).toEqual(expect.objectContaining({ profile: expect.objectContaining({ id: saved.profileId }) }));
      expect(f.engine.choose("opus-high", f.scope, "verifier")).toEqual(expect.objectContaining({ profile: expect.objectContaining({ id: "opus-high" }) }));
      const before = structuredClone(f.diagnostics());
      try {
        const input = (await f.round(2))[0]!;
        expect(input.mode).toBe("continued");
      } catch (error) {
        console.error("Near-limit reviewer continuation:", JSON.stringify({ before, after: f.diagnostics() }, null, 2));
        throw error;
      }
    } finally { await f.engine.shutdown(); }
  });

});
