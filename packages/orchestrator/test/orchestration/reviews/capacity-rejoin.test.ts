import { expect, it } from "vitest";
import { slotUses } from "@petrina/core";
import { capacityReviewersFixture } from "../../fixtures/capacity-reviewers.js";
import { FullModel } from "../../fixtures/capacity-recovery.js";
import { ReleaseEvents } from "../../fixtures/release-events.js";

const SOL = "gpt-6.1-sol", ASTRA = "gpt-6-astra", SHORT = [5_000, 10_000, 30_000], LONG = 5 * 60_000;
type Fixture = ReturnType<typeof capacityReviewersFixture>;
const waits = (f: Fixture, profile: string) => f.retry.events.filter(event => event.kind === "capacity" && event.profileId === profile).map(event => event.ms);
async function paused(f: Fixture, profile: string, count: number, member = "review-1") {
  await f.waitFor(() => waits(f, profile).length === count && f.ownership.groups.has(f.current.id) && !f.ownership.groups.get(f.current.id)!.running(member), "the actual capacity attempt to release its place");
}
function retainedAttempts(f: Fixture, profile: string, count: number, member = "review-1") {
  const attempts = f.retry.attempts.filter(attempt => attempt.profileId === profile);
  expect(attempts).toHaveLength(count); expect(new Set(attempts.map(attempt => attempt.sessionId)).size).toBe(1);
  for (const attempt of attempts.slice(1)) expect(attempt.resume).toMatchObject({ sessionId: attempts[0]!.sessionId, profileId: profile, member });
}

for (const busy of [true, false]) it(`hands a full reviewer's place to another tool ${busy ? "after its occupied place frees" : "as soon as it is available"}, preserving its working peer`, async () => {
  const peer = new ReleaseEvents();
  const f = capacityReviewersFixture(async (prompt, signal) => {
    if (prompt.model === "opus") await peer.wait("finish", signal);
    if (prompt.model === SOL && prompt.turn <= 4) throw new FullModel(prompt.toolId, prompt.model, prompt.profileId, prompt.sessionId);
    return `Supplied finding by ${prompt.profileId}`;
  });
  f.tools(["claude-code", "codex", "grok"]);
  f.state.profiles = f.state.profiles.filter(profile => profile.toolId !== "codex" || profile.modelId === SOL);
  f.state.pool.toolCaps.grok = 1;
  if (busy) f.state.backgroundAgents = [{ id: "occupied", roleId: "verifier", profileId: "grok-high", label: "Supplied other work", since: f.clock.now() }];
  try {
    f.start();
    for (const count of [1, 2, 3]) { await paused(f, "sol-high", count); f.releaseModel(SOL); }
    if (busy) {
      await paused(f, "sol-high", 4);
      const group = f.ownership.groups.get(f.current.id)!;
      expect(group.returning!()).toEqual([expect.objectContaining({ taskId: f.current.id, toolId: "grok" })]);
      for (let pass = 0; pass < 3; pass++) f.workflow.schedule();
      expect(group.running("review-1")).toBe(false);
      expect(f.retry.attempts.some(attempt => f.catalog.profile(attempt.profileId)?.toolId === "grok")).toBe(false);
      f.state.backgroundAgents = []; f.workflow.schedule();
    }
    await f.waitFor(() => f.current.hunt!.reported["1"], "the actual replacement report");
    expect(f.current.hunt!.reported["0"]).toBeUndefined();
    expect(f.ownership.groups.get(f.current.id)!.running("review-0")).toBe(true);
    expect(waits(f, "sol-high")).toEqual([...SHORT, LONG]);
    retainedAttempts(f, "sol-high", 4);
    expect(f.retry.attempts.filter(attempt => f.catalog.profile(attempt.profileId)?.toolId === "grok")).toHaveLength(1);
    peer.release("finish"); await f.done();
    expect(f.current.rounds.target).toBe(1);
    for (const toolId of ["claude-code", "grok"]) expect(f.current.findings.filter(finding => f.catalog.profile(finding.raisedBy)?.toolId === toolId)).toHaveLength(1);
    expect(f.waits).toEqual([]); expect(f.retry.limits).toEqual([]);
    expect(f.copies.filter(copy => copy.member === "review-1").every(copy => copy.reference === "supplied:copy:review-1")).toBe(true);
    expect(f.copies.filter(copy => copy.member === "review-1").slice(1).every(copy => copy.reuse)).toBe(true);
  } finally { peer.release("finish"); await f.close(); }
});

for (const originalFree of [false, true]) it(`keeps a replacement reviewer's own short retries beside a held peer ${originalFree ? "after the original model becomes free" : "while the original model stays full"}`, async () => {
  const peer = new ReleaseEvents();
  const f = capacityReviewersFixture(async (prompt, signal) => {
    if (prompt.model === "opus") await peer.wait("finish", signal);
    if (prompt.model === SOL && prompt.turn <= 4 || prompt.model === ASTRA && prompt.turn === 1)
      throw new FullModel(prompt.toolId, prompt.model, prompt.profileId, prompt.sessionId, prompt.model === ASTRA && originalFree ? 10 * 60_000 : undefined);
    return `Supplied finding by ${prompt.profileId}`;
  });
  f.tools(["claude-code", "codex"]);
  try {
    f.start();
    for (const count of [1, 2, 3]) { await paused(f, "sol-high", count); f.releaseModel(SOL); }
    await paused(f, "astra-xhigh", 1);
    expect(waits(f, "sol-high")).toEqual([...SHORT, LONG]);
    expect(waits(f, "astra-xhigh")).toEqual([originalFree ? 10 * 60_000 : 5_000]);
    expect(f.current.capacityPaused).toContainEqual(expect.objectContaining({ profileId: "astra-xhigh", plannedId: "sol-high", member: "review-1" }));
    f.releaseModel(ASTRA);
    await f.waitFor(() => f.current.hunt!.reported["1"], "the replacement's own continuation to report");
    expect(f.current.hunt!.reported["0"]).toBeUndefined();
    retainedAttempts(f, "sol-high", 4); retainedAttempts(f, "astra-xhigh", 2);
    expect(waits(f, "sol-high")).toHaveLength(4);
    if (originalFree) expect(f.current.modelCapacity?.some(entry => entry.modelId === SOL)).toBeFalsy();
    else expect(f.current.modelCapacity).toContainEqual(expect.objectContaining({ modelId: SOL }));
    peer.release("finish"); await f.done();
    expect(f.current.rounds.target).toBe(1);
    expect(f.current.findings.map(finding => finding.raisedBy).sort()).toEqual(["astra-xhigh", "opus-high"]);
    expect(f.waits).toEqual([]); expect(f.retry.limits).toEqual([]);
  } finally { peer.release("finish"); await f.close(); }
});

for (const busy of ["pool", "tool"] as const) it(`rejoins ahead of queued planning when the full ${busy} frees, without repeating a capacity attempt or exceeding its cap`, async () => {
  const peer = new ReleaseEvents(), returning = new ReleaseEvents();
  const f = capacityReviewersFixture(async (prompt, signal) => {
    if (prompt.model === SOL) await peer.wait("finish", signal);
    if (prompt.model === "opus" && prompt.turn === 1) throw new FullModel(prompt.toolId, prompt.model, prompt.profileId, prompt.sessionId);
    if (prompt.model === "opus") await returning.wait("report", signal);
    return `Supplied finding by ${prompt.profileId}`;
  });
  f.tools(["claude-code", "codex"]);
  if (busy === "pool") f.state.pool.limit = 2; else f.state.pool.toolCaps["claude-code"] = 1;
  const peaks: number[] = [];
  const off = f.subscribe(() => { const uses = slotUses(f.snapshot()); peaks.push(busy === "pool" ? uses.length : uses.filter(use => use.toolId === "claude-code").length); });
  try {
    f.start(); await paused(f, "opus-high", 1, "review-0");
    const farewell = f.enqueue(1);
    await f.waitFor(() => f.calls.includes(`planner:${farewell.id}`), "other planning to take the released place");
    const footer = f.enqueue(2);
    f.releaseModel("opus");
    for (let pass = 0; pass < 3; pass++) { f.workflow.schedule(); expect(f.ownership.groups.get(f.current.id)!.running("review-0")).toBe(false); }
    expect(f.retry.attempts.filter(attempt => attempt.profileId === "opus-high")).toHaveLength(1);
    expect(waits(f, "opus-high")).toEqual([5_000]); expect(footer.state).toBe("queued");
    f.releases.release(farewell.id);
    await f.waitFor(() => f.retry.attempts.filter(attempt => attempt.profileId === "opus-high").length === 2, "the returning reviewer to reserve the free place first");
    expect(footer.state).toBe("queued"); expect(f.calls).not.toContain(`planner:${footer.id}`);
    retainedAttempts(f, "opus-high", 2, "review-0");
    returning.release("report");
    await f.waitFor(() => f.current.hunt!.reported["0"] && f.calls.includes(`planner:${footer.id}`), "the queued planner to follow the completed returning reviewer");
    expect(f.calls.indexOf(`planner:${footer.id}`)).toBeGreaterThan(f.calls.lastIndexOf("attempt:opus-high"));
    expect(f.current.hunt!.reported["1"]).toBeUndefined();
    peer.release("finish"); await f.done();
    expect(Math.max(...peaks)).toBeLessThanOrEqual(busy === "pool" ? 2 : 1);
    expect(f.current.rounds.target).toBe(1); expect(f.waits).toEqual([]); expect(f.retry.limits).toEqual([]);
  } finally { off(); returning.release("report"); peer.release("finish"); await f.close(); }
});
