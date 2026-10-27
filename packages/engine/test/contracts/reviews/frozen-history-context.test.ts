import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { afterAll as closeOwnedCases } from "bun:test";
import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beginAgentStep, type DeepMutable, type JourneyStep } from "@petrina/core";
import { Coordination } from "../../../src/coordination.js";
import { executionFor, repositoryView } from "@petrina/orchestrator";
import { readReviewInput } from "../../../src/review-context.js";
import { CARD_OPENING, historyGuidance, readReviewHistory } from "../../../src/review-history.js";
import { builderContext } from "../../../src/builder-context.js";
import { formatFindings } from "../../../src/prompts.js";
import { checkReviewEvidence } from "@petrina/core";
import { ReviewResult } from "../../../src/roles.js";
import { git, makeProduct } from "../../fixtures.js";
import { frozenHistoryFixtures } from "../../fixtures/review-history.js";
const cases = engineCaseFixtures();
closeOwnedCases(() => cases.close());


const { role, stage, finding, examined, fixture, freeze, longCard, supplied, opening, measure, measureWarm } = frozenHistoryFixtures();
it("keeps first-round short cards and legacy snapshots exactly complete with nothing extra retained", async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const f = await fixture(owner, 0);
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
    } finally { await owner.stop(f.engine); }

  });
});

it("never shows a task its own follow-up card, in a live capture or a resumed frozen review", async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const f = await fixture(owner, 0);
    try {
      await owner.run(f.engine, async () => {
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

      });
    } finally { await owner.stop(f.engine); }

  });
});

it("freezes simultaneous fresh conflict reviewers, replacement and recovery without live peers or card edits", async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const f = await fixture(owner, 23);
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
      f.engine.commitNow(); await owner.stop(f.engine);
      const restart = owner.open(f.data, { admissionsClosed: true, terminals: () => [] }); restart.schedule = () => {};
      try {
        const recovered = restart.task(f.task.id)!;
        expect(recovered.journey!.find(s => s.id === step.id)!.reviewHistory!.body).toBe(full);
        expect(await readReviewInput(recovered.hunt!.input!)).toEqual(reopened);
      } finally { await owner.stop(restart); }
    } finally { await owner.stop(f.engine); }

  });
});

it("preserves warm status deltas, full packets and changed claim evidence", async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const f = await fixture(owner);
    try {
      await owner.run(f.engine, async () => {
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

      });
    } finally { await owner.stop(f.engine); }

  });
});

for (const shortened of ["findings", "cards", "both"]) it(`supplies frozen-history guidance once with shortened ${shortened}`, async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const f = await fixture(owner, shortened === "cards" ? 0 : 1);
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
    } finally { await owner.stop(f.engine); }

  });
});

it("resends a changed warm card complete without retaining unused history", async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const f = await fixture(owner);
    try {
      await owner.run(f.engine, async () => {
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

      });
    } finally { await owner.stop(f.engine); }

  });
});

it("does not retain history for a short capacity continuation, or shorten without a round owner", async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const f = await fixture(owner);
    try {
      await owner.run(f.engine, async () => {
        const { input, step } = await freeze(f, [longCard]);
        const sections = await f.context.sectionsFor(f.scope, role.id, "review-0", undefined, undefined, input);
        await f.engine["turns"]["prepareTurnPrompt"](f.scope, role, "capacity", sections, undefined, { packet: true, findings: input.findings, supplyHistory: false });
        expect(step.reviewHistory).toBeUndefined();
        delete step.reviewInput;
        const complete = await f.engine["turns"]["prepareTurnPrompt"](f.scope, role, "no-owner", sections, undefined, { packet: true, findings: input.findings });
        expect(opening(f, complete.sections)).toContain(input.findings[0]!.evidence!);
        expect(opening(f, complete.sections)).toContain(longCard.problem);
        expect(step.reviewHistory).toBeUndefined();

      });
    } finally { await owner.stop(f.engine); }

  });
});

it("retains one copy for each execution even when the round number and snapshot are reused", async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const f = await fixture(owner);
    try {
      await owner.run(f.engine, async () => {
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

      });
    } finally { await owner.stop(f.engine); }

  });
});

it("leaves reopened claims, current votes and native open findings complete, and can reopen a shortened id", async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const f = await fixture(owner, 0);
    try {
      await owner.run(f.engine, async () => {
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

      });
    } finally { await owner.stop(f.engine); }

  });
});

it("preserves separate shared-product claims and judgments in the frozen reference", async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const f = await fixture(owner, 0);
    try {
      await owner.run(f.engine, async () => {
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

      });
    } finally { await owner.stop(f.engine); }

  });
});
