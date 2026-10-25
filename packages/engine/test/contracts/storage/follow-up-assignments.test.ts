import { afterAll, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Coordination } from "../../../src/coordination.js";
import { createFollowUpFixtures, cards, failedAssignment } from "../../fixtures/follow-up-native.js";

const { open, reopen, close, shutdown } = createFollowUpFixtures();
afterAll(close);

for (const reason of ["unavailable", "no-choice"] as const) it(`keeps an archived assignment after a failed ${reason} copy`, async () => {
  const world = await open();
  let release = () => {};
  try {
    const { engine } = world;
    const saved = await failedAssignment(world, reason);
    release = saved.release;
    const { source, automaticId, manualId } = saved;
    engine.task(automaticId)!.state = "cancelled";
    engine.save();
    expect(engine.s.tasks.some(task => task.id === automaticId)).toBe(false);
    const args = { taskId: source.id, findingId: "old", targetTaskId: manualId, requestId: `archived-${reason}` };
    const c = new Coordination(engine);
    const result = await c.call("task.track-finding", args);
    expect(result.outcome).toBe("invalid");
    expect(result.message).toContain("another task");
    const same = await c.call("task.track-finding", { ...args, targetTaskId: automaticId, requestId: `cancelled-${reason}` });
    expect(same.outcome).toBe("invalid");
    expect(same.message).toContain("cancelled");
    await engine["followUps"].catchUp();
    expect(engine.task(manualId)!.followUp).toBeUndefined();
    expect(cards(engine)).toHaveLength(0);
    release();
    engine.save();
    await reopen(world);
    await world.engine["followUps"].catchUp();
    expect(world.engine.task(automaticId)!.followUp!.reports.map(report => report.findingId)).toEqual(["old"]);
    expect(cards(world.engine)).toHaveLength(0);
    expect(await new Coordination(world.engine).call("task.track-finding", args)).toEqual(result);
    const retry = await new Coordination(world.engine).call("task.track-finding", { ...args, requestId: `archived-retry-${reason}` });
    expect(retry.outcome).toBe("invalid");
  } finally { release(); await shutdown(world.engine); }
});

it("finishes a stranded History report on its existing card after restart, even without original pictures", async () => {
  const world = await open();
  let release = () => {};
  try {
    const saved = await failedAssignment(world, "no-choice");
    release = saved.release;
    const { source, automaticId, manualId } = saved;
    // A saved record from before unfinished assignments were kept for recovery.
    source.findings[0]!.tracking = { reason: "no-choice" };
    world.engine.s.followUpPending = [];
    release();
    world.engine.save();
    await world.engine["cleanup"].removeCaptures(source.id);
    expect(existsSync(join(world.data, "captures", source.id))).toBe(false);
    await reopen(world);
    await world.engine["followUps"].catchUp();
    expect(world.engine.s.tasks.some(task => task.id === source.id)).toBe(false);
    expect(world.engine.task(source.id)!.findings[0]!.tracking).toEqual({ reason: "no-choice" });
    const checks = world.prompts.length;
    const c = new Coordination(world.engine);
    const different = await c.call("task.track-finding", { taskId: source.id, findingId: "old", targetTaskId: manualId, requestId: "stranded-different" });
    expect(different.outcome).toBe("invalid");
    const args = { taskId: source.id, findingId: "old", targetTaskId: automaticId, requestId: "stranded-same" };
    expect((await c.call("task.track-finding", args)).outcome).toBe("completed");
    expect((await c.call("task.track-finding", args)).outcome).toBe("completed");
    expect(world.engine.task(source.id)!.findings[0]!.tracking).toEqual({ taskId: automaticId });
    expect(world.engine.task(automaticId)!.followUp!.reports).toHaveLength(1);
    expect(world.engine.task(manualId)!.followUp).toBeUndefined();
    expect(world.prompts).toHaveLength(checks);
  } finally { release(); await shutdown(world.engine); }
});
