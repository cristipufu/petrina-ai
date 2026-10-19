import { executionFor } from "../src/repository-context.js";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { readTaskImage } from "../src/image-preview.js";
import { makeWorld, removeDir } from "./support.js";
import { dispatch } from "../src/server.js";

const folders: string[] = [];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
async function folder() { const path = await mkdtemp(join(tmpdir(), "petrina-image-preview-")); folders.push(path); return path; }
afterEach(async () => { await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("screenshots read directly from a task's working copy", () => {
  it("previews absolute screenshots from this task's reviewer snapshot without widening relative links", async () => {
    const world = makeWorld("reviewer-image-roots");
    const engine = world.start();
    try {
      engine.setPoolPaused(true);
      const productId = await engine.addProduct(world.clone);
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
      await expect(engine.previewImage(id, "review.png")).rejects.toThrow("no longer available");
      const other = join(world.data, "worktrees", productId, "other-task.copies", "review-0", "review.png");
      await mkdir(join(other, ".."), { recursive: true });
      await writeFile(other, png);
      await expect(engine.previewImage(id, other)).rejects.toThrow("Only screenshots in this task");
      const outside = join(world.dir, "outside.png");
      await writeFile(outside, png);
      await symlink(outside, join(copy, "escape.png"));
      await expect(engine.previewImage(id, join(copy, "escape.png"))).rejects.toThrow("Only screenshots in this task");
      await symlink(world.clone, join(copy, "outside-folder"), "dir");
      await writeFile(join(world.clone, "outside.png"), png);
      await expect(engine.previewImage(id, join(copy, "outside-folder", "outside.png"))).rejects.toThrow("Only screenshots in this task");
      await rm(copy, { recursive: true });
      await expect(engine.previewImage(id, image)).rejects.toThrow("no longer available");
      for (const state of ["done", "cancelled"] as const) {
        task.state = state;
        await expect(engine.previewImage(id, image)).rejects.toThrow("while the task's working copy exists");
      }
    } finally { await engine.shutdown(); removeDir(world.dir); }
  });

  it("reads a shared task's named product copy rather than whichever product is active", async () => {
    const world = makeWorld("shared-images");
    const engine = world.start();
    try {
      engine.setPoolPaused(true);
      const productId = await engine.addProduct(world.clone);
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
      await expect(engine.previewImage(id, "checked.png", productId)).rejects.toThrow("no longer available");
      await expect(engine.previewImage(id, relative(first, join(second, "checked.png")), productId)).rejects.toThrow("Only screenshots in this task");
      await expect(engine.previewImage(id, "checked.png", "outside")).rejects.toThrow("outside the task");
      await expect(engine.previewImage(id, join(second, "checked.png"), "outside")).rejects.toThrow("outside the task");
      const copy = join(world.data, "worktrees", "api", `${id}.copies`, "review-0");
      await mkdir(copy, { recursive: true });
      await writeFile(join(copy, "checked.png"), png);
      expect(await engine.previewImage(id, join(copy, "checked.png"), "api")).toEqual({ mime: "image/png", data: png.toString("base64") });
      const unrelated = join(world.data, "worktrees", "outside", `${id}.copies`, "review-0");
      await mkdir(unrelated, { recursive: true });
      await writeFile(join(unrelated, "checked.png"), png);
      await expect(engine.previewImage(id, join(unrelated, "checked.png"))).rejects.toThrow("Only screenshots in this task");
      const removed = await folder();
      await writeFile(join(removed, "checked.png"), png);
      task.repositories.push({ productId: "removed", delivery: "local", completedStages: [], worktree: removed, removed: true });
      await expect(engine.previewImage(id, join(removed, "checked.png"))).rejects.toThrow("Only screenshots in this task");
      await expect(engine.previewImage(id, "checked.png", "removed")).rejects.toThrow("outside the task");
      await writeFile(join(first, "checked.png"), png);
      delete task.repositories[1]!.worktree;
      await expect(engine.previewImage(id, "checked.png", "api")).rejects.toThrow("no working copy");
    } finally { await engine.shutdown(); removeDir(world.dir); }
  });

  it("keeps explicit product roots after switching the active repository and refuses missing or removed owners", async () => {
    const world = makeWorld("switched-image-roots");
    const engine = world.start();
    try {
      engine.setPoolPaused(true);
      const productId = await engine.addProduct(world.clone);
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
      await expect(engine.previewImage(id, "checked.png", productId)).rejects.toThrow("no working copy");
      task.repositories[0]!.worktree = first;
      task.repositories[0]!.removed = true;
      await expect(engine.previewImage(id, "checked.png", productId)).rejects.toThrow("outside the task");
      // Even the currently projected owner must use its own saved root when explicitly named.
      delete task.repositories[1]!.worktree;
      await expect(engine.previewImage(id, "checked.png", "api")).rejects.toThrow("no working copy");
      task.repositories[1]!.worktree = second;
      task.repositories[1]!.removed = true;
      await expect(engine.previewImage(id, "checked.png", "api")).rejects.toThrow("outside the task");
    } finally { await engine.shutdown(); removeDir(world.dir); }
  });

  it("reads absolute and relative image links without creating a retained copy", async () => {
    const worktree = await folder();
    await mkdir(join(worktree, "screenshots"));
    const image = join(worktree, "screenshots", "Light theme.png");
    await writeFile(image, png);
    expect(await readTaskImage(worktree, image)).toEqual({ mime: "image/png", data: png.toString("base64") });
    expect(await readTaskImage(worktree, "screenshots/Light theme.png")).toEqual({ mime: "image/png", data: png.toString("base64") });
    expect(await readTaskImage(worktree, `file://${image.replaceAll(" ", "%20")}`)).toEqual({ mime: "image/png", data: png.toString("base64") });
    await rm(worktree, { recursive: true });
    await expect(readTaskImage(worktree, image)).rejects.toThrow("no longer available");
  });

  it("rejects parent paths and symlinks leading out of this task", async () => {
    const base = await folder();
    const worktree = join(base, "task");
    await mkdir(worktree);
    const outside = join(base, "outside.png");
    await writeFile(outside, png);
    await symlink(outside, join(worktree, "linked.png"));
    for (const image of [outside, "../outside.png", "linked.png"]) await expect(readTaskImage(worktree, image)).rejects.toThrow("Only screenshots in this task");
  });

  it("checks image bytes and rejects code disguised as an image", async () => {
    const worktree = await folder();
    for (const contents of ["<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>", "not an image", "\u00ff\u00d8"] ) {
      await writeFile(join(worktree, "image.png"), contents);
      await expect(readTaskImage(worktree, "image.png")).rejects.toThrow("cannot be previewed");
    }
    await expect(readTaskImage(worktree, "https://example.com/image.png")).rejects.toThrow("Only screenshots");
    await expect(readTaskImage(undefined, "image.png")).rejects.toThrow("no working copy");
  });

  it("bounds file bytes and decoded image dimensions", async () => {
    const worktree = await folder();
    await writeFile(join(worktree, "big.png"), Buffer.alloc(8 * 1024 * 1024 + 1));
    await expect(readTaskImage(worktree, "big.png")).rejects.toThrow("too large");
    const huge = Buffer.from(png);
    huge.writeUInt32BE(100_000, 16);
    huge.writeUInt32BE(100_000, 20);
    await writeFile(join(worktree, "huge.png"), huge);
    await expect(readTaskImage(worktree, "huge.png")).rejects.toThrow("dimensions are too large");
  });
});
