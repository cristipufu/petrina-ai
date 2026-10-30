import { afterAll, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createFollowUpFixtures, STAGE, older, groupByBug, taskOf, finish, cardFor, plant } from "../../fixtures/follow-up-native.js";
const { open, close, use } = createFollowUpFixtures();
afterAll(close);
it("takes back the product, the picture and the request when a later review says this change caused it", async () => {
  return use(async caseOwner => {
  const world = await open(caseOwner, groupByBug, true);
  const { engine } = world;
  try {
    const shopText = "bug-cause: The footer opens a retired page.";
    const notesText = "bug-cause: Notes shows the same retired page.";
    const shop = taskOf(engine, world.shop, "Shop footer", [older("shop", shopText, { productIds: [world.shop] })]);
    const notes = taskOf(engine, world.notes, "Notes footer", [older("notes", notesText, {
      productIds: [world.shop, world.notes],
      judgments: [{ by: "opus-high", severity: "pre-existing", at: 1 }, { by: "sol-high", severity: "pre-existing", at: 2 }],
    })]);
    plant(engine, shop.id, shopText);
    plant(engine, notes.id, notesText);
    notes.plan = { stages: [STAGE], rationale: "Review it", plannerProfileId: "opus-high" };
    notes.state = "running";
    notes.hunt = { stageId: STAGE.id, round: 1, reported: { "0": true, "1": true }, findings: 0 };
    await finish(caseOwner, engine, shop);
    const card = cardFor(engine, "cause")[0]!;
    expect(card.followUp!.reports.map((report) => report.findingId).sort()).toEqual(["notes", "shop"]);
    expect(card.selectedProducts?.map((choice) => choice.productId).sort()).toEqual([world.notes, world.shop].sort());
    expect(card.approvePlan).toBe(true);
    expect(card.description).toContain(notesText);
    expect(card.description).toContain(shopText);
    const copied = card.session.flatMap((line) => line.images ?? []);
    expect(copied.map((image) => image.from?.taskId).sort()).toEqual([notes.id, shop.id].sort());
    notes.findings[0]!.severity = "blocking";
    await engine["followUps"].catchUp();
    expect(card.followUp!.reports.map((report) => report.findingId)).toEqual(["shop"]);
    expect(card.selectedProducts?.map((choice) => choice.productId)).toEqual([world.shop]);
    expect(card.approvePlan).toBe(false);
    expect(card.description).toContain(shopText);
    expect(card.description).not.toContain(notesText);
    expect(card.followUp!.alsoReported).toBeUndefined();
    const kept = card.session.flatMap((line) => line.images ?? []);
    expect(kept.map((image) => image.from?.taskId)).toEqual([shop.id]);
    expect(existsSync(join(engine.dataDir, "captures", card.id, `${kept[0]!.id}.png`))).toBe(true);
    expect(copied.filter((image) => image.from?.taskId === notes.id).every((image) => !existsSync(join(engine.dataDir, "captures", card.id, `${image.id}.png`)))).toBe(true);
    expect(engine.task(notes.id)!.findings[0]!.tracking).toBeUndefined();
    expect(engine.task(shop.id)!.findings[0]!.tracking).toEqual({ taskId: card.id });
    notes.state = "done";
    notes.column = "done";
    notes.finishedAt = Date.now();
    await engine["cleanup"].removeCaptures(notes.id);
    expect(existsSync(join(engine.dataDir, "captures", notes.id))).toBe(false);
    expect(existsSync(join(engine.dataDir, "captures", card.id, `${kept[0]!.id}.png`))).toBe(true);
  } finally { await caseOwner.stop(engine); }
  });
});
