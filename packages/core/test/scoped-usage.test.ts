import { describe, expect, it } from "vitest";
import type { AgentProfile, Pool, State, UsageReport } from "../src/model.js";
import { balanced, extraSlot, pickStarts, slotUses, slotWait } from "../src/scheduler.js";
import { chooseProfile, chooseWithRoom, headroom, limitOf, nearLimit, toolCapNow } from "../src/usage.js";

const now = 1_800_000_000_000, hour = 3_600_000;
const alpha: AgentProfile = { id: "alpha", toolId: "provider", model: "Alpha", modelId: "alpha-v1", effort: "high" };
const beta: AgentProfile = { id: "beta", toolId: "provider", model: "Beta", modelId: "beta-v1", effort: "high" };
const report = (model: string | undefined, utilization: number, resetsAt = now + 100 * hour): UsageReport => ({ toolId: "provider", ...(model ? { model } : {}), kind: "weekly", utilization, status: utilization >= 1 ? "rejected" : "allowed", resetsAt, at: now });
const pool = (usage: UsageReport[] = []): Pool => ({ limit: 8, paused: false, toolCaps: { provider: 4 }, usage });
const seat = (taskId: string, profile: AgentProfile) => ({ ...profile, taskId });
const state = (p: Pool, running: AgentProfile[] = []): State => ({ now, seq: 0, products: [], roles: [], inbox: [], tools: [{ id: "provider", name: "Provider", command: [], models: [], status: "ready" }], profiles: [alpha, beta], tasks: running.map((profile, index) => ({ id: `running-${index}`, holdsSlot: true, agent: { roleId: "builder", profileId: profile.id, since: now, step: 0 } })) as unknown as State["tasks"], pool: p });

describe("reported quota scopes, independent of provider identity", () => {
  it("keeps other models available when one model exhausts its weekly limit", () => {
    const p = { ...pool([report("alpha", 1), report("beta", 0), { ...report("beta", 0.01, now + 5 * hour), kind: "five_hour" }]), limited: [{ toolId: "provider", model: "alpha", until: now + 100 * hour, reason: "The model's weekly limit" }] };
    expect(limitOf(p, alpha, now)).toBeDefined(); expect(limitOf(p, beta, now)).toBeUndefined();
    expect(nearLimit(p, beta, now)).toBe(false);
    expect(headroom(p, alpha, now)).toBe(0); expect(headroom(p, beta, now)).toBeGreaterThan(0);
    expect(chooseProfile(state(p), alpha, now)).toEqual({ kind: "substitute", profile: beta });
    expect(chooseProfile(state(p), beta, now)).toEqual({ kind: "planned", profile: beta });
    expect(balanced([seat("spent", alpha), seat("free", beta)], p, now).map(candidate => candidate.taskId)).toEqual(["free", "spent"]);
  });

  it("counts only matching agents against a model's reduced cap while preserving the shared tool cap", () => {
    const p = pool([report("alpha", 0.85), report("beta", 0)]);
    const running = [seat("a1", alpha), seat("a2", alpha)];
    expect(toolCapNow(p, "provider", now, alpha)).toBe(2); expect(toolCapNow(p, "provider", now, beta)).toBe(4);
    expect(pickStarts({ pool: p, now, inUse: running, candidates: [seat("a3", alpha), seat("b1", beta), seat("b2", beta), seat("b3", beta)] })).toEqual(["b1", "b2"]);
    const s = state(p, [alpha, alpha]);
    expect(extraSlot(s, beta.toolId, beta)).toBe(true); expect(extraSlot(s, alpha.toolId, alpha)).toBe(false);
    expect(slotWait(s, seat("a3", alpha))).toContain("Alpha");
    expect(slotWait(s, seat("b1", beta))).toBeUndefined();
    expect(slotUses(s).every(use => use.model === "Alpha" && use.modelId === alpha.modelId)).toBe(true);
    // Busy Beta agents do not consume Alpha's quota, but all four agents use the tool cap.
    expect(pickStarts({ pool: p, now, inUse: [seat("b1", beta), seat("b2", beta)], candidates: [seat("a1", alpha), seat("a2", alpha), seat("a3", alpha)] })).toEqual(["a1", "a2"]);
  });

  it("applies a shared account limit across models and ignores expired model windows", () => {
    const shared = pool([report(undefined, 0.85)]);
    expect(pickStarts({ pool: shared, now, inUse: [seat("b1", beta), seat("b2", beta)], candidates: [seat("a1", alpha), seat("b3", beta)] })).toEqual([]);
    const reset = pool([report("alpha", 1, now - 1)]);
    expect(pickStarts({ pool: reset, now, inUse: [seat("a1", alpha), seat("a2", alpha)], candidates: [seat("a3", alpha), seat("b1", beta)] })).toEqual(["a3", "b1"]);
  });

  it("uses every active window of a quota, including short windows, and counts helpers and background agents", () => {
    const p = pool([{ ...report("alpha", 0.85, now + 5 * hour), kind: "five_hour" }, report("alpha", 0.1)]);
    const s = state(p, [alpha]);
    s.tasks = [{ ...s.tasks[0]!, helpers: [{ roleId: "code-reviewer", profileId: alpha.id, since: now, step: 0 }] }];
    expect(extraSlot(s, alpha.toolId, alpha)).toBe(false);
    expect(extraSlot(s, beta.toolId, beta)).toBe(true);
    s.tasks = []; s.backgroundAgents = [1, 2].map(id => ({ id: `helper-${id}`, roleId: "matcher", profileId: alpha.id, label: "Matching", since: now }));
    expect(extraSlot(s, alpha.toolId, alpha)).toBe(false); expect(extraSlot(s, beta.toolId, beta)).toBe(true);
  });

  it("tries another model on an independent stand-in tool when the first model's quota is full", () => {
    const planned: AgentProfile = { ...alpha, id: "planned", toolId: "unavailable" };
    const p = { ...pool([report("alpha", 0.85, now + hour), report("beta", 0)]), limited: [{ toolId: "unavailable", until: now + hour, reason: "Out" }] };
    const s = state(p, [alpha, alpha]);
    s.profiles = [planned, alpha, beta];
    expect(chooseProfile(s, planned, now)).toEqual({ kind: "substitute", profile: alpha });
    const chosen = chooseWithRoom(s, planned, now, {}, (toolId, profile) => extraSlot(s, toolId, profile));
    expect(chosen).toEqual({ kind: "substitute", profile: beta });
    expect(chooseWithRoom(s, planned, now, {}, () => false)).toEqual({ kind: "substitute", profile: alpha });
    // A room-filtered candidate list cannot silently select its excluded planned profile.
    expect(chooseWithRoom({ ...s, profiles: [beta] }, alpha, now, {}, (toolId, profile) => extraSlot(s, toolId, profile))).toEqual({ kind: "substitute", profile: beta });
  });
});
