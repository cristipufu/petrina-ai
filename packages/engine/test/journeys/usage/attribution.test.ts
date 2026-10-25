import { usageWorld } from "../../fixtures/usage-world.js";
import { afterAll, describe, expect, it } from "bun:test";

import { join } from "node:path";

import { Engine } from "../../engine.js";






import type { Scenario } from "../../fake-agent.js";
import { removeDir, waitFor } from "../../fixtures.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

const start = (scenario: Scenario, options: Parameters<typeof usageWorld>[2] = {}) => usageWorld(roots, scenario, options);


describe("analytics keeps who actually did the work", () => {
  for (const restart of [false, true]) it(`completes a question answered after a pause${restart ? " and restart" : ""}`, async () => {
    const run = await start({ builder: "plain" });
    let restarted: Engine | undefined;
    try {
      const question = await waitFor(() => {
        for (const item of run.engine.getState().inbox) if (item.kind === "plan") run.engine.approve(item.id);
        return run.engine.getState().inbox.find((item) => item.taskId === run.taskId && item.kind === "question");
      }, "the architect's question");
      const original = run.engine.tracking.log.moments({ taskId: run.taskId, kinds: ["ask"] }).find((moment) => moment.ask === "question")!;
      run.engine.pause(run.taskId);
      if (restart) {
        await run.engine.shutdown();
        restarted = new Engine(join(run.root, "data"), { usageCommands: { codex: null } });
      }
      const engine = restarted ?? run.engine;
      expect(engine.getState().inbox.some((item) => item.id === question.id)).toBe(false);
      const version = engine.getState().work!.version;
      const beforeAnswer = Date.now();
      const context = { taskId: run.taskId, about: question.title, clientId: "late-answer" };
      engine.answer(question.id, "Follow the system", context);
      const afterAnswer = Date.now();
      const asks = () => engine.tracking.log.moments({ taskId: run.taskId, kinds: ["ask"] }).filter((moment) => moment.ask === "question");
      expect(asks()).toHaveLength(1);
      const completed = asks()[0]!;
      expect(completed).toEqual({ ...original, answer: "answered", durationMs: expect.any(Number) });
      expect(completed.durationMs!).toBeGreaterThanOrEqual(beforeAnswer - question.at);
      expect(completed.durationMs!).toBeLessThanOrEqual(afterAnswer - question.at);
      expect(engine.getState().work!.version).toBeGreaterThan(version);
      expect(engine.getState().tasks.find((task) => task.id === run.taskId)!.queued.some((message) => message.text.includes("Follow the system"))).toBe(true);
      const words = engine.usage({ view: "analytics", period: "today" }).squad.asks;
      expect(words).toContain("Agents stopped to ask you 1 time; you answered in");
      expect(words).not.toContain("unanswered");
      engine.answer(question.id, "Follow the system", context);
      expect(asks()).toEqual([completed]);
      engine.answer(question.id, "Follow the system", { ...context, clientId: "late-answer-repeated" });
      expect(asks()).toEqual([completed]);
    } finally {
      await run.engine.shutdown();
      await restarted?.shutdown();
    }
  });

  it("records unanswered questions before cancellation and keeps them after a restart", async () => {
    const run = await start({ builder: "plain" });
    let restarted: Engine | undefined;
    try {
      const question = await waitFor(() => {
        for (const item of run.engine.getState().inbox) if (item.kind === "plan") run.engine.approve(item.id);
        return run.engine.getState().inbox.find((item) => item.taskId === run.taskId && item.kind === "question");
      }, "the architect's question");
      const asks = () => run.engine.tracking.log.moments({ taskId: run.taskId, kinds: ["ask"] }).filter((moment) => moment.ask === "question");
      expect(asks()).toHaveLength(1);
      expect(asks()[0]).toMatchObject({ at: question.at, roleId: "architect" });
      expect(asks()[0]!.answer).toBeUndefined();
      run.engine.cancel(run.taskId);
      expect(run.engine.getState().inbox.some((item) => item.id === question.id)).toBe(false);
      expect(asks()).toHaveLength(1);
      const words = run.engine.usage({ view: "analytics", period: "today" }).squad.asks;
      expect(words).toContain("Agents stopped to ask you 1 time; 1 unanswered");
      expect(words).not.toContain("under a minute");
      expect(JSON.stringify(asks())).not.toContain(question.title);
      await run.engine.shutdown();
      restarted = new Engine(join(run.root, "data"), { usageCommands: { codex: null } });
      expect(restarted.usage({ view: "analytics", period: "today" }).squad.asks).toBe(words);
    } finally {
      await run.engine.shutdown();
      await restarted?.shutdown();
    }
  });

  for (const afterFirstRound of [false, true]) it(`credits replacement designers ${afterFirstRound ? "after a completed planned round" : "from the first round"}`, async () => {
    const limited = [{ model: "opus", role: "architect", type: "seven_day_opus" }, { model: "gpt-6.1-sol", role: "design reviewer" }];
    const run = await start(afterFirstRound ? {} : { limited }, {
      description: "[disagree]",
      before: (engine) => { engine.s.profiles = engine.s.profiles.filter((profile) => !["fable-xhigh", "astra-xhigh"].includes(profile.id)); },
    });
    let switched = false;
    const unsubscribe = run.engine.subscribe(() => {
      if (afterFirstRound && !switched && run.engine.tracking.log.moments({ taskId: run.taskId, kinds: ["design-round"] }).length > 0) {
        switched = true;
        run.fakes.scenario({ limited });
      }
    });
    try {
      const task = await waitFor(() => {
        run.answer();
        if (run.find().state === "failed") throw new Error(run.find().error);
        return run.engine.getState().inbox.some((item) => item.taskId === run.taskId && item.kind === "disagreement") && run.find();
      }, "the replacement agents' design rounds", 60_000);
      const rounds = run.engine.tracking.log.moments({ taskId: task.id, kinds: ["design-round"] });
      expect(rounds).toHaveLength(2);
      expect(rounds[0]).toMatchObject({ profileId: afterFirstRound ? "opus-xhigh" : "sonnet-high", peerProfileId: afterFirstRound ? "sol-xhigh" : "grok-xhigh", count: 2, blocking: 1 });
      expect(rounds[1]).toMatchObject({ profileId: "sonnet-high", peerProfileId: "grok-xhigh", count: 2, blocking: 1 });
      expect(task.objections.filter((objection) => objection.round === 2).every((objection) => objection.raisedBy === "grok-xhigh")).toBe(true);
      const details = run.engine.usage({ view: "analytics", period: "today" }).squad.details;
      const replacementRounds = afterFirstRound ? 1 : 2;
      expect(details.architects.find((row) => row.label.includes("Sonnet 5.5"))).toMatchObject({ rounds: replacementRounds, designs: 1, sentBack: 1 });
      expect(details.designReviewers.find((row) => row.label.startsWith("Grok · "))).toMatchObject({ rounds: replacementRounds, blocking: replacementRounds });
      expect(details.architects.filter((row) => !row.label.includes("Sonnet 5.5")).every((row) => row.rounds === (afterFirstRound ? 1 : 0) && row.designs === 0)).toBe(true);
    } finally {
      unsubscribe();
      run.engine.cancel(run.taskId);
      await run.engine.shutdown();
    }
  });

  it("keeps a confirming reviewer's blocking findings and pass or fail verdict", async () => {
    const run = await start({ planner: "claude-build", builder: "plain", reviewer: "confirm" }, { before: (engine) => engine.setPoolPaused(true) });
    try {
      run.engine.s.tasks.find((task) => task.id === run.taskId)!.findings.push({ id: "existing-important", text: "The greeting is missing on the welcome page.", severity: "blocking", raisedBy: "opus-high", confirmedBy: [], status: "open" });
      run.engine.setPoolPaused(false);
      await run.done();
      const verdicts = run.engine.tracking.log.moments({ taskId: run.taskId, kinds: ["verdict"] });
      expect(verdicts).toHaveLength(2);
      expect(verdicts[0]).toMatchObject({ profileId: "sol-high", verdict: "fail", count: 1, blocking: 1 });
      expect(verdicts[1]).toMatchObject({ profileId: "sol-high", verdict: "pass", count: 0, blocking: 0 });
      const reviewer = run.engine.usage({ view: "analytics", period: "today" }).squad.details.reviewers[0]!;
      expect(reviewer).toMatchObject({ rounds: 2, sentBack: 1, blocking: 1 });
    } finally {
      await run.engine.shutdown();
    }
  });
});
