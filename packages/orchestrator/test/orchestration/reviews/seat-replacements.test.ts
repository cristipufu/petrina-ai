import { describe, expect, it } from "vitest";
import { seatRemaining } from "@petrina/core";
import { reviewSelectionFixture } from "../../fixtures/review-selection.js";
  type Hunted = { stageId: string; round: number; input?: { heads: Readonly<Record<string, string>> } };
  const ballotOn = (hunt: Hunted, seat: string) => ({ stageId: hunt.stageId, round: hunt.round, seat, versions: { ...hunt.input!.heads } });
  const answer = (hunt: Hunted, seat: string, by: string, toolId: string, verdict: "real" | "nit" | "not-a-bug") => ({ by, toolId, plannedProfileId: seat, verdict, reason: `${toolId} answered ${verdict} for its place.`, ballot: ballotOn(hunt, seat) });

  const place = (key: string, profileId: string, toolId: string, findingIds: string[], extra: object = {}) => ({ key, profileId, toolId, findingIds, reason: "Chosen for the initial pair.", ...extra });

describe("immutable review inputs", () => {
it("keeps a later review stage's ballot to its own answers, never re-asking a finding left unresolved earlier", async () => {
    const f = reviewSelectionFixture(["sol-high", "opus-high"], []);
      const code = { id: "review", title: "Review", kind: "review-chain" as const, roleId: "code-reviewer", profileIds: ["sol-high", "opus-high"] };
      const security = { id: "security", title: "Security review", kind: "review-chain" as const, roleId: "security-reviewer", profileIds: ["sol-high", "opus-high"] };
      f.task.plan = { rationale: "Verify", plannerProfileId: "sol-high", stages: [code, security] }; f.task.stageIndex = 1;
      const codeBallot = { stageId: code.id, round: 1, seat: "sol-high", versions: { p: f.first } };
      f.task.findings = [
        { id: "unresolved", text: "Both first answers called it a nit", severity: "blocking", raisedBy: "grok-high", confirmedBy: [], status: "open", votes: [{ by: "sol-high", toolId: "codex", plannedProfileId: "sol-high", verdict: "nit", reason: "Only a nit on the code review's ballot.", ballot: codeBallot }], unresolved: { at: 1, reason: "No ready independent tool could give the third answer." } },
        { id: "security-finding", text: "Anyone can ask for the greeting.", severity: "blocking", raisedBy: "grok-high", confirmedBy: [], status: "open", votes: [{ by: "sol-high", toolId: "codex", plannedProfileId: "sol-high", verdict: "not-a-bug", reason: "An answer on the code review's ballot.", ballot: codeBallot }] },
      ];
      f.task.hunt = { stageId: security.id, round: 1, reported: { "0": true, "1": true }, findings: 0, input: { file: "input.json", digest: "d", heads: { p: f.first } } };
      const vote = f.ballots.next(f.task, security)!;
      expect(vote.findings.map((finding) => finding.id)).toEqual(["security-finding"]);
      expect(vote.seats.map((seat) => seat.toolId).sort()).toEqual(["claude-code", "codex"]);
      // The code review's Codex answer is history on this ballot: Codex's place still owes its own answer.
      for (const seat of vote.seats) expect(seatRemaining(vote.panel!, seat, f.task.findings, f.task.hunt!)).toEqual(["security-finding"]);
  });
});

describe("bounded verifier places after handoffs", () => {
it("never gives two unfinished places one tool at once, and lets a tool that finished one place take another", async () => {
    const f = reviewSelectionFixture(["opus-high", "sol-high", "grok-high"], ["x", "y"]);
    f.task.hunt = { stageId: f.stage.id, round: 1, reported: { "0": true, "1": true, "2": true }, findings: 0, input: { file: "input.json", digest: "d", heads: { p: f.first } } };
    const hunt = f.task.hunt;
    // Complementary partial answers: Claude Code answered x, Grok answered y. Both then run out.
    f.task.findings[0]!.votes = [answer(hunt, "opus-high", "opus-high", "claude-code", "nit")];
    f.task.findings[1]!.votes = [answer(hunt, "grok-high", "grok-high", "grok", "nit")];
    hunt.panel = { rule: "bounded", usable: ["claude-code", "codex", "grok"], seats: [place("opus-high", "opus-high", "claude-code", ["x", "y"]), place("grok-high", "grok-high", "grok", ["x", "y"])] };
    f.limit("claude-code", "grok");
      const vote = f.next()!;
      // Codex takes one place; the other waits while Codex still works there.
      expect(hunt.panel.seats.map((seat) => [seat.key, seat.toolId])).toEqual([["opus-high", "codex"], ["grok-high", "grok"]]);
      expect(vote.voters).toEqual(["sol-high", "grok-high"]);
      // Codex finished that place: it never answered x, so it takes the other place under that place's own name.
      f.task.findings[1]!.votes = [...f.task.findings[1]!.votes!, answer(hunt, "opus-high", "sol-high", "codex", "nit")];
      const next = f.next()!;
      expect(next.seats.map((seat) => [seat.key, seat.toolId, seat.profileId])).toEqual([["grok-high", "codex", "sol-high"]]);
      expect(next.phase!.map((seat) => seat.key)).toEqual(["opus-high", "grok-high"]);
      // A short same-conversation retry for Codex is looked up under the unfinished place it now works.
      expect(f.selection.votePlace(f.task, "sol-high")).toBe("vote-grok-high");
  });
});

describe("bounded verifier places after handoffs", () => {
for (const finished of [true, false]) it(`${finished ? "lets a tool that finished another finding's third answer give a stalled one" : "keeps a stalled third answer waiting while the free tool still works another place"}`, async () => {
    const f = reviewSelectionFixture(["opus-high", "sol-high", "grok-high", "argon-high"], ["x", "y"]);
    f.task.hunt = { stageId: f.stage.id, round: 1, reported: { "0": true, "1": true, "2": true, "3": true }, findings: 0, input: { file: "input.json", digest: "d", heads: { p: f.first } } };
    const hunt = f.task.hunt;
    // After partial handoffs x has Codex and Grok, y has Claude Code and Grok: separate third places.
    f.task.findings[0]!.votes = [answer(hunt, "sol-high", "sol-high", "codex", "nit"), answer(hunt, "grok-high", "grok-high", "grok", "nit"), ...(finished ? [answer(hunt, "third:argon-high", "argon-high", "antigravity", "nit")] : [])];
    f.task.findings[1]!.votes = [answer(hunt, "sol-high", "opus-high", "claude-code", "nit"), answer(hunt, "grok-high", "grok-high", "grok", "nit")];
    hunt.panel = { rule: "bounded", usable: ["claude-code", "codex", "grok", "antigravity"], escalatedAt: 1, seats: [
      place("sol-high", "sol-high", "codex", ["x", "y"]), place("grok-high", "grok-high", "grok", ["x", "y"]),
      place("third:argon-high", "argon-high", "antigravity", ["x"], { third: true }), place("third:sol-high", "sol-high", "codex", ["y"], { third: true }),
    ] };
    // y's third tool runs out; Antigravity stays free and has never answered y.
    f.limit("codex");
      const vote = f.next()!;
      const y = hunt.panel.seats.find((seat) => seat.key === "third:sol-high")!;
      if (finished) {
        expect([y.toolId, y.profileId]).toEqual(["antigravity", "argon-high"]);
        expect(y.replaced?.reason).toContain("takes its required seat on a different tool");
        expect(vote.seats.map((seat) => seat.key)).toEqual(["third:sol-high"]);
      } else {
        expect(y.toolId).toBe("codex");
        expect(vote.seats.map((seat) => [seat.key, seat.toolId])).toEqual([["third:argon-high", "antigravity"], ["third:sol-high", "codex"]]);
      }
  });
});

describe("bounded verifier places after handoffs", () => {
for (const [name, limited, profiles, expected] of [
    ["waits for the saved third tool rather than one left out at selection", ["claude-code", "antigravity"], ["opus-high", "sol-high", "grok-high", "argon-high"], { toolId: "antigravity" }],
    ["lets a tool left out at selection answer only when it can start now", ["antigravity"], ["opus-high", "sol-high", "grok-high", "argon-high"], { toolId: "claude-code" }],
    ["leaves the finding unresolved rather than waiting for a tool left out at selection", ["claude-code"], ["opus-high", "sol-high", "grok-high"], { unresolved: true }],
  ] as const) it(`${name}`, async () => {
    const f = reviewSelectionFixture([...profiles], ["f"]);
    f.task.hunt = { stageId: f.stage.id, round: 1, reported: Object.fromEntries(profiles.map((_, index) => [String(index), true as const])), findings: 0, input: { file: "input.json", digest: "d", heads: { p: f.first } } };
    const hunt = f.task.hunt;
    // Claude Code was out of usage when the panel was saved; both first answers say the finding does not block.
    f.task.findings[0]!.votes = [answer(hunt, "sol-high", "sol-high", "codex", "nit"), answer(hunt, "grok-high", "grok-high", "grok", "nit")];
    hunt.panel = { rule: "bounded", usable: ["codex", "grok", "antigravity"], seats: [place("sol-high", "sol-high", "codex", ["f"]), place("grok-high", "grok-high", "grok", ["f"])] };
    f.limit(...limited);
      const vote = f.next();
      const third = hunt.panel.seats.filter((seat) => seat.third);
      if ("unresolved" in expected) {
        expect(third).toEqual([]);
        expect(hunt.panel.escalations?.f?.unresolved).toBe(true);
        expect(vote?.seats).toEqual([]);
      } else {
        expect(third.map((seat) => [seat.toolId, seat.findingIds])).toEqual([[expected.toolId, ["f"]]]);
        expect(vote?.seats.map((seat) => seat.toolId)).toEqual([expected.toolId]);
      }
  });
});
