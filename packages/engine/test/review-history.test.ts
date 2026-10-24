import { afterAll, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as files from "node:fs/promises";
import { join } from "node:path";
import { beginAgentStep, BUILT_IN_ROLES, createDemoState, type DeepMutable, type Finding, type JourneyStep } from "@petrina/core";
import { Context, type Section } from "../src/context.js";
import { Coordination } from "../src/coordination.js";
import { executionFor, repositoryView } from "@petrina/orchestrator";
import { prepareReviewInput, readReviewInput, type ReviewInput } from "../src/review-context.js";
import { CARD_OPENING, historyGuidance, readReviewHistory, settledReviewFindings } from "../src/review-history.js";
import { builderContext } from "../src/builder-context.js";
import { buildPrompt, continuePrompt, formatFindings } from "../src/prompts.js";
import { checkReviewEvidence } from "@petrina/core";
import { ReviewResult } from "../src/roles.js";
import { Cleanup } from "../src/cleanup.js";
import { Engine } from "./engine.js";
import { expectRejection } from "@petrina/test-support/rejections";
import { git, makeProduct, removeDir, tempDir } from "./fixtures.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
const sha = (body: string) => createHash("sha256").update(body).digest("hex");
const role = BUILT_IN_ROLES.find(role => role.id === "code-reviewer")!;
const stage = { id: "review", title: "Review", kind: "review-chain" as const, roleId: role.id, profileIds: ["sol-high", "opus-high", "grok-high"] };
function finding(id = "f"): DeepMutable<Finding> {
  return { id, text: `Full problem statement for ${id}`, where: "The affected location", productIds: ["p"], severity: "blocking", raisedBy: "sol-high", roleId: role.id, status: "fixed", confirmedBy: ["opus-high"], evidence: `Original evidence for ${id}. `.repeat(100), steps: `Original reproduction for ${id}`, votes: [{ by: "grok-high", toolId: "grok", verdict: "real", reason: `Original vote for ${id}` }], answer: { fixed: true, text: `Builder answer for ${id}`, at: 10 }, sameBug: "card", tracking: { taskId: "card" } };
}
function examined(findings: readonly Finding[], extra: Partial<JourneyStep> = {}): DeepMutable<JourneyStep> {
  return structuredClone({ id: "checked", kind: "agent", roleId: role.id, stageId: stage.id, round: 2, sub: 0, startedAt: 20, endedAt: 30, seats: ["reviewer:0", "reviewer:1", "reviewer:2"], result: { findings, findingsSettled: true, findingChanges: { raised: [], fixed: findings.map(f => f.id), dismissed: [], claimedFixed: findings.map(f => f.id) } }, ...extra }) as DeepMutable<JourneyStep>;
}
function baseline(findings: readonly Finding[] = [finding()], journey = [examined(findings)]) {
  const task = createDemoState(1_000_000).tasks[0]!;
  return { ...task, findings, journey };
}
async function fixture(count = 1) {
  const root = tempDir("petrina-history-"); roots.push(root);
  const repo = await makeProduct(root), base = await git(repo, "rev-parse", "HEAD");
  const data = join(root, "data");
  const engine = new Engine(data, { admissionsClosed: true, agentCommand: () => undefined, terminals: () => [] });
  engine.schedule = () => {}; engine.setPoolPaused(true);
  engine.s.products.push({ id: "p", name: "Product", path: repo, repo: "local/product", tone: "blue" });
  const id = engine.addTask({ productId: "p", title: "Review history", backlog: true });
  const task = engine.task(id)!, scope = executionFor(task);
  Object.assign(scope.work, { worktree: repo, baseSha: base, base: "main", report: { summary: "Current Builder report", changes: [] } });
  task.plan = { rationale: "Review", plannerProfileId: "sol-high", stages: [stage] }; task.stageIndex = 0; task.rounds = { review: 3 };
  task.findings = Array.from({ length: count }, (_, index) => finding(`f${index}`));
  task.journey = count ? [examined(task.findings)] : [];
  const context = new Context(engine, { pendingPoints: async () => [] } as never);
  return { root, repo, base, data, engine, task, scope, context };
}
async function freeze(f: Awaited<ReturnType<typeof fixture>>, cards?: ReviewInput["cards"]) {
  const snapshot = await f.context.captureReview(f.scope); if (cards) snapshot.cards = cards;
  const ref = await prepareReviewInput(f.data, f.scope, snapshot, new AbortController().signal);
  f.task.hunt = { id: "round-3", stageId: stage.id, round: 3, reported: {}, input: ref };
  const step = beginAgentStep(f.task, role.id, "sol-high", 40, f.engine.s.roles, stage.profileIds, f.scope.work);
  step.reviewInput = ref;
  return { ref, input: await readReviewInput(ref), step };
}
const longCard = { id: "card", title: "Complete follow-up identity", productIds: ["p"], problem: "Opening of the original problem. ".repeat(100) + "Unique tail identity and evidence." };
async function supplied(f: Awaited<ReturnType<typeof fixture>>, input: ReviewInput, member = "review-0") {
  const sections = await f.context.sectionsFor(f.scope, role.id, member, undefined, undefined, input);
  return (await f.engine["turns"]["prepareTurnPrompt"](f.scope, role, `fresh-${member}`, sections, undefined, { packet: true, findings: input.findings })).sections;
}
const opening = (f: Awaited<ReturnType<typeof fixture>>, sections: readonly Section[]) => buildPrompt({ task: repositoryView(f.scope), product: f.engine.s.products[0]!, role, roles: f.engine.s.roles, profiles: f.engine.s.profiles, worktree: f.repo, branch: "task", base: "main", defaultBranch: "main", sections });
function journeyCharacters(f: Awaited<ReturnType<typeof fixture>>, before: readonly Section[], after: readonly Section[], mode = "fresh") {
  const step = f.task.journey!.at(-1)!;
  const inputs = (supplied: readonly Section[]) => [0, 1, 2].map(i => ({ mode, roleId: role.id, profileId: stage.profileIds[i]!, reviewerKey: String(i), taskTitle: f.task.title, reviewInput: step.reviewInput, sections: supplied.map(({ title, body }) => ({ title, body })) }));
  return { before: JSON.stringify({ ...step, reviewHistory: undefined, agentInputs: inputs(before) }).length, after: JSON.stringify({ ...step, agentInputs: inputs(after) }).length };
}
function measure(name: string, f: Awaited<ReturnType<typeof fixture>>, sections: readonly Section[], body = "") {
  const complete = sections.map(section => ({ ...section, body: section.background ?? section.body }));
  const before = opening(f, complete).length, after = opening(f, sections).length;
  const saved = journeyCharacters(f, complete, sections);
  // Whole serialized fixture journey step: three supplied seat records and the
  // single retained body, including JSON escaping. Working files are separate.
  console.log(`History characters ${name}: opening ${before} -> ${after}; serialized journey round (3 fixture seats) ${saved.before} -> ${saved.after}; complete reference ${body.length ? "available" : "not needed"}. Tokens, cost and time unmeasured.`);
  return { before, after };
}
function measureWarm(name: string, f: Awaited<ReturnType<typeof fixture>>, beforeSections: readonly Section[], afterSections: readonly Section[]) {
  const ctx = { task: repositoryView(f.scope), product: f.engine.s.products[0]!, role, roles: f.engine.s.roles, profiles: f.engine.s.profiles, worktree: f.repo, branch: "task", base: "main", defaultBranch: "main" };
  const before = continuePrompt({ ...ctx, sections: beforeSections }).length, after = continuePrompt({ ...ctx, sections: afterSections }).length;
  const saved = journeyCharacters(f, beforeSections, afterSections, "continued");
  console.log(`History characters ${name}: opening ${before} -> ${after}; serialized journey round (3 fixture seats) ${saved.before} -> ${saved.after}; complete packet available, no shortened entries supplied. Tokens, cost and time unmeasured.`);
  expect(before).toBe(after); expect(saved.before).toBe(saved.after);
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

it("keeps acceptance failures and findings with unknown origin complete after a checked fix claim", async () => {
  const f = await fixture(0);
  try {
    const acceptance = { ...finding("acceptance"), roleId: undefined, text: "Failed acceptance check: The guest sees a greeting", evidence: "Original acceptance evidence" };
    const unknown = { ...finding("unknown"), roleId: undefined };
    const retired = { ...finding("retired"), roleId: "unknown-role" };
    f.task.findings = [acceptance, unknown, retired, finding("reviewer")];
    f.task.journey = [examined(f.task.findings)];
    expect(settledReviewFindings(repositoryView(f.scope), BUILT_IN_ROLES)).toEqual({ reviewer: { round: 2, step: "checked" } });
    const { input, step } = await freeze(f);
    const sections = await supplied(f, input);
    for (const original of [acceptance, unknown, retired]) expect(opening(f, sections)).toContain(formatFindings([original], { complete: true }));
    expect(JSON.parse(step.reviewHistory!.body).findings.reviewer).toBe(formatFindings([input.findings[3]!], { complete: true }));
    measure("acceptance and unknown origins stay complete with reviewer control", f, sections, step.reviewHistory!.body);
  } finally { await f.engine.shutdown(); }
});

it("keeps first-round short cards and legacy snapshots exactly complete with nothing extra retained", async () => {
  const f = await fixture(0);
  try {
    const card = { ...longCard, problem: "Short full problem." };
    const { input, step } = await freeze(f, [card]);
    const sections = await supplied(f, input);
    expect(input.history).toBeUndefined(); expect(step.reviewHistory).toBeUndefined();
    expect(sections.find(section => section.title === "Open follow-up cards")?.body).toBe(`- card: ${card.title}\n  ${card.problem}\nIf this is the same bug as one of these cards, set "sameBug" to that card's id. If it is none of them, set "sameBug" to "none".`);
    const stats = measure("first round", f, sections); expect(stats.after).toBe(stats.before);
    f.task.findings = [finding()]; f.task.journey = [];
    const legacy = await freeze(f);
    expect(legacy.input.history).toBeUndefined();
    expect(legacy.input.parts.findings![0]!.body).toBe(formatFindings(f.task.findings, { complete: true }));
  } finally { await f.engine.shutdown(); }
});

it("never shows a task its own follow-up card, in a live capture or a resumed frozen review", async () => {
  const f = await fixture(0);
  try {
    f.task.kind = "bug";
    const peer = f.engine.task(f.engine.addTask({ productId: "p", kind: "bug", title: "Peer bug", description: "A peer's request", backlog: true }))!;
    expect((await f.context.captureReview(f.scope)).cards.map(card => card.id)).toEqual([peer.id]);
    // A review frozen before this rule listed the task itself. Resuming drops only that card and adds nothing.
    const own = { ...longCard, id: f.task.id, problem: "Own request. ".repeat(100) };
    const other = { ...longCard, id: peer.id };
    const { input } = await freeze(f, [own, other]);
    expect(input.history?.cards).toEqual([f.task.id, peer.id]);
    const body = (await supplied(f, input)).find(section => section.title === "Open follow-up cards")!.body;
    expect(body).toContain(`- ${peer.id}: ${longCard.title}`);
    expect(body).not.toContain(`- ${f.task.id}:`);
    expect(body).not.toContain("Own request.");
    expect(f.task.shownFollowUps!["review-0"]).toEqual([peer.id]);
    expect((await readReviewInput(f.task.hunt!.input!)).cards.map(card => card.id)).toEqual([f.task.id, peer.id]);
    // When only the task's own card was long, the shown card is complete and nothing points at the frozen copy.
    const short = { ...other, problem: "A short peer problem." };
    const alone = await freeze(f, [own, short]);
    expect(alone.input.history?.cards).toEqual([f.task.id]);
    const sections = await supplied(f, alone.input);
    expect(sections.find(section => section.title === "Open follow-up cards")!.body).toBe(`- ${peer.id}: ${short.title}\n  ${short.problem}\nIf this is the same bug as one of these cards, set "sameBug" to that card's id. If it is none of them, set "sameBug" to "none".`);
    expect(opening(f, sections)).not.toContain(alone.input.history!.digest);
  } finally { await f.engine.shutdown(); }
});

it("freezes simultaneous fresh conflict reviewers, replacement and recovery without live peers or card edits", async () => {
  const f = await fixture(23);
  try {
    // Ordinary full review after a real conflict port, whose native conversations were discarded.
    f.task.reviewFreshReasons = { review: { "0": "A real conflict required a Builder port", "1": "A real conflict required a Builder port", "2": "A real conflict required a Builder port" } };
    const { input, step, ref } = await freeze(f, [longCard, { ...longCard, id: "short", problem: "Short card in full." }]);
    const full = await readReviewHistory(input.history!), saved = JSON.parse(full);
    const bodies = await Promise.all([0, 1, 2].map(i => supplied(f, input, `review-${i}`)));
    expect(bodies[0]).toEqual(bodies[1]); expect(bodies[1]).toEqual(bodies[2]);
    expect(f.task.journey!.filter(step => step.reviewHistory)).toHaveLength(1);
    expect(step.reviewHistory).toEqual({ file: input.history!.file, digest: input.history!.digest, body: full, roundId: "round-3" });
    const stats = measure("23 settled findings + long cards, fresh conflict", f, bodies[0]!, full); expect(stats.after).toBeLessThan(stats.before);
    const text = opening(f, bodies[0]!);
    for (const original of input.findings) {
      expect(saved.findings[original.id]).toBe(formatFindings([original], { complete: true }));
      expect(text).toContain(original.id); expect(text).toContain(original.text); expect(text).not.toContain(original.evidence!);
    }
    expect(saved.cards.card).toEqual(longCard); expect(text).not.toContain("Unique tail identity"); expect(text).toContain(longCard.problem.slice(0, CARD_OPENING));
    expect(text).toContain("claim stood through round 2, journey step checked"); expect(text).toContain(input.history!.digest);
    for (const i of [0, 1, 2]) expect(f.task.shownFollowUps![`review-${i}`]).toEqual(["card", "short"]);
    f.task.findings[0]!.evidence = "MUTATED LIVE EVIDENCE"; f.task.findings.push({ ...finding("peer"), status: "open", text: "CURRENT PEER" });
    f.task.notes = [{ at: 60, text: "NEW UNHEARD GUIDANCE" }];
    const reopened = await readReviewInput(ref);
    const replacement = await supplied(f, reopened);
    expect(replacement.filter(s => s.title === "Findings so far (confirm or dispute by id)" || s.title === "Open follow-up cards")).toEqual(bodies[0]!.filter(s => s.title === "Findings so far (confirm or dispute by id)" || s.title === "Open follow-up cards"));
    expect(opening(f, replacement)).toContain("NEW UNHEARD GUIDANCE"); expect(opening(f, replacement)).not.toContain("CURRENT PEER");
    // A later retry/vote node reads the once-per-round copy, without crossing
    // stage, round or immutable-input boundaries.
    const later = structuredClone({ ...step, id: "later-read", reviewHistory: undefined }) as DeepMutable<JourneyStep>;
    f.task.journey!.push(later);
    const coordination = new Coordination(f.engine);
    expect(await coordination.call("journey.review-input", { taskId: f.task.id, nodeId: later.id, section: "history", limit: 100 })).toMatchObject({ outcome: "completed", digest: input.history!.digest, text: full.slice(0, 100), total: full.length });
    later.stageId = "another-stage";
    expect((await coordination.call("journey.review-input", { taskId: f.task.id, nodeId: later.id, section: "history" })).outcome).toBe("unavailable");
    later.stageId = step.stageId; later.round += 1;
    expect((await coordination.call("journey.review-input", { taskId: f.task.id, nodeId: later.id, section: "history" })).outcome).toBe("unavailable");
    later.round = step.round; later.reviewInput = { ...ref, digest: "different-input" };
    expect((await coordination.call("journey.review-input", { taskId: f.task.id, nodeId: later.id, section: "history" })).outcome).toBe("unavailable");
    f.task.journey!.pop();
    f.engine.commitNow(); await f.engine.shutdown();
    const restart = new Engine(f.data, { admissionsClosed: true, terminals: () => [] }); restart.schedule = () => {};
    try {
      const recovered = restart.task(f.task.id)!;
      expect(recovered.journey!.find(s => s.id === step.id)!.reviewHistory!.body).toBe(full);
      expect(await readReviewInput(recovered.hunt!.input!)).toEqual(reopened);
    } finally { await restart.shutdown(); }
  } finally { await f.engine.shutdown(); }
});

it("preserves warm status deltas, full packets and changed claim evidence", async () => {
  const f = await fixture();
  try {
    const { input } = await freeze(f, [longCard]);
    const sections = await f.context.sectionsFor(f.scope, role.id, "review-0", undefined, undefined, input);
    const view = repositoryView(f.scope);
    const first = await builderContext(f.data, view, role, "warm-seat", sections, undefined, { findings: input.findings });
    const warm = await builderContext(f.data, view, role, "warm-seat", sections, first.snapshot, { findings: input.findings });
    const actual = await f.engine["turns"]["prepareTurnPrompt"](f.scope, role, "warm-seat", sections, undefined, { packet: true, previous: first.snapshot, findings: input.findings });
    expect(actual.sections).toEqual(warm.sections);
    expect(f.task.journey!.at(-1)!.reviewHistory).toBeUndefined();
    expect(JSON.stringify(actual.sections)).not.toContain(input.history!.digest);
    expect(warm.sections.some(s => s.title === "Current finding status index")).toBe(true);
    expect(warm.sections.some(s => s.title === "Open follow-up cards")).toBe(false);
    expect(warm.sections.some(s => s.title === "New or changed finding records (confirm or dispute by id)")).toBe(false);
    const packet = readFileSync(warm.snapshot!.file, "utf8");
    expect(packet).toContain(input.findings[0]!.evidence!); expect(packet).toContain(longCard.problem);
    const complete = sections.map(s => ({ ...s, body: s.background ?? s.body }));
    const oldFirst = await builderContext(f.data, view, role, "before-seat", complete, undefined, { findings: input.findings });
    const oldWarm = await builderContext(f.data, view, role, "before-seat", complete, oldFirst.snapshot, { findings: input.findings });
    expect(warm.sections).toEqual(oldWarm.sections);
    measureWarm("warm fix", f, oldWarm.sections, actual.sections);
    const changed = { ...input.findings[0]!, status: "open" as const, reopenedAt: 50, evidence: "Current reproduction", answer: { fixed: true, text: "Current unreviewed answer", at: 60 } };
    const next = await builderContext(f.data, view, role, "warm-seat", sections, warm.snapshot, { findings: [changed] });
    expect(JSON.stringify(next.sections)).toContain("Current reproduction"); expect(JSON.stringify(next.sections)).toContain("Current unreviewed answer");
    // A fresh replacement later in that same frozen round creates its one
    // retained copy before receiving the shortened sections.
    const replacement = await supplied(f, input, "review-1");
    expect(f.task.journey!.at(-1)!.reviewHistory!.digest).toBe(input.history!.digest);
    expect(opening(f, replacement)).toContain(input.history!.digest);
  } finally { await f.engine.shutdown(); }
});

for (const shortened of ["findings", "cards", "both"]) it(`supplies frozen-history guidance once with shortened ${shortened}`, async () => {
  const f = await fixture(shortened === "cards" ? 0 : 1);
  try {
    const { input, step } = await freeze(f, shortened === "findings" ? [] : [longCard]);
    const sections = await supplied(f, input);
    const text = opening(f, sections);
    expect(text.split(historyGuidance(input.history!))).toHaveLength(2);
    expect(step.reviewHistory!.digest).toBe(input.history!.digest);
    const records = JSON.parse(step.reviewHistory!.body);
    for (const original of input.findings) expect(records.findings[original.id]).toBe(formatFindings([original], { complete: true }));
    for (const card of input.cards) expect(records.cards[card.id]).toEqual(card);
    measure(`guidance once with ${shortened}`, f, sections, step.reviewHistory!.body);
  } finally { await f.engine.shutdown(); }
});

it("resends a changed warm card complete without retaining unused history", async () => {
  const f = await fixture();
  try {
    const { input, step } = await freeze(f, [longCard]);
    const sections = await f.context.sectionsFor(f.scope, role.id, "review-0", undefined, undefined, input);
    // Compare supplied text only; empty note metadata adds no saved heading.
    const complete = sections.filter(section => section.background ?? section.body);
    const before = complete.map(section => ({ title: section.title, body: section.title === "Open follow-up cards" ? "Earlier complete card text" : section.background ?? section.body }));
    const first = await builderContext(f.data, repositoryView(f.scope), role, "warm-card", before, undefined, { findings: input.findings });
    const warm = await f.engine["turns"]["prepareTurnPrompt"](f.scope, role, "warm-card", sections, undefined, { packet: true, previous: first.snapshot, findings: input.findings });
    expect(warm.sections.some(section => section.title === "Current finding status index")).toBe(true);
    expect(warm.sections.find(section => section.title === "Open follow-up cards")!.body).toContain(longCard.problem);
    expect(opening(f, warm.sections)).not.toContain(historyGuidance(input.history!));
    expect(step.reviewHistory).toBeUndefined();
    const full = complete.map(section => ({ title: section.title, body: section.background ?? section.body }));
    const expected = await builderContext(f.data, repositoryView(f.scope), role, "warm-card", full, first.snapshot, { findings: input.findings });
    expect(warm.sections).toEqual(expected.sections);
    const packet = readFileSync(expected.snapshot!.file, "utf8");
    expect(packet).toContain(longCard.problem); expect(packet).toContain(input.findings[0]!.evidence!);
    measureWarm("warm changed card", f, expected.sections, warm.sections);
  } finally { await f.engine.shutdown(); }
});

it("does not retain history for a short capacity continuation, or shorten without a round owner", async () => {
  const f = await fixture();
  try {
    const { input, step } = await freeze(f, [longCard]);
    const sections = await f.context.sectionsFor(f.scope, role.id, "review-0", undefined, undefined, input);
    await f.engine["turns"]["prepareTurnPrompt"](f.scope, role, "capacity", sections, undefined, { packet: true, findings: input.findings, supplyHistory: false });
    expect(step.reviewHistory).toBeUndefined();
    delete step.reviewInput;
    const complete = await f.engine["turns"]["prepareTurnPrompt"](f.scope, role, "no-owner", sections, undefined, { packet: true, findings: input.findings });
    expect(opening(f, complete.sections)).toContain(input.findings[0]!.evidence!);
    expect(opening(f, complete.sections)).toContain(longCard.problem);
    expect(step.reviewHistory).toBeUndefined();
  } finally { await f.engine.shutdown(); }
});

it("retains one copy for each execution even when the round number and snapshot are reused", async () => {
  const f = await fixture();
  try {
    const { input, ref, step } = await freeze(f);
    await supplied(f, input);
    step.endedAt = 50;
    f.task.hunt!.id = "another-execution";
    const next = beginAgentStep(f.task, role.id, "sol-high", 51, f.engine.s.roles, stage.profileIds, f.scope.work);
    next.reviewInput = ref;
    await supplied(f, input);
    await supplied(f, input, "review-1");
    expect(f.task.journey!.filter(step => step.reviewHistory)).toHaveLength(2);
    expect(next.reviewHistory).toMatchObject({ roundId: "another-execution", digest: step.reviewHistory!.digest, body: step.reviewHistory!.body });
    expect(step.reviewHistory!.roundId).toBe("round-3");
  } finally { await f.engine.shutdown(); }
});

it("leaves reopened claims, current votes and native open findings complete, and can reopen a shortened id", async () => {
  const f = await fixture(0);
  try {
    const old = finding("settled"), rechecked = { ...finding("rechecked"), reopenedAt: 35, answer: { fixed: true, text: "Checked again", at: 40 } };
    const unreviewed = { ...finding("unreviewed"), reopenedAt: 35, answer: { fixed: true, text: "Current claim", at: 65 } };
    f.task.findings = [old, rechecked, unreviewed, { ...finding("open"), status: "open" }, { ...finding("native"), raisedBy: "petrina", status: "open" }];
    f.task.journey = [examined([old]), examined([rechecked], { id: "rechecked-round", round: 4, startedAt: 50, endedAt: 60 })];
    const { input, step } = await freeze(f);
    const sections = await supplied(f, input);
    const text = opening(f, sections);
    for (const id of ["unreviewed", "open", "native"]) expect(text).toContain(formatFindings([input.findings.find(f => f.id === id)!], { complete: true }));
    expect(text).toContain("Reopened before: yes");
    measure("reopened and rechecked with current unreviewed controls", f, sections, step.reviewHistory!.body);
    expect(checkReviewEvidence(input.findings, ReviewResult.parse({ verdict: "fail", findings: [], confirms: ["settled"], disputes: [] }))).toContain("current");
    const result = ReviewResult.parse({ verdict: "fail", findings: [], confirms: [{ id: "settled", evidence: "Current code loses the fix; expected greeting, observed empty." }], disputes: [] });
    expect(checkReviewEvidence(input.findings, result)).toBeUndefined();
    const votes = structuredClone(old.votes);
    await f.engine["reviews"]["applyReview"](f.scope, stage, result, "opus-high", role.id, "0");
    expect(f.task.findings[0]!.status).toBe("open"); expect(f.task.findings[0]!.earlierReviews![0]!.votes).toEqual(votes);
  } finally { await f.engine.shutdown(); }
});

it("preserves separate shared-product claims and judgments in the frozen reference", async () => {
  const f = await fixture(0);
  try {
    const second = await makeProduct(join(f.root, "second"));
    f.engine.s.products.push({ id: "second", name: "Second", path: second, repo: "local/second", tone: "blue" });
    f.task.repositories = [{ ...f.scope.work, completedStages: [] }, { ...f.scope.work, productId: "second", worktree: second, baseSha: await git(second, "rev-parse", "HEAD"), completedStages: [] }];
    delete f.task.repository;
    f.scope = executionFor(f.task);
    const shared = { ...finding("shared"), productIds: ["p", "second"], answers: { p: { fixed: true, text: "Product p claim", at: 10 }, second: { fixed: true, text: "Separate second-product claim", at: 25 } }, judgments: [{ by: "sol-high", severity: "blocking" as const, at: 5 }, { by: "opus-high", severity: "suggestion" as const, at: 6 }] };
    f.task.findings = [shared]; f.task.journey = [examined([shared], { startedAt: 26 })];
    const { input, step } = await freeze(f);
    const sections = await supplied(f, input);
    const records = JSON.parse(step.reviewHistory!.body);
    expect(records.findings.shared).toBe(formatFindings([shared], { complete: true }));
    expect(records.findings.shared).toContain("Product p claim"); expect(records.findings.shared).toContain("Separate second-product claim");
    expect(records.findings.shared).toContain("Severity reported by sol-high: important"); expect(records.findings.shared).toContain("Severity reported by opus-high: nit");
    expect(opening(f, sections)).toContain("Products: p, second");
    measure("shared fix with separate product and seat judgments", f, sections, step.reviewHistory!.body);
    shared.answers.second = { fixed: true, text: "New unreviewed second claim", at: 45 };
    const next = await f.context.captureReview(f.scope);
    expect(next.settled).toBeUndefined();
    expect(next.parts.findings![0]!.body).toContain("New unreviewed second claim");
    expect(records.findings.shared).not.toContain("New unreviewed second claim");
  } finally { await f.engine.shutdown(); }
});

it("keeps complete full entries after completion, cleanup and restart; missing and changed files stay unavailable", async () => {
  const f = await fixture(2);
  try {
    const cardId = f.engine.addTask({ productId: "p", title: longCard.title, description: longCard.problem, kind: "bug", backlog: true });
    const { input, ref, step } = await freeze(f);
    const originals = structuredClone(input.findings), originalCard = structuredClone(input.cards[0]!);
    const sections = await supplied(f, input);
    const full = step.reviewHistory!.body, historyFile = input.history!.file;
    step.agentInputs = [0, 1, 2].map(i => ({ at: 41, mode: "fresh", roleId: role.id, profileId: stage.profileIds[i]!, reviewerKey: String(i), taskTitle: f.task.title, reviewInput: ref, sections: sections.map(({ title, body }) => ({ title, body })) }));
    writeFileSync(historyFile, "CHANGED");
    await expectRejection(readReviewInput(ref), "frozen review history changed");
    writeFileSync(historyFile, full);
    f.task.findings[0]!.evidence = "LATER EDIT";
    f.task.findings[0]!.text = "LATER PROBLEM";
    f.engine.task(cardId)!.description = "LATER CARD";
    step.endedAt = 70; f.task.state = "done"; f.task.finishedAt = 80;
    f.engine.commitNow();
    await new Cleanup(f.engine).sweep();
    expect(existsSync(historyFile)).toBe(false); expect(existsSync(ref.file)).toBe(false);
    await f.engine.shutdown();
    const restart = new Engine(f.data, { admissionsClosed: true, terminals: () => [] }); restart.schedule = () => {};
    try {
      const task = restart.task(f.task.id)!;
      const kept = task.journey!.find(s => s.id === step.id)!;
      expect(kept.reviewHistory!.body).toBe(full); expect(sha(full)).toBe(kept.reviewHistory!.digest);
      for (const seat of kept.agentInputs!) expect(JSON.stringify(seat.sections)).toContain(kept.reviewHistory!.digest);
      const c = new Coordination(restart);
      let page = await c.call("journey.review-input", { taskId: task.id, nodeId: step.id, section: "history", limit: 500 });
      let text = String(page.text);
      while (page.next) { page = await c.call("journey.review-input", { taskId: task.id, nodeId: step.id, section: "history", limit: 500, cursor: page.next }); text += page.text; }
      expect(text).toBe(full); expect(page.digest).toBe(kept.reviewHistory!.digest);
      const records = JSON.parse(text);
      expect(records.cards[cardId]).toEqual(originalCard);
      for (const original of originals) expect(records.findings[original.id]).toBe(formatFindings([original], { complete: true }));
      expect(text).toContain("Original vote for f0"); expect(text).toContain("Original evidence for f0"); expect(text).not.toContain("LATER");
      expect((await c.call("journey.review-input", { taskId: task.id, nodeId: step.id })).outcome).toBe("unavailable");
      await expectRejection(readReviewHistory(input.history!), "unavailable");
      measure("completion retained after cleanup and restart", f, sections, full);
    } finally { await restart.shutdown(); }
  } finally { await f.engine.shutdown(); }
});

it("uses complete sections if the indexed copy cannot be frozen", async () => {
  const f = await fixture();
  const write = files.writeFile;
  const failed = spyOn(files, "writeFile").mockImplementation(async (path, data, options) => {
    if (String(path).endsWith(".history.json")) throw new Error("Unavailable history storage");
    return write(path, data, options);
  });
  try {
    const { input, step } = await freeze(f, [longCard]);
    expect(input.history).toBeUndefined();
    const sections = await supplied(f, input);
    expect(step.reviewHistory).toBeUndefined();
    expect(opening(f, sections)).toContain(f.task.findings[0]!.evidence!); expect(opening(f, sections)).toContain(longCard.problem);
    const stats = measure("copy storage unavailable, complete fallback", f, sections); expect(stats.after).toBe(stats.before);
  } finally { failed.mockRestore(); await f.engine.shutdown(); }
});
