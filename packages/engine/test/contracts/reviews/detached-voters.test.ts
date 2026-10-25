import { afterAll, describe, expect, it, spyOn } from "bun:test";
import * as gitOps from "@petrina/repositories/git";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepareReviewInput } from "../../../src/review-context.js";
import { WaitingForCapacity } from "../../../src/usage.js";
import { git, waitFor } from "../../fixtures.js";
import { reviewContextFixtures } from "../../fixtures/review-context.js";
const { ballot, answer, place, close } = reviewContextFixtures();
afterAll(close);

describe("bounded verifier places after handoffs", () => {
it("gives each third place, a replaced one included, its own portable copy and records its answer on that place", async () => {
    const f = await ballot(["opus-high", "sol-high", "grok-high", "argon-high"], ["x", "y"]);
    const signal = new AbortController().signal;
    const input = await prepareReviewInput(f.engine.dataDir, f.scope, await f.context.captureReview(f.scope), signal);
    f.task.hunt = { stageId: f.stage.id, round: 1, reported: { "0": true, "1": true, "2": true, "3": true }, findings: 2, input };
    const hunt = f.task.hunt;
    for (const finding of f.task.findings) finding.votes = [answer(hunt, "sol-high", "sol-high", "codex", "nit"), answer(hunt, "grok-high", "grok-high", "grok", "nit")];
    // Claude Code gives x its third answer; Antigravity took over y's third place from Codex.
    const third = place("third:opus-high", "opus-high", "claude-code", ["x"], { third: true });
    const taken = place("third:sol-high", "argon-high", "antigravity", ["y"], { third: true, replaced: { from: "sol-high", reason: "Codex ran out." } });
    hunt.panel = { rule: "bounded", usable: ["claude-code", "codex", "grok", "antigravity"], escalatedAt: 1, seats: [place("sol-high", "sol-high", "codex", ["x", "y"]), place("grok-high", "grok-high", "grok", ["x", "y"]), third, taken] };
    const folder = join(f.engine.dataDir, "worktrees", "p", `${f.task.id}.copies`);
    const seen: { member?: string; place?: string; copy: string; head: string; peers: string[] }[] = [];
    const turn = spyOn(f.engine["turns"], "parallel").mockImplementation(async (_scope, _role, _profile, copy, _given, _schema, _signal, options) => {
      // Each start in call order, with the folder as it was then; its version follows once Git answers.
      const entry = { member: options?.member, place: options?.place, copy, head: "", peers: readdirSync(folder).sort() };
      seen.push(entry);
      entry.head = await git(copy, "rev-parse", "HEAD");
      await (options!.check as (value: unknown) => unknown)({ verdicts: [{ id: "x", verdict: "real", reason: "Reproduced the missing x greeting." }, { id: "y", verdict: "real", reason: "Reproduced the missing y greeting." }] });
      return undefined as never;
    });
    try {
      await f.reviews["vote"](f.task, { findings: f.task.findings, seats: [third, taken], voters: ["opus-high", "argon-high"], phase: [third, taken], third: true, panel: hunt.panel }, signal);
      // Each place works in a folder named after its place, never its tool, and never the raw `third:` name.
      expect(seen.map(({ peers: _peers, ...entry }) => entry).sort((a, b) => a.copy.localeCompare(b.copy))).toEqual([
        { member: "vote-third:opus-high", place: "third:opus-high", copy: join(folder, "vote-third_3aopus-high"), head: f.first },
        { member: "vote-third:sol-high", place: "third:sol-high", copy: join(folder, "vote-third_3asol-high"), head: f.first },
      ]);
      // The later start still sees its peer's separate copy: both were made beside each other.
      expect(seen.at(-1)!.peers).toEqual(["vote-third_3aopus-high", "vote-third_3asol-high"]);
      expect(existsSync(folder)).toBe(false);
      expect(await git(f.repo, "worktree", "list", "--porcelain")).not.toContain(`${f.task.id}.copies`);
      // Answers keep their logical places: the takeover's answer counts for the place it took.
      const [x, y] = f.task.findings;
      expect(x!.votes!.at(-1)).toMatchObject({ by: "opus-high", toolId: "claude-code", verdict: "real", ballot: { seat: "third:opus-high" } });
      expect(y!.votes!.at(-1)).toMatchObject({ by: "argon-high", toolId: "antigravity", plannedProfileId: "argon-high", verdict: "real", ballot: { seat: "third:sol-high" } });
      expect(x!.votes).toHaveLength(3);
      expect(y!.votes).toHaveLength(3);
      expect(hunt.panel.seats.map((seat) => seat.key)).toEqual(["sol-high", "grok-high", "third:opus-high", "third:sol-high"]);
    } finally { turn.mockRestore(); await f.engine.shutdown(); }
  });
});

describe("bounded verifier places after handoffs", () => {
it("brings a third place stopped by a full model back into the copy it made, while its peer still works", async () => {
    const f = await ballot(["opus-high", "sol-high", "grok-high", "argon-high"], ["x", "y"]);
    const signal = new AbortController().signal;
    const input = await prepareReviewInput(f.engine.dataDir, f.scope, await f.context.captureReview(f.scope), signal);
    f.task.hunt = { stageId: f.stage.id, round: 1, reported: { "0": true, "1": true, "2": true, "3": true }, findings: 2, input };
    const hunt = f.task.hunt;
    for (const finding of f.task.findings) finding.votes = [answer(hunt, "sol-high", "sol-high", "codex", "nit"), answer(hunt, "grok-high", "grok-high", "grok", "nit")];
    const third = place("third:opus-high", "opus-high", "claude-code", ["x"], { third: true });
    const taken = place("third:sol-high", "argon-high", "antigravity", ["y"], { third: true, replaced: { from: "sol-high", reason: "Codex ran out." } });
    hunt.panel = { rule: "bounded", usable: ["claude-code", "codex", "grok", "antigravity"], escalatedAt: 1, seats: [place("sol-high", "sol-high", "codex", ["x", "y"]), place("grok-high", "grok-high", "grok", ["x", "y"]), third, taken] };
    const folder = join(f.engine.dataDir, "worktrees", "p", `${f.task.id}.copies`);
    const starts: { member?: string; copy: string; draft: boolean }[] = [];
    const back = () => starts.filter((entry) => entry.member === "vote-third:sol-high").length === 2;
    const turn = spyOn(f.engine["turns"], "parallel").mockImplementation(async (_scope, _role, _profile, copy, _given, _schema, _signal, options) => {
      const first = !starts.some((entry) => entry.member === options?.member);
      starts.push({ member: options?.member, copy, draft: existsSync(join(copy, "capacity-draft.txt")) });
      // Antigravity's model is full on its first try and leaves a partial draft in its copy.
      if (options?.member === "vote-third:sol-high" && first) {
        writeFileSync(join(copy, "capacity-draft.txt"), "A partial third answer\n");
        throw new WaitingForCapacity("Gemini 4 Argon is at capacity");
      }
      // Claude Code keeps working until its peer has come back.
      if (options?.member === "vote-third:opus-high") await waitFor(back, "the stopped third place to come back beside its working peer");
      await (options!.check as (value: unknown) => unknown)({ verdicts: [{ id: "x", verdict: "real", reason: "Reproduced the missing x greeting." }, { id: "y", verdict: "real", reason: "Reproduced the missing y greeting." }] });
      return undefined as never;
    });
    try {
      await f.reviews["vote"](f.task, { findings: f.task.findings, seats: [third, taken], voters: ["opus-high", "argon-high"], phase: [third, taken], third: true, panel: hunt.panel }, signal);
      const own = join(folder, "vote-third_3asol-high");
      expect(starts.filter((entry) => entry.member === "vote-third:sol-high")).toEqual([{ member: "vote-third:sol-high", copy: own, draft: false }, { member: "vote-third:sol-high", copy: own, draft: true }]);
      expect(starts.filter((entry) => entry.member === "vote-third:opus-high")).toEqual([{ member: "vote-third:opus-high", copy: join(folder, "vote-third_3aopus-high"), draft: false }]);
      expect(f.task.findings[1]!.votes!.at(-1)).toMatchObject({ by: "argon-high", toolId: "antigravity", verdict: "real", ballot: { seat: "third:sol-high" } });
      expect(f.task.findings[0]!.votes!.at(-1)).toMatchObject({ by: "opus-high", toolId: "claude-code", verdict: "real", ballot: { seat: "third:opus-high" } });
      expect(existsSync(folder)).toBe(false);
      expect(await git(f.repo, "worktree", "list", "--porcelain")).not.toContain(`${f.task.id}.copies`);
    } finally { turn.mockRestore(); await f.engine.shutdown(); }
  });
});

describe("bounded verifier places after handoffs", () => {
it("gives a verifier its own copy when a screen wait saved before the folder rule kept that folder name", async () => {
    const f = await ballot(["opus-high", "sol-high"], ["a"]);
    // Two accepted profile names: the earlier version saved `_46`'s copy as vote-_46, which is F's encoded folder now.
    f.engine.s.profiles.push({ ...f.engine.profile("opus-high")!, id: "_46" }, { ...f.engine.profile("sol-high")!, id: "F" });
    const signal = new AbortController().signal;
    const input = await prepareReviewInput(f.engine.dataDir, f.scope, await f.context.captureReview(f.scope), signal);
    f.task.hunt = { stageId: f.stage.id, round: 1, reported: { "0": true, "1": true }, findings: 1, input };
    const hunt = f.task.hunt;
    const saved = place("_46", "_46", "claude-code", ["a"]), peer = place("F", "F", "codex", ["a"]);
    hunt.panel = { rule: "bounded", usable: ["claude-code", "codex"], seats: [saved, peer] };
    const folder = join(f.engine.dataDir, "worktrees", "p", `${f.task.id}.copies`);
    const old = join(folder, "vote-_46");
    expect(join(folder, gitOps.copyFolderName("vote-F"))).toBe(old);
    await gitOps.addCopy(f.repo, old, f.first);
    writeFileSync(join(old, "screen-notes.txt"), "Kept through the upgrade\n");
    const conversation = { step: "review", roleId: "verifier", profileId: "_46", toolId: "claude-code", model: "opus", sessionId: "saved-before-upgrade", startedAt: Date.now() };
    hunt.screenTurns = { "vote-_46": { reason: "Check the window", at: Date.now(), copy: old, conversation } };
    f.task.screen = { reason: "Check the window", at: Date.now(), roleId: "verifier", profileId: "_46", member: "vote-_46", granted: true };
    const starts: { member?: string; copy: string; head: string; notes: boolean; peers: string[] }[] = [];
    const record = async (copy: string, options: { member?: string; check?: unknown } | undefined) => {
      // Each start in call order, with its copy and folder as they were then; its version follows once Git answers.
      const entry = { member: options?.member, copy, head: "", notes: existsSync(join(copy, "screen-notes.txt")), peers: readdirSync(folder).sort() };
      starts.push(entry);
      entry.head = await git(copy, "rev-parse", "HEAD");
      await (options!.check as (value: unknown) => unknown)({ verdicts: [{ id: "a", verdict: "real", reason: `Reproduced the missing a greeting in ${options?.member}.` }] });
      return undefined as never;
    };
    const continued = spyOn(f.engine["turns"], "turn").mockImplementation(async (_scope, _role, _profile, _given, _schema, _signal, options) => record(options!.copy!, options));
    const fresh = spyOn(f.engine["turns"], "parallel").mockImplementation(async (_scope, _role, _profile, copy, _given, _schema, _signal, options) => record(copy, options));
    try {
      await f.reviews["vote"](f.task, { findings: f.task.findings, seats: [saved, peer], voters: ["_46", "F"], phase: [saved, peer], panel: hunt.panel }, signal);
      // The saved verifier finishes in the copy it kept; that folder stays until the group ends, so F works beside it.
      expect(starts).toEqual([
        { member: "vote-_46", copy: old, head: f.first, notes: true, peers: ["vote-_46"] },
        { member: "vote-F", copy: join(folder, "vote-_46.1"), head: f.first, notes: false, peers: ["vote-_46", "vote-_46.1"] },
      ]);
      expect(f.task.findings[0]!.votes!.map((vote) => [vote.by, vote.ballot?.seat])).toEqual([["_46", "_46"], ["F", "F"]]);
      expect(existsSync(folder)).toBe(false);
      expect(await git(f.repo, "worktree", "list", "--porcelain")).not.toContain(`${f.task.id}.copies`);
    } finally { continued.mockRestore(); fresh.mockRestore(); await f.engine.shutdown(); }
  });
});
