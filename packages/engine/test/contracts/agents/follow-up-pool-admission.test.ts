import { afterAll, expect, it } from "bun:test";
import { join } from "node:path";
import { Fakes } from "../../fixtures.js";
import { createFollowUpFixtures, older, taskOf, finish, cards } from "../../fixtures/follow-up-native.js";
const { open, reopen, close, use } = createFollowUpFixtures();
afterAll(close);
it("leaves matching retryable when all model slots are occupied", async () => {
  return use(async caseOwner => {
  const world = await open(caseOwner);
  try {
    await reopen(world, false);
    const engine = world.engine;
    const source = taskOf(engine, world.shop, "Matching at capacity", [
      older("one", "bug-capacity: The old page is broken."),
      older("two", "bug-capacity: The same old page is broken.", { raisedBy: "sol-high" }),
    ]);
    engine.s.pool.limit = 1;
    engine.s.backgroundAgents = [{ id: "other", roleId: "verifier", profileId: "sol-high", label: "Already comparing", since: Date.now() }];
    engine.setPoolPaused(false);
    await finish(caseOwner, engine, source);
    expect(cards(engine)).toHaveLength(0);
    expect(source.findings[0]!.tracking).toEqual({ reason: "unavailable", retry: true });
    expect(new Fakes(join(world.root, "agents")).prompts()).toEqual([]);
    engine.s.backgroundAgents = [];
    await engine["followUps"].catchUp();
    expect(engine.s.backgroundAgents).toEqual([]);
  } finally { await caseOwner.stop(world.engine); }
  });
});
