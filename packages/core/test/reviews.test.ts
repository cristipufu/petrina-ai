import { describe, expect, it } from "vitest";
import { createDemoState } from "../src/demo.js";
import type { Finding, Task } from "../src/model.js";
import { combineReviewStats, reviewStats, subtractReviewStats, verificationSummary } from "../src/reviews.js";

const demo = createDemoState(1_000_000_000);
const base = demo.tasks.find((task) => task.state === "done")!;

/** A finished task with one review chain that passed in `rounds`, holding `findings`. */
function reviewed(id: string, rounds: number, findings: Finding[], extra: Partial<Task> = {}): Task {
  const chain = base.plan!.stages.find((stage) => stage.kind === "review-chain")!;
  return { ...base, id, state: "done", rounds: { [chain.id]: rounds }, findings, ...extra };
}

const finding = (id: string, raisedBy: string, extra: Partial<Finding> = {}): Finding => ({ id, text: `Finding ${id}`, severity: "blocking", raisedBy, confirmedBy: [], status: "open", ...extra });

it("names the recorded vote outcomes in step and timeline summaries", () => {
  const checked = (verdict: NonNullable<Finding["verification"]>["verdict"]) => ({ verification: { verdict, by: "tool", at: 1, reason: "Recorded result" } });
  expect(verificationSummary([checked("pre-existing")])).toBe("1 checked: none to fix now, 1 already there before this change");
  expect(verificationSummary([checked("nit")])).toBe("1 checked: none to fix now, 1 minor");
  expect(verificationSummary([checked("not-a-bug")])).toBe("1 checked: none to fix now, 1 not a bug");
  expect(verificationSummary([checked("real"), checked("nit"), checked("pre-existing"), checked("not-a-bug")])).toBe("4 checked: 1 must be fixed in this change, 1 already there before this change, 1 minor, 1 not a bug");
  expect(verificationSummary([{}])).toBe("1 checked: 1 without a recorded outcome");
  expect(verificationSummary([checked("real")], { disputed: 1 })).toBe("1 checked: 1 must be fixed in this change (1 disputed)");
  expect(verificationSummary([checked("pre-existing")], { oneTool: true })).toBe("1 checked by one tool: none to fix now, 1 already there before this change");
  expect(verificationSummary([{ unresolved: { at: 1, reason: "The required third answer was unavailable." } }])).toBe("1 checked: 1 unresolved");
  expect(verificationSummary([checked("nit"), { unresolved: { at: 1, reason: "The required third answer was unavailable." } }])).toBe("2 checked: 1 minor, 1 unresolved");
});

describe("how reviews are going", () => {
  it("combines archived and live reviews without changing outcomes, means or independent verifier counts", () => {
    const a = reviewed("a", 1, [finding("a", "codex", { status: "fixed", roleId: "security-reviewer", votes: [{ by: "grok", toolId: "grok", verdict: "real", reason: "Confirmed" }], verification: { by: "grok", verdict: "real", reason: "Confirmed", at: 1 } })]);
    const b = reviewed("b", 4, [finding("b", "codex", { status: "dismissed" }), finding("c", "claude", { severity: "suggestion" })], { sentBack: 2 });
    const total = combineReviewStats(reviewStats([a]), reviewStats([b]));
    expect(total).toEqual(reviewStats([a, b]));
    expect(subtractReviewStats(total, reviewStats([a]))).toEqual(reviewStats([b]));
    expect(subtractReviewStats(total, total)).toEqual(reviewStats([]));
  });
  it("counts rounds to pass, what became of each finding, and how each reviewer's findings held up", () => {
    const stats = reviewStats([
      reviewed("a", 1, [finding("a1", "opus-high", { severity: "suggestion" })]),
      reviewed("b", 2, [finding("b1", "sol-xhigh", { status: "fixed", answer: { fixed: true, text: "Fixed.", at: 0 } }), finding("b2", "sol-xhigh", { status: "dismissed", verification: { by: "opus-high", verdict: "not-a-bug", reason: "It works.", at: 0 } }), finding("b3", "sol-xhigh", { status: "unverified" })]),
      reviewed("c", 4, [finding("c1", "opus-high", { severity: "pre-existing", verification: { by: "sol-xhigh", verdict: "pre-existing", reason: "Older than this.", at: 0 } }), finding("c2", "petrina", { status: "fixed" })], { sentBack: 1 }),
      // Still under review: not counted as reviewed, but its findings count.
      { ...reviewed("d", 1, [finding("d1", "opus-high", { severity: "suggestion", answer: { fixed: false, text: "Kept on purpose.", at: 0 } })]), state: "running", stageIndex: 0 },
    ]);

    expect(stats.reviewed).toBe(3);
    expect(stats.passed).toEqual({ total: 3, first: 1, second: 1, third: 0, later: 1 });
    expect(stats.meanRounds).toBeCloseTo(7 / 3);
    expect(stats.sentBack).toBe(1);
    // Petrina's own failing check is not a reviewer's finding.
    expect(stats.findings).toEqual({ total: 6, fixed: 1, notABug: 1, unverified: 1, downgraded: 1, kept: 1, open: 1 });
    expect(stats.profiles).toEqual([
      { profileId: "opus-high", raised: 3, important: 1, heldUp: 0, notABug: 0 },
      { profileId: "sol-xhigh", raised: 3, important: 3, heldUp: 1, notABug: 1 },
    ]);
  });

  it("says nothing about rounds before any review is over", () => {
    const stats = reviewStats([]);
    expect(stats.reviewed).toBe(0);
    expect(stats.meanRounds).toBeUndefined();
    expect(stats.profiles).toEqual([]);
  });
  it("measures the highest numbered round without summing code, security, repeated visits or verifier seats", () => {
    const stages = [
      { id: "code", kind: "review-chain" as const, title: "Code", roleId: "code-reviewer", profileIds: ["sol-high", "opus-high"] },
      { id: "security", kind: "review-chain" as const, title: "Security", roleId: "security-reviewer", profileIds: ["sol-high"] },
    ];
    const task = reviewed("revisited", 1, [], { plan: { ...base.plan!, stages }, rounds: { code: 3, security: 2 }, journey: [1, 2, 3, 3].map((round, index) => ({ id: `code-${index}`, kind: "agent", roleId: "code-reviewer", stageId: "code", round, sub: 0, startedAt: index, endedAt: index + 1, team: ["sol-high", "opus-high"] })) });
    expect(reviewStats([task])).toMatchObject({ meanRounds: 3, passed: { first: 0, third: 1, total: 1 } });
    task.rounds = { code: 1, security: 1 };
    expect(reviewStats([task])).toMatchObject({ meanRounds: 1, passed: { first: 1, total: 1 } });
    delete task.journey;
    expect(reviewStats([task]).meanRounds).toBe(1);
  });
  it("keeps security findings separate from code findings on the same profile, including older and custom roles", () => {
    const stats = reviewStats([
      reviewed("a", 1, [
        finding("code", "sol-xhigh", { status: "fixed" }),
        finding("security", "sol-xhigh", { roleId: "security-reviewer", status: "unverified" }),
        finding("custom", "sol-xhigh", { roleId: "access-reviewer", status: "dismissed" }),
        finding("checks", "petrina"),
      ]),
      reviewed("cancelled", 1, [finding("ignored", "sol-xhigh", { roleId: "security-reviewer" })], { state: "cancelled" }),
    ]);
    expect(stats.roles.map((entry) => [entry.roleId, entry.findings.total, entry.important])).toEqual([["access-reviewer", 1, 1], ["code-reviewer", 1, 1], ["security-reviewer", 1, 1]]);
    expect(stats.roles.find((entry) => entry.roleId === "security-reviewer")!.findings.unverified).toBe(1);
    expect(stats.roles.reduce((sum, entry) => sum + entry.findings.total, 0)).toBe(stats.findings.total);
    expect(stats.profiles).toHaveLength(1);
    expect(stats.profiles[0]!.raised).toBe(3);
  });
  it("measures verifier decisions across reopened findings, counting only the last vote per actual tool in each check", () => {
    const final = (verdict: "real" | "not-a-bug" | "nit" | "pre-existing") => ({ by: "codex", verdict, reason: "Checked", at: 1 });
    const stats = reviewStats([
      reviewed("checks", 2, [
        finding("reopened", "reviewer", {
          severity: "suggestion", verification: final("nit"),
          earlierReviews: [{ at: 1, confirmedBy: [], verification: final("real"), votes: [{ by: "codex", toolId: "codex", verdict: "real", reason: "Before fix" }, { by: "grok", toolId: "grok", verdict: "not-a-bug", reason: "Disagreed" }, { by: "old-unknown", verdict: "real", reason: "No recorded tool" }] }],
          votes: [{ by: "codex", toolId: "codex", verdict: "real", reason: "First answer" }, { by: "codex", toolId: "codex", verdict: "nit", reason: "Corrected" }, { by: "grok", toolId: "grok", verdict: "real", reason: "Disagreed again" }],
        }),
        finding("older", "reviewer", { roleId: "security-reviewer", severity: "pre-existing", verification: final("pre-existing"), votes: [{ by: "codex-other", toolId: "codex", verdict: "pre-existing", reason: "Older" }] }),
        finding("unfinished", "reviewer", { votes: [{ by: "grok", toolId: "grok", verdict: "not-a-bug", reason: "Peer still working" }] }),
      ]),
      reviewed("cancelled", 1, [finding("ignored", "reviewer", { verification: final("real") })], { state: "cancelled" }),
    ]).verifiers;
    expect(stats).toMatchObject({ completed: 3, real: 1, notABug: 0, nit: 1, preExisting: 1, unfinished: 1, unattributedVotes: 1 });
    expect(stats.profiles.find((entry) => entry.profileId === "codex")).toEqual({ profileId: "codex", toolId: "codex", votes: 2, real: 1, nit: 1, notABug: 0, preExisting: 0, matched: 2, decided: 2 });
    expect(stats.profiles.find((entry) => entry.profileId === "grok")).toMatchObject({ votes: 3, matched: 0, decided: 2, notABug: 2, real: 1 });
    expect(stats.profiles.some((entry) => entry.profileId === "old-unknown")).toBe(false);
    expect(stats.roles.find((entry) => entry.roleId === "security-reviewer")).toMatchObject({ completed: 1, preExisting: 1 });
  });
});
