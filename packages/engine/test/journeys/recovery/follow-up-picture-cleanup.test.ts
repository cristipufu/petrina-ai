import { afterAll, expect, it } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { waitFor } from "../../fixtures.js";
import { createFollowUpFixtures, older, taskOf, finish, cardFor, plant } from "../../fixtures/follow-up-native.js";

const { open, reopen, close, shutdown } = createFollowUpFixtures();
afterAll(close);

it("keeps a report's picture on the unfinished follow-up, then removes it when that follow-up is finished or cancelled", async () => {
  const world = await open();
  const { engine } = world;
  try {
    const text = "bug-photo: The footer opens a retired page.";
    const source = taskOf(engine, world.shop, "Pictured", [older("photo", text)]);
    plant(engine, source.id, text);
    const nit = taskOf(engine, world.shop, "Nit picture", [older("nit", "bug-nit: A small footer note.", { severity: "suggestion" })]);
    plant(engine, nit.id, "bug-nit: A small footer note.");
    await finish(engine, source);
    await finish(engine, nit);
    const card = cardFor(engine, "photo")[0]!;
    const image = card.session.flatMap((line) => line.images ?? [])[0]!;
    expect(image.caption).toBe("The retired page");
    expect(image.from).toEqual({ taskId: source.id, imageId: "pic" });
    const copy = join(engine.dataDir, "captures", card.id, `${image.id}.png`);
    expect(existsSync(copy)).toBe(true);
    expect(readdirSync(join(engine.dataDir, "captures", card.id))).toHaveLength(1);
    await engine["followUps"].catchUp();
    expect(readdirSync(join(engine.dataDir, "captures", card.id))).toHaveLength(1);
    await engine["cleanup"].removeCaptures(source.id);
    await engine["cleanup"].removeCaptures(nit.id);
    expect(existsSync(join(engine.dataDir, "captures", source.id))).toBe(false);
    expect(existsSync(copy)).toBe(true);
    expect(cardFor(engine, "nit")).toHaveLength(0);

    await reopen(world);
    const again = world.engine.task(card.id)!;
    const kept = again.session.flatMap((line) => line.images ?? [])[0]!;
    const keptFile = join(world.engine.dataDir, "captures", card.id, `${kept.id}.png`);
    await waitFor(() => existsSync(keptFile) && !existsSync(join(world.engine.dataDir, "captures", source.id)), "the follow-up picture to outlive the original task");
    again.state = "done";
    await world.engine["cleanup"].removeCaptures(card.id);
    expect(existsSync(keptFile)).toBe(false);

    const cancelledText = "bug-drop: The footer opens a retired page.";
    const dropped = taskOf(world.engine, world.shop, "Dropped picture", [older("drop", cancelledText)]);
    plant(world.engine, dropped.id, cancelledText);
    await finish(world.engine, dropped);
    const dropCard = cardFor(world.engine, "drop")[0]!;
    expect(existsSync(join(world.engine.dataDir, "captures", dropCard.id))).toBe(true);
    world.engine.cancel(dropCard.id);
    await waitFor(() => !existsSync(join(world.engine.dataDir, "captures", dropCard.id)), "the cancelled follow-up picture to be removed");
  } finally { await shutdown(world.engine); }
});
