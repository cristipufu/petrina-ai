import { afterAll, expect, it, spyOn } from "bun:test";
import { createFollowUpFixtures, older, groupByBug, taskOf, finish, cards, plant } from "../../fixtures/follow-up-native.js";

const { open, close, shutdown } = createFollowUpFixtures();
afterAll(close);

it("finishes a credited report's picture copy on a manual fix whose products changed, adding no product or card", async () => {
  const world = await open(groupByBug, true);
  const { engine } = world;
  try {
    const fixId = engine.addTask({ productId: world.shop, kind: "bug", title: "bug-moved: The coordinator's fix", backlog: true });
    engine.queueTask(fixId);
    const fix = engine.task(fixId)!;
    const source = taskOf(engine, world.shop, "A pictured sighting", [older("old", "bug-moved: A later sighting")]);
    plant(engine, source.id, source.findings[0]!.text);
    const copy = spyOn(world.files, "copyFile").mockRejectedValue(new Error("Copy refused"));
    try { await finish(engine, source); } finally { copy.mockRestore(); }
    expect(fix.followUp!.reports.map(report => report.findingId)).toEqual(["old"]);
    fix.selectedProducts = [{ productId: world.notes, startFrom: { kind: "default" }, delivery: "pull-request" }];
    const products = structuredClone(fix.selectedProducts);
    await engine["followUps"].catchUp();
    expect(engine.task(source.id)!.findings[0]!.tracking).toEqual({ taskId: fixId });
    expect(fix.session.flatMap(line => line.images ?? []).map(image => image.from)).toEqual([{ taskId: source.id, imageId: "pic" }]);
    expect([fix.selectedProducts, fix.followUp!.alsoReported, fix.followUp!.reports.length, cards(engine).length]).toEqual([products, undefined, 1, 1]);
    expect(world.prompts).toHaveLength(1);
  } finally { await shutdown(world.engine); }
});
