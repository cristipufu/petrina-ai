import { afterAll, describe, expect, it } from "bun:test";
import { Coordination } from "../../../src/coordination.js";
import { participantConversationFixtures } from "../../fixtures/participant-conversation.js";

const { fixture, conflicting, close } = participantConversationFixtures();
afterAll(close);
describe.concurrent("eligible saved review stand-ins", () => {
it("keeps each conflict-dropped conversation's reason with its own stage and seat until that seat starts", async () => {
    const f = await fixture(true);
    try {
      const conflict = await conflicting(f);
      const later = { ...f.stage, id: "later", title: "Review once more" };
      f.task.plan!.stages.push(later);
      const choose = (seat: string) => f.engine.choose(later.profileIds[Number(seat)]!, f.scope, later.roleId, undefined, seat);
      await f.round(1);
      // Only the later stage's second seat had a conversation of its own there.
      f.task.reviewSessions = { ...f.task.reviewSessions, later: { "1": structuredClone(f.task.reviewSessions![f.stage.id]!["1"]!) } };
      const why = "main conflicted with the change, so the Builder had to port it";
      await conflict("Main's first greeting\n");
      expect(f.task.reviewSessions).toBeUndefined();
      expect(f.task.reviewFreshReasons).toEqual({ [f.stage.id]: { "0": why, "1": why }, later: { "1": why } });
      f.task.stageIndex = f.task.plan!.stages.indexOf(later);
      expect(choose("0")).not.toHaveProperty("freshReason");
      expect(choose("1")).toMatchObject({ freshReason: why });
      f.task.stageIndex = 0;
      const round2 = await f.round(2);
      expect(round2).toHaveLength(2);
      for (const input of round2) expect(input).toMatchObject({ mode: "fresh", freshReason: why });
      expect(f.task.reviewFreshReasons).toEqual({ later: { "1": why } });
      // Another conflict drops the new conversations; the seat it found nothing for keeps its own reason.
      await conflict("Main's second greeting\n");
      expect(f.task.reviewFreshReasons).toEqual({ [f.stage.id]: { "0": why, "1": why }, later: { "1": why } });
      const round3 = await f.round(3);
      expect(round3).toHaveLength(2);
      for (const input of round3) expect(input).toMatchObject({ mode: "fresh", freshReason: why });
      // The next start returns to its conversation, with no stale explanation left over.
      const round4 = await f.round(4);
      expect(round4).toHaveLength(2);
      for (const input of round4) {
        expect(input.mode).toBe("continued");
        expect(input.freshReason).toBeUndefined();
      }
      expect(f.task.reviewFreshReasons).toEqual({ later: { "1": why } });
    } finally { await f.engine.shutdown(); }
  });

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
