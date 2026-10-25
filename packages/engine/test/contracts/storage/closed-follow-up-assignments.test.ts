import { afterAll, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Coordination } from "../../../src/coordination.js";
import { createFollowUpFixtures, cards, failedAssignment } from "../../fixtures/follow-up-native.js";

const { open, reopen, close, shutdown } = createFollowUpFixtures();
afterAll(close);

it("finishes an archived assignment only after its original pictures are gone, leaving the finished target unchanged", async () => {
  const world = await open();
  let release = () => {};
  try {
    const saved = await failedAssignment(world, "no-choice");
    release = saved.release;
    const { source, automaticId, manualId } = saved;
    world.engine.task(automaticId)!.state = "done";
    release();
    world.engine.save();
    const before = structuredClone(world.engine.task(automaticId));
    const c = new Coordination(world.engine);
    const args = { taskId: source.id, findingId: "old", targetTaskId: automaticId, requestId: "closed-assignment" };
    const pictured = await c.call("task.track-finding", args);
    expect(pictured.outcome).toBe("invalid");
    expect(pictured.message).toContain("pictures");
    expect((await c.call("task.track-finding", { ...args, targetTaskId: manualId, requestId: "closed-different" })).outcome).toBe("invalid");
    await world.engine["cleanup"].removeCaptures(source.id);
    expect(existsSync(join(world.data, "captures", source.id))).toBe(false);
    expect((await c.call("task.track-finding", { ...args, requestId: "closed-no-pictures" })).outcome).toBe("completed");
    expect(world.engine.task(automaticId)).toEqual(before);
    expect(world.engine.task(source.id)!.findings[0]!.tracking).toEqual({ taskId: automaticId });
    await reopen(world);
    expect(world.engine.task(automaticId)).toEqual(before);
    expect(world.engine.task(manualId)!.followUp).toBeUndefined();
    expect(cards(world.engine)).toHaveLength(0);
  } finally { release(); await shutdown(world.engine); }
});
