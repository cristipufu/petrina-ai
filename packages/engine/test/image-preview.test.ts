import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readTaskImage } from "../src/image-preview.js";

const folders: string[] = [];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
async function folder() { const path = await mkdtemp(join(tmpdir(), "petrina-image-preview-")); folders.push(path); return path; }
afterEach(async () => { await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("screenshots read directly from a task's working copy", () => {
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
