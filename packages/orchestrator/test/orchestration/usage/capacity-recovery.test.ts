import { describe, expect, it } from "vitest";
import { capacityFixture, FullModel, UsageWait, AccountLimit } from "../../fixtures/capacity-recovery.js";
import { recordModelCapacity, expireModelCapacity } from "../../../src/model-capacity.js";

const SHORT_WAITS = [5_000, 10_000, 30_000] as const;

describe("actual turn recovery policy", () => {
  it("accepts a completed attempt mentioning capacity without recording a refusal, retry or account restriction", async () => {
    const result = "A note mentioned a full model; this attempt completed normally.";
    const f = capacityFixture(() => result);
    try {
      expect(await f.main()).toBe(result);
      expect(f.attempts).toHaveLength(1);
      expect(f.task.modelCapacity).toBeUndefined();
      expect(f.task.capacityRetries).toBeUndefined();
      expect(f.events.some(event => event.kind === "capacity" || event.kind === "owesRetry")).toBe(false);
      expect(f.state.pool.limited ?? []).toEqual([]);
      expect(f.limits).toEqual([]);
      expect(f.failures).toEqual([]);
    } finally { await f.close(); }
  });
  for (const mode of ["main", "member", "grok"] as const) it(`keeps the same ${mode} retry budget, then waits longer when no alternative is offered`, async () => {
    let stops = 0;
    const f = capacityFixture(prompt => { if (++stops <= 4) throw new FullModel(prompt.toolId, prompt.model, prompt.profileId, prompt.sessionId); return "Recovered"; });
    const planned = mode === "grok" ? "grok-xhigh" : mode === "main" ? "sol-xhigh" : "sol-high";
    f.prepare(mode === "member" ? "code-reviewer" : "builder", [planned]);
    f.state.profiles = f.state.profiles.filter(profile => profile.id === planned);
    const run = () => mode === "member" ? f.member() : f.main("builder", planned);
    try {
      for (const [index, delay] of SHORT_WAITS.entries()) {
        await expect(run()).rejects.toBeInstanceOf(UsageWait);
        expect(f.events.filter(entry => entry.kind === "capacity").at(-1)?.ms).toBe(delay);
        expect(f.task.capacityRetries?.[0]?.tried).toBe(index + 1);
        f.release();
      }
      await expect(run()).rejects.toBeInstanceOf(UsageWait);
      expect(f.events.filter(entry => entry.kind === "capacity").at(-1)?.ms).toBe(5 * 60_000);
      expect(f.task.capacityRetries?.some(entry => entry.tried === 3)).toBe(true);
      expect(f.task.capacityPaused).toBeUndefined();
      if (mode !== "member") { expect(f.task.holdsSlot).toBe(false); expect(f.task.agent).toBeUndefined(); }
      expect(f.limits).toEqual([]);
      f.release(); expect(await run()).toBe("Recovered");
      expect(new Set(f.agents.received().map(prompt => prompt.sessionId)).size).toBe(1);
    } finally { await f.close(); }
  });

  it("honors a provider's delay floor before continuing the same selected profile", async () => {
    const f = capacityFixture(prompt => { if (prompt.turn === 1) throw new FullModel(prompt.toolId, prompt.model, prompt.profileId, prompt.sessionId, 45_000); return "Recovered"; });
    try {
      await expect(f.main()).rejects.toBeInstanceOf(UsageWait);
      expect(f.events.find(entry => entry.kind === "capacity")?.ms).toBe(45_000);
      expect(f.task.modelCapacity?.[0]?.until).toBe(f.clock.now() + 45_000);
      f.release(); expect(await f.main()).toBe("Recovered");
      expect(f.agents.received().map(prompt => prompt.profileId)).toEqual(["sol-xhigh", "sol-xhigh"]);
      expect(f.limits).toEqual([]);
    } finally { await f.close(); }
  });

  it("gives a main replacement one short retry before any third tool takes the step", async () => {
    const f = capacityFixture(prompt => {
      if (prompt.model === "gpt-6.1-sol" && prompt.turn <= 4) throw new FullModel(prompt.toolId, prompt.model, prompt.profileId, prompt.sessionId);
      if (prompt.model === "gpt-6-astra" && prompt.turn === 1) throw new FullModel(prompt.toolId, prompt.model, prompt.profileId, prompt.sessionId);
      return "Recovered";
    });
    try {
      for (const [index, delay] of SHORT_WAITS.entries()) {
        await expect(f.main()).rejects.toBeInstanceOf(UsageWait);
        expect(f.events.filter(entry => entry.kind === "capacity").at(-1)?.ms).toBe(delay);
        expect(f.task.capacityRetries?.find(entry => entry.profileId === "sol-xhigh")?.tried).toBe(index + 1);
        expect(f.scope.work.conversation).toMatchObject({ profileId: "sol-xhigh", capacityContinue: true });
        f.release("gpt-6.1-sol");
      }
      await expect(f.main()).rejects.toBeInstanceOf(UsageWait);
      expect(f.task.capacityRetries?.some(entry => entry.modelId === "gpt-6-astra" && entry.tried === 1)).toBe(true);
      expect(f.task.capacityPaused?.some(entry => entry.profileId === "astra-xhigh" && entry.plannedId === "sol-xhigh")).toBe(true);
      expect(f.events.filter(entry => entry.kind === "capacity").at(-1)?.ms).toBe(5_000);
      expect(f.attempts.map(attempt => attempt.profileId)).toEqual(["sol-xhigh", "sol-xhigh", "sol-xhigh", "sol-xhigh", "astra-xhigh"]);
      const replacement = f.attempts.at(-1)!;
      expect(f.task.capacityResume?.find(entry => entry.profileId === "astra-xhigh")).toMatchObject({ sessionId: replacement.sessionId, roleId: "builder" });
      expect(f.scope.work.conversation).toMatchObject({ profileId: "astra-xhigh", sessionId: replacement.sessionId, capacityContinue: true });
      f.release("gpt-6-astra"); expect(await f.main()).toBe("Recovered");
      const sol = f.attempts.filter(attempt => attempt.profileId === "sol-xhigh"), astra = f.attempts.filter(attempt => attempt.profileId === "astra-xhigh");
      expect(sol).toHaveLength(4); expect(astra).toHaveLength(2);
      expect(f.attempts.every(attempt => attempt.profileId === "sol-xhigh" || attempt.profileId === "astra-xhigh")).toBe(true);
      for (const attempt of sol.slice(1)) expect(attempt.resume).toMatchObject({ sessionId: sol[0]!.sessionId, profileId: "sol-xhigh" });
      expect(astra[1]!.resume).toMatchObject({ sessionId: replacement.sessionId, profileId: "astra-xhigh", roleId: "builder" });
      expect(astra[1]!.conversation).toMatchObject({ sessionId: replacement.sessionId, profileId: "astra-xhigh", capacityContinue: true });
      expect(astra[1]!.sessionId).toBe(replacement.sessionId);
      expect(f.state.pool.limited ?? []).toEqual([]); expect(f.limits).toEqual([]);
    } finally { await f.close(); }
  });

  for (const mode of ["main", "member"] as const) it(`gives an actual ${mode} replacement its own short retries even after the planned model is free`, async () => {
    const f = capacityFixture(prompt => {
      if (prompt.model === "gpt-6.1-sol") throw new FullModel(prompt.toolId, prompt.model, prompt.profileId, prompt.sessionId);
      if (prompt.model === "gpt-6-astra" && prompt.turn <= 2) throw new FullModel(prompt.toolId, prompt.model, prompt.profileId, prompt.sessionId);
      return "Recovered";
    });
    const role = mode === "member" ? "code-reviewer" : "builder", planned = mode === "member" ? "sol-high" : "sol-xhigh";
    f.prepare(role, [planned]);
    const run = () => mode === "main" ? f.main() : f.member();
    try {
      for (const delay of SHORT_WAITS) { await expect(run()).rejects.toBeInstanceOf(UsageWait); expect(f.events.filter(entry => entry.kind === "capacity").at(-1)?.ms).toBe(delay); f.release(); }
      await expect(run()).rejects.toBeInstanceOf(UsageWait);
      expect(f.task.capacityPaused?.some(entry => entry.profileId === "astra-xhigh" && entry.plannedId === planned)).toBe(true);
      expect(f.task.capacityRetries?.find(entry => entry.profileId === "astra-xhigh")?.tried).toBe(1);
      // The original model is free; the actual selector still owes the replacement its short continue.
      f.task.modelCapacity = f.task.modelCapacity?.filter(entry => entry.modelId !== "gpt-6.1-sol");
      f.release("gpt-6-astra"); await expect(run()).rejects.toBeInstanceOf(UsageWait);
      expect(f.task.capacityRetries?.find(entry => entry.profileId === "astra-xhigh")?.tried).toBe(2);
      expect(f.events.filter(entry => entry.kind === "capacity").at(-1)?.ms).toBe(10_000);
      f.release("gpt-6-astra"); expect(await run()).toBe("Recovered");
      const sol = f.agents.received().filter(prompt => prompt.model === "gpt-6.1-sol"), astra = f.agents.received().filter(prompt => prompt.model === "gpt-6-astra");
      expect(sol).toHaveLength(4); expect(astra).toHaveLength(3);
      expect(new Set(astra.map(prompt => prompt.sessionId)).size).toBe(1);
      expect(f.limits).toEqual([]);
    } finally { await f.close(); }
  });

  for (const mode of ["main", "member"] as const) for (const failure of [undefined, new Error("Actual rejected attempt")]) it(`preserves ${mode} ${failure === undefined ? "undefined" : "Error"} rejection without recording capacity or account limits`, async () => {
    const f = capacityFixture(() => { throw failure; });
    if (mode === "member") f.prepare("code-reviewer", ["sol-high"]);
    try {
      await expect(mode === "main" ? f.main() : f.member()).rejects.toBe(failure);
      expect(f.events.filter(entry => entry.kind === "capacity")).toEqual([]);
      expect(f.limits).toEqual([]);
    } finally { await f.close(); }
  });

  for (const mode of ["main", "member"] as const) it(`honors ${mode} abort before failure classification and retains the exact original rejection`, async () => {
    const stop = new AbortController(), failure = new FullModel("codex", "gpt-6.1-sol", "sol-xhigh");
    const f = capacityFixture(() => { stop.abort(); throw failure; });
    if (mode === "member") f.prepare("code-reviewer", ["sol-high"]);
    try {
      await expect(mode === "main" ? f.main("builder", "sol-xhigh", stop.signal) : f.member("code-reviewer", "sol-high", "review-0", stop.signal)).rejects.toBe(failure);
      expect(f.failures).toEqual([]); expect(f.task.capacityRetries).toBeUndefined(); expect(f.limits).toEqual([]);
    } finally { await f.close(); }
  });

  for (const mode of ["main", "member"] as const) it(`discards an unavailable ${mode} participant before interpreting a capacity-shaped error`, async () => {
    let attempts = 0;
    const failure = new FullModel("codex", "gpt-6.1-sol", mode === "main" ? "sol-xhigh" : "sol-high");
    const f = capacityFixture(() => { if (++attempts === 1) throw failure; return "Recovered"; });
    if (mode === "member") f.prepare("code-reviewer", ["sol-high"]);
    const discarded: unknown[] = [];
    f.host.discardUnavailable = (_scope, _role, error) => { discarded.push(error); return true; };
    try {
      expect(await (mode === "main" ? f.main() : f.member())).toBe("Recovered");
      expect(discarded).toEqual([failure]); expect(f.task.capacityRetries).toBeUndefined(); expect(f.task.modelCapacity).toBeUndefined(); expect(f.limits).toEqual([]);
    } finally { await f.close(); }
  });

  it("publishes retry and pause before a reentrant record checkpoint and does not expose a replacement", async () => {
    const f = capacityFixture(), seen: unknown[] = [];
    // The real recorder mutates the model record; the host's synchronous checkpoint observes the actual selector.
    const error = new FullModel("codex", "gpt-6.1-sol", "sol-xhigh", "opaque-session");
    const record = recordModelCapacity;
    const { ModelCapacity } = await import("../../../src/model-capacity.js");
    const actual = new ModelCapacity({ profile: f.profile, now: f.clock.now, words: f.selectionHost.capacityWaiting,
      record(task, role, id, refusal, ms) { record(task, id, refusal, ms, f.clock.now()); seen.push({ role, retry: task.capacityRetries?.[0]?.tried, pause: task.capacityPaused?.[0]?.plannedId, choice: f.selection.choose("sol-xhigh", f.scope, "builder")?.kind }); },
    });
    expect(actual.defer(f.scope, "builder", "sol-xhigh", error, "sol-xhigh")).toBe(true);
    expect(seen).toEqual([{ role: "builder", retry: 1, pause: "sol-xhigh", choice: "none" }]);
    await f.close();
  });

  it("expires only elapsed task model records and their holds, retaining other members' sessions and retry counts", () => {
    const f = capacityFixture(), now = f.clock.now();
    const sol = new FullModel("codex", "gpt-6.1-sol", "sol-high", "sol-session"), astra = new FullModel("codex", "gpt-6-astra", "astra-xhigh", "astra-session");
    f.capacity.defer(f.scope, "code-reviewer", "sol-high", sol, "sol-high", "review-0");
    f.clock.advance(1); f.capacity.defer(f.scope, "code-reviewer", "astra-xhigh", astra, "astra-xhigh", "review-1");
    expect(expireModelCapacity(f.task, now + 5_000)).toBe(true);
    expect(f.task.modelCapacity?.map(entry => entry.modelId)).toEqual(["gpt-6-astra"]);
    expect(f.task.capacityPaused?.map(entry => entry.member)).toEqual(["review-1"]);
    expect(f.task.capacityResume).toHaveLength(2); expect(f.task.capacityRetries).toHaveLength(2);
  });

  it("keeps an actual usage refusal on its own branch and rethrows it when the same profile is selected again", async () => {
    const failure = new AccountLimit("codex", 10_000, "Codex's weekly limit"), f = capacityFixture(() => { throw failure; });
    try {
      await expect(f.main()).rejects.toBe(failure);
      expect(f.limits).toEqual([failure]); expect(f.task.modelCapacity).toBeUndefined(); expect(f.task.capacityRetries).toBeUndefined();
    } finally { await f.close(); }
  });
});
