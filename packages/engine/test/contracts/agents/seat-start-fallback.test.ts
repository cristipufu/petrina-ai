import { rejectionOf } from "@petrina/test-support/rejections";
import { afterAll, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { participantConversationFixtures } from "../../fixtures/participant-conversation.js";

const { fixture, close } = participantConversationFixtures();
afterAll(close);
describe.concurrent("eligible saved review stand-ins", () => {
for (const pair of [false, true]) it(`records the attempted ${pair ? "parallel" : "single"} seat when its fresh tool cannot start`, async () => {
    const f = await fixture(pair);
    try {
      const command = f.engine.options.agentCommand!;
      f.engine.options.agentCommand = (profile) => profile.toolId === "claude-code"
        ? [process.execPath, join(import.meta.dir, "../../fake-agent.ts"), "--wont-start"] : command(profile);
      await f.withRound(1, async raw => {
        expect(await rejectionOf(raw)).toMatchObject({ toolId: "claude-code", status: "wont-start" });
      });
      expect(f.task.timeline.filter((entry) => entry.tone === "milestone" && entry.roleId === f.stage.roleId && entry.profileId === "opus-high")).toHaveLength(1);
      expect(f.task.session.filter((entry) => entry.from === "system" && entry.profileId === "opus-high" && entry.text.includes("joined ·"))).toHaveLength(1);
      expect(f.task.journey!.flatMap((step) => step.agentInputs ?? []).filter((input) => input.profileId === "opus-high")).toHaveLength(0);
    } finally { await f.engine.shutdown(); }
  });

for (const pair of [false, true]) it(`announces each ${pair ? "parallel" : "single"} seat only once when a failed reopen selects the same planned profile`, async () => {
    const f = await fixture(pair);
    try {
      await f.round(1);
      const saved = structuredClone(f.task.reviewSessions![f.stage.id]!);
      for (const seat of Object.values(saved)) rmSync(join(f.fakes.dir, "conversations", `${seat.sessionId}.json`));
      const note = { id: "current-revision", at: 1, text: "CURRENT-REVISION-NOTE" };
      f.task.notes = [note];
      f.task.stepNotes = [{ ...note, kind: "changes" }];
      const inputs = await f.round(2);
      expect(inputs).toHaveLength(pair ? 2 : 1);
      for (const input of inputs) {
        const prior = saved[input.reviewerKey!]!;
        expect(input.mode).toBe("fresh");
        expect(input.profileId).toBe(prior.profileId);
        expect(input.selectionReason).toContain("could not reopen");
        expect(input.taskDescription).toBe("ORIGINAL-SEAT-REQUEST");
        expect(input.sections.find((section) => section.title.startsWith("The coordinator's notes"))?.body).toContain(note.text);
        expect(input.sections.some((section) => section.title === "What the coordinator said in an earlier attempt at this step")).toBe(false);
        expect(f.fakes.received().filter((entry) => entry.session === prior.sessionId)).toHaveLength(1);
        expect(f.task.timeline.filter((entry) => entry.tone === "milestone" && entry.roleId === f.stage.roleId && entry.profileId === prior.profileId)).toHaveLength(2);
        expect(f.task.session.filter((entry) => entry.from === "system" && entry.profileId === prior.profileId && entry.text.includes("joined ·"))).toHaveLength(2);
      }
    } finally { await f.engine.shutdown(); }
  });

});
