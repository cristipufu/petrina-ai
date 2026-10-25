import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beginAgentStep, panelAnswers } from "@petrina/core";
import { prepareReviewInput } from "../../../src/review-context.js";
import { git } from "../../fixtures.js";
import { reviewContextFixtures } from "../../fixtures/review-context.js";
const { bare, ballot, earlier, answer, place, close } = reviewContextFixtures();
afterAll(close);

describe("immutable review inputs", () => {
it("records a passed round against its saved snapshot, and omits unknown versions on older inputs", async () => {
    const f = await bare();
    try {
      const stage = { id: "review", title: "Review", kind: "review-chain" as const, roleId: "code-reviewer", profileIds: ["sol-high"] };
      f.task.plan = { rationale: "Review", plannerProfileId: "sol-high", stages: [stage] };
      f.task.stageIndex = 0; f.task.findings = [];
      const signal = new AbortController().signal;
      const input = await prepareReviewInput(f.engine.dataDir, f.scope, await f.context.captureReview(f.scope), signal);
      const originalTree = await git(f.repo, "rev-parse", "HEAD^{tree}");
      expect(input.trees).toEqual({ p: originalTree });
      f.task.hunt = { stageId: stage.id, round: 1, reported: { "0": true }, input };
      beginAgentStep(f.task, "code-reviewer", "sol-high", Date.now(), f.engine.s.roles, undefined, f.scope.work);
      writeFileSync(join(f.repo, "later.txt"), "Different current code\n");
      await git(f.repo, "add", "."); await git(f.repo, "commit", "-qm", "Later contents");
      await f.engine["reviews"].runReview(f.task, stage, signal);
      expect(f.task.journey!.at(-1)!.checkReviews?.map((review) => review.tree)).toEqual([originalTree]);
      expect(originalTree).not.toBe(await git(f.repo, "rev-parse", "HEAD^{tree}"));
      f.task.stageIndex = 0;
      const { trees: _trees, ...olderInput } = input;
      f.task.hunt = { stageId: stage.id, round: 1, reported: { "0": true }, input: olderInput };
      beginAgentStep(f.task, "code-reviewer", "sol-high", Date.now(), f.engine.s.roles, undefined, f.scope.work);
      await f.engine["reviews"].runReview(f.task, stage, signal);
      expect(f.task.journey!.at(-1)!.checkReviews).toBeUndefined();
    } finally { await f.shutdown(); }
  });
});

describe("immutable review inputs", () => {
it("gives queued voters complete reproduction evidence without current peer ballots", async () => {
    const f = await bare();
    const reviews = f.engine["reviews"];
    const stage = { id: "review", title: "Review", kind: "review-chain" as const, roleId: "code-reviewer", profileIds: ["sol-high", "opus-high"] };
    f.task.plan = { rationale: "Verify", plannerProfileId: "sol-high", stages: [stage] }; f.task.stageIndex = 0;
    f.task.findings = [{ ...structuredClone(earlier), status: "open", answer: undefined, evidence: "Original full diagnostic ".repeat(100), steps: "Exact reproduction" }];
    const signal = new AbortController().signal;
    const input = await prepareReviewInput(f.engine.dataDir, f.scope, await f.context.captureReview(f.scope), signal);
    f.task.hunt = { stageId: stage.id, round: 1, reported: {}, findings: 1, input };
    const bodies: string[] = [];
    const turn = spyOn(f.engine["turns"], "parallel").mockImplementation(async (_scope, _role, _profile, _copy, given) => {
      bodies.push(JSON.stringify(await given()));
      f.task.findings[0]!.votes = [{ by: "sol-high", toolId: "codex", verdict: "real", reason: "CURRENT-PEER-BALLOT" }];
      return undefined as never;
    });
    const together = spyOn(reviews as unknown as { together: typeof reviews["together"] }, "together").mockImplementation(async (_task, members) => {
      for (const member of members) await member.work(f.repo, () => true, member.profileId, () => {}, {} as never, false, signal);
    });
    try {
      const ids = f.task.findings.map((finding) => finding.id);
      const seats = stage.profileIds.map((profileId) => ({ key: profileId, profileId, toolId: f.engine.profile(profileId)!.toolId, findingIds: ids, reason: "Chosen for the initial pair." }));
      await reviews["vote"](f.task, { findings: f.task.findings, seats, voters: stage.profileIds }, signal);
      expect(bodies).toHaveLength(2);
      for (const body of bodies) { expect(body).toContain("Exact reproduction"); expect(body).toContain(f.task.findings[0]!.evidence!); expect(body).not.toContain("CURRENT-PEER-BALLOT"); }
    } finally { together.mockRestore(); turn.mockRestore(); await f.shutdown(); }
  });
});

describe("bounded verifier places after handoffs", () => {
it("records only what a takeover still owes, and its step still expects every place", async () => {
    const f = await ballot(["opus-high", "sol-high", "grok-high"], ["a", "b"]);
    const signal = new AbortController().signal;
    const input = await prepareReviewInput(f.engine.dataDir, f.scope, await f.context.captureReview(f.scope), signal);
    f.task.hunt = { stageId: f.stage.id, round: 1, reported: { "0": true, "1": true, "2": true }, findings: 2, input };
    const hunt = f.task.hunt;
    // Claude answered "a" before running out; Codex took over its place, which still owes "b". Grok answered both.
    f.task.findings[0]!.votes = [answer(hunt, "opus-high", "opus-high", "claude-code", "nit"), answer(hunt, "grok-high", "grok-high", "grok", "real")];
    f.task.findings[1]!.votes = [answer(hunt, "grok-high", "grok-high", "grok", "real")];
    const taken = place("opus-high", "sol-high", "codex", ["a", "b"], { replaced: { from: "opus-high", reason: "Claude Code ran out." } });
    const grok = place("grok-high", "grok-high", "grok", ["a", "b"]);
    hunt.panel = { rule: "bounded", usable: ["claude-code", "codex", "grok"], seats: [taken, grok] };
    const bodies: string[] = [];
    const expected: unknown[] = [];
    const named: unknown[] = [];
    let status = "";
    const turn = spyOn(f.engine["turns"], "parallel").mockImplementation(async (_scope, _role, _profile, _copy, given, _schema, _signal, options) => {
      bodies.push(JSON.stringify(await given()));
      expected.push(options?.seats);
      named.push([options?.key, options?.member, options?.place]);
      // Shown only "b", the takeover also answers "a", which its place already holds from Claude Code.
      await (options!.check as (value: unknown) => unknown)({ verdicts: [{ id: "a", verdict: "nit", reason: "An unasked answer on a finding this place already holds." }, { id: "b", verdict: "nit", reason: "The answer this place still owed." }] });
      return undefined as never;
    });
    const together = spyOn(f.reviews as unknown as { together: typeof f.reviews["together"] }, "together").mockImplementation(async (_task, members, _signal, words) => {
      status = words(1, 0);
      for (const member of members) await member.work(f.repo, () => true, member.profileId, () => {}, {} as never, false, signal);
    });
    try {
      await f.reviews["vote"](f.task, { findings: f.task.findings, seats: [hunt.panel.seats[0]!], voters: ["sol-high"], phase: [...hunt.panel.seats], panel: hunt.panel }, signal);
      const shown = JSON.parse(bodies[0]!).map((section: { body: string }) => section.body).at(-1) as string;
      expect(shown).toContain("- [b]");
      expect(shown).not.toContain("- [a]");
      expect(panelAnswers(hunt.panel, f.task.findings[0]!, hunt).map((vote) => [vote.toolId, vote.verdict])).toEqual([["claude-code", "nit"], ["grok", "real"]]);
      expect(f.task.findings[0]!.votes).toHaveLength(2);
      expect(panelAnswers(hunt.panel, f.task.findings[1]!, hunt).map((vote) => [vote.toolId, vote.verdict])).toEqual([["grok", "real"], ["codex", "nit"]]);
      // The step expects Grok's finished place as well as the one being taken over, each named by its place.
      expect(expected).toEqual([["verifier:opus-high", "verifier:grok-high"]]);
      expect(named).toEqual([["verifier:opus-high", "vote-opus-high", "opus-high"]]);
      expect(status).toBe("1 fresh agent voting on 2 important findings");
    } finally { together.mockRestore(); turn.mockRestore(); await f.shutdown(); }
  });
});

describe("bounded verifier places after handoffs", () => {
it("counts only the findings a third answer was given in its live status", async () => {
    const f = await ballot(["opus-high", "sol-high", "grok-high"], ["a", "b"]);
    const signal = new AbortController().signal;
    const input = await prepareReviewInput(f.engine.dataDir, f.scope, await f.context.captureReview(f.scope), signal);
    f.task.hunt = { stageId: f.stage.id, round: 1, reported: { "0": true, "1": true, "2": true }, findings: 2, input };
    const third = place("third:opus-high", "opus-high", "claude-code", ["b"], { third: true, reason: "Third answer." });
    f.task.hunt.panel = { rule: "bounded", usable: ["claude-code", "codex", "grok"], seats: [place("sol-high", "sol-high", "codex", ["a", "b"]), place("grok-high", "grok-high", "grok", ["a", "b"]), third], escalatedAt: 1 };
    let status = "";
    const together = spyOn(f.reviews as unknown as { together: typeof f.reviews["together"] }, "together").mockImplementation(async (_task, _members, _signal, words) => { status = words(1, 0); });
    try {
      await f.reviews["vote"](f.task, { findings: f.task.findings, seats: [third], voters: ["opus-high"], phase: [third], third: true, panel: f.task.hunt.panel }, signal);
      expect(status).toBe("1 fresh agent giving a third answer on 1 important finding");
    } finally { together.mockRestore(); await f.shutdown(); }
  });
});
