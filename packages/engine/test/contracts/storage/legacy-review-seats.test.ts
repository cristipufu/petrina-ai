import { executionFor } from "@petrina/orchestrator";
import { afterAll, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../../fixtures.js";
import { independentReviewFixtures } from "../../fixtures/independence.js";

const { fixture, close } = independentReviewFixtures();
afterAll(close);
describe.concurrent("reviews after a usage handoff", () => {
it("retains a reported review after a restart of a saved legacy pair", async () => {
    const f = await fixture({ controlled: true }, 1, undefined, undefined, false);
    try {
      await f.run(async () => {
      // Save the legacy Sol + Opus plan with Claude already out before the review starts.
      await f.advance(() => f.fakes.received("builder").length === 1, (role) => role !== "builder");
      const stage = f.engine.s.tasks.find((entry) => entry.id === f.task().id)!.plan!.stages.find((stage) => stage.kind === "review-chain")!;
      stage.profileIds = ["sol-high", "opus-high"];
      f.engine.s.pool.limited = [{ toolId: "claude-code", until: Date.now() + 3_600_000, reason: "Claude Code's usage limit" }];
      await f.advance(() => Object.keys(f.task().hunt?.reported ?? {}).length === 1, (role, session) => role !== "code reviewer" || f.model(session) === "gpt-6.1-sol");
      expect(f.task().hunt?.profiles?.["0"]).toBe("sol-high");
      await f.restart();
      await f.advance(f.delivery);
      const reviewers = f.fakes.received("code reviewer");
      expect(reviewers.filter((entry) => f.model(entry.session) === "gpt-6.1-sol")).toHaveLength(1);
      expect(reviewers.filter((entry) => f.model(entry.session) === "grok-4.7").length).toBeGreaterThanOrEqual(1);
      expect(f.task().hunt).toBeUndefined();
      expect(f.task().brief?.summary).toBe("A greeting file.");
      });
    } finally { await f.close(); }
  });

it("keeps an actual replacement's verdict in older saved rounds without recorded reviewer positions", async () => {
    const f = await fixture({ controlled: true, limited: [{ model: "opus", role: "code reviewer", spendCap: true }] }, 1);
    try {
      await f.run(async () => {
      // Initially only Codex can finish the review. Both other tools recover before the restart.
      f.engine.s.pool.limited = [{ toolId: "grok", until: Date.now() + 3_600_000, reason: "Grok's usage limit" }];
      await f.advance(() => Object.keys(f.task().hunt?.reported ?? {}).length === 1);
      f.engine.setPoolPaused(true);
      expect(f.task().hunt?.profiles?.["0"]).toBe("sol-high");
      const saved = f.engine.s.tasks.find((entry) => entry.id === f.task().id)!;
      delete saved.hunt!.profiles;
      f.engine.s.pool.limited = [];
      f.engine.s.pool.usage = [];
      f.fakes.scenario({ controlled: true, builder: "plain" });
      await f.restart();
      f.engine.setPoolPaused(false);
      await f.advance(f.delivery);
      const verdicts = f.engine.tracking.log.moments({ taskId: f.task().id, kinds: ["verdict"] });
      expect(verdicts.map((entry) => entry.profileId)).toEqual(["sol-high", "opus-high"]);
      expect(f.fakes.openings("builder")).toHaveLength(1);
      });
    } finally { await f.close(); }
  });

it("restores the full planned review when an older saved port has no proof of completed feature review", async () => {
    const f = await fixture({ controlled: true }, 3);
    try {
      await f.run(async () => {
      await f.advance(f.delivery);
      writeFileSync(join(f.repo, "greeting.txt"), "Hi from main\n");
      await git(f.repo, "add", "greeting.txt");
      await git(f.repo, "commit", "-q", "-m", "A greeting on main");
      f.engine.approve(f.engine.getState().inbox.find((item) => item.kind === "delivery")!.id);
      await f.advance(() => f.fakes.received("code reviewer").some((entry) => entry.text.includes("Review only the port")), (role) => role !== "code reviewer");
      // Older releases saved this mark even for an unreviewed feature. A restart must not trust it.
      f.engine.setPoolPaused(true);
      const saved = f.engine.s.tasks.find((entry) => entry.id === f.task().id)!;
      delete executionFor(saved).work.reviewedTree;
      // Even a report already saved under that narrower scope cannot replace an ordinary review.
      const key = Object.keys(saved.hunt!.profiles!)[0]!;
      saved.hunt!.reported[key] = true;
      const before = f.fakes.received("code reviewer").length;
      await f.restart();
      f.engine.setPoolPaused(false);
      await f.advance(f.delivery);
      const reviews = f.fakes.received("code reviewer").slice(before);
      expect(reviews).toHaveLength(2);
      for (const review of reviews) {
        expect(review.text).not.toContain("Review only the port");
        expect(review.text).toContain(`git diff ${f.task().baseSha}...HEAD`);
      }
      expect(f.task().portReview).toBeUndefined();
      expect(f.task().reviewedTree).toBe(await git(f.task().worktree!, "rev-parse", "HEAD^{tree}"));
      });
    } finally { await f.close(); }
  });

});
