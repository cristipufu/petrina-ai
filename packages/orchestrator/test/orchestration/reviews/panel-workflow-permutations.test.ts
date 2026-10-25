import { describe, expect, it } from "vitest";
import { independentVotes } from "@petrina/core";
import { reviewRoundsFixture } from "../../fixtures/review-rounds.js";

describe.concurrent("bounded verifier panels", () => {
  it("settles with the two usable tools when two of four registered tools are already out of usage", async () => {
    const f = reviewRoundsFixture(["claude-code", "grok"], true);
    const initial = f.next()!;
    f.voteStep(initial);
    for (const seat of initial.seats) f.answer(seat, "not-a-bug");
    const outcome = f.finish(initial);
    expect(new Set(f.finding.votes!.map(vote => vote.toolId))).toEqual(new Set(["codex", "antigravity"]));
    expect(initial.seats).toHaveLength(2);
    expect(f.finding.status).toBe("dismissed");
    expect(f.finding.verification?.verdict).toBe("not-a-bug");
    expect(f.task.journey!.filter(step => step.roleId === "verifier")).toHaveLength(1);
    expect(initial.seats[0]!.reason).toContain("usable at selection: Codex and Antigravity");
    await f.close(outcome);
    expect(f.ended).toEqual(["passed"]);
    expect(f.task.stageIndex).toBe(2);
  });

  it("uses one truthful fresh vote when only Codex remains", async () => {
    const f = reviewRoundsFixture(["claude-code", "grok"]);
    const initial = f.next()!;
    f.voteStep(initial);
    f.answer(initial.seats[0]!, "not-a-bug");
    const outcome = f.finish(initial);
    expect(initial.seats).toHaveLength(1);
    expect(f.finding.votes!.map(({ ballot: _ballot, ...vote }) => vote)).toEqual([{ by: "sol-high", toolId: "codex", plannedProfileId: "sol-high", verdict: "not-a-bug", reason: "The welcome page shows the greeting already." }]);
    expect(f.finding.verification?.by).toBe("sol-high");
    expect(f.finding.status).toBe("dismissed");
    await f.close(outcome);
    expect(f.ended).toEqual(["passed"]);
    expect(f.task.stageIndex).toBe(2);
    expect(f.task.journey!.filter(step => step.roleId === "verifier")[0]!.outcome).toBe("1 checked by one tool: none to fix now, 1 not a bug");
    expect(f.notes.some(text => text === "1 checked by one tool: none to fix now, 1 not a bug")).toBe(true);
  });

  it("waits with no usable voter and resumes on the one tool that recovers", async () => {
    const f = reviewRoundsFixture(["claude-code", "codex", "grok"]);
    const waiting = f.next()!;
    expect(waiting.panel).toBeUndefined();
    expect(f.task.hunt?.panel).toBeUndefined();
    expect(f.finding.verification).toBeUndefined();
    expect(f.task.stageIndex).toBe(1);
    f.state.pool.limited = f.state.pool.limited!.filter(limit => limit.toolId !== "codex");
    const recovered = f.next()!;
    f.voteStep(recovered);
    f.answer(recovered.seats[0]!, "not-a-bug");
    await f.close(f.finish(recovered));
    expect(recovered.seats).toHaveLength(1);
    expect(independentVotes(f.finding.votes).map(vote => vote.toolId)).toEqual(["codex"]);
  });
});
