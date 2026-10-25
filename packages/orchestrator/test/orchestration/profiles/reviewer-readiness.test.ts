import { describe, expect, it } from "vitest";
import { profileSelectionFixture } from "../../fixtures/profile-selection.js";

describe.concurrent("reviews after a usage handoff", () => {
  for (const status of ["ready", "logged-out", "unknown"] as const) it(`keeps review replacements within the checked tools when Grok is ${status}`, () => {
    const f = profileSelectionFixture();
    f.host.awayFromBuilder = () => false;
    f.state.pool.paused = false; f.state.pool.limit = 1;
    f.state.setup!.checks = [{ id: "claude-code", status: "ready" }, { id: "codex", status: "ready" }, { id: "grok", status }, { id: "antigravity", status: "logged-out" }];
    const stage = { id: "review", title: "Review", kind: "review-chain" as const, roleId: "code-reviewer", profileIds: ["sol-high", "opus-high"] };
    f.task.plan = { rationale: "Independent checked tools", plannerProfileId: "sol-high", stages: [stage] };
    f.task.stageIndex = 0;
    const first = f.selection.choose("sol-high", f.task, "code-reviewer", undefined, "0")!;
    if (first.kind === "none") throw new Error(first.waiting);
    f.task.hunt = { stageId: stage.id, round: 1, reported: { "0": true }, profiles: { "0": first.profile.id } };
    f.state.pool.limited = [{ toolId: "claude-code", until: f.now() + 3_600_000, reason: "Claude Code's usage limit" }];
    const second = f.selection.choose("opus-high", f.task, "code-reviewer", undefined, "1")!;
    if (second.kind === "none") throw new Error(second.waiting);
    expect([first.profile.id, second.profile.id]).toEqual(["sol-high", status === "ready" ? "grok-high" : "sol-high"]);
    expect([first.profile.modelId, second.profile.modelId].includes("grok-4.7")).toBe(status === "ready");
  });
});
