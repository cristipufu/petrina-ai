import { engineCaseFixtures, type EngineCaseOwner } from "../../fixtures/engine-cases.js";
import { afterAll, describe, expect, it } from "bun:test";
import { slotWait } from "@petrina/core";
import { Engine } from "../../engine.js";
import { executionFor } from "@petrina/orchestrator";
import { capacityWaiting } from "../../../src/usage.js";

const engineCases = engineCaseFixtures();
afterAll(() => engineCases.close());
describe("choosing who continues after a model fills up", () => {
  function choiceEngine(caseOwner: EngineCaseOwner) {
    const root = caseOwner.root;
    const engine = caseOwner.open(root, { agentCommand: () => ["unused"], toolPath: () => process.execPath });
    engine.setPoolPaused(true);
    engine.s.products.push({ id: "product", name: "Product", repo: "a/b", tone: "blue", delivery: "local", approveDelivery: true });
    engine.s.setup!.checks = ["claude-code", "codex", "grok", "antigravity"].map((id) => ({ id: id as "codex", status: "ready" as const }));
    const id = engine.addTask({ productId: "product", title: "Build" });
    const task = engine.s.tasks.find((entry) => entry.id === id)!;
    engine.s.pool.paused = false;
    const room = (toolId: string) => !slotWait(engine.getState(), { taskId: id, toolId });
    const profileOf = (planned: string, role: string, reviewerKey?: string) => {
      const choice = engine.choose(planned, task, role, room, reviewerKey);
      return choice?.kind === "none" ? undefined : choice?.profile;
    };
    return { engine, task, profileOf };
  }
  it("uses a free tool when the preferred tool has no seat, and keeps a review off the builder's tool", async () => {
  return engineCases.use("petrina-capacity-choice-", async caseOwner => {
    const { engine, task, profileOf } = choiceEngine(caseOwner);
    const soon = Date.now() + 60_000;
    try {
      engine.s.setup!.checks = [
        { id: "claude-code", status: "ready" },
        { id: "codex", status: "ready" },
        { id: "grok", status: "logged-out" },
        { id: "antigravity", status: "logged-out" },
      ];
      task.stageIndex = 0;
      task.plan = { rationale: "Build", plannerProfileId: "sol-xhigh", stages: [
        { id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
      ] };
      task.modelCapacity = [{ toolId: "codex", modelId: "gpt-6.1-sol", profileId: "sol-xhigh", until: soon }];
      expect(profileOf("sol-xhigh", "builder")?.id).toBe("astra-xhigh");
      engine.s.pool.toolCaps["codex"] = 0;
      expect(profileOf("sol-xhigh", "builder")?.toolId).toBe("claude-code");
      delete task.modelCapacity;
      engine.s.pool.toolCaps["codex"] = 3;
      engine.s.pool.limited = [{ toolId: "codex", until: soon, reason: "Codex is out" }];
      expect(profileOf("sol-xhigh", "builder")?.toolId).toBe("claude-code");
      engine.s.pool.limited = [];
      engine.s.pool.toolCaps["codex"] = 0;
      task.modelCapacity = [{ toolId: "codex", modelId: "gpt-6.1-sol", profileId: "sol-xhigh", until: soon }];
      task.plan = { rationale: "Review", plannerProfileId: "opus-high", stages: [
        { id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["sol-xhigh", "opus-high"] },
      ] };
      expect(profileOf("sol-xhigh", "code-reviewer", "0")?.id).toBe("astra-xhigh");
      engine.s.pool.toolCaps["codex"] = 3;
      engine.s.setup!.checks = ["claude-code", "codex", "grok", "antigravity"].map((id) => ({ id: id as "codex", status: "ready" as const }));
      task.stageIndex = 1;
      task.plan = { rationale: "Build", plannerProfileId: "opus-high", stages: [
        { id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["opus-xhigh"] },
        { id: "security", kind: "review-chain", title: "Security", roleId: "security-reviewer", profileIds: ["opus-xhigh"] },
      ] };
      executionFor(task).work.builderSession = { stageId: "build", profileId: "opus-xhigh", toolId: "claude-code", model: "opus", sessionId: "saved" };
      expect(profileOf("opus-xhigh", "security-reviewer")?.toolId).not.toBe("claude-code");
      task.modelCapacity = [{ toolId: "codex", modelId: "gpt-6.1-sol", profileId: "sol-xhigh", until: soon }];
      expect(profileOf("opus-xhigh", "security-reviewer")?.toolId).not.toBe("claude-code");
    } finally { await caseOwner.stop(engine); }
  });
});
  it("continues a replacement's conversation only when it has a seat and usage, and stays off the builder's tool", async () => {
  return engineCases.use("petrina-capacity-choice-", async caseOwner => {
    const { engine, task, profileOf } = choiceEngine(caseOwner);
    const later = Date.now() + 5 * 60_000;
    const hours = Date.now() + 5 * 60 * 60_000;
    try {
      engine.s.setup!.checks = [
        { id: "claude-code", status: "ready" },
        { id: "codex", status: "ready" },
        { id: "grok", status: "logged-out" },
        { id: "antigravity", status: "logged-out" },
      ];
      task.stageIndex = 0;
      task.plan = { rationale: "Build", plannerProfileId: "sol-xhigh", stages: [
        { id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
      ] };
      // The first Codex model is still full. The second one took over, filled up too, and is owed its short continue.
      const owe = (roleId: string, member?: string) => {
        task.modelCapacity = [{ toolId: "codex", modelId: "gpt-6.1-sol", profileId: "sol-xhigh", until: later }];
        task.capacityResume = [{ sessionId: "astra-session", profileId: "astra-xhigh", roleId, toolId: "codex", model: "gpt-6-astra", ...(member ? { member } : {}) }];
        task.capacityRetries = [{ toolId: "codex", modelId: "gpt-6-astra", profileId: "astra-xhigh", roleId, tried: 1, ...(member ? { member } : {}) }];
      };
      for (const [roleId, key, member] of [["builder", undefined, undefined], ["code-reviewer", "0", "review-0"]] as const) {
        owe(roleId, member);
        expect(profileOf("sol-xhigh", roleId, key)?.id).toBe("astra-xhigh");
        // No free Codex seat: a free tool takes the step instead of waiting for Codex.
        engine.s.pool.toolCaps["codex"] = 0;
        expect(profileOf("sol-xhigh", roleId, key)?.toolId).toBe("claude-code");
        delete task.capacityResume;
        expect(profileOf("sol-xhigh", roleId, key)?.toolId).toBe("claude-code");
        engine.s.pool.toolCaps["codex"] = 3;
        // Codex is out of account usage for hours: the existing stand-in still takes the step.
        owe(roleId, member);
        engine.s.pool.limited = [{ toolId: "codex", until: hours, reason: "Codex's weekly limit" }];
        expect(profileOf("sol-xhigh", roleId, key)?.toolId).toBe("claude-code");
        delete task.capacityResume;
        expect(profileOf("sol-xhigh", roleId, key)?.toolId).toBe("claude-code");
        engine.s.pool.limited = [];
      }
      // A security review stays off the builder's tool even when its own conversation there is owed a continue.
      task.stageIndex = 1;
      task.plan = { rationale: "Build", plannerProfileId: "sol-xhigh", stages: [
        { id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
        { id: "security", kind: "review-chain", title: "Security", roleId: "security-reviewer", profileIds: ["sol-xhigh"] },
      ] };
      executionFor(task).work.builderSession = { stageId: "build", profileId: "astra-xhigh", toolId: "codex", model: "gpt-6-astra", sessionId: "built" };
      owe("security-reviewer");
      expect(profileOf("sol-xhigh", "security-reviewer")?.toolId).toBe("claude-code");
    } finally { await caseOwner.stop(engine); }
  });
});
  it("waits for the account, not the full model, when the account is out too", async () => {
  return engineCases.use("petrina-capacity-choice-", async caseOwner => {
    const { engine, task } = choiceEngine(caseOwner);
    const later = Date.now() + 5 * 60_000;
    const hours = Date.now() + 5 * 60 * 60_000;
    const capacityWait = (choice: ReturnType<Engine["choose"]>) => choice?.kind === "none" && choice.waiting.startsWith("The selected model is at capacity");
    const usageWait = (choice: ReturnType<Engine["choose"]>) => choice?.kind === "none" && choice.waiting.startsWith("Waiting for usage");
    try {
      engine.s.setup!.checks = [
        { id: "claude-code", status: "ready" },
        { id: "codex", status: "ready" },
        { id: "grok", status: "logged-out" },
        { id: "antigravity", status: "logged-out" },
      ];
      const codexModels = [...new Set(engine.s.profiles.filter((profile) => profile.toolId === "codex").map((profile) => profile.modelId ?? profile.model))];
      const allFull = () => codexModels.map((modelId) => ({ toolId: "codex", modelId, profileId: "sol-xhigh", until: later }));
      task.stageIndex = 0;
      task.plan = { rationale: "Build", plannerProfileId: "sol-xhigh", stages: [
        { id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
      ] };
      // Every Codex model is full and Claude is out: the task waits for the full model.
      task.modelCapacity = allFull();
      engine.s.pool.limited = [{ toolId: "claude-code", until: hours, reason: "Claude's weekly limit" }];
      expect(capacityWait(engine.choose("sol-xhigh", task, "builder"))).toBe(true);
      // Codex's account is out as well: the wait is the account limit's.
      engine.s.pool.limited = [...engine.s.pool.limited, { toolId: "codex", until: hours, reason: "Codex's weekly limit" }];
      expect(usageWait(engine.choose("sol-xhigh", task, "builder"))).toBe(true);
      // A voter keeps its seat for a full model, but not for an account limit.
      engine.s.pool.limited = [];
      expect(capacityWait(engine.choose("sol-high", task, "verifier"))).toBe(true);
      engine.s.pool.limited = [{ toolId: "codex", until: hours, reason: "Codex's weekly limit" }];
      expect(capacityWait(engine.choose("sol-high", task, "verifier"))).toBe(false);
      // A scheduled run waits for its saved profile's account the same way.
      const sol = engine.s.profiles.find((profile) => profile.id === "sol-xhigh")!;
      (task as { maintenance?: unknown }).maintenance = { role: engine.s.roles.find((role) => role.id === "maintenance-bug-finder"), profile: sol };
      expect(engine.choose("sol-xhigh", task, "maintenance-bug-finder")).toEqual({ kind: "none", waiting: "Waiting for usage on the saved maintenance profile" });
      engine.s.pool.limited = [];
      expect(capacityWait(engine.choose("sol-xhigh", task, "maintenance-bug-finder"))).toBe(true);
    } finally { await caseOwner.stop(engine); }
  });
});
  it("holds a replacement's own short retry, and not a different step", async () => {
  return engineCases.use("petrina-capacity-choice-", async caseOwner => {
    const { engine, task, profileOf } = choiceEngine(caseOwner);
    const now = Date.now();
    const soon = now + 5_000;
    const later = now + 5 * 60_000;
    try {
      task.stageIndex = 0;
      task.plan = { rationale: "Build", plannerProfileId: "sol-xhigh", stages: [
        { id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
      ] };
      task.modelCapacity = [
        { toolId: "codex", modelId: "gpt-6.1-sol", profileId: "sol-xhigh", until: later },
        { toolId: "codex", modelId: "gpt-6-astra", profileId: "astra-xhigh", until: soon },
      ];
      task.capacityPaused = [{ toolId: "codex", modelId: "gpt-6-astra", profileId: "astra-xhigh", roleId: "builder", plannedId: "sol-xhigh" }];
      expect(engine.choose("sol-xhigh", task, "builder")).toEqual({ kind: "none", waiting: capacityWaiting(soon, Date.now()) });
      expect(engine.choose("astra-xhigh", task, "builder")).toEqual({ kind: "none", waiting: capacityWaiting(soon, Date.now()) });
      expect(engine.choose("sol-xhigh", task, "code-reviewer")).not.toEqual({ kind: "none", waiting: capacityWaiting(soon, Date.now()) });
      task.modelCapacity = [{ toolId: "codex", modelId: "gpt-6-astra", profileId: "astra-xhigh", until: soon }];
      task.capacityPaused = [{ toolId: "codex", modelId: "gpt-6-astra", profileId: "astra-xhigh", roleId: "builder", plannedId: "astra-xhigh" }];
      expect(engine.choose("astra-xhigh", task, "builder")?.kind).toBe("none");
      expect(profileOf("sol-xhigh", "builder")?.id).toBe("sol-xhigh");
      task.modelCapacity = [{ toolId: "codex", modelId: "gpt-6.1-sol", profileId: "sol-xhigh", until: later }];
      task.capacityPaused = [{ toolId: "codex", modelId: "gpt-6-astra", profileId: "astra-xhigh", roleId: "builder", plannedId: "sol-xhigh" }];
      expect(profileOf("sol-xhigh", "builder")?.id).toBe("astra-xhigh");
      // Both waits have ended, so the pause is gone and the original model is free. The replacement's saved conversation still goes on.
      delete task.modelCapacity;
      delete task.capacityPaused;
      task.capacityResume = [{ sessionId: "astra-session", profileId: "astra-xhigh", roleId: "builder", toolId: "codex", model: "gpt-6-astra" }];
      task.capacityRetries = [{ toolId: "codex", modelId: "gpt-6-astra", profileId: "astra-xhigh", roleId: "builder", tried: 1 }];
      expect(profileOf("sol-xhigh", "builder")?.id).toBe("astra-xhigh");
      expect(profileOf("sol-xhigh", "code-reviewer")?.id).not.toBe("astra-xhigh");
      delete task.capacityResume;
      expect(profileOf("sol-xhigh", "builder")?.id).toBe("sol-xhigh");
      task.capacityResume = [
        { sessionId: "review-astra", profileId: "astra-xhigh", roleId: "code-reviewer", toolId: "codex", model: "gpt-6-astra", member: "review-0" },
        { sessionId: "review-opus", profileId: "opus-high", roleId: "code-reviewer", toolId: "claude-code", model: "opus", member: "review-1" },
      ];
      task.capacityRetries = [
        { toolId: "codex", modelId: "gpt-6-astra", profileId: "astra-xhigh", roleId: "code-reviewer", member: "review-0", tried: 1 },
        { toolId: "claude-code", modelId: "opus", profileId: "opus-high", roleId: "code-reviewer", member: "review-1", tried: 1 },
      ];
      expect(profileOf("sol-xhigh", "code-reviewer", "0")?.id).toBe("astra-xhigh");
      expect(profileOf("opus-high", "code-reviewer", "1")?.id).toBe("opus-high");
      task.capacityResume = [{ sessionId: "vote-astra", profileId: "astra-xhigh", roleId: "verifier", toolId: "codex", model: "gpt-6-astra", member: "vote-sol-high" }];
      task.capacityRetries = [{ toolId: "codex", modelId: "gpt-6-astra", profileId: "astra-xhigh", roleId: "verifier", member: "vote-sol-high", tried: 1 }];
      expect(profileOf("sol-high", "verifier")?.id).toBe("astra-xhigh");
      expect(profileOf("opus-high", "verifier")?.id).toBe("opus-high");
    } finally { await caseOwner.stop(engine); }
  });
});
});
