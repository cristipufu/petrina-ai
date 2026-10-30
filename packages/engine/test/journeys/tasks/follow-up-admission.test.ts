import { afterAll, expect, it } from "bun:test";
import { waitFor } from "../../fixtures.js";
import { createFollowUpFixtures, older, groupByBug, taskOf, finish, cards } from "../../fixtures/follow-up-native.js";
const { open, close, use } = createFollowUpFixtures();
afterAll(close);
it("stays in the backlog until the coordinator queues it, then starts", async () => {
  return use(async caseOwner => {
  const world = await open(caseOwner, groupByBug, false, true);
  const { engine } = world;
  try {
    const task = taskOf(engine, world.shop, "Ready footer", [older("ready", "bug-ready: The footer opens a retired page.")]);
    await finish(caseOwner, engine, task);
    const card = cards(engine)[0]!;
    engine.setPoolPaused(false);
    engine.schedule();
    expect(card.state).toBe("backlog");
    expect(card.startedAt).toBeUndefined();
    expect(engine.drivers.size).toBe(0);
    engine.queueTask(card.id);
    await waitFor(() => engine.task(card.id)!.startedAt !== undefined, "the queued follow-up to start");
    expect(cards(engine)).toHaveLength(1);
  } finally { await caseOwner.stop(engine); }
  });
});
