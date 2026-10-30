import { afterAll, describe, expect, it } from "bun:test";
import { participantConversationFixtures } from "../../fixtures/participant-conversation.js";

const { fixture, close } = participantConversationFixtures();
afterAll(close);
describe.concurrent("eligible saved review stand-ins", () => {
for (const passed of [true, false]) it(`keeps completed reviewer seats for a same-round return after ${passed ? "passing" : "the coordinator checkpoint"}`, async () => {
    const f = await fixture(true);
    try {
      await f.round(1);
      const saved = structuredClone(f.task.reviewSessions![f.stage.id]!);
      if (!passed) f.task.findings.push({ id: "still-open", text: "A confirmed problem", severity: "blocking", status: "open", raisedBy: "opus-high", confirmedBy: [] });
      await f.engine["reviews"]["closeReviewRound"](f.task, f.stage, 1, "Reviewed");
      expect(f.task.reviewSessions![f.stage.id]).toEqual(saved);
      // A later repair returns to this stage without granting a new numbered review round.
      f.task.stageIndex = 0; f.task.state = "waiting"; f.engine.s.inbox = [];
      f.scope.work.report!.summary = "A late check repair";
      const inputs = await f.round(1);
      expect(inputs).toHaveLength(2);
      for (const input of inputs) {
        expect(input.mode).toBe("continued");
        expect(input.sessionId).toBe(saved[input.reviewerKey!]!.sessionId);
        expect(input.taskDescription).toBeUndefined();
        expect(JSON.stringify(input.sections)).toContain("A late check repair");
      }
      expect(f.task.rounds[f.stage.id]).toBe(1);
      f.engine.cancel(f.task.id);
      expect(f.task.reviewSessions).toBeUndefined();
    } finally { await f.engine.shutdown(); }
  });

});
