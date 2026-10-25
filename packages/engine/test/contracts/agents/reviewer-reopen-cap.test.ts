import { expectRejection } from "@petrina/test-support/rejections";
import { afterAll, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { participantConversationFixtures } from "../../fixtures/participant-conversation.js";

const { fixture, close } = participantConversationFixtures();
afterAll(close);
describe.concurrent("eligible saved review stand-ins", () => {
it("checks the new tool's cap after a parallel reopen fails, and retains the reason through the wait", async () => {
    const f = await fixture(true);
    try {
      const saved = (await f.first())["0"]!;
      rmSync(join(f.fakes.dir, "conversations", `${saved.sessionId}.json`));
      f.engine.s.pool.toolCaps["claude-code"] = 0;
      const firstPrompts = f.fakes.received().length;
      await expectRejection(f.round(2), "Waiting for a free");
      expect(f.task.reviewSessions![f.stage.id]!["0"]!.freshReason).toContain("could not reopen");
      expect(f.task.journey!.at(-1)!.agentInputs!.some((input) => input.reviewerKey === "0")).toBe(false);
      expect(f.fakes.received().length).toBe(firstPrompts + 1); // Only the healthy peer received instructions.
      f.engine.s.pool.toolCaps["claude-code"] = 1;
      await f.engine["reviews"]["hunt"](f.task, f.stage, [{ key: "0", profileId: "opus-high" }], new AbortController().signal);
      const input = f.task.journey!.at(-1)!.agentInputs!.find((input) => input.reviewerKey === "0")!;
      expect(input.mode).toBe("fresh");
      expect(input.profileId).toBe("opus-high");
      expect(input.selectionReason).toContain("could not reopen");
      expect(input.taskDescription).toContain("ORIGINAL-SEAT-REQUEST");
    } finally { await f.engine.shutdown(); }
  });

});
