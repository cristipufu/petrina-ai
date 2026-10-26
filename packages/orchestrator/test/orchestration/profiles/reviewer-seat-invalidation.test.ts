import { describe, expect, it } from "vitest";
import { reviewParticipantFixture } from "../../fixtures/review-participants.js";

describe.concurrent("eligible saved review stand-ins", () => {
  for (const changed of ["assignment to saved", "chosen", "usage", "capacity", "readiness", "login", "removed", "planned removed", "cap", "effort", "standby", "request", "role", "source", "port", "peer", "builder"] as const) {
    it(`starts fresh with the recorded reason after ${changed} changes`, () => {
      const f = reviewParticipantFixture(changed === "peer", changed === "builder");
      const { state, task, saved, stage, scope } = f;
      const kept = f.choose();
      expect(kept).toMatchObject({ kind: "substitute", profile: { id: saved.profileId }, reason: expect.stringContaining("Kept its own conversation") });
      expect(f.prior()).toMatchObject({ prior: { sessionId: saved.sessionId }, actual: { id: saved.profileId }, reason: undefined });
      let reason: string = changed;
      if (changed === "assignment to saved") { stage.profileIds[0] = saved.profileId; reason = "you changed who works"; }
      else if (changed === "chosen") { Object.assign(stage, { assignments: [{ profileId: "opus-high", by: "coordinator" }] }); reason = "you chose this seat"; }
      else if (changed === "usage") { state.pool.limited = [{ toolId: saved.toolId, until: f.now() + 3_600_000, reason: "Out" }]; reason = "out of usage"; }
      else if (changed === "capacity") { task.modelCapacity = [{ toolId: saved.toolId, modelId: saved.model, profileId: saved.profileId, until: f.now() + 3_600_000 }]; reason = "saved model is full"; }
      else if (changed === "readiness" || changed === "login") { state.setup!.checks.find(check => check.id === saved.toolId)!.status = changed === "login" ? "logged-out" : "not-installed"; reason = changed === "login" ? "logged out" : "not installed"; }
      else if (changed === "removed") { state.retiredProfiles = [f.profile(saved.profileId)!]; state.profiles = state.profiles.filter(profile => profile.id !== saved.profileId); reason = "no longer offered"; }
      else if (changed === "planned removed") { state.retiredProfiles = [f.profile("opus-high")!]; state.profiles = state.profiles.filter(profile => profile.id !== "opus-high"); reason = "planned profile is no longer offered"; }
      else if (changed === "cap") { state.pool.toolCaps[saved.toolId] = 0; reason = "no free agent slot"; }
      else if (changed === "effort" || changed === "standby") {
        const profile = state.profiles.find(profile => profile.id === saved.profileId)!;
        if (changed === "effort") profile.effort = "medium"; else profile.standby = true;
        f.rebindObservation(); reason = changed === "effort" ? "different effort" : "standby profile";
      } else if (changed === "request") { task.description += " revised"; reason = "role, profile, request or starting point changed"; }
      else if (changed === "role") { state.roles.find(role => role.id === stage.roleId)!.instructions += " Revised"; reason = "role, profile, request or starting point changed"; }
      else if (changed === "source") { scope.work.source = { product: { id: task.productId, name: "Product", repo: "local/product" }, start: { kind: "branch", branch: "release" }, destination: { mode: "local", repo: "local/product", branch: "release", kind: "branch" }, confirmed: true }; reason = "role, profile, request or starting point changed"; }
      else if (changed === "port") { scope.work.portReview = { from: scope.work.baseSha!, head: scope.work.baseSha!, onto: scope.work.baseSha!, files: [] }; reason = "role, profile, request or starting point changed"; }
      else if (changed === "peer") { task.hunt = { stageId: stage.id, round: 2, reported: { "1": true }, profiles: { "1": saved.profileId } }; reason = "Selected a more independent tool or model for this review."; }
      else if (changed === "builder") { scope.work.builderSession = { stageId: "build", profileId: saved.profileId, toolId: saved.toolId, model: saved.model, sessionId: "observed-builder-session" }; reason = "Selected a more independent tool or model for this review."; }
      const selected = f.choose();
      expect(selected?.kind).not.toBe("none");
      if (!selected || selected.kind === "none") throw new Error("The invalidated participant did not get a fresh selection");
      expect(selected.reason).toContain(reason);
      expect(selected.freshReason).toBeDefined();
      if (changed === "peer" || changed === "builder") expect(selected.profile.toolId).not.toBe(saved.toolId);
      // A selection decision never claims that an adapter opened a new native session or rewrites the old observation.
      expect(task.reviewSessions![stage.id]!["0"]!.sessionId).toBe(saved.sessionId);
      expect(task.journey).toBeUndefined();
    });
  }
});
