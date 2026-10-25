import { afterAll, expect, it } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createFollowUpFixtures, older, taskOf, finish, cardFor, plant } from "../../fixtures/follow-up-native.js";

const { open, reopen, close, shutdown } = createFollowUpFixtures();
afterAll(close);

it("keeps a refused picture on the original task until a later pass copies it", async () => {
  const world = await open();
  const { engine } = world;
  try {
    const text = "bug-copy: The footer opens a retired page.";
    const source = taskOf(engine, world.shop, "Copied later", [older("copy", text)]);
    plant(engine, source.id, text);
    const allowCopy = world.faults.blockCopy(join(engine.dataDir, "captures", source.id, "pic.png"));
    await finish(engine, source);
    const card = cardFor(engine, "copy")[0]!;
    expect(source.findings[0]!.tracking).toEqual({ reason: "pictures", retry: true });
    expect(card.session.some((line) => line.images?.length)).toBe(false);
    expect(existsSync(join(engine.dataDir, "captures", source.id, "pic.png"))).toBe(true);
    await engine["cleanup"].removeCaptures(source.id);
    expect(existsSync(join(engine.dataDir, "captures", source.id, "pic.png"))).toBe(true);
    allowCopy();
    await engine["followUps"].catchUp();
    const image = card.session.flatMap((line) => line.images ?? [])[0]!;
    expect(image.from).toEqual({ taskId: source.id, imageId: "pic" });
    expect(readdirSync(join(engine.dataDir, "captures", card.id))).toHaveLength(1);
    expect(engine.task(source.id)!.findings[0]!.tracking).toEqual({ taskId: card.id });
    await engine["cleanup"].removeCaptures(source.id);
    expect(existsSync(join(engine.dataDir, "captures", source.id))).toBe(false);
    expect(existsSync(join(engine.dataDir, "captures", card.id, `${image.id}.png`))).toBe(true);
    await reopen(world);
    const again = world.engine.task(card.id)!;
    const kept = again.session.flatMap((line) => line.images ?? [])[0]!;
    expect(existsSync(join(world.engine.dataDir, "captures", card.id, `${kept.id}.png`))).toBe(true);
    expect(existsSync(join(world.engine.dataDir, "captures", source.id))).toBe(false);
    expect(world.engine.task(source.id)!.findings[0]!.tracking).toEqual({ taskId: card.id });
  } finally { await shutdown(world.engine); }
});

it("keeps a picture that could not be copied until a later try, including after a restart", async () => {
  const world = await open();
  const { engine } = world;
  try {
    const blockedText = "bug-held: The footer opens a retired page.";
    const clearText = "bug-clear: The header opens a retired page.";
    const blocked = taskOf(engine, world.shop, "Held picture", [older("held", blockedText)]);
    const clear = taskOf(engine, world.shop, "Clear picture", [older("clear", clearText)]);
    plant(engine, blocked.id, blockedText);
    plant(engine, clear.id, clearText);
    const allowCopy = world.faults.blockCopy(join(engine.dataDir, "captures", blocked.id, "pic.png"));
    await finish(engine, blocked);
    await finish(engine, clear);
    expect(blocked.findings[0]!.tracking).toEqual({ reason: "pictures", retry: true });
    expect(clear.findings[0]!.tracking && "taskId" in clear.findings[0]!.tracking).toBe(true);
    await reopen(world);
    await world.engine["cleanup"].removeCaptures(blocked.id);
    await world.engine["cleanup"].removeCaptures(clear.id);
    expect(existsSync(join(world.engine.dataDir, "captures", blocked.id, "pic.png"))).toBe(true);
    expect(world.engine.task(blocked.id)!.findings[0]!.tracking).toEqual({ reason: "pictures", retry: true });
    expect(cardFor(world.engine, "held")[0]!.session.some((line) => line.images?.length)).toBe(false);
    const clearCard = cardFor(world.engine, "clear")[0]!;
    const clearImage = clearCard.session.flatMap((line) => line.images ?? [])[0]!;
    expect(existsSync(join(world.engine.dataDir, "captures", clearCard.id, `${clearImage.id}.png`))).toBe(true);
    allowCopy();
    await world.engine["followUps"].catchUp();
    const heldCard = cardFor(world.engine, "held")[0]!;
    const image = heldCard.session.flatMap((line) => line.images ?? [])[0]!;
    expect(image.from).toEqual({ taskId: blocked.id, imageId: "pic" });
    expect(readdirSync(join(world.engine.dataDir, "captures", heldCard.id))).toHaveLength(1);
    expect(world.engine.task(blocked.id)!.findings[0]!.tracking).toEqual({ taskId: heldCard.id });
    await world.engine["cleanup"].removeCaptures(blocked.id);
    expect(existsSync(join(world.engine.dataDir, "captures", blocked.id))).toBe(false);
    expect(existsSync(join(world.engine.dataDir, "captures", heldCard.id, `${image.id}.png`))).toBe(true);
  } finally { await shutdown(world.engine); }
});
