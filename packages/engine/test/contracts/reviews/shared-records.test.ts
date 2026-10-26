import { executionFor } from "@petrina/orchestrator";
import { completeAll, reviewRoundEnd } from "@petrina/core";
import { afterAll, describe, expect, it } from "bun:test";
import { reviewRecords } from "../../fixtures/review-records.js";
import { ReviewResult } from "../../../src/roles.js";
import { coordinator, itemOf, removeDir, tempDir, until } from "../../support.js";
import { sharedWorldFixtures } from "../../fixtures/shared-world.js";
const fixtures = sharedWorldFixtures();
afterAll(() => completeAll([fixtures.close(), Promise.resolve().then(() => recordRoots.forEach(removeDir))]));
const recordRoots: string[] = [];
async function sharedRecords() { const root = tempDir("petrina-review-records-"); recordRoots.push(root); return reviewRecords(root); }

describe.concurrent("one task across products", () => {
  for (const count of [1, 2]) it(`settles completed objections before waiting for voting usage across ${count} products`, async () => {
    await fixtures.world(`objection-usage-${count}`, async ({ shop, api, engine: withEngine, fakes }) => {

    const { id } = await withEngine(async engine => {

      const first = await engine.addProduct(shop.clone);
      const products = count === 1 ? [first] : [first, await engine.addProduct(api.clone, "API")];
      const id = engine.addTask({ productId: first, ...(count > 1 ? { worksOn: products.map((productId) => ({ productId, startFrom: { kind: "default" as const }, delivery: "pull-request" as const })) } : {}), title: "Settle saved review objections" });
      await until(engine, (state) => !!itemOf(state, id, "delivery"), coordinator(["plan", "design"]));
      engine.setPoolPaused(true);
      const task = engine.task(id)!;
      task.stageIndex = task.plan!.stages.findIndex((stage) => stage.kind === "review-chain");
      const stage = task.plan!.stages[task.stageIndex]!;
      task.state = "waiting";
      task.holdsSlot = false;
      task.hunt = { stageId: stage.id, round: task.rounds[stage.id] ?? 1, reported: Object.fromEntries(stage.profileIds.map((_, index) => [String(index), true])), findings: 1 };
      task.findings = [{ id: "objected", text: "An objection nobody confirmed", ...(count > 1 ? { productIds: products } : {}), severity: "blocking", status: "open", raisedBy: "earlier-reviewer", confirmedBy: [], disputes: [{ by: stage.profileIds[0]!, reason: "The current code already handles this case.", at: Date.now() }] }];
      engine.s.inbox = engine.s.inbox.filter((item) => item.taskId !== id);
      engine.s.pool.limited = [...new Set(engine.s.profiles.map((profile) => profile.toolId))].map((toolId) => ({ toolId, until: Date.now() + 120_000, reason: "No voting usage left" }));
      engine.save();

      return { id };

    });

    await withEngine(async engine => {
      await engine.waitUntilReady();
      const resumed = engine.task(id)!;
      // Scheduling must settle the saved reports before deciding whether an agent is needed.
      engine.setPoolPaused(false);
      expect(resumed.statusLine).not.toStartWith("Waiting for usage");
      expect(resumed.findings[0]!.status).toBe("dismissed");
      await until(engine, (state) => !!itemOf(state, id, "delivery"), coordinator([]));
      expect(fakes.openings("verifier")).toHaveLength(0);
      expect(engine.getState().pool.limited?.length).toBeGreaterThan(0);

    });

    });
  });
});

describe.concurrent("shared-task repair regressions", () => {
  for (const order of ["pass-first", "confirmation-first", "dispute-first", "confirmation-before-dispute", "repeated-finding-after-dispute", "repeated-finding-before-dispute", "dispute-without-confirmation", "both-pass"] as const) it(`combines shared fix reviews regardless of completion order, including restart: ${order}`, async () => {
    const fixture = await sharedRecords(), { first, second, start, stage } = fixture;
    let engine = fixture.engine, task = fixture.task;
    const id = task.id;
    try {
      // Two independent reviewers assess the same saved repaired finding.
      task.hunt = { stageId: stage.id, round: 2, reported: {}, findings: 1 };
      task.rounds[stage.id] = 2;
      task.findings = [{ id: "shared-fix", text: "The journey still fails across both products", productIds: [first, second], severity: "blocking", raisedBy: "earlier-reviewer", status: "open", confirmedBy: [], answer: { at: Date.now(), fixed: true, text: "Repaired" }, answers: Object.fromEntries([first, second].map((id) => [id, { at: Date.now(), fixed: true, text: "Repaired my part" }])) }];
      for (const key of ["0", "1"]) {
        const confirmationFirst = order === "confirmation-first" || order === "confirmation-before-dispute" || order === "repeated-finding-before-dispute";
        const confirms = !["both-pass", "dispute-without-confirmation"].includes(order) && (confirmationFirst ? key === "0" : key === "1");
        const disputes = order.includes("dispute") && (confirmationFirst ? key === "1" : key === "0");
        const repeats = confirms && order.startsWith("repeated-finding");
        const result = ReviewResult.parse({
          verdict: confirms || repeats ? "fail" : "pass",
          findings: repeats ? [{ text: task.findings[0]!.text, productIds: [first, second], severity: "important", evidence: "The combined journey still fails on the current product versions." }] : [],
          confirms: confirms && !repeats ? [{ id: "shared-fix", evidence: "The combined journey still fails on the current product versions." }] : [],
          disputes: disputes ? [{ id: "shared-fix", reason: "I could not reproduce this problem on the changed code." }] : [],
          learnings: [],
        });
        await engine["reviews"]["applyReview"](executionFor(task), stage, result, stage.profileIds[Number(key)]!, "code-reviewer", key);
        task.hunt!.reported[key] = true;
        if (key === "0") {
          engine["reviews"]["settleReviews"](task, stage);
          expect(task.findings[0]!.status).toBe("open");
          engine.save(); await engine.shutdown(); engine = start(); task = engine.task(id)!;
        }
      }
      engine["reviews"]["settleReviews"](task, stage);
      const expected = order === "both-pass" ? "fixed" : order === "dispute-without-confirmation" || order.startsWith("repeated-finding") ? "dismissed" : "open";
      expect(task.findings[0]!.status).toBe(expected);
      expect(reviewRoundEnd(task, stage, 2, engine.s.roles).kind === "passed").toBe(expected !== "open" && !order.startsWith("repeated-finding"));
      if (order.startsWith("repeated-finding")) {
        expect(task.findings).toHaveLength(2);
        expect(task.findings[1]!.status).toBe("open");
        expect(task.findings[1]!.confirmedBy).toEqual([]);
      }
      if (expected === "open") expect(task.findings[0]!.confirmedBy).toHaveLength(1);
      if (order.includes("dispute")) expect(task.findings[0]!.disputes).toHaveLength(1);
    } finally { await engine.shutdown(); }
  });

  it("settles single-product objections with the whole group and preserves checks and unresolved ownership", async () => {
    const { engine, first, second, task, stage } = await sharedRecords();
    try {
      task.hunt = { stageId: stage.id, round: 1, reported: {}, findings: 5 };
      task.findings = [
        { id: "single", text: "Single-product problem", productIds: [first] },
        { id: "unopposed", text: "Unopposed single-product objection", productIds: [second] },
        { id: "native", text: "Check failed: Product tests", raisedBy: "petrina", productIds: [second] },
        { id: "acceptance", text: "Failed acceptance check: Shared behaviour", productIds: [first, second] },
        { id: "unassigned", text: "Ownership not yet resolved" },
      ].map((finding) => ({ severity: "blocking", raisedBy: "earlier-reviewer", confirmedBy: [], status: "open", ...finding }));
      const result = ReviewResult.parse({ verdict: "pass", findings: [], confirms: [], disputes: task.findings.map((finding) => ({ id: finding.id, reason: "I disagree with this finding." })), learnings: [] });
      await engine["reviews"]["applyReview"](executionFor(task), stage, result, "opus-high", "code-reviewer", "0");
      task.hunt.reported = { "0": true };
      engine["reviews"]["settleReviews"](task, stage);
      expect(task.findings.every((finding) => finding.status === "open")).toBe(true);
      await engine["reviews"]["applyReview"](executionFor(task), stage, ReviewResult.parse({ ...result, verdict: "fail", disputes: [], confirms: ["single"] }), "sol-high", "code-reviewer", "1");
      task.hunt.reported = { "0": true, "1": true };
      engine["reviews"]["settleReviews"](task, stage);
      expect(task.findings.map((finding) => [finding.id, finding.status])).toEqual([["single", "open"], ["unopposed", "dismissed"], ["native", "open"], ["acceptance", "open"], ["unassigned", "open"]]);
      expect(task.findings[0]!.disputes).toHaveLength(1);
      expect(task.findings[0]!.confirmedBy).toEqual(["sol-high"]);
    } finally { await engine.shutdown(); }
  });
});
