import { expect, it } from "vitest";
import { roleForTask, slotUses, type CheckId } from "@petrina/core";
import { ReviewRoundCompletion } from "../../../src/review-round-completion.js";
import { pendingReviewPlaces } from "../../../src/review-members.js";
import { profileSelectionFixture } from "../../fixtures/profile-selection.js";
import { reviewParticipantFixture } from "../../fixtures/review-participants.js";
import { verifierAdmissionFixture } from "../../fixtures/verifier-admission.js";
import { parallelFixture } from "../../fixtures/parallel-admission.js";

function participants() {
  const f = profileSelectionFixture();
  f.host.awayFromBuilder = () => false;
  f.state.pool.paused = false; f.state.pool.limit = 1;
  f.state.setup!.checks = f.state.tools.map(tool => ({ id: tool.id as CheckId, status: ["claude-code", "codex", "grok"].includes(tool.id) ? "ready" : "logged-out" }));
  f.task.plan = { rationale: "Explicit independent review seats", plannerProfileId: "sol-high", stages: [
    { id: "review", title: "Review", kind: "review-chain", roleId: "code-reviewer", profileIds: ["sol-high", "opus-high"] },
  ] }; f.task.stageIndex = 0;
  const stage = f.task.plan.stages[0]!;
  const choose = (id: string, key: string) => {
    const selected = f.selection.choose(id, f.task, "code-reviewer", undefined, key);
    if (!selected || selected.kind === "none") throw new Error(selected?.waiting ?? "No supplied reviewer");
    return selected;
  };
  return { ...f, stage, choose };
}

it("keeps a reviewer handoff independent with one pool slot and one slot per tool", () => {
  const f = participants(), first = f.choose("sol-high", "0");
  f.task.hunt = { stageId: f.stage.id, round: 1, reported: { "0": true }, profiles: { "0": first.profile.id } };
  f.state.pool.limited = [{ toolId: "claude-code", until: f.now() + 3_600_000, reason: "Observed provider usage refusal" }];
  const replacement = f.choose("opus-high", "1");
  expect([first.profile.toolId, replacement.profile.toolId]).toEqual(["codex", "grok"]);
  expect(replacement.profile.modelId).toBe("grok-4.7");
  expect(new Set([first.profile.toolId, replacement.profile.toolId]).size).toBe(2);
});

it("finishes both reviews on the remaining tool when independence is unavailable", () => {
  const f = participants(), first = f.choose("sol-high", "0");
  f.task.hunt = { stageId: f.stage.id, round: 1, reported: { "0": true }, profiles: { "0": first.profile.id } };
  f.state.pool.limited = ["claude-code", "grok"].map(toolId => ({ toolId, until: f.now() + 3_600_000, reason: "Observed account limit" }));
  const second = f.choose("opus-high", "1");
  expect([first.profile.toolId, second.profile.toolId]).toEqual(["codex", "codex"]);
});

for (const replacedAuthor of [true, false]) it(replacedAuthor
  ? "keeps a design review away from the replacement that actually wrote the brief"
  : "hands a design reviewer to another tool when its own usage runs out", () => {
  const f = participants();
  f.task.plan = { rationale: "One design round", plannerProfileId: "sol-high", stages: [{ id: "design", title: "Design", kind: "converge", roleId: "architect", profileIds: ["opus-high"], reviewerRoleId: "design-reviewer", reviewerProfileIds: ["sol-high"] }] };
  f.task.stageIndex = 0; f.task.sub = 0;
  if (replacedAuthor) f.state.pool.limited = [{ toolId: "claude-code", until: f.now() + 3_600_000, reason: "Observed author usage refusal" }];
  const author = f.selection.choose("opus-high", f.task, "architect")!;
  if (author.kind === "none") throw new Error(author.waiting);
  expect(author.profile.toolId).toBe(replacedAuthor ? "codex" : "claude-code");
  f.host.completedDesignAuthor = () => ({ toolId: author.profile.toolId, modelRan: author.profile.modelId });
  f.task.sub = 1;
  if (!replacedAuthor) f.state.pool.limited = [{ toolId: "codex", until: f.now() + 3_600_000, reason: "Observed review usage refusal" }];
  const reviewer = f.selection.choose("sol-high", f.task, "design-reviewer")!;
  if (reviewer.kind === "none") throw new Error(reviewer.waiting);
  expect(reviewer.profile.toolId).toBe("grok"); expect(reviewer.profile.modelId).toBe("grok-4.7");
  expect(reviewer.profile.toolId).not.toBe(author.profile.toolId);
});

for (const savedPositions of [true, false]) it(savedPositions
  ? "retains a reported review when rehydrating a saved legacy pair"
  : "keeps an actual replacement's verdict in older saved rounds without recorded reviewer positions", () => {
  const f = participants();
  f.task.hunt = { stageId: f.stage.id, round: 1, reported: { "0": true }, ...(savedPositions ? { profiles: { "0": "sol-high" } } : {}) };
  let reads = 0;
  f.host.reportedReviewerTools = () => { reads++; return ["codex"]; };
  if (savedPositions) f.state.pool.limited = [{ toolId: "claude-code", until: f.now() + 3_600_000, reason: "Observed Claude limit" }];
  const pending = pendingReviewPlaces(f.task, f.stage, { roles: () => f.state.roles, profile: f.profile });
  expect(pending).toEqual([{ key: "1", profileId: "opus-high" }]);
  const next = f.choose(pending[0]!.profileId, pending[0]!.key);
  expect(next.profile.id).toBe(savedPositions ? "grok-high" : "opus-high");
  expect(f.task.hunt.reported).toEqual({ "0": true });
  expect(reads).toBe(savedPositions ? 0 : 1);
  // These are supplied saved facts, not a claim of SQLite or native session recovery.
  expect(pending.some(place => place.key === "0")).toBe(false);
});

for (const passed of [true, false]) it(`keeps completed reviewer seats for a same-round return after ${passed ? "passing" : "the coordinator checkpoint"}`, async () => {
  const f = reviewParticipantFixture(true), { task, stage, scope, state } = f;
  task.rounds[stage.id] = 1;
  const saved = structuredClone(task.reviewSessions![stage.id]);
  if (!passed) task.findings.push({ id: "still-open", text: "A confirmed problem", severity: "blocking", status: "open", raisedBy: "opus-high", confirmedBy: [] });
  const rounds = new ReviewRoundCompletion({ roles: () => state.roles, role: (id, current) => roleForTask(state.roles, id, current), incrementalReview: () => true,
    ownChanges: async () => ({ product: "supplied-task-change" }), anchor: async () => ({ head: "observed-review-head", tree: "observed-review-tree" }),
    reviewEnd() {}, releaseInput() {}, note() {}, changed() {}, commitNow() {}, openDeliveryDecision() {}, now: f.now });
  await rounds.finish(task, stage, 1, "Reviewed");
  expect(task.reviewSessions![stage.id]).toEqual(saved);
  task.stageIndex = 0; task.state = "waiting";
  scope.work.report!.summary = "A late check repair";
  const choice = f.choose()!;
  if (choice.kind === "none") throw new Error(choice.waiting);
  expect(choice.profile.id).toBe(saved!["0"]!.profileId);
  expect(f.prior()!.prior!.sessionId).toBe(saved!["0"]!.sessionId);
  expect(task.rounds[stage.id]).toBe(1);
});

it("takes turns when the pool has one slot, and still gets every review and vote", async () => {
  const reviews = parallelFixture(); reviews.state.pool.limit = 1;
  let live = 0, peak = 0;
  let release!: () => void;
  const seats: string[] = [], gate = new Promise<void>(resolve => { release = resolve; });
  const snapshots: number[] = [];
  const unsubscribe = reviews.subscribe(() => snapshots.push(slotUses(reviews.snapshot()).length));
  const running = reviews.group.run(reviews.request(["0", "1"].map(key => reviews.member(key as "0" | "1", async () => {
    peak = Math.max(peak, ++live); seats.push(key);
    await gate; live--;
  }))));
  try {
    await reviews.waitFor(() => seats.length === 1, "the first actual review to hold its only slot", undefined, running);
    expect(seats).toEqual(["0"]); release(); await running;
    expect(seats).toEqual(["0", "1"]); expect(peak).toBe(1);
    expect(Math.max(...snapshots)).toBe(1);
  } finally { release(); reviews.stop.abort(); await running; unsubscribe(); await reviews.close(); }
  const voters = verifierAdmissionFixture({ limit: 1 });
  try {
    await voters.phase();
    expect(voters.attempts).toHaveLength(2);
    expect(voters.slotSnapshots.every(snapshot => snapshot.tasks.filter(task => task.holdsSlot).reduce((count, task) => count + 1 + (task.helpers?.length ?? 0), 0) <= 1)).toBe(true);
    voters.finishBallot();
    expect(voters.finding.verification?.verdict).toBe("real");
  } finally { await voters.close(); }
});
