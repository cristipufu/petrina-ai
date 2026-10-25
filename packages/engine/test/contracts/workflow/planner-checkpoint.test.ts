import { afterAll, expect, it } from "bun:test";
import { plannerCheckpoint } from "../../fixtures/planner-checkpoint.js";
import { itemOf, removeDir, taskOf, tempDir, until, waitFor } from "../../support.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

it("still presents a finished plan checkpoint while the pool is paused", async () => {
  const root = tempDir("planner-checkpoint-"); roots.push(root);
  const f = await plannerCheckpoint(root);
  try {
    const planner = await waitFor(() => f.agents.received("planner")[0], "the planner to start");
    f.engine.task(f.taskId)!.approvePlan = true;
    f.engine.setPoolPaused(true);
    f.agents.release(planner.session);
    const state = await until(f.engine, (state) => !!itemOf(state, f.taskId, "plan"));
    expect(taskOf(state, f.taskId).holdsSlot).toBe(false);
    expect(f.agents.received("builder")).toHaveLength(0);
    expect(f.runs()).toEqual([]);
  } finally { await f.engine.shutdown(); }
});
