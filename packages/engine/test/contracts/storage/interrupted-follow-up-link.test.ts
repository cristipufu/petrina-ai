import { afterAll, expect, it } from "bun:test";
import { followUpKey } from "@petrina/core";
import { createFollowUpFixtures, older, groupByBug, taskOf, finish, cardFor } from "../../fixtures/follow-up-native.js";

const { open, reopen, close, shutdown } = createFollowUpFixtures();
afterAll(close);

it("keeps a matching retry until the link is saved, including when saving the link is interrupted", async () => {
  let mode: "down" | "same" = "same";
  const world = await open((prompt) => mode === "down" ? "unavailable" : groupByBug(prompt));
  const { engine } = world;
  try {
    const known = taskOf(engine, world.shop, "Known card", [older("known", "bug-retry: The footer opens a retired page.")]);
    await finish(engine, known);
    const card = cardFor(engine, "retry")[0]!;
    mode = "down";
    const held = taskOf(engine, world.shop, "Held report", [older("held", "bug-retry: About in the footer is the old page.")]);
    await finish(engine, held);
    expect(held.findings[0]!.tracking).toEqual({ reason: "unavailable", retry: true });
    expect(engine.s.followUpPending?.some((group) => group.retry && group.keys.includes(followUpKey(held.id, "held")))).toBe(true);
    mode = "same";
    let interrupt = false;
    const stop = engine.subscribe(() => {
      if (!interrupt) return;
      interrupt = false;
      throw new Error("interrupted after the follow-up was saved");
    });
    interrupt = true;
    await engine["followUps"].catchUp();
    stop();
    expect(engine.task(held.id)!.findings[0]!.tracking).toEqual({ reason: "unavailable", retry: true });
    expect(card.followUp!.reports.map((report) => report.findingId)).toEqual(["known"]);
    await reopen(world);
    const restored = cardFor(world.engine, "retry");
    expect(restored).toHaveLength(1);
    expect(restored[0]!.id).toBe(card.id);
    expect(restored[0]!.followUp!.reports.map((report) => report.findingId).sort()).toEqual(["held", "known"]);
    expect(world.engine.task(held.id)!.findings[0]!.tracking).toEqual({ taskId: card.id });
    await reopen(world);
    expect(cardFor(world.engine, "retry")).toHaveLength(1);
    expect(world.engine.task(held.id)!.findings[0]!.tracking).toEqual({ taskId: card.id });
  } finally { await shutdown(world.engine); }
});
