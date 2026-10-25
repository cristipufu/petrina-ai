import { afterAll, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { git } from "../../fixtures.js";
import { FixtureTrace } from "../../fixture-trace.js";
import { participantConversationFixtures } from "../../fixtures/participant-conversation.js";

const { fixture, close } = participantConversationFixtures();
afterAll(close);
describe.concurrent("eligible saved review stand-ins", () => {
for (const changed of ["assignment", "assignment to saved", "chosen", "usage", "capacity", "readiness", "login", "removed", "planned removed", "cap", "effort", "standby", "request", "role", "source", "port", "starting point", "peer", "builder", "context", "native"] as const) {
    it(`starts fresh with the recorded reason after ${changed} changes`, async () => {
      const trace = new FixtureTrace(`Review fixture after ${changed} changes`);
      const f = await fixture(changed === "peer", changed === "builder" ? "security-reviewer" : "code-reviewer", trace).catch((error) => {
        trace?.report("setup failed", error); trace?.close(); throw error;
      });
      try {
        const saved = (await f.first())["0"]!;
        trace?.mark("Applying the controlled seat change");
        let reason: string = changed;
        if (changed === "assignment") { f.stage.profileIds[0] = "grok-high"; reason = "you changed who works"; }
        else if (changed === "assignment to saved") { f.stage.profileIds[0] = saved.profileId; reason = "you changed who works"; }
        else if (changed === "chosen") { Object.assign(f.stage, { assignments: [{ profileId: "opus-high", by: "coordinator" }] }); reason = "you chose this seat"; }
        else if (changed === "usage") { f.engine.s.pool.limited = [{ toolId: saved.toolId, until: Date.now() + 3_600_000, reason: "Out" }]; reason = "out of usage"; }
        else if (changed === "capacity") { f.task.modelCapacity = [{ toolId: saved.toolId, modelId: saved.model, profileId: saved.profileId, until: Date.now() + 3_600_000 }]; reason = "saved model is full"; }
        else if (changed === "readiness" || changed === "login") { f.engine.s.setup!.checks.find((check) => check.id === saved.toolId)!.status = changed === "login" ? "logged-out" : "not-installed"; reason = changed === "login" ? "logged out" : "not installed"; }
        else if (changed === "removed") { f.engine.s.retiredProfiles = [f.engine.profile(saved.profileId)!]; f.engine.s.profiles = f.engine.s.profiles.filter((profile) => profile.id !== saved.profileId); reason = "no longer offered"; }
        else if (changed === "planned removed") { f.engine.s.retiredProfiles = [f.engine.profile("opus-high")!]; f.engine.s.profiles = f.engine.s.profiles.filter((profile) => profile.id !== "opus-high"); reason = "planned profile is no longer offered"; }
        else if (changed === "cap") { f.engine.s.pool.toolCaps[saved.toolId] = 0; reason = "no free agent slot"; }
        else if (changed === "effort" || changed === "standby") {
          // A valid saved scope at another effort/standby still does not earn the preference.
          const profile = f.engine.s.profiles.find((profile) => profile.id === saved.profileId)!;
          if (changed === "effort") profile.effort = "medium"; else profile.standby = true;
          const { reviewScopeKey } = await import("../../../src/review-context.js");
          f.task.reviewSessions![f.stage.id]!["0"]!.scope = reviewScopeKey(f.scope, f.stage.id, "0", f.engine.role(f.stage.roleId)!, f.engine.profile("opus-high"), profile);
          reason = changed === "effort" ? "different effort" : "standby profile";
        } else if (changed === "request") { f.task.description += " revised"; reason = "role, profile, request or starting point changed"; }
        else if (changed === "role") { f.engine.s.roles.find((role) => role.id === f.stage.roleId)!.instructions += " Revised"; reason = "role, profile, request or starting point changed"; }
        else if (changed === "source") { f.scope.work.source = { product: { id: "p", name: "Product", repo: "local/product" }, start: { kind: "branch", branch: "release" }, destination: { mode: "local", repo: "local/product", branch: "release", kind: "branch" }, confirmed: true }; reason = "role, profile, request or starting point changed"; }
        else if (changed === "port") { f.scope.work.portReview = { from: f.scope.work.baseSha!, head: f.scope.work.baseSha!, onto: f.scope.work.baseSha!, files: [] }; reason = "role, profile, request or starting point changed"; }
        else if (changed === "starting point") {
          const repo = f.scope.work.worktree!;
          const replacement = await git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit-tree", `${f.scope.work.baseSha}^{tree}`, "-m", "Replace starting history");
          await git(repo, "reset", "--hard", replacement);
          f.scope.work.baseSha = replacement;
          reason = "starting branch's history was replaced or diverged";
        }
        else if (changed === "peer") { f.task.hunt = { stageId: f.stage.id, round: 2, reported: { "1": true }, profiles: { "1": saved.profileId } }; reason = "Selected a more independent tool or model for this review."; }
        else if (changed === "builder") { f.scope.work.builderSession = { stageId: "build", profileId: saved.profileId, toolId: saved.toolId, model: saved.model, sessionId: "builder-own" }; reason = "Selected a more independent tool or model for this review."; }
        else if (changed === "context") { rmSync(saved.context!.file); reason = "saved context is unavailable"; }
        else if (changed === "native") { rmSync(join(f.fakes.dir, "conversations", `${saved.sessionId}.json`)); reason = "could not reopen"; }
        const inputs = await f.round(2, changed === "peer" ? { "1": saved.profileId } : {});
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
        if (changed === "peer" || changed === "builder") expect(f.engine.profile(input.profileId)!.toolId).not.toBe(saved.toolId);
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
