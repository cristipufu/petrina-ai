import { expect, it } from "vitest";
import { independentVotes, slotUses } from "@petrina/core";
import { verifierAdmissionFixture, VerifierWait } from "../../fixtures/verifier-admission.js";
import { ReleaseEvents } from "../../fixtures/release-events.js";

it("starts two fresh verifiers instead of one per ready tool, avoiding the reporting tool", async () => {
  const f = verifierAdmissionFixture({ limit: 4, limited: [], antigravity: true });
  try {
    f.state.pool.usage = [{ toolId: "grok", kind: "five_hour", status: "allowed", utilization: 0.95, resetsAt: f.now() + 3_600_000, at: f.now() }];
    await f.phase();
    expect(new Set(independentVotes(f.finding.votes).map(vote => vote.toolId))).toEqual(new Set(["codex", "grok"]));
    expect(f.attempts).toHaveLength(2);
    expect(f.task.hunt!.panel!.seats.map(seat => seat.key)).toEqual(["sol-high", "grok-high"]);
    for (const attempt of f.attempts) expect(attempt.selectionReason).toContain("usable at selection: Claude Code, Codex, Grok and Antigravity; avoided Claude Code, which reported a finding");
    expect(f.notes.some(text => text.startsWith("Verifiers: ") && text.includes("usable at selection: Claude Code, Codex, Grok and Antigravity"))).toBe(true);
  } finally { await f.close(); }
});

for (const third of ["real", "nit"] as const) it(`asks the usable unasked tool for a third answer when both first answers do not block, which then says ${third}`, async () => {
  const f = verifierAdmissionFixture({ limited: [], answer: attempt => attempt.toolId === "claude-code" ? third : "nit" });
  try {
    await f.phase();
    const next = f.next()!;
    expect(next.third).toBe(true);
    expect(next.seats).toMatchObject([{ key: "third:opus-high", findingIds: [f.finding.id] }]);
    const first = f.task.journey!.filter(step => step.roleId === "verifier")[0]!;
    expect(first).toMatchObject({ outcome: "1 checked: 0 must be fixed in this change, 1 awaiting a third answer", reason: "1 finding to check on a third tool" });
    expect(first.result?.findingsSettled).toBeUndefined();
    expect(first.result?.findings?.[0]?.verification).toBeUndefined();
    await f.phase();
    const outcome = f.finishBallot();
    await f.completeRound(outcome);
    const steps = f.task.journey!.filter(step => step.roleId === "verifier");
    expect(f.attempts.map(attempt => attempt.model)).toEqual(expect.arrayContaining(["gpt-6.1-sol", "grok-4.7", "opus"]));
    expect(f.attempts).toHaveLength(3);
    expect(steps[1]!.result?.findingsSettled).toBe(true);
    expect(steps[1]!.result?.findings?.[0]?.verification?.verdict).toBe(third);
    expect(f.attempts[2]!.selectionReason).toContain("Third answer: both first verifiers said this finding does not block");
    expect(f.finding.votes!.find(vote => vote.toolId === "claude-code")!.ballot!.seat).toBe("third:opus-high");
    expect(f.finding.verification?.verdict).toBe(third);
    if (third === "real") {
      expect(f.finding.verification?.reason).toContain("Disputed: ");
      expect(outcome).toBe("1 checked: 1 must be fixed in this change (1 disputed)");
      expect(f.task.fixing).toBe(true);
    } else {
      expect(f.finding.severity).toBe("suggestion");
      expect(outcome).toBe("1 checked: none to fix now, 1 minor");
    }
    expect(f.next()?.voters ?? []).toEqual([]);
    expect(f.attempts).toHaveLength(3);
  } finally { await f.close(); }
});

it("targets a mixed batch's third answer at the unsettled finding only", async () => {
  const f = verifierAdmissionFixture({ limited: [], answer: attempt => attempt.findingIds.map(id => ({ id,
    verdict: id === "second" ? attempt.toolId === "claude-code" ? "not-a-bug" : "nit" : "real", reason: "Explicit normalized finding verdict" })) });
  try {
    const second = f.addFinding("second");
    await f.phase();
    expect(f.next()!.seats.map(seat => seat.findingIds)).toEqual([["second"]]);
    await f.phase();
    const outcome = f.finishBallot();
    expect(f.attempts).toHaveLength(3);
    expect(f.attempts[2]!.findingIds).toEqual(["second"]);
    expect(f.finding.votes!.map(vote => vote.toolId).sort()).toEqual(["codex", "grok"]);
    expect(f.finding.verification?.verdict).toBe("real");
    expect(second.verification?.verdict).toBe("nit");
    expect(second.severity).toBe("suggestion");
    expect(outcome).toBe("2 checked: 1 must be fixed in this change, 1 minor");
  } finally { await f.close(); }
});

it("leaves a finding unresolved when no ready tool can give its third answer, and never repeats that ballot", async () => {
  const gate = new ReleaseEvents();
  const f = verifierAdmissionFixture({ limited: [], answer: async (_attempt, signal) => { await gate.wait("answers", signal); return "not-a-bug" as const; } });
  try {
    const phase = f.phase();
    await f.started(2);
    f.state.setup!.checks.find(check => check.id === "claude-code")!.status = "logged-out";
    gate.release("answers"); await phase;
    expect(f.next()!.voters).toEqual([]);
    const outcome = f.finishBallot();
    expect(f.attempts).toHaveLength(2);
    expect(f.finding.verification).toBeUndefined();
    expect(f.finding.unresolved?.reason).toContain("no ready independent tool can give the required third answer");
    expect(f.finding.unresolved?.heads).toEqual({ p: f.first });
    expect(f.finding.unresolved?.trees).toEqual({ p: f.tree });
    expect(f.finding.severity).toBe("blocking");
    expect(f.finding.status).toBe("open");
    expect(outcome).toBe("1 checked: 1 unresolved");
    await f.completeRound(outcome, 2);
    expect(f.ended).toEqual(["rounds-used"]);
    expect(f.decisions).toEqual([f.task.id]);
    expect(f.notes.some(text => text.startsWith("Review rounds used up"))).toBe(true);
    expect(f.next()?.voters ?? []).toEqual([]);
  } finally { gate.release("answers"); await f.close(); }
});

for (const limit of [1, 3]) it(`does not turn Claude's lost place into a second Codex vote with ${limit} pool slots`, async () => {
  const f = verifierAdmissionFixture({ limit, answer: attempt => attempt.toolId === "codex" ? "not-a-bug" : "real" });
  try {
    await f.phase();
    expect(f.attempts).toHaveLength(2);
    expect(new Set(f.attempts.map(attempt => attempt.model))).toEqual(new Set(["gpt-6.1-sol", "grok-4.7"]));
    expect(f.finding.votes).toHaveLength(2);
    expect(new Set(f.finding.votes!.map(vote => vote.toolId))).toEqual(new Set(["codex", "grok"]));
    for (const vote of f.finding.votes!) expect(f.profile(vote.by)?.toolId).toBe(vote.toolId);
    expect(f.slotSnapshots.some(state => slotUses(state).some(use => use.roleId === "verifier"))).toBe(true);
    for (const state of f.slotSnapshots) {
      const uses = slotUses(state);
      expect(uses.length).toBeLessThanOrEqual(limit);
      for (const toolId of ["claude-code", "codex", "grok"]) expect(uses.filter(use => use.toolId === toolId).length).toBeLessThanOrEqual(1);
    }
    f.finishBallot();
    expect(f.finding.verification?.verdict).toBe("real");
  } finally { await f.close(); }
});

for (const modelOnly of [false, true]) it(`retains a selected seat whose ${modelOnly ? "model" : "tool"} is limited after its peer finishes, without borrowing the peer's vote`, async () => {
  let refused = false;
  const f = verifierAdmissionFixture({ limited: ["grok"], answer: attempt => {
    if (attempt.model === "opus" && !refused) {
      refused = true;
      if (modelOnly) {
        f.state.pool.usage = [{ toolId: "claude-code", kind: "seven_day_opus", model: "opus", status: "rejected", utilization: 1, resetsAt: f.now() + 3_600_000, at: f.now() }];
        f.state.pool.limited!.push({ toolId: "claude-code", model: "opus", until: f.now() + 3_600_000, reason: "The supplied normalized observation limits the weekly Opus allowance" });
      }
      else f.limit("grok", "claude-code");
      throw f.unavailable("The selected Claude allowance is unavailable");
    }
    return "real";
  } });
  try {
    await expect(f.phase()).rejects.toBeInstanceOf(VerifierWait);
    expect(f.finding.verification).toBeUndefined();
    expect(f.task.hunt!.panel!.seats.map(seat => seat.toolId)).toEqual(["codex", "claude-code"]);
    expect(f.task.hunt!.panel!.usable).toEqual(["claude-code", "codex"]);
    const accepted = structuredClone(f.finding.votes);
    expect(accepted).toHaveLength(1);
    if (!modelOnly) {
      const saved = structuredClone(f.task);
      expect(f.finding.votes).toEqual(accepted);
      expect(saved.findings[0]!.verification).toBeUndefined();
      f.limit("grok");
    }
    await f.phase(); f.finishBallot();
    expect(f.completed).toHaveLength(2);
    expect(new Set(f.completed.map(attempt => attempt.toolId)).size).toBe(2);
    expect(f.finding.votes).toHaveLength(2);
    expect(f.finding.votes!.some(vote => vote.by === "opus-high")).toBe(!modelOnly);
    if (modelOnly) expect(f.finding.votes!.find(vote => vote.toolId === "claude-code")!.by).toBe("sonnet-high");
    expect(f.finding.verification?.verdict).toBe("real");
  } finally { await f.close(); }
});

it("replaces a selected seat limited after its peer finishes with an independent usable tool", async () => {
  let refused = false;
  const f = verifierAdmissionFixture({ limited: [], answer: attempt => {
    if (attempt.toolId === "grok" && !refused) { refused = true; f.limit("grok"); throw f.unavailable("Grok reached its spending limit"); }
    return "real";
  } });
  try {
    await expect(f.phase()).rejects.toBeInstanceOf(VerifierWait);
    const accepted = structuredClone(f.finding.votes);
    const next = f.next()!;
    expect(next.seats[0]).toMatchObject({ key: "grok-high", profileId: "opus-high", toolId: "claude-code", replaced: { from: "grok-high" } });
    expect(f.finding.votes).toEqual(accepted);
    await f.phase(); f.finishBallot();
    expect(new Set(f.finding.votes!.map(vote => vote.toolId))).toEqual(new Set(["codex", "claude-code"]));
    expect(f.finding.votes!.find(vote => vote.toolId === "claude-code")!.ballot!.seat).toBe("grok-high");
    expect(f.attempts.at(-1)!).toMatchObject({ profileId: "opus-high", seat: "grok-high" });
    expect(f.attempts.at(-1)!.selectionReason).toContain("takes its required seat");
    expect(f.finding.verification?.verdict).toBe("real");
  } finally { await f.close(); }
});

it("waits for a capped tool instead of duplicating its partner", async () => {
  const f = verifierAdmissionFixture();
  const occupied = { ...structuredClone(f.task), id: "occupied", state: "paused" as const, holdsSlot: true, helpers: [], agent: { roleId: "builder", profileId: "grok-high", since: f.now(), step: 0 } };
  f.state.tasks.push(occupied);
  try {
    await f.phase();
    expect(f.attempts.map(attempt => attempt.model)).toEqual(["gpt-6.1-sol"]);
    expect(f.task.hunt!.panel!.usable).toEqual(["codex", "grok"]);
    expect(f.task.hunt!.panel!.seats.map(seat => seat.toolId)).toEqual(["codex", "grok"]);
    expect(f.finding.verification).toBeUndefined();
    expect(f.next()!.voters).toEqual(["grok-high"]);
    expect(f.decisions).toEqual([]);
    f.state.tasks = f.state.tasks.filter(task => task.id !== occupied.id);
    await f.phase(); f.finishBallot();
    expect(f.attempts).toHaveLength(2);
    expect(new Set(f.finding.votes!.map(vote => vote.toolId))).toEqual(new Set(["codex", "grok"]));
  } finally { await f.close(); }
});

for (const failure of [new Error("Controlled verifier failure"), undefined]) it(`preserves an unknown verifier rejection through group settlement (${failure === undefined ? "undefined" : "Error"})`, async () => {
  const f = verifierAdmissionFixture({ limit: 1, answer: () => { throw failure; } });
  let cleanup: { error: unknown } | undefined;
  const work = f.phase();
  try {
    await expect(f.started(2)).rejects.toBe(failure);
    await expect(work).rejects.toBe(failure);
  }
  finally { cleanup = await f.close().then(() => undefined, error => ({ error })); }
  expect(cleanup?.error).toBeInstanceOf(AggregateError);
  expect((cleanup!.error as AggregateError).errors).toContain(failure);
  expect(f.completed).toEqual([]);
  expect(f.finding.votes).toBeUndefined();
});

it("refuses an overlapping phase without losing its actual held session owner", async () => {
  const gate = new ReleaseEvents();
  const f = verifierAdmissionFixture({ answer: async (_attempt, signal) => { await gate.wait("finish", signal); return "real" as const; } });
  try {
    const first = f.phase();
    await f.started(2);
    await expect(f.phase()).rejects.toThrow("A verifier phase is already running");
    expect(f.completed).toEqual([]);
    gate.release("finish");
    await first;
    await f.started(2);
    expect(f.completed).toHaveLength(2);
    expect(f.ownership.groups.size).toBe(0);
    await expect(f.started(3)).rejects.toThrow("The verifier phase completed before started-3");
  } finally { gate.release("finish"); await f.close(); }
});
