import { afterAll, expect, it } from "bun:test";
import { join } from "node:path";
import { queueOf } from "@petrina/core";
import { Engine } from "./engine.js";
import { dispatch } from "../src/server.js";
import { Fakes, makeProduct, removeDir, tempDir, waitFor } from "./fixtures.js";

const root = tempDir("petrina-backlog-");
afterAll(() => removeDir(root));

it("keeps reviewed requests out of agent work through a restart and queues them exactly once", async () => {
  const data = join(root, "data");
  const fakes = new Fakes(join(root, "agents"));
  const options = { agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir] };
  let engine = new Engine(data, options);
  try {
    const productId = await engine.addProduct(makeProduct(root));
    const id = engine.addTask({ productId, title: "Draft request", description: "Check scope", backlog: true });
    engine.setPoolPaused(false);
    engine.schedule();
    expect(engine.task(id)!.state).toBe("backlog");
    expect(engine.task(id)!.startedAt).toBeUndefined();
    expect(engine.drivers.size).toBe(0);
    await engine.shutdown();
    engine = new Engine(data, options);
    expect(engine.task(id)!.state).toBe("backlog");
    expect(engine.task(id)!.startedAt).toBeUndefined();
    await dispatch(engine, { name: "updateBacklog", args: [id, { title: "Reviewed request", description: "Clear requirements" }] });
    engine.setPoolPaused(true);
    await dispatch(engine, { name: "queueTask", args: [id] });
    await dispatch(engine, { name: "queueTask", args: [id] });
    expect(queueOf(engine.activeState().tasks).map((task) => task.id)).toEqual([id]);
    engine.moveToBacklog(id);
    expect(engine.task(id)!.state).toBe("backlog");
    engine.queueTask(id);
    engine.setPoolPaused(false);
    await waitFor(() => engine.task(id)!.startedAt !== undefined, "the explicitly queued task to start");
    expect(engine.task(id)!.title).toBe("Reviewed request");
    engine.moveToBacklog(id);
    expect(engine.task(id)!.state).not.toBe("backlog");
    expect(() => engine.updateBacklog(id, { title: "Too late", description: "" })).toThrow("Only backlog requests");
  } finally { await engine.shutdown(); }
});

it("saves a combination and its pictures before retiring the sources, and returns it after restart", async () => {
  const { mkdirSync, writeFileSync, readdirSync } = await import("node:fs");
  const data = join(root, "combine-data");
  const options = { usageCommands: { codex: null, grok: null },  agentCommand: () => undefined };
  let engine = new Engine(data, options);
  engine.setPoolPaused(true);
  try {
    const productId = await engine.addProduct(makeProduct(join(root, "combine-product")));
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
    await engine.shutdown();
    engine = new Engine(data, options);
    engine.setPoolPaused(true);
    expect(await engine.combineBacklog([first, second], "Two small fixes", "combine-request")).toBe(id);
    expect(queueOf(engine.activeState().tasks).map((task) => task.id)).toEqual([id]);
    expect(engine.task(first)!.combinedInto).toBe(id);
    engine.cancel(id);
    await engine["cleanup"].sweep();
    expect(await engine.reportImage(id, picture.id)).toBeUndefined();
    expect(readdirSync(join(data, "captures")).includes(id)).toBe(false);
  } finally { await engine.shutdown(); }
});
