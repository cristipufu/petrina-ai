import { expect, it } from "vitest";
import { slotUses } from "@petrina/core";
import { scheduledDeliveryScenario } from "../../fixtures/delivery-scenarios.js";

for (const mode of ["local", "pull-request"] as const) {
  it(`publishes an approved ${mode} delivery while every agent slot is full`, async () => {
    const f = scheduledDeliveryScenario(mode);
    try {
      await f.startBusy();
      expect(slotUses(f.scheduler.snapshot()).map(use => use.taskId)).toEqual([f.busy.id]);
      expect(f.task.state).toBe("needs-you"); expect(f.published).toEqual([]);
      f.approve(); await f.drive();
      expect(f.task.error).toBeUndefined(); expect(f.task.holdsSlot).toBe(false); expect(f.task.agent).toBeUndefined();
      expect(f.published.map(row => row.task)).toEqual([f.task.id]);
      expect(slotUses(f.scheduler.snapshot()).map(use => use.taskId)).toEqual([f.busy.id]);
      expect(f.busy.agent?.roleId).toBe("builder");
      expect(f.scheduler.agents.received().map(prompt => prompt.roleId)).toEqual(["builder"]);
    } finally { await f.close(); }
  });

  it(`holds an approved ${mode} delivery while the pool is paused, then publishes with its agent slot still full`, async () => {
    const f = scheduledDeliveryScenario(mode);
    try {
      await f.startBusy(); f.scheduler.workflow.setPoolPaused(true); f.approve(); await f.drive();
      expect(f.task.state).toBe("waiting"); expect(f.task.statusLine).toBe("Waiting for the pool to resume");
      expect(f.task.holdsSlot).toBe(false); expect(f.scope.work.shipping).toBeUndefined(); expect(f.published).toEqual([]);
      // Task pause is saved data; the actual scheduler must continue respecting it after pool resume.
      f.task.state = "paused"; f.scheduler.workflow.setPoolPaused(false); f.scheduler.workflow.schedule();
      expect(f.task.state).toBe("paused"); expect(f.published).toEqual([]);
      await f.drive();
      expect(f.task.error).toBeUndefined(); expect(f.published.map(row => row.task)).toEqual([f.task.id]);
      expect(slotUses(f.scheduler.snapshot()).map(use => use.taskId)).toEqual([f.busy.id]);
      expect(f.scheduler.agents.received().map(prompt => prompt.roleId)).toEqual(["builder"]);
    } finally { await f.close(); }
  });
}

it("retries publishing a release with its notes already written while every agent slot is full", async () => {
  const f = scheduledDeliveryScenario("release");
  try {
    await f.startBusy(); f.approve(); f.prepareObservation(f.scope);
    f.scope.work.shipping!.prepared!.notes = "The already written release notes";
    const prepared = structuredClone(f.scope.work.shipping!.prepared);
    await f.drive();
    expect(f.task.holdsSlot).toBe(false); expect(f.task.agent).toBeUndefined();
    expect(f.published.map(row => row.task)).toEqual([f.task.id]);
    expect(f.scope.work.shipping!.prepared).toEqual(prepared);
    expect(f.scheduler.agents.received().map(prompt => prompt.roleId)).toEqual(["builder"]);
    expect(slotUses(f.scheduler.snapshot()).map(use => use.taskId)).toEqual([f.busy.id]);
  } finally { await f.close(); }
});
