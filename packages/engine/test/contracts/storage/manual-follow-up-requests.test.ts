import { afterAll, expect, it } from "bun:test";
import { followUpKey } from "@petrina/core";
import { createFollowUpFixtures, older, groupByBug, taskOf, finish } from "../../fixtures/follow-up-native.js";

const { open, reopen, close, shutdown } = createFollowUpFixtures();
afterAll(close);

it("reuses a coordinator's Backlog bug with current wording, preserving its request, products and links through restart", async () => {
  const world = await open(groupByBug, true);
  try {
    const engine = world.engine;
    const id = engine.addTask({ productId: world.shop, kind: "bug", title: "bug-manual: Fix the remaining variant", description: "Current request, edited by the coordinator.", backlog: true });
    const manual = engine.task(id)!;
    const unrelated = engine.addTask({ productId: world.notes, kind: "bug", title: "bug-manual: Separate product", description: "Another scope", backlog: true });
    const feature = engine.addTask({ productId: world.shop, title: "bug-manual: A feature", description: "Do not turn features into bug follow-ups", backlog: true });
    const source = taskOf(engine, world.shop, "Report the remaining issue", [older("remaining", "bug-manual: A confirmed current defect")]);
    await finish(engine, source);
    expect(source.findings[0]!.tracking).toEqual({ taskId: id });
    expect(manual.followUp?.preserveRequest).toBe(true);
    expect(manual.description).toBe("Current request, edited by the coordinator.");
    expect(manual.followUp?.reports).toHaveLength(1);
    expect(manual.state).toBe("backlog");
    expect(engine.task(unrelated)!.followUp).toBeUndefined();
    expect(engine.task(feature)!.followUp).toBeUndefined();
    expect(world.prompts[0]).toContain("Current request, edited by the coordinator.");
    await reopen(world);
    expect(world.engine.task(id)!.followUp?.reports).toHaveLength(1);
    // A withdrawn source credit cannot rewrite a coordinator-created request or its products.
    const loaded = world.engine.task(source.id)!;
    loaded.findings[0]!.status = "fixed";
    world.engine.saveArchivedTask(loaded);
    world.engine.s.followUpPending = [{ keys: [followUpKey(source.id, "remaining")], cardId: id }];
    await world.engine["followUps"].catchUp();
    expect(world.engine.task(id)!.description).toBe("Current request, edited by the coordinator.");
    expect(world.engine.task(id)!.productId).toBe(world.shop);
    expect(world.engine.task(id)!.followUp?.reports).toHaveLength(0);
  } finally { await shutdown(world.engine); }
});
