import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { afterAll, expect, it } from "bun:test";
import { plannerCheckpoint } from "../../fixtures/planner-checkpoint.js";
import { itemOf, taskOf, until, waitFor } from "../../support.js";
const cases = engineCaseFixtures();
afterAll(() => cases.close());


it("still presents a finished plan checkpoint while the pool is paused", async () => {
  return cases.use("planner-checkpoint-", owner => plannerCheckpoint(owner, async f => {
  try {
    const planner = await waitFor(() => f.agents.received("planner")[0], "the planner to start");
    f.engine.task(f.taskId)!.approvePlan = true;
    f.engine.setPoolPaused(true);
    f.agents.release(planner.session);
    const state = await until(f.engine, (state) => !!itemOf(state, f.taskId, "plan"));
    expect(taskOf(state, f.taskId).holdsSlot).toBe(false);
    expect(f.agents.received("builder")).toHaveLength(0);
    expect(f.runs()).toEqual([]);
  } finally { await owner.stop(f.engine); }

  }));
});
