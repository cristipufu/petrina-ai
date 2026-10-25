import { describe, expect, it } from "vitest";
import { reviewConversationScope, type CheckId } from "@petrina/core";
import { executionFor, repositoryView } from "../../../src/repository-context.js";
import { profileSelectionFixture } from "../../fixtures/profile-selection.js";

describe.concurrent("eligible saved review stand-ins", () => {
  it("waits only for a readiness check already running on an otherwise eligible saved tool", () => {
    const f = profileSelectionFixture();
    f.host.awayFromBuilder = () => false;
    f.state.pool.paused = false;
    f.state.setup!.checks = f.state.tools.map(tool => ({ id: tool.id as CheckId, status: "ready" }));
    const stage = { id: "review", title: "Review the greeting", kind: "review-chain" as const, roleId: "code-reviewer", profileIds: ["opus-high"] };
    f.task.plan = { rationale: "Return to the eligible participant", plannerProfileId: "sol-high", stages: [stage] };
    f.task.stageIndex = 0; f.task.rounds[stage.id] = 2;
    const scope = executionFor(f.task), planned = f.profile("opus-high")!, actual = f.profile("grok-high")!;
    const role = f.host.role(stage.roleId, f.task)!;
    const saved = { scope: reviewConversationScope(repositoryView(scope), stage.id, "0", role, planned, actual, text => f.host.digest(text)),
      round: 1, plannedProfileId: planned.id, profileId: actual.id, toolId: actual.toolId, model: actual.modelId ?? actual.model, sessionId: "completed-review-seat" };
    f.task.reviewSessions = { [stage.id]: { "0": saved } };
    const check = f.state.setup!.checks.find(check => check.id === saved.toolId)!;
    check.checking = true;
    expect(f.selection.choose(planned.id, scope, role.id, undefined, "0")).toEqual({ kind: "none", waiting: expect.stringContaining("before returning"), readiness: expect.objectContaining({ toolId: saved.toolId, profileId: saved.profileId }) });
    check.checking = false;
    expect(f.selection.choose(planned.id, scope, role.id, undefined, "0")).toEqual(expect.objectContaining({ profile: expect.objectContaining({ id: saved.profileId }) }));
  });
});
