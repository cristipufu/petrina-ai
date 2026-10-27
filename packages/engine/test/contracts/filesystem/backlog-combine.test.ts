import { engineCaseFixtures } from "../../fixtures/engine-cases.js";

import { afterAll, expect, it } from "bun:test";
import { join } from "node:path";
import { queueOf } from "@petrina/core";
import { dispatch } from "../../../src/server.js";
const cases = engineCaseFixtures();
afterAll(() => cases.close());


it("saves a combination and its pictures before retiring the sources, and returns it after restart", async () => {
  return cases.use("petrina-backlog-", async owner => {
  const root = owner.root;
  const { mkdirSync, writeFileSync, readdirSync } = await import("node:fs");
  const data = join(root, "combine-data");
  const options = { usageCommands: { codex: null, grok: null },  agentCommand: () => undefined };
  let engine = owner.open(data, options);
  engine.setPoolPaused(true);
  try {
    const productId = "product"; engine.s.products.push({ id: productId, name: "Product", repo: "local/product", tone: "blue" });
    const first = engine.addTask({ productId, title: "First fix", description: "Keep this request.", approveDelivery: true, backlog: true });
    const second = engine.addTask({ productId, title: "Second fix", description: "And this request.", approveDelivery: false, backlog: true });
    const imageId = crypto.randomUUID();
    mkdirSync(join(data, "captures", first), { recursive: true });
    writeFileSync(join(data, "captures", first, `${imageId}.png`), "picture bytes");
    engine.task(first)!.session.push({ id: "picture", from: "system", at: 1, text: "Evidence", images: [{ id: imageId, caption: "Original symptom" }] });
    const id = await dispatch(engine, { name: "combineBacklog", args: [[first, second], "Two small fixes", "combine-request"] }) as string;
    const combined = engine.task(id)!;
    expect(combined.state).toBe("queued");
    expect(combined.approveDelivery).toBe(true);
    expect(combined.description).toContain("Keep this request.");
    expect(combined.description).toContain("And this request.");
    const picture = combined.session.flatMap((line) => line.images ?? [])[0]!;
    expect(await (await engine.reportImage(id, picture.id))!.text()).toBe("picture bytes");
    expect(engine.task(first)).toMatchObject({ state: "cancelled", combinedInto: id });
    expect(engine.task(second)).toMatchObject({ state: "cancelled", combinedInto: id });
    await owner.stop(engine);
    engine = owner.open(data, options);
    engine.setPoolPaused(true);
    expect(await engine.combineBacklog([first, second], "Two small fixes", "combine-request")).toBe(id);
    expect(queueOf(engine.activeState().tasks).map((task) => task.id)).toEqual([id]);
    expect(engine.task(first)!.combinedInto).toBe(id);
    engine.cancel(id);
    await engine["cleanup"].sweep();
    expect(await engine.reportImage(id, picture.id)).toBeUndefined();
    expect(readdirSync(join(data, "captures")).includes(id)).toBe(false);
  } finally { await owner.stop(engine); }

  });
});
