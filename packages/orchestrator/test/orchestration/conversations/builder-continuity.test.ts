import { describe, expect, it } from "vitest";
import { slotUses, slotWait, stepKey } from "@petrina/core";
import { executionFor } from "../../../src/repository-context.js";
import { profileSelectionFixture } from "../../fixtures/profile-selection.js";
const later = (f: ReturnType<typeof profileSelectionFixture>) => f.now() + 3_600_000;
function roomierAlternative(f: ReturnType<typeof profileSelectionFixture>) {
  f.state.pool.usage = [
    { toolId: "codex", kind: "weekly", status: "allowed", utilization: 0.33, at: f.now(), resetsAt: later(f) },
    { toolId: "grok", kind: "weekly", status: "allowed", utilization: 0.01, at: f.now(), resetsAt: later(f) },
  ];
}
describe("Builder continuity boundaries", () => {
it("keeps usage, readiness, models, seats, pauses, plan changes and step-back rules", async () => {
    const f = profileSelectionFixture();
    const task = f.task, id = task.id;
    task.stageIndex = 0;
    task.plan = { rationale: "Build", plannerProfileId: "opus-high", stages: [
      { id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["opus-high"] },
      { id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["sol-high", "grok-high"] },
    ] };
    task.fixing = true;
    executionFor(task).work.builderSession = { stageId: "build", profileId: "opus-high", toolId: "codex", model: "gpt-6.1-sol", sessionId: "saved" };
    f.state.setup!.checks = ["claude-code", "codex", "grok"].map((id) => ({ id: id as "codex", status: "ready" }));
    f.state.pool.paused = false;
    f.state.pool.limit = 3;
    f.state.pool.limited = [{ toolId: "claude-code", until: later(f), reason: "Claude Code is out" }];
    roomierAlternative(f);
    const snapshot = structuredClone({ task, pool: f.state.pool, profiles: f.state.profiles, checks: f.state.setup!.checks });
    const reset = () => {
      Object.assign(task, structuredClone(snapshot.task));
      delete executionFor(task).work.conversation;
      f.state.tasks = [task];
      f.state.pool = structuredClone(snapshot.pool);
      f.state.profiles = structuredClone(snapshot.profiles);
      f.state.setup!.checks = structuredClone(snapshot.checks);
    };
    const choose = (planned = "opus-high", role = "builder") => f.selection.choose(planned, task, role, (toolId) => !slotWait(f.snapshot(), { taskId: id, toolId }));
    const tool = () => { const choice = choose(); return choice?.kind === "none" ? "none" : choice?.profile.toolId; };
      expect(tool()).toBe("codex");
      f.state.pool.usage = f.state.pool.usage!.filter((entry) => entry.toolId !== "grok");
      expect(tool()).toBe("codex"); // Unknown Grok usage must not discard a healthy saved Codex.
      const handoffs: [string, () => void][] = [
        ["tool usage exhausted", () => { f.state.pool.limited!.push({ toolId: "codex", until: later(f), reason: "Codex is out" }); }],
        ["saved model exhausted", () => { f.state.pool.limited!.push({ toolId: "codex", model: "sol", until: later(f), reason: "Sol is out" }); }],
        ["90% near-limit mark", () => { f.state.pool.usage![0]!.utilization = 0.9; }],
        ["usage warning at the 90% mark", () => { Object.assign(f.state.pool.usage![0]!, { status: "allowed_warning", utilization: 0.9 }); }],
        ["no headroom on extra usage", () => { Object.assign(f.state.pool.usage![0]!, { status: "rejected", overage: true }); }],
        ["logged out", () => { f.state.setup!.checks[1]!.status = "logged-out"; }],
        ["not installed", () => { f.state.setup!.checks[1]!.status = "not-installed"; }],
        ["recently unverified with Ready alternatives", () => { Object.assign(f.state.setup!.checks[1]!, { status: "unknown", at: f.now() }); }],
        ["removed profiles", () => { f.state.profiles = f.state.profiles.filter((profile) => profile.toolId !== "codex"); }],
        ["different stage", () => { executionFor(task).work.builderSession!.stageId = "other"; }],
        ["changed plan effort", () => { executionFor(task).work.builderSession!.profileId = "opus-xhigh"; }],
        ["removed saved model", () => { executionFor(task).work.builderSession!.model = "removed-model"; }],
        ["fresh step-back round", () => { task.rounds["review"] = 4; }],
        ["new build", () => { task.fixing = false; }],
        ["no saved-tool capacity", () => { f.state.pool.toolCaps["codex"] = 0; }],
      ];
      for (const [why, change] of handoffs) {
        reset(); change(); expect(tool(), why).toBe("grok");
      }
      // An older or undated uncertain answer gets one bounded recheck first; its recorded answer then decides.
      for (const at of [undefined, f.now() - 5 * 60_000]) {
        reset(); Object.assign(f.state.setup!.checks[1]!, { status: "unknown", at });
        const waiting = choose();
        expect(waiting).toEqual({ kind: "none", waiting: "Checking Codex before the Builder returns", readiness: expect.objectContaining({ toolId: "codex", profileId: "sol-high" }) });
        if (waiting?.kind !== "none" || !waiting.readiness) throw new Error("No readiness decision");
        waiting.readiness.saved.readinessWait = { at: f.now() - 1, toolId: "codex", previous: { status: "unknown", ...(at ? { at } : {}) }, check: "started" };
        expect(tool()).toBe("none");
        f.state.setup!.checks[1]!.at = f.now();
        expect(choose()).toEqual(expect.objectContaining({ profile: expect.objectContaining({ toolId: "grok" }), freshReason: "its saved tool's readiness recheck was inconclusive", readiness: expect.objectContaining({ outcome: "unknown", check: "started" }) }));
      }
      // A provider warning at 33%, or without a percentage, keeps the healthy saved Builder.
      for (const utilization of [0.33, undefined]) {
        reset(); Object.assign(f.state.pool.usage![0]!, { status: "allowed_warning", utilization }); expect(tool(), `warning at ${utilization}`).toBe("codex");
      }
      reset();
      // A fallback build records who finished it, and still resumes for the profile the plan asked for.
      executionFor(task).work.builderSession = { stageId: "build", profileId: "sol-high", plannedProfileId: "opus-high", toolId: "codex", model: "gpt-6.1-sol", sessionId: "saved" };
      expect(tool()).toBe("codex");
      executionFor(task).work.builderSession!.plannedProfileId = "opus-xhigh";
      expect(tool()).toBe("grok");
      reset();
      expect(choose("grok-high")).toEqual(expect.objectContaining({ kind: "planned", profile: expect.objectContaining({ id: "grok-high" }) }));
      reset();
      executionFor(task).work.conversation = { step: stepKey(task), roleId: "builder", profileId: "sol-high", plannedProfileId: "opus-high", toolId: "codex", model: "gpt-6.1-sol", sessionId: "active", startedAt: f.now(), briefed: true };
      expect(tool()).toBe("codex");
      executionFor(task).work.conversation!.plannedProfileId = "opus-xhigh";
      expect(tool()).toBe("grok");
      executionFor(task).work.conversation!.plannedProfileId = "opus-high";
      executionFor(task).work.conversation!.briefed = false;
      expect(tool()).toBe("grok");
      reset();
      f.state.pool.usage![0]!.utilization = 0.8;
      f.state.pool.toolCaps["codex"] = 2;
      f.state.tasks.push({ ...structuredClone(task), id: "busy", state: "running", holdsSlot: true, agent: { roleId: "builder", profileId: "sol-high", since: f.now(), step: 0 } });
      expect(slotUses(f.snapshot())).toHaveLength(1);
      expect(tool()).toBe("grok"); // The existing 80% slowdown halves the cap.
      f.state.pool.usage![0]!.utilization = 0.33;
      expect(tool()).toBe("codex"); // A seat is available again.
      f.state.pool.toolCaps["codex"] = 1;
      expect(tool()).toBe("grok");
      // Both the saved fallback and the now-recovered planned tool are full: use free Grok.
      f.state.pool.limited = [];
      f.state.pool.toolCaps["claude-code"] = 1;
      f.state.tasks.push({ ...structuredClone(task), id: "busy-claude", state: "running", holdsSlot: true, agent: { roleId: "builder", profileId: "opus-high", since: f.now(), step: 0 } });
      expect(tool()).toBe("grok");
      f.state.pool.limited = [{ toolId: "grok", until: later(f), reason: "Grok is out" }];
      expect(tool()).toBe("claude-code"); // With no usable alternative, wait for capacity.
      reset(); f.state.pool.paused = true;
      expect(slotWait(f.snapshot(), { taskId: id, toolId: "codex" })).toBe("Waiting for the pool to resume");
      reset(); f.state.pool.limit = 0;
      expect(slotWait(f.snapshot(), { taskId: id, toolId: "codex" })).toBe("Waiting for a free slot");
      reset();
      expect(choose("opus-high", "release-manager")?.kind).toBe("substitute");
      expect(choose("opus-high", "release-manager")).toEqual(expect.objectContaining({ profile: expect.objectContaining({ toolId: "grok" }) }));
  });
});
