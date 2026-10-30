import { afterAll, expect, it, spyOn } from "bun:test";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFollowUpFixtures, older, taskOf, finish, cardFor, plant } from "../../fixtures/follow-up-native.js";
const { open, close, use } = createFollowUpFixtures();
afterAll(close);
it("retries a partial picture copy without attaching successful images again", async () => {
  return use(async caseOwner => {
  const world = await open(caseOwner);
  const { engine } = world;
  try {
  const source = taskOf(engine, world.shop, "Two pictures", [older("partial", "bug-partial: The footer opens a retired page.")]);
  plant(engine, source.id, source.findings[0]!.text);
  source.journey![0]!.agentResults![0]!.images!.push({ id: "second", caption: "The other view" });
  writeFileSync(join(engine.dataDir, "captures", source.id, "second.png"), "png");
  const original = world.files.copyFile;
  let fail = true;
  const copy = spyOn(world.files, "copyFile");
    caseOwner.onStop(() => copy.mockRestore());
    copy.mockImplementation(async (from, to) => {
    if (String(from).endsWith("second.png") && fail) throw new Error("Copy unavailable");
    return original(from, to);
  });
  try {
    await finish(caseOwner, engine, source);
    const card = cardFor(engine, "partial")[0]!;
    expect(card.session.flatMap(line => line.images ?? [])).toHaveLength(1);
    expect(source.findings[0]!.tracking).toEqual({ reason: "pictures", retry: true });
    fail = false;
    await engine["followUps"].catchUp();
    const images = card.session.flatMap(line => line.images ?? []);
    expect(images).toHaveLength(2);
    expect(new Set(images.map(image => image.from!.imageId))).toEqual(new Set(["pic", "second"]));
    expect(readdirSync(join(engine.dataDir, "captures", card.id))).toHaveLength(2);
    expect(engine.task(source.id)!.findings[0]!.tracking).toEqual({ taskId: card.id });
    await engine["followUps"].catchUp();
    expect(card.session.flatMap(line => line.images ?? [])).toHaveLength(2);
  } finally { copy.mockRestore(); }
  } finally { await caseOwner.stop(engine); }
  });
});
