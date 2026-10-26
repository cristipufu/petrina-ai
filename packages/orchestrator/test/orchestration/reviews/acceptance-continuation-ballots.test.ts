import { describe, expect, it } from "vitest";
import { independentVotes, panelAnswers } from "@petrina/core";
import { reviewRoundsFixture } from "../../fixtures/review-rounds.js";

const plain = (votes: ReturnType<typeof independentVotes>) => votes.map(({ ballot: _ballot, ...vote }) => vote);

describe("acceptance continuation ballot records", () => {
  for (const [initial, corrected] of [["not-a-bug", "real"], ["real", "not-a-bug"]] as const) {
    it(`counts a corrected ${corrected} verdict after an incomplete ${initial} answer`, async () => {
      const f = reviewRoundsFixture(["claude-code", "grok"]), second = f.addFinding("second");
      const pending = f.next()!; f.voteStep(pending);
      const seat = pending.seats[0]!;
      f.answer(seat, initial, [second.id]);
      expect(f.finding.verification).toBeUndefined(); expect(second.verification).toBeUndefined();
      expect(f.next()!.seats[0]!.findingIds).toEqual([f.finding.id, second.id]);
      const reason = `After checking every finding, this one ${corrected === "real" ? "is a real problem" : "is not a bug"}.`;
      f.answer(seat, corrected, seat.findingIds, reason);
      const ready = f.next()!; expect(ready.voters).toEqual([]);
      const outcome = f.finish(ready);
      expect(second.verification?.verdict).toBe(corrected);
      expect(plain(independentVotes(second.votes))).toEqual([{ by: "sol-high", toolId: "codex", plannedProfileId: "sol-high", verdict: corrected, reason }]);
      expect(plain(second.votes!)).toEqual([
        { by: "sol-high", toolId: "codex", plannedProfileId: "sol-high", verdict: initial,
          reason: initial === "real" ? "The welcome page has no greeting: confirmed by opening it." : "The welcome page shows the greeting already." },
        { by: "sol-high", toolId: "codex", plannedProfileId: "sol-high", verdict: corrected, reason },
      ]);
      await f.close(outcome);
      expect(second.status).toBe(corrected === "real" ? "open" : "dismissed");
      expect(f.task.fixing === true).toBe(corrected === "real");
      expect(f.ended).toEqual([corrected === "real" ? "sent-back" : "passed"]);
    });
  }

  it("keeps an older round's admitted one-per-tool panel and its majority rule until it finishes", () => {
    const f = reviewRoundsFixture([], true);
    f.task.hunt!.voterProfiles = ["opus-high", "sol-high", "grok-high", "argon-high"];
    f.finding.votes = [
      { by: "opus-high", toolId: "claude-code", plannedProfileId: "opus-high", verdict: "real", reason: "An older ballot's real answer." },
      { by: "sol-high", toolId: "codex", plannedProfileId: "sol-high", verdict: "nit", reason: "An older ballot's nit answer." },
    ];
    const next = f.next()!;
    expect(next.panel!.rule).toBe("majority");
    expect(next.voters).toEqual(["grok-high", "argon-high"]);
    for (const seat of next.seats) f.answer(seat, "nit");
    const ready = f.next()!; expect(ready.voters).toEqual([]); f.finish(ready);
    expect(f.finding.verification?.verdict).toBe("nit");
    expect(independentVotes(f.finding.votes)).toHaveLength(4);
    expect(f.task.hunt!.voterProfiles).toBeUndefined();
  });

  for (const proven of [true, false]) it(`${proven ? "counts this ballot's saved answers before choosing more work" : "keeps answers of unproven provenance as history"} when no panel was saved`, () => {
    const f = reviewRoundsFixture(["claude-code", "codex", "grok"]), second = f.addFinding("second");
    const hunt = f.task.hunt!;
    const provenance = (seat: string) => proven ? { ballot: { stageId: hunt.stageId, round: hunt.round, seat, versions: { ...hunt.input!.heads } } } : {};
    const first = { by: "sol-high", toolId: "codex", plannedProfileId: "sol-high", verdict: "not-a-bug" as const, reason: "Codex's finished verdict before its limit.", ...provenance("sol-high") };
    const prior = { by: "grok-xhigh", toolId: "grok", plannedProfileId: "grok-high", verdict: "not-a-bug" as const, reason: "Grok's finished verdict before its limit.", ...provenance("grok-high") };
    f.finding.votes = [first]; second.votes = [prior];
    const waiting = f.next()!;
    if (proven) expect(waiting.panel!.seats.map(seat => seat.toolId)).toEqual(["codex", "grok"]);
    else expect(waiting.panel).toBeUndefined();
    expect(f.task.findings.every(finding => !finding.verification)).toBe(true);
    f.state.pool.limited = f.state.pool.limited!.filter(limit => limit.toolId !== "codex");
    const next = f.next()!;
    if (proven) {
      expect(next.panel!.seats.map(seat => [seat.key, seat.toolId])).toEqual([["sol-high", "codex"], ["grok-high", "grok"]]);
      expect(panelAnswers(next.panel!, f.finding, hunt)).toContainEqual(first);
      expect(next.seats.find(seat => seat.toolId === "codex")!.findingIds).toEqual([f.finding.id, second.id]);
      f.answer(next.seats.find(seat => seat.toolId === "codex")!, "not-a-bug", [second.id]);
      expect(f.next()!.voters).toEqual(["grok-high"]);
      expect(f.finding.verification).toBeUndefined();
      f.state.pool.limited = f.state.pool.limited!.filter(limit => limit.toolId !== "grok");
    }
    const remaining = f.next()!;
    for (const seat of remaining.seats) f.answer(seat, "not-a-bug");
    const ready = f.next()!; expect(ready.voters).toEqual([]); f.finish(ready);
    expect(f.finding.votes).toContainEqual(first); expect(second.votes).toContainEqual(prior);
    expect(f.task.findings.every(finding => finding.status === "dismissed")).toBe(true);
  });

  it("keeps partial votes through a usage limit and waits until every finding has a verdict", () => {
    const f = reviewRoundsFixture(["claude-code", "grok"]), second = f.addFinding("second");
    const initial = f.next()!; f.voteStep(initial);
    f.answer(initial.seats[0]!, "not-a-bug", [f.finding.id]);
    const partial = structuredClone(f.finding.votes![0]!);
    f.limit("claude-code", "codex", "grok");
    expect(f.next()!.voters).toEqual(["sol-high"]);
    expect(f.task.findings.every(finding => !finding.verification)).toBe(true);
    f.limit("claude-code", "codex");
    const replacement = f.next()!, seat = replacement.seats[0]!;
    expect(seat.key).toBe("sol-high"); expect(seat.profileId).toBe("grok-high");
    expect(seat.replaced!.reason).toContain("saved votes remain");
    expect(seat.findingIds).toEqual([f.finding.id, second.id]);
    f.answer(seat, "not-a-bug", [second.id]);
    const ready = f.next()!; expect(ready.voters).toEqual([]); f.finish(ready);
    expect(f.finding.votes).toContainEqual(partial);
    expect(f.task.findings.every(finding => finding.status === "dismissed" && finding.votes!.every(vote => vote.ballot?.seat === "sol-high"))).toBe(true);
  });
});
