import { executionFor } from "@petrina/orchestrator";
import * as gitOps from "@petrina/repositories/git";
import { afterAll, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { independentReviewFixtures } from "../../fixtures/independence.js";

const { fixture, close } = independentReviewFixtures();
afterAll(close);
describe.concurrent("reviews after a usage handoff", () => {
for (const [reopen, legacy] of [["resume", true], ["load", false]] as const) {
    it(`${legacy ? "replaces a legacy port conversation with full instructions" : "keeps a genuine port conversation"} for a single reviewer after ${reopen}`, async () => {
      const f = await fixture({ planner: "short", controlled: true, reopen }, 1);
      try {
        await f.run(async () => {
        await f.advance(f.delivery);
        expect(f.fakes.openings("code reviewer")).toHaveLength(1);
        writeFileSync(join(f.repo, "greeting.txt"), "Hi from main\n");
        await gitOps.commitChanges(f.repo, "A greeting on main");
        f.engine.approve(f.engine.getState().inbox.find((item) => item.kind === "delivery")!.id);
        await f.advance(() => f.fakes.received("code reviewer").length === 2 && !!f.task().conversation?.briefed, (role) => role !== "code reviewer");
        const port = f.fakes.received("code reviewer").at(-1)!;
        expect(port.text).toContain("Review only the port");
        expect(f.task().plan!.stages.find((stage) => stage.kind === "review-chain")!.profileIds).toHaveLength(1);
        f.engine.setPoolPaused(true);
        const saved = f.engine.s.tasks.find((entry) => entry.id === f.task().id)!;
        expect(executionFor(saved).work.conversation?.sessionId).toBe(port.session);
        if (legacy) delete executionFor(saved).work.reviewedTree;
        f.engine.sendMessage(f.task().id, "Check the welcome page too.");
        await f.restart();
        f.engine.setPoolPaused(false);
        if (legacy) {
          await f.advance(() => f.fakes.received("code reviewer").length > 2 && !!f.task().conversation?.briefed, (role) => role !== "code reviewer");
          expect(f.task().reviewedTree).toBeUndefined();
        }
        await f.advance(f.delivery);
        const after = f.fakes.received("code reviewer").slice(2);
        expect(after).toHaveLength(1);
        expect(after.map((entry) => entry.text).join("\n")).toContain("Check the welcome page too.");
        if (legacy) {
          expect(after[0]!.session).not.toBe(port.session);
          expect(after[0]!.text).not.toContain("Review only the port");
          expect(after[0]!.text).toContain(`git diff ${f.task().baseSha}...HEAD`);
          expect(after[0]!.text).toContain("Check every acceptance item");
        } else {
          expect(after[0]!.session).toBe(port.session);
          expect(after[0]!.text).toContain("Petrina restarted");
        }
        expect(f.task().reviewedTree).toBe(await gitOps.treeOf(f.task().worktree!));
        });
      } finally { await f.close(); }
    });
  }

});
