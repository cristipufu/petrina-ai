import { afterAll, describe, expect, it } from "bun:test";
import { participantConversationFixtures } from "../../fixtures/participant-conversation.js";

const { fixture, close } = participantConversationFixtures();
afterAll(close);
describe.concurrent("eligible saved review stand-ins", () => {
for (const kind of ["single", "parallel", "security", "added"]) it(`keeps the ${kind} seats' own native conversations when planned profiles recover`, async () => {
    const pair = kind === "parallel";
    const f = await fixture(pair, kind === "security" ? "security-reviewer" : kind === "added" ? "added" : "code-reviewer");
    try {
      const saved = await f.first();
      expect(Object.values(saved).every((seat) => seat.profileId !== seat.plannedProfileId)).toBe(true);
      const booked = f.engine["driver"].workflow["seatOf"]({ roleId: f.stage.roleId, profileId: "opus-high", reviewerKey: "0" }, f.task);
      expect(booked.toolId).toBe(saved["0"]!.toolId);
      const inputs = await f.round(2);
      expect(inputs).toHaveLength(pair ? 2 : 1);
      for (const input of inputs) {
        const prior = saved[input.reviewerKey!]!;
        expect(input.mode).toBe("continued");
        expect(input.profileId).toBe(prior.profileId);
        expect(input.requestedProfileId).toBe(prior.plannedProfileId);
        expect(input.taskDescription).toBeUndefined();
        expect(input.selectionReason).toContain("while the planned");
        expect(input.selectionReason).toContain("is available");
        expect(input.sections.some((section) => section.title === "Design brief")).toBe(false);
        expect(JSON.stringify(input.sections)).toContain("CHANGED-BUILDER-REPORT");
        const prompts = f.fakes.received(f.engine.role(f.stage.roleId)!.name.toLowerCase()).filter((entry) => entry.session === prior.sessionId);
        expect(prompts).toHaveLength(2);
        expect(prompts[1]!.text).not.toContain("ORIGINAL-SEAT-REQUEST");
        expect(f.fakes.opens().filter((entry) => entry.session === prior.sessionId).map((entry) => entry.how)).toEqual(["new", "resume"]);
      }
      // Only the assigned seats opened conversations: no unrelated login probes in this fixture.
      expect(f.fakes.opens()).toHaveLength(pair ? 4 : 2);
      expect(new Set(inputs.map((input) => f.engine.profile(input.profileId)!.toolId)).size).toBe(inputs.length);
      expect(f.task.timeline.some((entry) => entry.text.includes("Kept its own conversation"))).toBe(true);
    } finally { await f.engine.shutdown(); }
  });

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
