import { executionFor } from "@petrina/orchestrator";
import { afterAll, describe, expect, it } from "bun:test";


import type { State, Task } from "@petrina/core";
import type { Engine } from "../../engine.js";
import { checkWorkflowFixtures } from "../../fixtures/check-workflow.js";
import { coordinator, itemOf, taskOf, until, waitFor } from "../../support.js";

const workflows = checkWorkflowFixtures();
afterAll(() => workflows.close());
const fixture = workflows.use;

const lines = (task: Task) => task.timeline.map((entry) => entry.text);
const sentBack = (task: Task) => lines(task).filter((line) => line.startsWith("Sent back to the builder: the checks failed")).length;
const reviewStage = (task: Task) => task.plan!.stages.findIndex((stage) => stage.kind === "review-chain");



describe.concurrent("automatic check repairs belong to one failure episode", () => {
it("keeps the episode count across a restart, the blocker and its position after one, and the cleared count after a pass", async () => {
    await fixture("workflow", async f => {
      const release = f.agents.release;
      const releaseAll = (engine: Engine, state: State) => {
        coordinator(["plan"])(engine, state);
        for (const prompt of f.agents.received()) release(prompt.session);
      };
      try {
        // Hold the first automatic repair while it works, then restart in the middle of the episode.
        await waitFor(() => {
          coordinator(["plan"])(f.engine, f.engine.getState());
          const builders = f.agents.received("builder");
          for (const prompt of f.agents.received()) if (prompt.role !== "builder" || prompt.session === builders[0]?.session) release(prompt.session);
          return builders.length >= 2;
        }, "the first automatic repair to start");
        expect(executionFor(f.engine.task(f.taskId)!).work.checkReturns).toBe(1);
        await f.restart();
        expect(executionFor(f.engine.task(f.taskId)!).work.checkReturns).toBe(1);
        let state = await until(f.engine, (state) => !!itemOf(state, f.taskId, "delivery"), releaseAll);
        let task = taskOf(state, f.taskId);
        // One more automatic turn after the restart, never a fresh pair.
        expect(task.checkReturns).toBe(2);
        expect(sentBack(task)).toBe(2);
        expect(f.runs()).toEqual(["failed"]);
        const item = itemOf(state, f.taskId, "delivery")!;

        await f.restart();
        state = f.engine.getState();
        task = taskOf(state, f.taskId);
        expect(itemOf(state, f.taskId, "delivery")).toEqual(item);
        expect(task.stageIndex).toBe(reviewStage(task));
        expect(task.state).toBe("needs-you");
        expect(task.statusLine).toBe("Checks still fail. Your call");
        expect(task.checkReturns).toBe(2);

        // The coordinator's turn is not a fresh allowance: a still-failing run returns straight to the blocker.
        const builders = f.agents.openings("builder").length;
        f.engine.requestChanges(item.id, "Try once more");
        state = await until(f.engine, (state) => !!itemOf(state, f.taskId, "delivery"), releaseAll);
        task = taskOf(state, f.taskId);
        expect(f.agents.openings("builder").length).toBe(builders + 1);
        expect(task.checkReturns).toBe(2);
        expect(sentBack(task)).toBe(2);
        expect(f.agents.openings("code reviewer")).toHaveLength(0);

        f.agents.scenario({ planner: "short", builder: "plain", controlled: true, fixes: "change" });
        f.engine.requestChanges(itemOf(state, f.taskId, "delivery")!.id, "Make the actual fix");
        state = await until(f.engine, (state) => itemOf(state, f.taskId, "delivery")?.title.startsWith("Ready to ship") ?? false, releaseAll);
        expect(f.runs()).toEqual(["failed", "passed"]);
        expect(taskOf(state, f.taskId).checkReturns).toBeUndefined();
        await f.restart();
        expect(taskOf(f.engine.getState(), f.taskId).checkReturns).toBeUndefined();
      } finally { await f.engine.shutdown(); }
    }, true, { planner: "short", builder: "plain", controlled: true });
  });
});
