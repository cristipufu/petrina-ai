import { executionFor } from "@petrina/orchestrator";
import { independentVotes } from "@petrina/core";
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ReviewResult } from "../../../src/roles.js";
import { coordinator, finish, git, headNow, itemOf, taskOf, until } from "../../support.js";
import { sharedWorldFixtures } from "../../fixtures/shared-world.js";
import { preparedSharedReview } from "../../fixtures/prepared-shared-review.js";
const fixtures = sharedWorldFixtures();
afterAll(() => fixtures.close());

describe.concurrent("one task across products", () => {
  it("routes an incompletely repeated finding to its saved owner after restart and keeps ownership in History", async () => {
    await fixtures.world("finding-owner-restart", async ({ shop, api, engine: withEngine, fakes }) => {

    const { second, id, findingId, report } = await withEngine(async engine => {

      const first = await shop.preparedProduct(engine), second = await api.preparedProduct(engine);
      const id = await preparedSharedReview(engine, [first, second], "Keep routing the reported API repair", false);
      await until(engine, (state) => !!itemOf(state, id, "delivery") || !!taskOf(state, id).error, coordinator(["plan", "design"]));
      engine.setPoolPaused(true);
      const task = engine.task(id)!;
      expect(task.error).toBeUndefined();
      const stage = task.plan!.stages.find((stage) => stage.kind === "review-chain")!;
      const report = { text: "The API drops the greeting after signing out.", severity: "important", evidence: "The current API guest request omits the greeting; a signed-in request includes it." };
      for (const [index, productIds] of [[second], undefined].entries()) {
        await engine["reviews"]["applyReview"](executionFor(task), stage, ReviewResult.parse({ verdict: "fail", findings: [{ ...report, productIds }] }), index ? "sol-high" : "opus-high", "code-reviewer", String(index));
      }
      const findingId = task.findings.find((finding) => finding.text === report.text)!.id;
      task.findings.push({ id: "unknown-owner", text: "A separate finding has no known owner.", productIds: [], severity: "blocking", raisedBy: "sol-high", confirmedBy: [], status: "open" });
      engine.save();

      return { second, id, findingId, report };

    });

    await withEngine(async engine => {
      const restored = engine.task(id)!;
      expect(restored.findings.find((finding) => finding.id === findingId)?.productIds).toEqual([second]);
      engine.requestChanges(itemOf(engine.getState(), id, "delivery")!.id, "Repair the known API finding.");
      expect(restored.repair?.products).toEqual([second]);
      engine.setPoolPaused(false);
      const repaired = taskOf(await until(engine, (state) => !!itemOf(state, id, "delivery") || !!taskOf(state, id).error, coordinator([])), id);
      expect(repaired.error).toBeUndefined();
      const repairs = fakes.received("builder").filter((entry) => entry.text.includes("You are fixing the review findings"));
      expect(repairs).toHaveLength(1);
      expect(repairs[0]!.text).toContain(`You own only product ${second}`);
      expect(repairs[0]!.text).toContain(report.text);
      expect(repairs[0]!.text).toContain(report.evidence);
      expect(repaired.findings.find((finding) => finding.id === findingId)?.answers?.[second]?.fixed).toBe(true);
      expect(repaired.findings.find((finding) => finding.id === "unknown-owner")?.status).toBe("open");
      engine.cancel(id);
      engine.save();
      const archived = engine.store.history.get(id)!;
      expect(archived.findings.find((finding) => finding.id === findingId)?.productIds).toEqual([second]);
      expect(archived.findings.find((finding) => finding.id === "unknown-owner")?.productIds).toEqual([]);
      expect(shop.github().prs).toHaveLength(0);
      expect(api.github().prs).toHaveLength(0);

    });

    });
  });

  it("keeps each parallel reviewer's complete snapshot map and queued coordinator message", async () => {
    await fixtures.world("review-messages", async ({ shop, api, engine: withEngine, fakes }) => {

    await withEngine(async engine => {

      const first = await shop.preparedProduct(engine), second = await api.preparedProduct(engine);
      fakes.scenario({ planner: "parallel", builder: "plain", controlled: true });
      const id = await preparedSharedReview(engine, [first, second], "Review the shared greeting", true);
      await until(engine, () => fakes.received("code reviewer").length >= 2, (engine, state) => {
        coordinator(["plan", "design"])(engine, state);
        for (const entry of fakes.received()) if (entry.role !== "code reviewer") writeFileSync(join(fakes.dir, `release-${entry.session}`), "go");
      });
      engine.setPoolPaused(true);
      const reviews = fakes.received("code reviewer");
      const copies = reviews.flatMap((review) => [...review.text.matchAll(/Product id: ([^;]+); copy: ([^;]+); base version: ([^\n]+)/g)]);
      expect(reviews).toHaveLength(2);
      expect(copies).toHaveLength(4);
      expect(new Set(copies.map((match) => match[2])).size).toBe(4);
      for (const review of reviews) for (const productId of [first, second]) expect(review.text).toContain(`Product id: ${productId}; copy:`);
      for (const work of taskOf(engine.getState(), id).repositories!) {
        expect(copies.filter((match) => match[1] === work.productId).map((match) => match[3])).toEqual([`${work.baseSha}; last completed review: none; inspect the full change`, `${work.baseSha}; last completed review: none; inspect the full change`]);
        expect(copies.some((match) => match[2] === work.worktree)).toBe(false);
        for (const match of copies.filter((entry) => entry[1] === work.productId)) expect(dirname(match[2]!)).toBe(join(shop.data, "worktrees", work.productId, `${id}.copies`));
      }
      engine.sendMessage(id, "Check the guest journey across both products", "queue");
      for (const review of reviews) writeFileSync(join(fakes.dir, `release-${review.session}`), "go");
      const state = await until(engine, (state) => taskOf(state, id).state === "waiting" && !taskOf(state, id).holdsSlot, coordinator([]));
      const heard = fakes.received("code reviewer").filter((entry) => entry.text.includes("Check the guest journey across both products"));
      expect(heard.map((entry) => entry.session).sort()).toEqual(reviews.map((entry) => entry.session).sort());
      expect(taskOf(state, id).queued).toEqual([]);
      for (const match of copies) expect(existsSync(match[2]!)).toBe(false);
      for (const world of [shop, api]) expect(await git(world.clone, "worktree", "list", "--porcelain")).not.toContain(`${id}.copies`);

    });
    });
  });

  it("visits both affected saved builders in one shared repair pass and keeps separate answers", async () => {
    await fixtures.world("shared-repair", async ({ shop, api, engine: withEngine, fakes }) => {
    await withEngine(async engine => {
    const reviewedHeads = new Map<string, string>();
    // A failed read is reported by the test, not thrown into the engine's announcement.
    let captureFailure: unknown;
    let unsubscribe = () => {};

    try {
      const first = await shop.preparedProduct(engine), second = await api.preparedProduct(engine);
      fakes.scenario({ planner: "parallel", reviewRounds: 2, builder: "plain", reopen: "resume", reviewer: "important-twice", affectedProducts: [first, second], fixes: "change" });
      const id = engine.addTask({ productId: first, worksOn: [first, second].map((productId) => ({ productId, startFrom: { kind: "default" }, delivery: "pull-request" })), title: "Repair the shared greeting" });
      unsubscribe = engine.subscribe(() => {
        const current = engine.task(id);
        const review = current?.plan?.stages.find((stage) => stage.kind === "review-chain");
        if (!current || !review || current.rounds[review.id] !== 2 || reviewedHeads.size) return;
        const builder = current.plan!.stages.findIndex((stage) => stage.kind === "do" && stage.roleId === "builder");
        if (current.stageIndex !== builder) return;
        // Announcements stay synchronous: read each copy's HEAD from Git's files as the fix round starts.
        try { for (const work of current.repositories ?? []) reviewedHeads.set(work.productId, headNow(work.worktree!)); }
        catch (error) { captureFailure ??= error; }
      });
      const task = taskOf(await finish(engine, id), id);
      if (captureFailure) throw captureFailure;
      expect(task.error).toBeUndefined();
      const finding = task.findings.find((finding) => finding.severity === "blocking")!;
      expect(finding.productIds).toEqual([first, second]);
      expect(Object.keys(finding.answers!)).toEqual([first, second]);
      expect(finding.status).toBe("fixed");
      // One bounded pair checked the shared finding in round one, each answer bound to both products' reviewed versions.
      const votes = independentVotes(finding.earlierReviews?.[0]?.votes);
      expect(votes.length).toBeGreaterThan(0);
      expect(votes.length).toBeLessThanOrEqual(2);
      for (const vote of votes) expect(Object.keys(vote.ballot!.versions!).sort()).toEqual([first, second].sort());
      const earlier = task.journey!.find((step) => step.roleId === "code-reviewer" && step.round === 1)!.result!.findings!.find((entry) => entry.id === finding.id)!;
      expect(earlier.status).toBe("open");
      expect(earlier.productIds).toEqual([first, second]);
      expect(earlier.answers).toBeUndefined();
      expect(task.repositories!.every((work) => !!work.builderSession)).toBe(true);
      const fixes = fakes.received("builder").filter((entry) => entry.text.includes("You are fixing the review findings"));
      expect(fixes).toHaveLength(2);
      expect(fixes[0]!.text).toContain(`You own only product ${first}`);
      expect(fixes[1]!.text).toContain(`You own only product ${second}`);
      expect(task.rounds[task.plan!.stages.find((stage) => stage.kind === "review-chain")!.id]).toBe(2);
      expect(reviewedHeads.size).toBe(2);
      const roundTwoReviews = fakes.received("code reviewer").map((entry) => entry.text).filter((text) => text.includes("This is review round 2"));
      expect(roundTwoReviews.length).toBeGreaterThan(0);
      for (const [productId, sha] of reviewedHeads) for (const review of roundTwoReviews) {
        expect(review).toContain(`Product id: ${productId}; copy:`);
        expect(review).toContain(`last completed review: ${sha}`);
        expect(review).toContain(`git diff ${sha}..HEAD`);
      }

    } finally { unsubscribe();  }
    });
    });
  });

  it("keeps unassigned Important findings under Together and sends them to no builder", async () => {
    await fixtures.world("unassigned", async ({ shop, api, engine: withEngine, fakes }) => {
    await withEngine(async engine => {

      const first = await shop.preparedProduct(engine), second = await api.preparedProduct(engine);
      fakes.scenario({ planner: "parallel", reviewRounds: 2, builder: "plain", reviewer: "important-twice" });
      const id = engine.addTask({ productId: first, worksOn: [first, second].map((productId) => ({ productId, startFrom: { kind: "default" }, delivery: "pull-request" })), title: "Resolve ownership" });
      const state = await until(engine, (state) => !!itemOf(state, id, "delivery") || !!taskOf(state, id).error, coordinator(["plan", "design"]));
      const task = taskOf(state, id);
      expect(task.error).toBeUndefined();
      expect(task.findings.some((finding) => finding.severity === "blocking" && finding.status === "open" && !finding.productIds?.length)).toBe(true);
      expect(fakes.received("builder").filter((entry) => entry.text.includes("You are fixing the review findings"))).toHaveLength(0);
      expect(shop.github().prs).toHaveLength(0); expect(api.github().prs).toHaveLength(0);
      expect(task.plan!.stages[task.stageIndex]!.gate).toBe("delivery");
      const reviews = fakes.received("code reviewer").length;
      const decision = itemOf(engine.getState(), id, "delivery")!;
      expect(engine.task(id)!.reviewDecision?.accepted).toBe(false);
      engine.approve(decision.id);
      const verified = await until(engine, state => !!itemOf(state, id, "delivery"), coordinator([]));
      expect(itemOf(verified, id, "delivery")!.id).not.toBe(decision.id);
      expect(shop.github().prs).toHaveLength(0); expect(api.github().prs).toHaveLength(0);
      engine.approve(itemOf(verified, id, "delivery")!.id);
      const delivered = await until(engine, (state) => taskOf(state, id).state === "pr-open" || !!taskOf(state, id).error || !!itemOf(state, id, "delivery"), coordinator([]));
      expect(taskOf(delivered, id).error).toBeUndefined();
      expect(taskOf(delivered, id).state).toBe("pr-open");
      expect(fakes.received("code reviewer")).toHaveLength(reviews);
      expect(shop.github().prs).toHaveLength(1); expect(api.github().prs).toHaveLength(1);

    });
    });
  });
});
