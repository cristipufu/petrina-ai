import { expect, it } from "vitest";
import { BUILT_IN_ROLES, type DeepMutable, type Finding, type JourneyStep } from "../../../src/index.js";
import { settledReviewFindings } from "../../../src/settled-review-history.js";
import { stateFixture, taskFixture } from "../../fixtures/state.js";

const role = BUILT_IN_ROLES.find(role => role.id === "code-reviewer")!;
const stage = { id: "review", title: "Review", kind: "review-chain" as const, roleId: role.id, profileIds: ["sol-high", "opus-high", "grok-high"] };
function finding(id = "f"): DeepMutable<Finding> {
  return { id, text: `Full problem statement for ${id}`, where: "The affected location", productIds: ["p"], severity: "blocking", raisedBy: "sol-high", roleId: role.id, status: "fixed", confirmedBy: ["opus-high"], evidence: `Original evidence for ${id}. `.repeat(100), steps: `Original reproduction for ${id}`, votes: [{ by: "grok-high", toolId: "grok", verdict: "real", reason: `Original vote for ${id}` }], answer: { fixed: true, text: `Builder answer for ${id}`, at: 10 }, sameBug: "card", tracking: { taskId: "card" } };
}
function examined(findings: readonly Finding[], extra: Partial<JourneyStep> = {}): DeepMutable<JourneyStep> {
  return JSON.parse(JSON.stringify({ id: "checked", kind: "agent", roleId: role.id, stageId: stage.id, round: 2, sub: 0, startedAt: 20, endedAt: 30, seats: ["reviewer:0", "reviewer:1", "reviewer:2"], result: { findings, findingsSettled: true, findingChanges: { raised: [], fixed: findings.map(f => f.id), dismissed: [], claimedFixed: findings.map(f => f.id) } }, ...extra })) as DeepMutable<JourneyStep>;
}
function baseline(findings: readonly Finding[] = [finding()], journey = [examined(findings)]) {
  const state = stateFixture({ now: 1_000_000, products: [{ id: "p", name: "Product", repo: "local/product", tone: "blue" }] });
  const task = taskFixture(state);
  return { ...task, findings, journey };
}
it("only shortens dated reviewer claims that stood through a completed recorded examination", () => {
  const good = finding();
  expect(settledReviewFindings(baseline([good]), BUILT_IN_ROLES)).toEqual({ f: { round: 2, step: "checked" } });
  const variants: Partial<Finding>[] = [{ status: "open" }, { status: "dismissed" }, { status: "unverified" }, { severity: "pre-existing" }, { raisedBy: "petrina" }, { roleId: "tester" }, { answer: undefined }, { answer: { fixed: false, text: "Not fixed", at: 10 } }, { answer: { fixed: true, text: "No time" } as never }, { answer: { fixed: true, text: "New claim", at: 35 } }, { reopenedAt: 35 }, { reopenedAt: 15 }];
  for (const change of variants) expect(settledReviewFindings(baseline([{ ...good, ...change }], [examined([good])]), BUILT_IN_ROLES)).toEqual({});
  for (const step of [examined([good], { endedAt: undefined }), examined([good], { startedAt: 9 }), examined([good], { result: { findings: [good] } }), examined([good], { result: { findings: [good], findingsSettled: true } }), examined([{ ...good, status: "open" }])]) {
    expect(settledReviewFindings(baseline([good], [step]), BUILT_IN_ROLES)).toEqual({});
  }
  const reopened = { ...good, reopenedAt: 35, answer: { fixed: true, text: "Claimed again", at: 40 } };
  expect(settledReviewFindings(baseline([reopened], [examined([good])]), BUILT_IN_ROLES)).toEqual({});
  expect(settledReviewFindings(baseline([reopened], [examined([reopened], { id: "rechecked", round: 4, startedAt: 50, endedAt: 60 })]), BUILT_IN_ROLES)).toEqual({ f: { round: 4, step: "rechecked" } });
  // Added findings roles and single-seat security reviews follow the result contract.
  const custom = { ...role, id: "custom-reviewer" };
  const customFinding = { ...good, roleId: custom.id };
  expect(settledReviewFindings(baseline([customFinding], [examined([customFinding], { roleId: custom.id, seats: ["reviewer:0"] })]), [...BUILT_IN_ROLES, custom])).toHaveProperty("f");
});

it("requires every product's dated shared claim and a round after the latest claim", () => {
  const shared = { ...finding(), productIds: ["p", "second"], answers: { p: { fixed: true, text: "Product p fix", at: 10 }, second: { fixed: true, text: "Second fix", at: 25 } } };
  expect(settledReviewFindings(baseline([shared], [examined([shared])]), BUILT_IN_ROLES)).toEqual({});
  const step = examined([shared], { startedAt: 26 });
  expect(settledReviewFindings(baseline([shared], [step]), BUILT_IN_ROLES)).toHaveProperty("f");
  for (const second of [undefined, { fixed: false, text: "Not fixed", at: 25 }, { fixed: true, text: "No time" }]) {
    const changed = { ...shared, answers: { ...shared.answers, second } } as Finding;
    expect(settledReviewFindings(baseline([changed as DeepMutable<Finding>], [step]), BUILT_IN_ROLES)).toEqual({});
  }
  // Retry-split rounds began before the claim, even if their final step began later.
  const partial = examined([shared], { id: "partial", startedAt: 15, endedAt: 16, result: undefined });
  const finished = examined([shared], { startedAt: 26 });
  expect(settledReviewFindings(baseline([shared], [partial, finished]), BUILT_IN_ROLES)).toEqual({});
});
