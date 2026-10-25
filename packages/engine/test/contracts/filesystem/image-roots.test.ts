import { fixtureFiles } from "@petrina/test-support/fixture-files";
import { expectRejection } from "@petrina/test-support/rejections";
import { executionFor } from "@petrina/orchestrator";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";


import { Engine } from "../../engine.js";
import { removeDir, tempDir } from "../../fixtures.js";
import { dispatch } from "../../../src/server.js";

const folders: string[] = [];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
async function folder() { const path = tempDir("petrina-image-preview-"); folders.push(path); return path; }
afterEach(async () => { await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function previewRecords(name: string) {
 const dir = tempDir(name), data = join(dir, "data"), productId = "product";
 return { dir, data, productId, start: () => { const engine = new Engine(data, { admissionsClosed: true });
   engine.s.products.push({ id: productId, name: "Product", repo: "local/product", path: dir, tone: "blue" }); return engine; } };
}
describe("screenshots read directly from a task's working copy", () => {
it("previews absolute screenshots from this task's reviewer snapshot without widening relative links", async () => {
    const world = previewRecords("reviewer-image-roots");
    const engine = world.start();
    try {
      engine.setPoolPaused(true);
      const productId = world.productId;
      const id = engine.addTask({ productId, title: "Reviewer screenshots", backlog: true });
      const task = engine.task(id)!;
      executionFor(task).work.worktree = join(world.data, "worktrees", productId, id);
      const copy = join(world.data, "worktrees", productId, `${id}.copies`, "review-0");
      await mkdir(copy, { recursive: true });
      await mkdir(executionFor(task).work.worktree!, { recursive: true });
      await writeFile(join(executionFor(task).work.worktree!, "local.png"), png);
      expect(await engine.previewImage(id, "local.png", productId)).toEqual({ mime: "image/png", data: png.toString("base64") });
      const image = join(copy, "review.png");
      await writeFile(image, png);
      expect(await engine.previewImage(id, image)).toEqual({ mime: "image/png", data: png.toString("base64") });
      expect(await engine.previewImage(id, pathToFileURL(image).href)).toEqual({ mime: "image/png", data: png.toString("base64") });
      await expectRejection(engine.previewImage(id, "review.png"), "no longer available");
      const other = join(world.data, "worktrees", productId, "other-task.copies", "review-0", "review.png");
      await mkdir(join(other, ".."), { recursive: true });
      await writeFile(other, png);
      await expectRejection(engine.previewImage(id, other), "Only screenshots in this task");
      const outside = join(world.dir, "outside.png");
      await writeFile(outside, png);
      fixtureFiles.fileLink(outside, join(copy, "escape.png"));
      await expectRejection(engine.previewImage(id, join(copy, "escape.png")), "Only screenshots in this task");
      fixtureFiles.directoryLink(world.dir, join(copy, "outside-folder"));
      await writeFile(join(world.dir, "outside.png"), png);
      await expectRejection(engine.previewImage(id, join(copy, "outside-folder", "outside.png")), "Only screenshots in this task");
      await rm(copy, { recursive: true });
      await expectRejection(engine.previewImage(id, image), "no longer available");
      for (const state of ["done", "cancelled"] as const) {
        task.state = state;
        await expectRejection(engine.previewImage(id, image), "while the task's working copy exists");
      }
    } finally { await engine.shutdown(); removeDir(world.dir); }
  });

it("reads a shared task's named product copy rather than whichever product is active", async () => {
    const world = previewRecords("shared-images");
    const engine = world.start();
    try {
      engine.setPoolPaused(true);
      const productId = world.productId;
      const id = engine.addTask({ productId, title: "Shared screenshots", backlog: true });
      const first = await folder(), second = await folder();
      await writeFile(join(second, "checked.png"), png);
      const task = engine.task(id)!;
      executionFor(task).work.worktree = first;
      task.activeProductId = productId;
      task.repositories = [{ productId, delivery: "local", completedStages: [], worktree: first }, { productId: "api", delivery: "local", completedStages: [], worktree: second }];
      expect(await dispatch(engine, { name: "previewImage", args: [id, "checked.png", "api"] })).toEqual({ mime: "image/png", data: png.toString("base64") });
      expect(await engine.previewImage(id, join(second, "checked.png"))).toEqual({ mime: "image/png", data: png.toString("base64") });
      expect(await engine.previewImage(id, join(second, "checked.png"), productId)).toEqual({ mime: "image/png", data: png.toString("base64") });
      await expectRejection(engine.previewImage(id, "checked.png", productId), "no longer available");
      await expectRejection(engine.previewImage(id, relative(first, join(second, "checked.png")), productId), "Only screenshots in this task");
      await expectRejection(engine.previewImage(id, "checked.png", "outside"), "outside the task");
      await expectRejection(engine.previewImage(id, join(second, "checked.png"), "outside"), "outside the task");
      const copy = join(world.data, "worktrees", "api", `${id}.copies`, "review-0");
      await mkdir(copy, { recursive: true });
      await writeFile(join(copy, "checked.png"), png);
      expect(await engine.previewImage(id, join(copy, "checked.png"), "api")).toEqual({ mime: "image/png", data: png.toString("base64") });
      const unrelated = join(world.data, "worktrees", "outside", `${id}.copies`, "review-0");
      await mkdir(unrelated, { recursive: true });
      await writeFile(join(unrelated, "checked.png"), png);
      await expectRejection(engine.previewImage(id, join(unrelated, "checked.png")), "Only screenshots in this task");
      const removed = await folder();
      await writeFile(join(removed, "checked.png"), png);
      task.repositories.push({ productId: "removed", delivery: "local", completedStages: [], worktree: removed, removed: true });
      await expectRejection(engine.previewImage(id, join(removed, "checked.png")), "Only screenshots in this task");
      await expectRejection(engine.previewImage(id, "checked.png", "removed"), "outside the task");
      await writeFile(join(first, "checked.png"), png);
      delete task.repositories[1]!.worktree;
      await expectRejection(engine.previewImage(id, "checked.png", "api"), "no working copy");
    } finally { await engine.shutdown(); removeDir(world.dir); }
  });

it("keeps explicit product roots after switching the active repository and refuses missing or removed owners", async () => {
    const world = previewRecords("switched-image-roots");
    const engine = world.start();
    try {
      engine.setPoolPaused(true);
      const productId = world.productId;
      const id = engine.addTask({ productId, title: "Images from both products", backlog: true });
      const first = await folder(), second = await folder();
      const otherPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64");
      await writeFile(join(first, "checked.png"), png);
      await writeFile(join(second, "checked.png"), otherPng);
      const task = engine.task(id)!;
      executionFor(task).work.worktree = first;
      task.activeProductId = productId;
      task.repositories = [{ productId, delivery: "local", completedStages: [], worktree: first }, { productId: "api", delivery: "local", completedStages: [], worktree: second }];
      task.activeProductId = "api";
      expect(engine.taskDetails(id)!.worktree).toBe(second);
      expect(await engine.previewImage(id, "checked.png", productId)).toEqual({ mime: "image/png", data: png.toString("base64") });
      expect(await engine.previewImage(id, "checked.png", "api")).toEqual({ mime: "image/png", data: otherPng.toString("base64") });
      expect(await engine.previewImage(id, "checked.png")).toEqual({ mime: "image/png", data: otherPng.toString("base64") });
      delete task.repositories[0]!.worktree;
      await expectRejection(engine.previewImage(id, "checked.png", productId), "no working copy");
      task.repositories[0]!.worktree = first;
      task.repositories[0]!.removed = true;
      await expectRejection(engine.previewImage(id, "checked.png", productId), "outside the task");
      // Even the currently projected owner must use its own saved root when explicitly named.
      delete task.repositories[1]!.worktree;
      await expectRejection(engine.previewImage(id, "checked.png", "api"), "no working copy");
      task.repositories[1]!.worktree = second;
      task.repositories[1]!.removed = true;
      await expectRejection(engine.previewImage(id, "checked.png", "api"), "outside the task");
    } finally { await engine.shutdown(); removeDir(world.dir); }
  });
});
