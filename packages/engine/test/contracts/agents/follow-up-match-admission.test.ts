import { afterAll, expect, it } from "bun:test";
import { join } from "node:path";
import { Fakes } from "../../fixtures.js";
import { createFollowUpFixtures, older, taskOf, finish, cards } from "../../fixtures/follow-up-native.js";

const { open, reopen, close, shutdown } = createFollowUpFixtures();
afterAll(close);

it("does not start an identity agent while scheduling is paused", async () => {
  const world = await open();
  try {
    const source = taskOf(world.engine, world.shop, "A paused follow-up", [
      older("paused", "bug-paused: An older page is broken."),
      older("peer", "bug-paused: The same older page cannot open.", { raisedBy: "sol-high" }),
    ]);
    world.engine.commitNow();
    await reopen(world, false);
    await finish(world.engine, world.engine.task(source.id)!);
    const fakes = new Fakes(join(world.root, "agents"));
    expect(fakes.received().filter((entry) => entry.text.includes("Which older reports are the same bug?"))).toHaveLength(0);
    expect(cards(world.engine)).toHaveLength(0);
    expect(world.engine.task(source.id)!.findings[0]!.tracking).toEqual({ reason: "unavailable", retry: true });
  } finally { await shutdown(world.engine); }
});
