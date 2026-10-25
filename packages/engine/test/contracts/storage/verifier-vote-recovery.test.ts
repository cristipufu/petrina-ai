import { afterAll, describe, expect, it } from "bun:test";
import { draftOf, independentVotes } from "@petrina/core";
import { waitFor } from "../../fixtures.js";
import { independentReviewFixtures } from "../../fixtures/independence.js";

const { voting, checkedFinding, plain, inject, close } = independentReviewFixtures();
afterAll(close);
describe.concurrent("bounded verifier panels", () => {
it("retains a finished tool's vote across restart while its partner is unfinished", async () => {
    const f = await voting({ verifier: "not-a-bug" });
    try {
      await f.advance(() => checkedFinding(f)?.votes?.length === 1, (role, session) => role !== "verifier" || f.model(session) === "gpt-6.1-sol");
      const saved = structuredClone(checkedFinding(f).votes![0]!);
      await f.restart();
      await f.advance(f.delivery);
      expect(f.fakes.received("verifier").filter((entry) => f.model(entry.session) === "gpt-6.1-sol")).toHaveLength(1);
      expect(checkedFinding(f).votes?.find((vote) => vote.toolId === "codex")).toEqual(saved);
      expect(checkedFinding(f).votes).toHaveLength(2);
      expect(checkedFinding(f).status).toBe("dismissed");
    } finally { await f.engine.shutdown(); }
  });

it("keeps the first pair's answers and its third place through a pause and a restart", async () => {
    const f = await voting({ verifier: "not-a-bug" }, 3, []);
    try {
      await f.advance(() => f.fakes.received("verifier").length === 2, (role) => role !== "verifier");
      // Pausing admits no new conversation: the pair finishes, and the third answer waits for resume.
      f.engine.setPoolPaused(true);
      for (const entry of f.fakes.received("verifier")) f.release(entry.session);
      await waitFor(() => independentVotes(checkedFinding(f).votes).length === 2 && !f.engine.drivers.has(f.task().id), "the first pair's answers");
      expect(f.fakes.received("verifier")).toHaveLength(2);
      expect(f.task().hunt?.panel?.seats).toHaveLength(2);
      f.engine.setPoolPaused(false);
      await f.advance(() => f.fakes.received("verifier").length === 3, (role) => role !== "verifier");
      const saved = f.task().hunt!.panel!;
      expect(saved.seats.map((seat) => seat.key)).toEqual(["sol-high", "grok-high", "third:opus-high"]);
      expect(saved.escalatedAt).toBeDefined();
      await f.restart();
      expect(f.task().hunt?.panel).toEqual(saved);
      await f.advance(f.delivery);
      const received = f.fakes.received("verifier");
      expect(received.filter((entry) => f.model(entry.session) === "gpt-6.1-sol")).toHaveLength(1);
      expect(received.filter((entry) => f.model(entry.session) === "grok-4.7")).toHaveLength(1);
      expect(new Set(received.filter((entry) => f.model(entry.session) === "opus").map((entry) => entry.session)).size).toBe(2);
      expect(checkedFinding(f).verification?.verdict).toBe("not-a-bug");
      expect(independentVotes(checkedFinding(f).votes)).toHaveLength(3);
    } finally { await f.engine.shutdown(); }
  });

it("saves partial reports before repair and restarts only the missing verdicts", async () => {
    const f = await voting({ partialVerification: true, verifier: "not-a-bug" }, 1, ["claude-code", "grok"]);
    try {
      inject(f, "second", "opus-high");
      await f.advance(() => f.fakes.marked("partial-verification"));
      const partial = structuredClone(f.task().findings.find((finding) => finding.votes?.length)!);
      expect(partial.votes).toHaveLength(1);
      expect(f.delivery()).toBe(false);
      f.fakes.scenario({ controlled: true, builder: "plain", reviewer: "important", verifier: "not-a-bug" });
      await f.restart();
      await f.advance(f.delivery);
      const opening = f.fakes.openings("verifier").at(-1)!;
      expect(opening.slice(opening.indexOf("## Important findings to check"))).not.toContain(`- [${partial.id}]`);
      expect(f.task().findings.find((finding) => finding.id === partial.id)?.votes).toEqual(partial.votes);
      expect(f.task().findings.filter((finding) => finding.votes?.length).every((finding) => finding.votes?.length === 1 && finding.status === "dismissed")).toBe(true);
    } finally { await f.engine.shutdown(); }
  });

it("keeps a voter's starting role and partial work when its model changes before restart", async () => {
    const f = await voting({ partialVerification: true, verifier: "not-a-bug" }, 3, ["codex", "grok"]);
    try {
      inject(f, "second", "opus-high");
      await f.advance(() => f.fakes.marked("partial-verification"));
      const partial = structuredClone(f.task().findings.find((finding) => finding.votes?.length)!);
      const original = f.engine.role("verifier")!;
      f.engine.saveRole(original.id, { ...draftOf(original), purpose: "Use the new voting instructions next round.", instructions: `${original.instructions}\nNew wording for the next voting round.` });
      f.engine.s.pool.limited!.push({ toolId: "claude-code", model: "opus", until: Date.now() + 3_600_000, reason: "Claude Code's weekly Opus limit" });
      f.fakes.scenario({ controlled: true, builder: "plain", reviewer: "important", verifier: "not-a-bug" });
      await f.restart();
      await f.advance(f.delivery);
      expect(f.models("verifier")).toEqual(["opus", "sonnet"]);
      const opening = f.fakes.openings("verifier").at(-1)!;
      expect(opening).toContain(`Your role: ${original.purpose}`);
      expect(opening).not.toContain("New wording for the next voting round.");
      expect(opening).not.toContain("Use the new voting instructions next round.");
      expect(opening.slice(opening.indexOf("## Important findings to check"))).not.toContain(`- [${partial.id}]`);
      expect(f.task().findings.find((finding) => finding.id === partial.id)?.votes).toEqual(partial.votes);
      const remaining = f.task().findings.find((finding) => finding.id !== partial.id && finding.votes?.length)!;
      expect(plain(remaining.votes)).toEqual([{ by: "sonnet-high", toolId: "claude-code", plannedProfileId: "opus-high", verdict: "not-a-bug", reason: "The welcome page shows the greeting already." }]);
      expect(f.engine.role("verifier")?.purpose).toBe("Use the new voting instructions next round.");
    } finally { await f.engine.shutdown(); }
  });

for (const [initial, corrected, restart] of [
    ["not-a-bug", "real", false],
    ["real", "not-a-bug", false],
    ["not-a-bug", "real", true],
  ] as const) it(`counts a corrected ${corrected} verdict after an incomplete ${initial} answer${restart ? ", retaining it through restart" : ""}`, async () => {
    const f = await voting({ partialVerification: true, verifier: initial, correctPartialVerification: corrected }, 3, restart ? ["claude-code"] : ["claude-code", "grok"]);
    try {
      // First on the ballot: its initial verdict must be revised by the completed answer.
      inject(f, "second", "opus-high");
      let saved;
      if (restart) {
        await f.advance(() => !!f.task().hunt?.voted?.["sol-high"], (role, session) => role !== "verifier" || f.model(session) === "gpt-6.1-sol");
        saved = structuredClone(f.task().findings.find((finding) => finding.id === "second")!.votes);
        expect(f.delivery()).toBe(false);
        expect(f.task().findings.every((finding) => !finding.verification)).toBe(true);
        f.fakes.scenario({ controlled: true, builder: "plain", reviewer: "important", verifier: "not-a-bug" });
        await f.restart();
      }
      // Hold a fix until we have checked whether the corrected ballot sends the work back.
      await f.advance(() => f.delivery() || f.fakes.openings("builder").length === 2, (role) => role !== "builder");
      const finding = f.task().findings.find((entry) => entry.id === "second")!;
      const votes = independentVotes(finding.votes);
      const reason = `After checking every finding, this one ${corrected === "real" ? "is a real problem" : "is not a bug"}.`;
      expect(finding.verification?.verdict).toBe(corrected);
      expect(plain(votes)!.find((vote) => vote.toolId === "codex")).toEqual({ by: "sol-high", toolId: "codex", plannedProfileId: "sol-high", verdict: corrected, reason });
      expect(votes).toHaveLength(restart ? 2 : 1);
      expect(plain(finding.votes?.filter((vote) => vote.toolId === "codex"))).toEqual([
        { by: "sol-high", toolId: "codex", plannedProfileId: "sol-high", verdict: initial, reason: initial === "real" ? "The welcome page has no greeting: confirmed by opening it." : "The welcome page shows the greeting already." },
        { by: "sol-high", toolId: "codex", plannedProfileId: "sol-high", verdict: corrected, reason },
      ]);
      if (saved) expect(finding.votes?.filter((vote) => vote.toolId === "codex")).toEqual([...saved]);
      expect(f.fakes.received("verifier").filter((entry) => f.model(entry.session) === "gpt-6.1-sol")).toHaveLength(2);
      if (corrected === "real") {
        expect(f.delivery()).toBe(false);
        expect(finding.status).toBe("open");
        expect(f.task().fixing).toBe(true);
      } else {
        expect(finding.status).toBe("dismissed");
        expect(f.fakes.openings("builder")).toHaveLength(1);
      }
      await f.advance(f.delivery);
    } finally { await f.engine.shutdown(); }
  });

it("keeps partial votes through a usage limit and waits until every finding has a verdict", async () => {
    const f = await voting({ partialVerification: true, limitAfterPartial: true, verifier: "not-a-bug" }, 3, ["claude-code", "grok"]);
    try {
      inject(f, "second", "opus-high");
      await f.advance(() => f.task().state === "waiting" && f.task().statusLine.startsWith("Waiting for usage") && f.fakes.received("verifier").length === 2);
      const partial = structuredClone(f.task().findings.find((finding) => finding.votes?.length)!);
      expect(partial.votes).toHaveLength(1);
      expect(f.task().findings.every((finding) => !finding.verification)).toBe(true);
      expect(f.delivery()).toBe(false);
      f.fakes.scenario({ controlled: true, builder: "plain", reviewer: "important", verifier: "not-a-bug" });
      f.engine.s.pool.limited = f.engine.s.pool.limited!.filter((limit) => limit.toolId !== "grok");
      f.engine.schedule();
      await f.advance(f.delivery);
      expect(f.task().findings.find((finding) => finding.id === partial.id)?.votes).toContainEqual(partial.votes![0]);
      const replacement = f.task().journey!.flatMap(step => step.agentInputs ?? []).find(input => input.selectionReason?.includes("takes its required seat"));
      expect(replacement?.selectionReason).toContain("saved votes remain");
      expect(replacement?.profileId).toBe("grok-high");
      expect(f.fakes.openings("verifier")).toHaveLength(2);
      // The replacement answered only what its place still owed, under the same place.
      const replacementOpening = f.fakes.openings("verifier").at(-1)!;
      expect(replacementOpening.slice(replacementOpening.indexOf("## Important findings to check"))).not.toContain(`- [${partial.id}]`);
      expect(f.task().findings.filter((finding) => finding.votes?.length).every((finding) => finding.status === "dismissed" && finding.votes!.every((vote) => vote.ballot?.seat === "sol-high"))).toBe(true);
    } finally { await f.engine.shutdown(); }
  });

it("keeps an older round's admitted one-per-tool panel and its majority rule until it finishes", async () => {
    const f = await voting({ verifierByModel: { "grok-4.7": "nit", "gemini-4-argon": "nit" } }, 4, [], true);
    try {
      // Pausing lets the admitted reviewers finish and admits no voter, so no bounded panel is saved yet.
      f.engine.setPoolPaused(true);
      await f.advance(() => Object.keys(f.task().hunt?.reported ?? {}).length === 2 && !f.engine.drivers.has(f.task().id) && !f.engine.settling.has(f.task().id));
      const task = f.engine.s.tasks.find((entry) => entry.id === f.task().id)!;
      expect(task.hunt!.panel).toBeUndefined();
      // An earlier release saved one voter per ready tool and two of their answers.
      task.hunt!.voterProfiles = ["opus-high", "sol-high", "grok-high", "argon-high"];
      task.findings.find((entry) => entry.text === "The greeting is missing on the welcome page.")!.votes = [
        { by: "opus-high", toolId: "claude-code", plannedProfileId: "opus-high", verdict: "real", reason: "An older ballot's real answer." },
        { by: "sol-high", toolId: "codex", plannedProfileId: "sol-high", verdict: "nit", reason: "An older ballot's nit answer." },
      ];
      await f.restart();
      f.engine.setPoolPaused(false);
      await f.advance(f.delivery);
      expect(new Set(f.models("verifier"))).toEqual(new Set(["grok-4.7", "gemini-4-argon"]));
      expect(f.fakes.openings("verifier")).toHaveLength(2);
      // One real answer of four does not reach that panel's half; a bounded panel would have kept it Important.
      expect(checkedFinding(f).verification?.verdict).toBe("nit");
      expect(independentVotes(checkedFinding(f).votes)).toHaveLength(4);
    } finally { await f.engine.shutdown(); }
  });

for (const proven of [true, false]) it(`${proven ? "counts this ballot's saved answers before choosing more work" : "keeps answers of unproven provenance as history"} when no panel was saved`, async () => {
    const f = await voting({ verifier: "not-a-bug" }, 3, ["claude-code", "codex", "grok"]);
    try {
      inject(f, "second", "opus-high");
      const task = f.engine.s.tasks.find((entry) => entry.id === f.task().id)!;
      await f.advance(() => Object.keys(f.task().hunt?.reported ?? {}).length === 2 && f.task().state === "waiting");
      const findings = task.findings.filter((finding) => finding.severity === "blocking");
      const hunt = task.hunt!;
      const provenance = (seat: string) => (proven ? { ballot: { stageId: hunt.stageId, round: hunt.round, seat, versions: { ...hunt.input!.heads } } } : {});
      const first = { by: "sol-high", toolId: "codex", plannedProfileId: "sol-high", verdict: "not-a-bug" as const, reason: "Codex's finished verdict before its limit.", ...provenance("sol-high") };
      const second = { by: "grok-xhigh", toolId: "grok", plannedProfileId: "grok-high", verdict: "not-a-bug" as const, reason: "Grok's finished verdict before its limit.", ...provenance("grok-high") };
      findings[0]!.votes = [first];
      findings[1]!.votes = [second];
      await f.restart();
      await f.advance(() => f.task().state === "waiting");
      expect(f.delivery()).toBe(false);
      expect(f.task().findings.every((finding) => !finding.verification)).toBe(true);
      expect(f.fakes.openings("verifier")).toHaveLength(0);
      // Only Codex recovers. Complementary partial answers never close the ballot by themselves.
      f.engine.s.pool.limited = f.engine.s.pool.limited!.filter((limit) => limit.toolId !== "codex");
      f.engine.schedule();
      if (proven) {
        await f.advance(() => f.fakes.openings("verifier").length === 1 && f.task().state === "waiting" && !!f.task().findings.find((finding) => finding.id === findings[1]!.id)?.votes?.some((vote) => vote.toolId === "codex"));
        expect(f.task().hunt?.panel?.seats.map((seat) => [seat.key, seat.toolId])).toEqual([["sol-high", "codex"], ["grok-high", "grok"]]);
        expect(f.delivery()).toBe(false);
        // Grok's evidenced place still owes the first finding.
        f.engine.s.pool.limited = f.engine.s.pool.limited!.filter((limit) => limit.toolId !== "grok");
        f.engine.schedule();
      }
      await f.advance(f.delivery);
      const openings = f.fakes.openings("verifier");
      expect(openings).toHaveLength(proven ? 2 : 1);
      const codex = openings[0]!.slice(openings[0]!.indexOf("## Important findings to check"));
      expect(codex.includes(`- [${findings[0]!.id}]`)).toBe(!proven);
      expect(f.task().findings.find((finding) => finding.id === findings[0]!.id)?.votes).toContainEqual(first);
      expect(f.task().findings.find((finding) => finding.id === findings[1]!.id)?.votes).toContainEqual(second);
      expect(f.task().findings.filter((finding) => finding.votes?.length).every((finding) => finding.status === "dismissed")).toBe(true);
    } finally { await f.engine.shutdown(); }
  });

});
