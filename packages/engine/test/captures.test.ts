import { fixtureFiles } from "./fixture-files.js";
import { expectRejection } from "./rejections.js";
import { afterAll, expect, it, spyOn } from "bun:test";
import * as files from "node:fs/promises";
import { createRequire } from "node:module";
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { capturePath, guardCaptureWrites, preserveCaptures } from "../src/captures.js";
import { restartPrompt, formatWhereYouWere } from "../src/prompts.js";
import { BuildResult, TestResult, ObjectionsResult, ReviewResult, NotesResult } from "../src/roles.js";
import { removeDir, tempDir } from "./fixtures.js";

const root = tempDir("petrina-captures-");
afterAll(() => removeDir(root));
const captures = join(root, "temporary");
const storage = join(root, "history");
mkdirSync(captures);
const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: "white" } }).png().toBuffer();
writeFileSync(join(captures, "chosen.png"), png);

it("resolves named output inside captures and refuses traversal, outside absolute paths and escaping links before writing", async () => {
  expect(await capturePath(captures, "nested/page.png")).toBe(join(captures, "nested/page.png"));
  const outside = join(root, "product");
  mkdirSync(outside);
  fixtureFiles.directoryLink(outside, join(captures, "linked"));
  for (const name of ["../product/escape.png", join(outside, "escape.png"), "linked/escape.png"]) {
    await expectRejection(capturePath(captures, name));
  }
  expect(readdirSync(outside)).toEqual([]);
  writeFileSync(join(outside, "linked.png"), png);
  linkSync(join(outside, "linked.png"), join(captures, "hardlink.png"));
  await expectRejection(capturePath(captures, "hardlink.png"), "linked file");
  expect(readFileSync(join(outside, "linked.png"))).toEqual(png);
});

it("refuses automatic writes through a shortcut or shared file before they can change a product file", async () => {
  const folder = join(root, "guarded-captures");
  const product = join(root, "guarded-product");
  mkdirSync(folder); mkdirSync(product);
  const victim = join(product, "existing.png");
  const bytes = Buffer.from("download");
  writeFileSync(victim, png);
  writeFileSync(join(folder, "source.bin"), bytes);
  fixtureFiles.fileLink(victim, join(folder, "shortcut.png"));
  linkSync(victim, join(folder, "shared.png"));
  fixtureFiles.fileLink("shared.png", join(folder, "chain.png"));
  fixtureFiles.fileLink(join(product, "missing.png"), join(folder, "dangling.png"));
  const fs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
  const release = guardCaptureWrites(folder);
  try {
    for (const write of [
      () => fs.promises.copyFile(join(folder, "source.bin"), join(folder, "shortcut.png")),
      () => fs.promises.writeFile(join(folder, "shortcut.png"), bytes),
      () => fs.promises.appendFile(join(folder, "shortcut.png"), bytes),
    ]) await expectRejection(write(), "capture folder");
    expect(() => fs.createWriteStream(join(folder, "shortcut.png"))).toThrow("capture folder");
    await expectRejection(fs.promises.copyFile(join(folder, "source.bin"), join(folder, "shared.png")), "linked file");
    await expectRejection(fs.promises.copyFile(join(folder, "source.bin"), join(folder, "chain.png")), "capture folder");
    await expectRejection(fs.promises.copyFile(join(folder, "source.bin"), join(folder, "dangling.png")));
    expect(lstatSync(join(folder, "shortcut.png")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(folder, "shared.png")).nlink).toBeGreaterThan(1);
    expect(readFileSync(victim)).toEqual(png);
    expect(existsSync(join(product, "missing.png"))).toBe(false);
    await fs.promises.copyFile(join(folder, "source.bin"), join(folder, "ordinary.bin"));
    expect(readFileSync(join(folder, "ordinary.bin"))).toEqual(bytes);
    await fs.promises.writeFile(join(product, "cache.bin"), Buffer.from("cache"));
    expect(readFileSync(join(product, "cache.bin"), "utf8")).toBe("cache");
  } finally { release(); }
});

it("saves only decoded chosen images, with captions and opaque references that survive temporary cleanup", async () => {
  writeFileSync(join(captures, "chosen.png"), png);
  writeFileSync(join(captures, "unused.png"), png);
  const images = await preserveCaptures(captures, storage, [{ path: "chosen.png", caption: " A checked page " }]);
  expect(images).toHaveLength(1);
  expect(images[0]!.caption).toBe("A checked page");
  expect(Object.keys(images[0]!)).toEqual(["id", "caption"]);
  expect(readdirSync(storage)).toEqual([`${images[0]!.id}.png`]);
  expect((await sharp(readFileSync(join(storage, `${images[0]!.id}.png`))).metadata()).width).toBe(4);
});

it("refuses shortcuts to shared files and dangling links before writing or accepting a report", async () => {
  const folder = join(root, "linked-captures");
  const product = join(root, "linked-product");
  const history = join(root, "linked-history");
  mkdirSync(folder); mkdirSync(product);
  writeFileSync(join(product, "existing.png"), png);
  linkSync(join(product, "existing.png"), join(folder, "shared.png"));
  fixtureFiles.fileLink("shared.png", join(folder, "shortcut.png"));
  fixtureFiles.fileLink("shortcut.png", join(folder, "shortcut-chain.png"));
  mkdirSync(join(folder, "nested"));
  linkSync(join(product, "existing.png"), join(folder, "nested", "shared.png"));
  fixtureFiles.directoryLink("nested", join(folder, "alias-folder"));
  fixtureFiles.fileLink(join(product, "missing.png"), join(folder, "dangling.png"));
  fixtureFiles.directoryLink(join(product, "missing-folder"), join(folder, "dangling-folder"));
  for (const path of ["shared.png", "shortcut.png", "shortcut-chain.png", "alias-folder/shared.png", "dangling.png", "dangling-folder/page.png"]) {
    await expectRejection(capturePath(folder, path));
    await expectRejection(preserveCaptures(folder, history, [{ path, caption: "A linked picture" }]), "inside this session's capture folder");
  }
  expect(readdirSync(product)).toEqual(["existing.png"]);
  expect(readFileSync(join(product, "existing.png"))).toEqual(png);
  expect(existsSync(history)).toBe(false);
  const redirected = join(root, "replaced-capture-folder");
  fixtureFiles.directoryLink(product, redirected);
  await expectRejection(capturePath(redirected, "existing.png"), "capture folder");
  await expectRejection(preserveCaptures(redirected, history, [{ path: "existing.png", caption: "An outside picture" }]), "inside this session's capture folder");
  // A shortcut is never a picture, even when it names an ordinary file in this folder.
  writeFileSync(join(folder, "ordinary.png"), png);
  fixtureFiles.fileLink("ordinary.png", join(folder, "ordinary-shortcut.png"));
  await expectRejection(capturePath(folder, "ordinary-shortcut.png"), "capture folder");
  await expectRejection(preserveCaptures(folder, history, [{ path: "ordinary-shortcut.png", caption: "A safe captured page" }]), "inside this session's capture folder");
  const saved = await preserveCaptures(folder, history, [{ path: "ordinary.png", caption: "A safe captured page" }]);
  expect(saved).toHaveLength(1);
  expect(readFileSync(join(product, "existing.png"))).toEqual(png);
});

it("refuses a shortcut that stays in the capture folder but leads through another shortcut into the product", async () => {
  const folder = join(root, "through-captures");
  const product = join(root, "through-product");
  const history = join(root, "through-history");
  mkdirSync(folder); mkdirSync(product);
  const victim = join(product, "existing.png");
  writeFileSync(victim, png);
  fixtureFiles.directoryLink(product, join(folder, "via"));
  fixtureFiles.fileLink(victim, join(folder, "direct.png"));
  fixtureFiles.fileLink("via/existing.png", join(folder, "second.png"));
  await expectRejection(capturePath(folder, "direct.png"), "capture folder");
  await expectRejection(capturePath(folder, "via/existing.png"), "capture folder");
  await expectRejection(capturePath(folder, "second.png"), "capture folder");
  await expectRejection(preserveCaptures(folder, history, [{ path: "second.png", caption: "A checked page" }]), "inside this session's capture folder");
  expect(existsSync(history)).toBe(false);
  const fs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
  const release = guardCaptureWrites(folder);
  try {
    const bytes = Buffer.from("more");
    await expectRejection(fs.promises.appendFile(join(folder, "second.png"), bytes), "capture folder");
    expect(() => fs.createWriteStream(join(folder, "second.png"))).toThrow("capture folder");
    await expectRejection(fs.promises.writeFile(join(folder, "second.png"), bytes), "capture folder");
    await expectRejection(fs.promises.copyFile(join(folder, "direct.png"), join(folder, "second.png")), "capture folder");
  } finally { release(); }
  expect(readFileSync(victim)).toEqual(png);
  expect(lstatSync(join(folder, "second.png")).isSymbolicLink()).toBe(true);
  expect(lstatSync(join(folder, "via")).isSymbolicLink()).toBe(true);
});

it("rejects missing, broken, outside and blank-caption pictures without saving a partial report", async () => {
  const fresh = join(root, "invalid-history");
  writeFileSync(join(captures, "broken.png"), "not a picture");
  fixtureFiles.directoryLink(join(root, "product"), join(captures, "outside"));
  for (const path of ["missing.png", "broken.png", "outside/page.png", "../product/page.png"]) {
    await expectRejection(preserveCaptures(captures, fresh, [{ path: "chosen.png", caption: "Valid first choice" }, { path, caption: "Invalid choice" }]));
  }
  await expectRejection(preserveCaptures(captures, fresh, [{ path: "chosen.png", caption: "  " }]), "caption");
  expect(existsSync(fresh)).toBe(false);
});

it("removes a report's newly written bytes when saving is interrupted or a write fails partway", async () => {
  const writeFile = files.writeFile;
  for (const interrupt of [true, false]) {
    const folder = join(root, `interrupted-${interrupt}`);
    const controller = new AbortController();
    const saving = spyOn(files, "writeFile").mockImplementation(async (path, data, options) => {
      await writeFile(path, data, options);
      if (interrupt) controller.abort();
      else throw new Error("Disk write interrupted");
    });
    try {
      await expectRejection(preserveCaptures(captures, folder, [{ path: "chosen.png", caption: "A checked page" }], controller.signal));
      expect(readdirSync(folder)).toEqual([]);
    } finally { saving.mockRestore(); }
  }
});

it("all five reporting roles allow optional pictures and require a caption on each one", () => {
  for (const [schema, base] of [
    [BuildResult, { summary: "Built it" }], [TestResult, { summary: "Checked it" }],
    [ObjectionsResult, {}], [ReviewResult, { verdict: "pass" }], [NotesResult, { summary: "Screens checked" }],
  ] as const) {
    expect(schema.safeParse(base).success).toBe(true);
    expect(schema.safeParse({ ...base, images: [{ path: "page.png", caption: "The checked page" }] }).success).toBe(true);
    for (const caption of [undefined, "", "   "]) expect(schema.safeParse({ ...base, images: [{ path: "page.png", caption }] }).success).toBe(false);
  }
});

it("both restart messages explain that pages and browser logins are gone", () => {
  const where = { stage: "Build", role: "Builder", done: [] };
  for (const text of [restartPrompt(where, { messages: [] }), formatWhereYouWere(where, "not found")]) {
    expect(text).toContain("Earlier pages and browser logins are gone");
  }
});
