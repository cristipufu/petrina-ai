import { headroom, limitOf } from "@petrina/core";
import { afterAll, expect, it, spyOn } from "bun:test";
import { coordinatorRecords } from "../../fixtures/coordinator-records.js";
import { removeDir } from "../../fixtures.js";
const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
const fixture = () => coordinatorRecords(roots);

it("starts available Antigravity models while Argon's weekly quota is exhausted", async () => {
  const { engine, task } = await fixture();
  engine.schedule = () => {};
  engine.s.profiles = engine.s.profiles.filter(profile => profile.toolId === "antigravity");
  const argon = engine.s.profiles.find(profile => profile.modelId?.includes("argon"))!;
  const flash = engine.s.profiles.find(profile => profile.modelId?.includes("flash"))!;
  engine.s.tools.forEach(tool => { tool.status = tool.id === "antigravity" ? "ready" : "not-installed"; });
  engine.s.setup!.checks = [{ id: "antigravity", status: "ready" }];
  engine.s.pool.limit = 8; engine.s.pool.toolCaps.antigravity = 4;
  engine.s.pool.paused = false; engine.draining = false;
  const until = Date.now() + 3_600_000;
  engine.recordUsage({ toolId: "antigravity", model: "argon", kind: "seven_day", status: "rejected", utilization: 1, resetsAt: until });
  engine.recordUsage({ toolId: "antigravity", model: "flash", kind: "seven_day", status: "allowed", utilization: 0, resetsAt: until });
  engine.recordUsage({ toolId: "antigravity", model: "flash", kind: "five_hour", status: "allowed", utilization: 0.01, resetsAt: until });
  const other = engine.task(engine.addTask({ productId: "p", title: "Other model", backlog: true }))!;
  for (const [index, entry] of [task, other].entries()) {
    entry.state = "waiting"; entry.stageIndex = 0;
    entry.plan = { rationale: "Build", plannerProfileId: flash.id, stages: [{ id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: [index ? flash.id : argon.id] }] };
  }
  const start = spyOn(engine["driver"].workflow, "startDriver").mockImplementation(() => {});
  try {
    engine["driver"].schedule();
    expect(start.mock.calls.map(args => args[0])).toEqual([task.id, other.id]);
    expect([task.agent?.profileId, other.agent?.profileId]).toEqual([flash.id, flash.id]);
    expect(engine.s.pool.limited?.every(limit => limit.model === "argon")).toBe(true);
  } finally { start.mockRestore(); await engine.shutdown(); }
});

it("replaces an account's old quota groups after a subscription change without clearing unrelated or retry limits", async () => {
  const { engine } = await fixture();
  const now = Date.now(), resetsAt = now + 3_600_000;
  const alpha = { id: "alpha", toolId: "provider", model: "Group Alpha", modelId: "group-alpha", effort: "high" as const };
  const report = (model: string, kind = "seven_day", utilization = 0.01) => ({ toolId: "provider", model, kind, name: model === "group" ? "Shared models" : model, utilization, status: utilization === 1 ? "rejected" as const : "allowed" as const, resetsAt });
  try {
    engine.recordUsage(report("alpha", "seven_day", 1));
    engine.recordUsage(report("beta"));
    engine.recordUsage({ toolId: "other", kind: "seven_day", status: "rejected", resetsAt });
    engine.s.pool.limited!.push({ toolId: "provider", retry: true, until: resetsAt, reason: "A refused request", at: now });
    engine.s.pool.limited!.push({ toolId: "provider", model: "gamma", until: resetsAt, reason: "A turn-only rate limit", at: now });
    engine.recordAccountUsage("provider", [report("group"), report("group", "five_hour", 0.03)]);
    expect(engine.s.pool.usage!.filter(entry => entry.toolId === "provider").map(entry => [entry.model, entry.kind])).toEqual([["group", "seven_day"], ["group", "five_hour"]]);
    expect(engine.s.pool.limited!.map(entry => [entry.toolId, entry.model, entry.retry])).toEqual([["other", undefined, undefined], ["provider", undefined, true], ["provider", "gamma", undefined]]);
    expect(headroom(engine.s.pool, alpha, now)).toBeGreaterThan(0);
    const saved = structuredClone(engine.s.pool);
    engine.recordAccountUsage("provider", []);
    engine.recordAccountUsage("provider", [{ toolId: "other", kind: "seven_day", status: "allowed" }]);
    expect(engine.s.pool).toEqual(saved);
    // A complete reading can retain a genuinely exhausted model without blocking its peers.
    engine.s.pool.limited = engine.s.pool.limited!.filter(entry => !entry.retry);
    engine.recordAccountUsage("provider", [report("alpha", "seven_day", 1), report("beta")]);
    expect(limitOf(engine.s.pool, alpha, now)?.model).toBe("alpha");
    expect(limitOf(engine.s.pool, { ...alpha, model: "Beta", modelId: "beta" }, now)).toBeUndefined();
    engine.recordAccountUsage("provider", [report("group"), report("group", "five_hour", 0.03)]);
    expect(limitOf(engine.s.pool, alpha, now)).toBeUndefined();
    engine.save();
    const persisted = engine.store.load()!.pool;
    expect(persisted.usage!.filter(entry => entry.toolId === "provider")).toEqual(engine.s.pool.usage!.filter(entry => entry.toolId === "provider"));
    expect(limitOf(persisted, alpha, now)).toBeUndefined();
    expect(persisted.limited!.some(entry => entry.toolId === "other")).toBe(true);
  } finally { await engine.shutdown(); }
});
