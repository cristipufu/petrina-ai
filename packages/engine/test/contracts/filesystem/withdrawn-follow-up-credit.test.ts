import { afterAll, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createFollowUpFixtures, failedAssignment } from "../../fixtures/follow-up-native.js";

const { open, close, shutdown } = createFollowUpFixtures();
afterAll(close);

it("withdraws a picture retry when its report is fixed instead of retaining an unfinished credit", async () => {
  const world = await open();
  let release = () => {};
  try {
    const saved = await failedAssignment(world, "no-choice");
    release = saved.release;
    saved.source.findings[0]!.status = "fixed";
    await world.engine["followUps"].catchUp();
    expect(world.engine.s.followUpPending).toEqual([]);
    expect(world.engine.task(saved.automaticId)!.followUp!.reports).toEqual([]);
    expect(world.engine.task(saved.source.id)!.findings[0]!.tracking).toBeUndefined();
    release();
    await world.engine["cleanup"].removeCaptures(saved.source.id);
    expect(existsSync(join(world.data, "captures", saved.source.id))).toBe(false);
  } finally { release(); await shutdown(world.engine); }
});
