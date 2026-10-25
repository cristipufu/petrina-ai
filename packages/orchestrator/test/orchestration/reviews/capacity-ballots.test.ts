import { deferred } from "../../fixtures/tool-checks.js";
import { expect, it } from "vitest";
import { capacityBallotFixture } from "../../fixtures/capacity-ballots.js";
import { FullModel, UsageWait } from "../../fixtures/capacity-recovery.js";

const SHORT_WAITS = [5_000, 10_000, 30_000] as const;

for (const replacementStops of [0, 2]) it(`keeps a full-model voter's place and ${replacementStops ? "the replacement's own short retries" : "its same-tool replacement"}`, async () => {
  const f = capacityBallotFixture(prompt => {
    if (prompt.model === "gpt-6.1-sol" && prompt.turn <= 4) throw new FullModel(prompt.toolId, prompt.model, prompt.profileId, prompt.sessionId);
    if (prompt.model === "gpt-6-astra" && prompt.turn <= replacementStops) throw new FullModel(prompt.toolId, prompt.model, prompt.profileId, prompt.sessionId);
    return "Verified";
  });
  try {
    for (const [index, delay] of SHORT_WAITS.entries()) {
      await expect(f.run()).rejects.toBeInstanceOf(UsageWait);
      expect(f.events.filter(entry => entry.kind === "capacity").at(-1)?.ms).toBe(delay);
      expect(f.task.capacityRetries?.find(entry => entry.profileId === "sol-high")?.tried).toBe(index + 1);
      expect(f.task.findings.every(finding => finding.verification === undefined)).toBe(true);
      f.release("gpt-6.1-sol");
    }
    if (replacementStops) {
      for (const [index, delay] of SHORT_WAITS.slice(0, replacementStops).entries()) {
        await expect(f.run()).rejects.toBeInstanceOf(UsageWait);
        expect(f.task.capacityRetries?.find(entry => entry.profileId === "astra-xhigh")).toMatchObject({ tried: index + 1, member: "vote-sol-high" });
        expect(f.task.capacityResume?.some(entry => entry.profileId === "astra-xhigh" && entry.member === "vote-sol-high")).toBe(true);
        expect(f.events.filter(entry => entry.kind === "capacity").at(-1)?.ms).toBe(delay);
        // Release both models: the original is available, while the replacement is still owed its own continue.
        if (index === 0) f.task.modelCapacity = f.task.modelCapacity?.filter(entry => entry.modelId !== "gpt-6.1-sol");
        f.release("gpt-6-astra");
      }
    }
    await f.run(); f.finish();
    const votes = f.task.findings.flatMap(finding => finding.votes ?? []);
    expect(votes.some(vote => vote.by === "astra-xhigh")).toBe(true);
    expect(votes.every(vote => f.profile(vote.by)?.modelId !== "gpt-6.1-sol")).toBe(true);
    const sol = f.agents.received().filter(prompt => prompt.model === "gpt-6.1-sol"), astra = f.agents.received().filter(prompt => prompt.model === "gpt-6-astra");
    expect(sol).toHaveLength(4); expect(astra).toHaveLength(replacementStops + 1);
    expect(new Set(astra.map(prompt => prompt.sessionId)).size).toBe(1);
    expect(f.task.findings.some(finding => finding.verification !== undefined)).toBe(true);
    expect(f.limits).toEqual([]);
  } finally { await f.close(); }
});

it("retains peer answers and an unfinished ballot when every model for the missing tool is full", async () => {
  const f = capacityBallotFixture(prompt => {
    if (prompt.model === "gpt-6.1-sol" && prompt.turn <= 4) throw new FullModel(prompt.toolId, prompt.model, prompt.profileId, prompt.sessionId);
    return "Verified";
  });
  f.state.profiles = f.state.profiles.filter(profile => profile.modelId !== "gpt-6-astra");
  try {
    for (const delay of SHORT_WAITS) { await expect(f.run()).rejects.toBeInstanceOf(UsageWait); expect(f.events.filter(entry => entry.kind === "capacity").at(-1)?.ms).toBe(delay); f.release(); }
    await expect(f.run()).rejects.toBeInstanceOf(UsageWait);
    expect(f.events.filter(entry => entry.kind === "capacity").at(-1)?.ms).toBe(5 * 60_000);
    const early = f.task.findings.flatMap(finding => finding.votes ?? []);
    expect(early.some(vote => vote.toolId !== "codex")).toBe(true);
    expect(early.some(vote => vote.toolId === "codex")).toBe(false);
    expect(f.task.findings.every(finding => finding.verification === undefined)).toBe(true);
    expect(f.ballots.next(f.task, f.stage)?.voters).toEqual(["sol-high"]);
    const kept = structuredClone(early);
    f.release(); await f.run(); f.finish();
    const votes = f.task.findings.flatMap(finding => finding.votes ?? []);
    expect(votes.some(vote => vote.by === "sol-high")).toBe(true);
    expect(votes.filter(vote => vote.toolId === "codex").every(vote => vote.by === "sol-high")).toBe(true);
    expect(votes.filter(vote => vote.toolId !== "codex")).toEqual(kept);
    expect(f.task.findings.some(finding => finding.verification !== undefined)).toBe(true);
    expect(f.agents.received().filter(prompt => prompt.model === "gpt-6.1-sol")).toHaveLength(5);
    expect(f.limits).toEqual([]);
  } finally { await f.close(); }
});

it("rejoins its own ended capacity wait while a peer still owns the working group", async () => {
  const release = deferred<void>(), entered = deferred<void>();
  const f = capacityBallotFixture(async prompt => {
    if (prompt.toolId !== "codex") { entered.resolve(); await release.promise; }
    if (prompt.model === "gpt-6.1-sol" && prompt.turn === 1) throw new FullModel(prompt.toolId, prompt.model, prompt.profileId, prompt.sessionId);
    return "Verified";
  });
  const running = f.run();
  try {
    await entered.promise; await f.memberEnded(1);
    expect(f.task.state).toBe("running"); expect(f.task.holdsSlot).toBe(true);
    expect(f.task.capacityRetries).toEqual([expect.objectContaining({ profileId: "sol-high", member: "vote-sol-high", tried: 1 })]);
    expect(f.task.capacityResume).toEqual([expect.objectContaining({ profileId: "sol-high", member: "vote-sol-high" })]);
    f.release("gpt-6.1-sol"); f.rejoin(); await f.memberEnded(2);
    expect(f.task.findings.flatMap(finding => finding.votes ?? []).map(vote => vote.toolId)).toEqual(["codex"]);
    expect(f.task.findings.every(finding => finding.verification === undefined)).toBe(true);
    release.resolve(); await running; f.finish();
    expect(f.task.findings.flatMap(finding => finding.votes ?? [])).toHaveLength(2);
    expect(f.agents.received().filter(prompt => prompt.model === "gpt-6.1-sol")).toHaveLength(2);
  } finally { release.resolve(); await f.close(); }
});
