import { afterAll, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createFollowUpFixtures, older, keysOf, groupByBug, taskOf, finish, cards, cardFor, plant } from "../../fixtures/follow-up-native.js";

const { open, close, shutdown } = createFollowUpFixtures();
afterAll(close);

it("leaves a report untracked when the match cannot be settled, then links one card when it can", async () => {
  let mode: "unsure" | "down" | "same" = "unsure";
  const world = await open((prompt) => {
    if (mode === "down") return "unavailable";
    if (mode === "unsure") return { groups: [], uncertain: keysOf(prompt) };
    return groupByBug(prompt);
  });
  const { engine } = world;
  try {
    const one = taskOf(engine, world.shop, "Date", [older("one", "bug-lost: The date is wrong.")]);
    const two = taskOf(engine, world.shop, "Year", [older("two", "bug-lost: The year is wrong.")]);
    await finish(engine, one);
    await finish(engine, two);
    expect(cards(engine)).toHaveLength(0);
    expect(one.findings[0]!.tracking).toEqual({ reason: "unmatched" });
    expect(two.findings[0]!.tracking).toEqual({ reason: "unmatched" });
    mode = "same";
    await engine["followUps"].catchUp();
    expect(cards(engine)).toHaveLength(0);
    expect(one.findings[0]!.tracking).toEqual({ reason: "unmatched" });

    mode = "down";
    const pictured = "bug-held: The footer opens a retired page.";
    const held = taskOf(engine, world.shop, "Held", [older("held", pictured)]);
    const heldToo = taskOf(engine, world.shop, "Held too", [older("held-too", "bug-held: About in the footer is retired.")]);
    plant(engine, held.id, pictured);
    await finish(engine, held);
    await finish(engine, heldToo);
    expect(cards(engine)).toHaveLength(0);
    expect(held.findings[0]!.tracking).toEqual({ reason: "unavailable", retry: true });
    await engine["cleanup"].removeCaptures(held.id);
    expect(existsSync(join(engine.dataDir, "captures", held.id))).toBe(false);
    mode = "same";
    await engine["followUps"].catchUp();
    const card = cardFor(engine, "held");
    expect(card).toHaveLength(1);
    expect(card[0]!.followUp!.reports).toHaveLength(2);
    expect(card[0]!.session.some((line) => line.images?.length)).toBe(false);
    expect(existsSync(join(engine.dataDir, "captures", card[0]!.id))).toBe(false);
    await engine["followUps"].catchUp();
    expect(cardFor(engine, "held")).toHaveLength(1);
  } finally { await shutdown(engine); }
});
