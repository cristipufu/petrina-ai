import { describe, expect, it } from "vitest";
import type { VerifierPanel } from "../../../src/model.js";
import { acceptsAnswer, authorProfile, ballotOf, choosePanel, decide, engagedTools, inBallot, panelAnswers, planThirdAnswers, reopensUnresolved, replacementFor, reviewedCode, seatRemaining } from "../../../src/verifier-panel.js";
import { answer, candidate, hunt, name } from "../../fixtures/verifier-panel.js";

describe("choosing a new ballot's panel", () => {
  it("starts two fresh places on distinct tools, not one per registered provider", () => {
    const panel = choosePanel({ candidates: ["claude-code", "codex", "grok", "antigravity"].map((tool) => candidate(tool)), findings: [{ id: "f1", author: "codex" }], name })!;
    expect(panel.rule).toBe("bounded");
    expect(panel.usable).toEqual(["claude-code", "codex", "grok", "antigravity"]);
    // The historical split: Claude and Grok sit first because Codex reported the finding.
    expect(panel.seats.map((seat) => seat.toolId)).toEqual(["claude-code", "grok"]);
    expect(panel.seats.every((seat) => seat.findingIds.join() === "f1")).toBe(true);
    expect(panel.seats[0]!.reason).toContain("usable at selection: Claude Code, Codex, Grok and Antigravity; avoided Codex, which reported a finding");
  });

  it("keeps one shared pair for mixed authors, with the fewest author overlaps and the stable order breaking ties", () => {
    const panel = choosePanel({ candidates: ["claude-code", "codex", "grok"].map((tool) => candidate(tool)), findings: [{ id: "a", author: "claude-code" }, { id: "b", author: "claude-code" }, { id: "c", author: "codex" }], name })!;
    expect(panel.seats.map((seat) => seat.toolId)).toEqual(["grok", "codex"]);
    expect(panel.seats.map((seat) => seat.findingIds)).toEqual([["a", "b", "c"], ["a", "b", "c"]]);
    expect(panel.authors).toEqual({ a: "claude-code", b: "claude-code", c: "codex" });
  });

  it("uses the author's tool only when no other usable tool exists, and one place when only one tool is usable", () => {
    const pair = choosePanel({ candidates: [candidate("claude-code"), candidate("codex")], findings: [{ id: "f", author: "claude-code" }], name })!;
    expect(pair.seats.map((seat) => seat.toolId)).toEqual(["codex", "claude-code"]);
    const one = choosePanel({ candidates: [candidate("codex")], findings: [{ id: "f" }], name })!;
    expect(one.seats).toHaveLength(1);
    expect(one.seats[0]!.reason).toContain("The only usable tool checks these findings alone");
    expect(choosePanel({ candidates: [], findings: [{ id: "f" }], name })).toBeUndefined();
  });

  it("keeps every place an earlier answer of this ballot proved, then fills the pair", () => {
    const kept = choosePanel({ candidates: [candidate("claude-code"), candidate("codex")], recovered: [candidate("grok")], findings: [{ id: "f", author: "claude-code" }], name })!;
    expect(kept.seats.map((seat) => seat.toolId)).toEqual(["grok", "codex"]);
    expect(kept.usable).toEqual(["claude-code", "codex", "grok"]);
    const larger = choosePanel({ candidates: [candidate("claude-code")], recovered: ["codex", "grok", "antigravity"].map((tool) => candidate(tool)), findings: [{ id: "f" }], name })!;
    expect(larger.seats.map((seat) => seat.toolId)).toEqual(["codex", "grok", "antigravity"]);
  });
});

describe("settling a finding", () => {
  const four: VerifierPanel = { rule: "bounded", usable: ["claude-code", "codex", "grok", "antigravity"], seats: [] };
  const two: VerifierPanel = { rule: "bounded", usable: ["claude-code", "codex"], seats: [] };

  it("keeps any real answer Important, disputed when the other answer disagreed, without a third answer", () => {
    expect(decide(four, [answer("opus-high", "claude-code", "real"), answer("grok-high", "grok", "real")])).toMatchObject({ verdict: "real", disputed: [] });
    const split = decide(four, [answer("opus-high", "claude-code", "nit"), answer("grok-high", "grok", "real")]);
    expect(split).toMatchObject({ verdict: "real", vote: { toolId: "grok" } });
    expect(split?.verdict === "real" && split.disputed.map((vote) => vote.toolId)).toEqual(["claude-code"]);
  });

  it("asks a third tool when both initial answers do not block and the saved usable set had one", () => {
    // task-59268-65829: Claude and Grok said nit; Codex and Antigravity, unasked, said real.
    const pair = [answer("opus-high", "claude-code", "nit"), answer("grok-high", "grok", "nit")];
    expect(decide(four, pair)).toEqual({ verdict: "third" });
    expect(decide(four, [answer("opus-high", "claude-code", "nit"), answer("grok-high", "grok", "not-a-bug")])).toEqual({ verdict: "third" });
    expect(decide(four, [...pair, answer("third:argon-high", "antigravity", "real")])).toMatchObject({ verdict: "real" });
    expect(decide(four, [...pair, answer("third:sol-high", "codex", "real")])).toMatchObject({ verdict: "real" });
    // Without dissent the third answer settles on the most common other verdict; no fourth is asked.
    expect(decide(four, [...pair, answer("third:sol-high", "codex", "not-a-bug")])).toMatchObject({ verdict: "nit" });
  });

  it("lets an exhaustive one- or two-tool panel settle, with the mildest verdict breaking a tie", () => {
    expect(decide(two, [answer("opus-high", "claude-code", "not-a-bug"), answer("sol-high", "codex", "not-a-bug")])).toMatchObject({ verdict: "not-a-bug" });
    expect(decide(two, [answer("opus-high", "claude-code", "pre-existing"), answer("sol-high", "codex", "nit")])).toMatchObject({ verdict: "nit" });
    expect(decide(two, [answer("opus-high", "claude-code", "not-a-bug"), answer("sol-high", "codex", "pre-existing")])).toMatchObject({ verdict: "pre-existing" });
    expect(decide({ ...two, usable: ["codex"] }, [answer("sol-high", "codex", "not-a-bug")])).toMatchObject({ verdict: "not-a-bug" });
    expect(decide(two, [])).toBeUndefined();
  });

  it("keeps an older panel's majority rule until it finishes", () => {
    const older: VerifierPanel = { rule: "majority", usable: ["claude-code", "codex", "grok", "antigravity"], seats: [] };
    const votes = [answer("opus-high", "claude-code", "nit"), answer("sol-high", "codex", "real"), answer("grok-high", "grok", "nit"), answer("argon-high", "antigravity", "real")];
    expect(decide(older, votes)).toMatchObject({ verdict: "real" });
    expect(decide(older, [votes[0]!, votes[1]!, votes[2]!])).toMatchObject({ verdict: "nit" });
  });
});

describe("which answers count", () => {
  const panel: VerifierPanel = { rule: "bounded", usable: ["claude-code", "codex", "grok"], seats: [
    { key: "opus-high", profileId: "sol-high", toolId: "codex", findingIds: ["a", "b"], reason: "", replaced: { from: "opus-high", reason: "Claude ran out" } },
    { key: "grok-high", profileId: "grok-high", toolId: "grok", findingIds: ["a", "b"], reason: "" },
  ] };

  it("counts only this stage, round and reviewed version, the latest per tool, and never an unproven identity", () => {
    const finding = { id: "a", votes: [
      { by: "opus-high", verdict: "real" as const, reason: "An older nominal vote" },
      { ...answer("grok-high", "grok", "real"), ballot: { ...ballotOf(hunt, "grok-high"), round: 0 } },
      { ...answer("grok-high", "grok", "real"), ballot: { ...ballotOf(hunt, "grok-high"), versions: { product: "older" } } },
      { ...answer("grok-high", "grok", "real"), ballot: { ...ballotOf(hunt, "grok-high"), stageId: "security" } },
      answer("opus-high", "claude-code", "nit"),
      answer("opus-high", "codex", "real"),
      answer("opus-high", "codex", "not-a-bug", "A corrected answer"),
    ] };
    expect(inBallot(finding.votes[4]!, hunt)).toBe(true);
    expect(inBallot(finding.votes[1]!, hunt)).toBe(false);
    expect(inBallot(finding.votes[3]!, hunt)).toBe(false);
    expect(panelAnswers(panel, finding, hunt).map((vote) => [vote.toolId, vote.verdict])).toEqual([["claude-code", "nit"], ["codex", "not-a-bug"]]);
  });

  it("asks a replacement only for what its place still owes, and keeps each finding's tools independent", () => {
    const findings = [{ id: "a", votes: [answer("opus-high", "claude-code", "nit")] }, { id: "b", votes: [] }];
    // Claude answered "a" before its limit; its replacement owes only "b".
    expect(seatRemaining(panel, panel.seats[0]!, findings, hunt)).toEqual(["b"]);
    expect([...engagedTools(panel, findings[0]!, hunt)].sort()).toEqual(["claude-code", "grok"]);
    expect([...engagedTools(panel, findings[1]!, hunt, panel.seats[0])]).toEqual(["grok"]);
    const engaged = (id: string) => engagedTools(panel, findings.find((finding) => finding.id === id)!, hunt, panel.seats[0]);
    expect(replacementFor(["b"], engaged, [candidate("grok"), candidate("claude-code"), candidate("antigravity")], ["codex"])?.toolId).toBe("claude-code");
    expect(replacementFor(["a", "b"], engaged, [candidate("grok"), candidate("claude-code")], [])).toBeUndefined();
  });

  it("records only answers a place still owes or its own tool's corrections, never an unasked takeover answer", () => {
    // Claude answered "a" on its place before Codex took over that place for "b"; Grok answered "a" on its own place.
    const a = { id: "a", votes: [answer("opus-high", "claude-code", "nit"), answer("grok-high", "grok", "real")] };
    const b = { id: "b", votes: [answer("grok-high", "grok", "real")] };
    const [taken, grok] = panel.seats as [VerifierPanel["seats"][number], VerifierPanel["seats"][number]];
    expect(acceptsAnswer(panel, taken, b, hunt, "codex")).toBe(true);
    expect(acceptsAnswer(panel, taken, a, hunt, "codex")).toBe(false);
    // The same tool may still correct its own answer on its place, through a model stand-in too.
    expect(acceptsAnswer(panel, taken, a, hunt, "claude-code")).toBe(true);
    expect(acceptsAnswer(panel, grok, a, hunt, "grok")).toBe(true);
    // A tool that already answered a finding through another place never answers it again here.
    const reused = { ...taken, toolId: "grok", profileId: "grok-high" };
    expect(acceptsAnswer({ ...panel, seats: [reused, grok] }, reused, { id: "a", votes: [answer("grok-high", "grok", "real")] }, hunt, "grok")).toBe(false);
    expect(acceptsAnswer(panel, taken, { id: "c", votes: [] }, hunt, "codex")).toBe(false);
    expect(acceptsAnswer({ ...panel, rule: "majority" }, taken, a, hunt, "codex")).toBe(true);
    // An answer from an older round on this place does not block this ballot's answer.
    expect(acceptsAnswer(panel, taken, { id: "b", votes: [{ ...answer("opus-high", "claude-code", "nit"), ballot: { ...ballotOf(hunt, "opus-high"), round: 0 } }] }, hunt, "codex")).toBe(true);
  });

  it("reopens a finding a vote left unresolved only with a current reproduction on changed code", () => {
    const unresolved = { unresolved: { at: 1, reason: "No ready tool could answer.", ...reviewedCode(hunt) } };
    const later = { input: { file: "input.json", digest: "d2", heads: { product: "def" } } };
    expect(reopensUnresolved(unresolved, later, "The greeting is still missing on the changed code.")).toBe(true);
    // On the code it was left unresolved on, a written confirmation keeps the finished ballot.
    expect(reopensUnresolved(unresolved, hunt, "The greeting is still missing.")).toBe(false);
    expect(reopensUnresolved(unresolved, later, "  ")).toBe(false);
    expect(reopensUnresolved({ unresolved: { at: 1, reason: "Older record without versions." } }, later, "Proof.")).toBe(false);
    expect(reopensUnresolved({}, later, "Proof.")).toBe(false);
    expect(reopensUnresolved(unresolved, {}, "Proof.")).toBe(false);
  });

  it("compares commits with commits and trees with trees when deciding whether an unresolved finding's code changed", () => {
    const input = (heads: Record<string, string>, trees?: Record<string, string>) => ({ input: { file: "i", digest: "d", heads, ...(trees ? { trees } : {}) } });
    const leftOn = (round: ReturnType<typeof input>) => ({ unresolved: { at: 1, reason: "r", ...reviewedCode(round) } });
    expect(reviewedCode(input({ product: "c1" }, { product: "t1" }))).toEqual({ heads: { product: "c1" }, trees: { product: "t1" } });
    // A mark saved before trees were recorded, then a review of the same commit that records its tree: the same code.
    expect(reopensUnresolved(leftOn(input({ product: "c1" })), input({ product: "c1" }, { product: "t1" }), "Proof.")).toBe(false);
    expect(reopensUnresolved(leftOn(input({ product: "c1" }, { product: "t1" })), input({ product: "c1" }), "Proof.")).toBe(false);
    // Control: both recorded trees on the same commit.
    expect(reopensUnresolved(leftOn(input({ product: "c1" }, { product: "t1" })), input({ product: "c1" }, { product: "t1" }), "Proof.")).toBe(false);
    // A new commit with the same tree is no change; a different tree, or a different commit with no tree to compare, is.
    expect(reopensUnresolved(leftOn(input({ product: "c1" }, { product: "t1" })), input({ product: "c2" }, { product: "t1" }), "Proof.")).toBe(false);
    expect(reopensUnresolved(leftOn(input({ product: "c1" }, { product: "t1" })), input({ product: "c2" }, { product: "t2" }), "Proof.")).toBe(true);
    expect(reopensUnresolved(leftOn(input({ product: "c1" })), input({ product: "c2" }, { product: "t2" }), "Proof.")).toBe(true);
    // One product's tree could not be read: its commits still decide, and another product's change still counts.
    expect(reopensUnresolved(leftOn(input({ a: "c1", b: "c3" }, { a: "t1" })), input({ a: "c1", b: "c3" }, { a: "t1", b: "t3" }), "Proof.")).toBe(false);
    expect(reopensUnresolved(leftOn(input({ a: "c1", b: "c3" }, { a: "t1" })), input({ a: "c1", b: "c4" }, { a: "t1", b: "t4" }), "Proof.")).toBe(true);
    // A product only one review covered is changed code.
    expect(reopensUnresolved(leftOn(input({ a: "c1" })), input({ a: "c1", b: "c3" }), "Proof.")).toBe(true);
  });

  it("uses the reopening reviewer as a reopened finding's author, and leaves unknown attribution unknown", () => {
    expect(authorProfile({ raisedBy: "opus-high", confirmedBy: [] })).toBe("opus-high");
    expect(authorProfile({ raisedBy: "opus-high", reopenedAt: 5, confirmedBy: ["sol-high", "grok-high"] })).toBe("sol-high");
    expect(authorProfile({ raisedBy: "opus-high", reopenedAt: 5, confirmedBy: [] })).toBeUndefined();
  });
});

describe("targeted third answers", () => {
  it("groups compatible findings into one place on a usable tool", () => {
    const plan = planThirdAnswers({ findings: [{ id: "a", answered: ["claude-code", "grok"] }, { id: "b", answered: ["claude-code", "grok"] }], suppliers: ["claude-code", "codex", "grok", "antigravity"].map((tool) => candidate(tool)), name });
    expect(plan.seats).toEqual([expect.objectContaining({ key: "third:sol-high", toolId: "codex", findingIds: ["a", "b"], third: true })]);
    expect(plan.escalations.a).toEqual({ reason: "Both first answers said it does not block; Codex gives the third answer." });
  });

  it("prefers a tool that reported neither finding, and one usable now over one that must wait", () => {
    const plan = planThirdAnswers({ findings: [{ id: "a", answered: ["claude-code", "grok"], author: "codex" }], suppliers: ["claude-code", "codex", "grok", "antigravity"].map((tool) => candidate(tool)), name });
    expect(plan.seats.map((seat) => seat.toolId)).toEqual(["antigravity"]);
    const waiting = planThirdAnswers({ findings: [{ id: "a", answered: ["claude-code", "grok"] }], suppliers: [candidate("claude-code"), candidate("codex", false), candidate("grok"), candidate("antigravity")], name });
    expect(waiting.seats.map((seat) => seat.toolId)).toEqual(["antigravity"]);
    const only = planThirdAnswers({ findings: [{ id: "a", answered: ["claude-code", "grok"] }], suppliers: [candidate("claude-code"), candidate("codex", false), candidate("grok")], name });
    expect(only.seats.map((seat) => [seat.toolId, seat.profileId])).toEqual([["codex", "sol-high"]]);
  });

  it("splits places only when per-finding independence requires it, reusing a tool that answered only other findings", () => {
    // After handoffs "a" has Codex and Grok, "b" has Claude and Grok; Antigravity is unavailable.
    const plan = planThirdAnswers({ findings: [{ id: "a", answered: ["codex", "grok"] }, { id: "b", answered: ["claude-code", "grok"] }], suppliers: [candidate("claude-code"), candidate("codex"), candidate("grok")], name });
    expect(plan.seats.map((seat) => [seat.toolId, seat.findingIds])).toEqual([["claude-code", ["a"]], ["codex", ["b"]]]);
    const shared = planThirdAnswers({ findings: [{ id: "a", answered: ["codex", "grok"] }, { id: "b", answered: ["claude-code", "grok"] }], suppliers: ["claude-code", "codex", "grok", "antigravity"].map((tool) => candidate(tool)), name });
    expect(shared.seats.map((seat) => [seat.toolId, seat.findingIds])).toEqual([["antigravity", ["a", "b"]]]);
  });

  it("leaves a finding unresolved when no ready independent tool remains, rather than settling on two answers", () => {
    const plan = planThirdAnswers({ findings: [{ id: "a", answered: ["claude-code", "grok"] }, { id: "b", answered: ["claude-code", "codex"] }], suppliers: [candidate("claude-code"), candidate("codex"), candidate("grok")], name });
    expect(plan.seats.map((seat) => [seat.toolId, seat.findingIds])).toEqual([["codex", ["a"]], ["grok", ["b"]]]);
    const none = planThirdAnswers({ findings: [{ id: "a", answered: ["claude-code", "grok"] }], suppliers: [candidate("claude-code"), candidate("grok")], name });
    expect(none.seats).toEqual([]);
    expect(none.escalations.a).toMatchObject({ unresolved: true });
  });
});
