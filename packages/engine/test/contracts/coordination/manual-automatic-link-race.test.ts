import { afterAll, expect, it } from "bun:test";
import { Coordination } from "../../../src/coordination.js";
import { createFollowUpFixtures, older, groupByBug, taskOf, finish, plant } from "../../fixtures/follow-up-native.js";

const { open, close, shutdown } = createFollowUpFixtures();
afterAll(close);

it("waits for automatic linking before a manual link, so a report cannot be credited twice", async () => {
  let release!: () => void;
  let matching!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { matching = resolve; });
  const world = await open(async prompt => { matching(); await held; return groupByBug(prompt); });
  try {
    const { engine } = world;
    const automaticId = engine.addTask({ productId: world.shop, kind: "bug", title: "bug-race: Existing bug", backlog: true });
    const manualId = engine.addTask({ productId: world.shop, kind: "bug", title: "Different manual request", backlog: true });
    const source = taskOf(engine, world.shop, "Skipped choice", [older("old", "bug-race: A new sighting", { cardsShown: [automaticId] })]);
    plant(engine, source.id, source.findings[0]!.text);
    const finishing = finish(engine, source);
    await started;
    let replied = false;
    const linking = new Coordination(engine).call("task.track-finding", { taskId: source.id, findingId: "old", targetTaskId: manualId, requestId: "racing-link" }).then(result => { replied = true; return result; });
    await Promise.resolve();
    expect(replied).toBe(false);
    release();
    await finishing;
    const result = await linking;
    expect(result.outcome).toBe("invalid");
    expect(result.message).toContain("another task");
    expect(engine.task(source.id)!.findings[0]!.tracking).toEqual({ taskId: automaticId });
    expect(engine.task(automaticId)!.followUp!.reports).toHaveLength(1);
    expect(engine.task(automaticId)!.session.flatMap(line => line.images ?? [])).toHaveLength(1);
    expect(engine.task(manualId)!.followUp).toBeUndefined();
    await engine["followUps"].catchUp();
    expect(engine.task(manualId)!.followUp).toBeUndefined();
  } finally { release(); await shutdown(world.engine); }
});
