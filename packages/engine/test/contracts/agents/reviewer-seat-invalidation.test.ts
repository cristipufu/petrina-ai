import { afterAll, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { git } from "../../fixtures.js";
import { FixtureTrace } from "../../fixture-trace.js";
import { participantConversationFixtures } from "../../fixtures/participant-conversation.js";

const { fixture, close } = participantConversationFixtures();
afterAll(close);
describe.concurrent("eligible saved review stand-ins", () => {
for (const changed of ["assignment", "starting point", "context", "native"] as const) {
    it(`starts fresh with the recorded reason after ${changed} changes`, async () => {
      const trace = new FixtureTrace(`Review fixture after ${changed} changes`);
      const f = await fixture(false, "code-reviewer", trace).catch((error) => {
        trace?.report("setup failed", error); trace?.close(); throw error;
      });
      try {
        const saved = (await f.first())["0"]!;
        trace?.mark("Applying the controlled seat change");
        let reason: string = changed;
        if (changed === "assignment") { f.stage.profileIds[0] = "grok-high"; reason = "you changed who works"; }
        else if (changed === "starting point") {
          await f.run(async () => {
            const repo = f.scope.work.worktree!;
            const replacement = await git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit-tree", `${f.scope.work.baseSha}^{tree}`, "-m", "Replace starting history");
            await git(repo, "reset", "--hard", replacement);
            f.scope.work.baseSha = replacement;
          });
          reason = "starting branch's history was replaced or diverged";
        }
        else if (changed === "context") { rmSync(saved.context!.file); reason = "saved context is unavailable"; }
        else if (changed === "native") { rmSync(join(f.fakes.dir, "conversations", `${saved.sessionId}.json`)); reason = "could not reopen"; }
        const inputs = await f.round(2);
        trace?.mark("Checking the fresh conversation and selection reason");
        const input = inputs.find((input) => input.reviewerKey === "0")!;
        expect(input.mode).toBe("fresh");
        expect(input.taskDescription).toContain("ORIGINAL-SEAT-REQUEST");
        expect(input.selectionReason).toContain(reason);
        expect(input.sections.some((section) => section.title === "Design brief")).toBe(true);
        expect(f.task.timeline.some((entry) => entry.text.includes(reason))).toBe(true);
        const current = f.task.reviewSessions![f.stage.id]!["0"]!;
        const prompts = f.fakes.received().filter((entry) => entry.session === current.sessionId);
        expect(prompts).toHaveLength(1);
        expect(prompts[0]!.text).toContain("ORIGINAL-SEAT-REQUEST");
        expect(prompts[0]!.text).toContain("UNCHANGED-BRIEF");
        if (["context", "native", "starting point"].includes(changed)) {
          expect(input.profileId).toBe("opus-high");
          expect(f.fakes.received().filter((entry) => entry.session === saved.sessionId)).toHaveLength(1);
        }
        if (changed === "native") {
          expect(f.task.timeline.filter((entry) => entry.tone === "milestone" && entry.roleId === f.stage.roleId && entry.profileId === saved.profileId)).toHaveLength(1);
          expect(f.task.timeline.filter((entry) => entry.tone === "milestone" && entry.roleId === f.stage.roleId && entry.profileId === input.profileId)).toHaveLength(1);
        }
      } catch (error) {
        trace?.report("test failed", error); throw error;
      } finally {
        try {
          await (trace ? trace.during("Stopping the fixture engine", () => f.engine.shutdown()) : f.engine.shutdown());
        } finally { f.closeTrace(); }
      }
    });
  }

});
