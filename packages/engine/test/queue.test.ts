import { afterAll, expect, it } from "bun:test";
import { join } from "node:path";
import { queueOf } from "@petrina/core";
import { Engine } from "./engine.js";
import { dispatch } from "../src/server.js";
import { makeProduct, removeDir, tempDir } from "./fixtures.js";

const dir = tempDir("petrina-keyboard-queue-");
const engine = new Engine(join(dir, "data"));
afterAll(() => { engine.shutdown(); removeDir(dir); });

it("places filtered cards beside their neighbours and applies quick keyboard requests to the latest real queue", async () => {
  engine.setPoolPaused(true);
  const productId = await engine.addProduct(makeProduct(dir));
  const make = (title: string) => engine.addTask({ productId, title, kind: "chore" });
  const a1 = make("A1"), b1 = make("B1"), a2 = make("A2");
  const ids = () => queueOf(engine.getState().tasks).map((task) => task.id);
  expect(await dispatch(engine, { name: "moveVisibleInQueue", args: [a2, [a1, a2], -1] })).toBe(1);
  expect(ids()).toEqual([a2, a1, b1]);
  await dispatch(engine, { name: "placeInQueue", args: [a2, a1, "after"] });
  expect(ids()).toEqual([a1, a2, b1]);
  const b2 = make("B2"), a3 = make("A3"), a4 = make("A4");
  engine.setHeld(a1, true);
  engine.setAfter(a4, [b2]);
  const visible = [a1, a2, a3, a4];
  await Promise.all([1, 2, 3].map(() => dispatch(engine, { name: "moveVisibleInQueue", args: [a4, visible, -1] })));
  expect(ids()).toEqual([a4, a1, a2, b1, b2, a3]);
  expect(queueOf(engine.getState().tasks).map((task) => task.priority)).toEqual([0, 1, 2, 3, 4, 5]);
  expect(engine.task(a4)!.after).toEqual([b2]);
});
