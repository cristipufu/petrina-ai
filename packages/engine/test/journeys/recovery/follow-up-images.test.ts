import { afterAll, expect, it, spyOn } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Coordination } from "../../../src/coordination.js";
import { createFollowUpFixtures, older, taskOf, finish, cards, plant, failedAssignment } from "../../fixtures/follow-up-native.js";
const { open, reopen, close, use } = createFollowUpFixtures();
afterAll(close);
it("retries a queued manual fix's picture across source retirement and restart, adding only the missing copy and one credit", async () => {
  return use(async caseOwner => {
  const world = await open(caseOwner);
  try {
    const { engine } = world;
    const fixId = engine.addTask({ productId: world.shop, kind: "bug", title: "bug-retry: The coordinator's fix", description: "The unchanged request", backlog: true });
    engine.queueTask(fixId);
    const source = taskOf(engine, world.shop, "A pictured sighting", [older("old", "bug-retry: A later sighting")]);
    plant(engine, source.id, source.findings[0]!.text);
    const original = join(engine.dataDir, "captures", source.id, "pic.png");
    const copy = spyOn(world.files, "copyFile");
    caseOwner.onStop(() => copy.mockRestore());
    copy.mockRejectedValue(new Error("Copy refused"));
    try {
      await finish(caseOwner, engine, source);
      expect(source.findings[0]!.tracking).toEqual({ reason: "pictures", retry: true });
      expect(engine.task(fixId)!.followUp!.reports.map(report => report.findingId)).toEqual(["old"]);
      engine.save();
      expect(engine.s.tasks.some(task => task.id === source.id)).toBe(false);
      await engine["cleanup"].removeCaptures(source.id);
      expect(existsSync(original)).toBe(true);
    } finally { copy.mockRestore(); }
    await reopen(world);
    const fix = world.engine.task(fixId)!;
    expect([fix.state, fix.description]).toEqual(["queued", "The unchanged request"]);
    expect(world.engine.task(source.id)!.findings[0]!.tracking).toEqual({ taskId: fixId });
    expect(fix.followUp!.reports).toHaveLength(1);
    await world.engine["followUps"].catchUp();
    expect(fix.session.flatMap(line => line.images ?? []).map(image => image.from)).toEqual([{ taskId: source.id, imageId: "pic" }]);
    await world.engine["cleanup"].removeCaptures(source.id);
    expect(existsSync(original)).toBe(false);
    expect(cards(world.engine).map(task => task.id)).toEqual([fixId]);
    expect(world.prompts).toHaveLength(1);
  } finally { await caseOwner.stop(world.engine); }
  });
});
for (const reason of ["unavailable", "no-choice"] as const) it(`keeps the ${reason} picture retry through source retirement and restart`, async () => {
  return use(async caseOwner => {
  const world = await open(caseOwner);
  let release = () => {};
  try {
    const saved = await failedAssignment(world, reason);
    release = saved.release;
    const { source, automaticId, manualId, key } = saved;
    release();
    world.engine.save();
    expect(world.engine.s.tasks.some(task => task.id === source.id)).toBe(false);
    const copy = spyOn(world.files, "copyFile");
    caseOwner.onStop(() => copy.mockRestore());
    copy.mockRejectedValue(new Error("Copy still refused"));
    try {
      await world.engine["cleanup"].removeCaptures(source.id);
      expect(existsSync(join(world.data, "captures", source.id, "pic.png"))).toBe(true);
      await reopen(world);
      await world.engine["followUps"].catchUp();
      expect(world.engine.task(source.id)!.findings[0]!.tracking).toEqual({ reason: "pictures", retry: true });
      expect(world.engine.s.followUpPending).toEqual([{ keys: [key], cardId: automaticId }]);
    } finally { copy.mockRestore(); }
    const checks = world.prompts.length;
    const c = new Coordination(world.engine);
    const args = { taskId: source.id, findingId: "old", targetTaskId: automaticId, requestId: `retired-${reason}` };
    const different = await c.call("task.track-finding", { ...args, targetTaskId: manualId, requestId: `retired-different-${reason}` });
    expect(different.outcome).toBe("invalid");
    const result = await c.call("task.track-finding", args);
    expect(result.outcome).toBe("completed");
    expect(await c.call("task.track-finding", args)).toEqual(result);
    expect(world.prompts).toHaveLength(checks);
    expect(world.engine.s.followUpPending).toEqual([]);
    expect(world.engine.task(source.id)!.findings[0]!.tracking).toEqual({ taskId: automaticId });
    expect(world.engine.task(manualId)!.followUp).toBeUndefined();
    await world.engine["cleanup"].removeCaptures(source.id);
    expect(existsSync(join(world.data, "captures", source.id))).toBe(false);
    await reopen(world);
    expect(world.engine.task(automaticId)!.followUp!.reports).toHaveLength(1);
    expect(world.engine.task(automaticId)!.session.flatMap(line => line.images ?? [])).toHaveLength(1);
    expect(readdirSync(join(world.data, "captures", automaticId))).toHaveLength(1);
  } finally { release(); await caseOwner.stop(world.engine); }
  });
});
