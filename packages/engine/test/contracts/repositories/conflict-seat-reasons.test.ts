import { afterAll, describe, expect, it } from "bun:test";
import { Coordination } from "../../../src/coordination.js";
import { participantConversationFixtures } from "../../fixtures/participant-conversation.js";

const { fixture, conflicting, close } = participantConversationFixtures();
afterAll(close);
describe.concurrent("eligible saved review stand-ins", () => {
for (const pair of [true, false]) it(`gives a ${pair ? "parallel" : "single"} seat's usage stand-in its own start, not the conflict reason the seat already used`, async () => {
    const f = await fixture(pair);
    try {
      const conflict = await conflicting(f);
      await f.round(1);
      await conflict("Main's greeting\n");
      const why = "main conflicted with the change, so the Builder had to port it";
      // The seat's first start after the port runs out of usage partway through its turn.
      f.fakes.scenario({ reopen: "resume", addedReviewer: "pass", limited: [{ model: "opus", role: "code reviewer", spendCap: true }] });
      const before = f.task.journey!.length;
      await f.round(2);
      const starts = f.task.journey!.slice(before).flatMap((step) => step.agentInputs ?? []).filter((input) => input.reviewerKey === "0");
      expect(starts.map((input) => input.profileId)).toEqual(["opus-high", expect.not.stringMatching(/^opus-/)]);
      const [first, standIn] = starts;
      expect(first).toMatchObject({ mode: "fresh", freshReason: why });
      // The stand-in says why it took over; the single seat's own turn also notes its new tool, as before.
      expect(standIn!.mode).toBe("fresh");
      expect(standIn!.selectionReason).toContain("Claude Code's spend limit");
      expect(standIn!.selectionReason).not.toContain(why);
      expect(standIn!.freshReason).toBe(pair ? undefined : "it now runs on a different tool or model");
      const events = (await new Coordination(f.engine).call("watch.events", { taskIds: [f.task.id], from: "oldest", kinds: ["seat.started"], timeoutMs: 0 })).events as { profileId: string; freshReason?: string; summary: string; at: number }[];
      const standInEvent = events.find((event) => event.profileId === standIn!.profileId && event.at === standIn!.at)!;
      expect(standInEvent).toBeDefined();
      expect(standInEvent.freshReason).toBe(standIn!.freshReason);
      expect(standInEvent.summary).not.toContain(why);
      expect(f.task.reviewFreshReasons).toBeUndefined();
    } finally { await f.engine.shutdown(); }
  });

});
