import { afterAll, describe, expect, it } from "bun:test";
import { nextLine } from "@petrina/core";
import { reviewProgressFixtures } from "../../fixtures/review-todo.js";

const { MINUTE, models, reviewersHaveRead, setup, close } = reviewProgressFixtures();
afterAll(close);
describe("real grouped review summaries", () => {
it("keeps unfinished work through a restart, excludes it from history, and skips reported reviewers in Next after a pause", async () => {
    const run = await setup();
    let engine = run.engine;
    const tags = models.map((model) => `code-reviewer-${model}`);
    try {
      await run.approve();
      await Promise.all(tags.map((tag) => run.ready(tag)));
      for (const tag of tags) { run.go(`publish-1-${tag}`); run.go(`action-1-${tag}`); }
      await engine.until((state) => reviewersHaveRead(run.find(state)), "the review actions");
      run.advance(5);
      run.go(`result-1-${tags[1]}`); run.go(`finish-${tags[1]}`);
      const partial = await engine.until((state) => !!run.find(state).hunt?.reported["1"], "the second reviewer to finish");
      expect(run.find(partial).steps!.filter((step) => step.roleId === "code-reviewer")).toHaveLength(1);
      await engine.act("setPoolPaused", true);
      await engine.act("sendMessage", run.taskId, "Check the guest view too", "queue");
      await engine.kill();
      run.advance(6 * 60);
      engine = await run.launch();
      const recovered = await engine.state();
      expect(run.find(recovered).todo).toBe("Checking the greeting");
      expect(run.find(recovered).stepClock!.worked).toBeGreaterThanOrEqual(5 * MINUTE);
      expect(run.find(recovered).stepClock!.worked).toBeLessThan(6 * MINUTE);
      expect(nextLine(recovered, run.find(recovered))).toBe("Next: code review (Claude Code · Opus 5.5), then your OK to ship");
      await engine.act("setPoolPaused", false);
      await run.ready(tags[0]!, 2);
      expect(run.find(await engine.until((state) => run.find(state).todo === "Checking the greeting", "the reopened reviewer summary")).todo).toBe("Checking the greeting");
      // Pausing clears the item, but the saved result still keeps the other reviewer out of Next.
      await engine.act("pause", run.taskId);
      const paused = await engine.state();
      expect(run.find(paused).todo).toBeUndefined();
      expect(nextLine(paused, run.find(paused))).toBe("Next: code review (Claude Code · Opus 5.5), then your OK to ship");
      await engine.act("resume", run.taskId);
      await run.ready(tags[0]!, 3);
      for (const name of ["publish-3", "action-3", "result-3", "finish"]) run.go(`${name}-${tags[0]}`);
      const done = run.find(await engine.until((state) => state.inbox.some((item) => item.kind === "delivery"), "the delivery check"));
      expect(done.steps!.filter((step) => step.roleId === "code-reviewer")).toHaveLength(1);
      expect(run.fakes.openings("code reviewer")).toHaveLength(4);
    } finally { await engine.quit(); }
  });

});
