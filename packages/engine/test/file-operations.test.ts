import { afterAll, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { localFiles } from "../src/file-operations.js";
import { FileFaults } from "./file-faults.js";
import { fixtureFiles } from "./fixture-files.js";
import { removeDir, tempDir } from "./fixtures.js";
import { rejectionOf } from "./rejections.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
function fixture() { const root = tempDir("petrina-file-effects-"); roots.push(root); return root; }

it("copies real bytes and reports a missing source instead of inventing successful storage", async () => {
  const root = fixture(), source = join(root, "source"), destination = join(root, "destination");
  writeFileSync(source, new Uint8Array([0, 255, 195, 169]));
  await localFiles.copyFile(source, destination);
  expect(readFileSync(destination)).toEqual(readFileSync(source));
  const failure = await rejectionOf(localFiles.copyFile(join(root, "missing"), destination));
  expect(failure).toBeInstanceOf(Error);
  expect((failure as NodeJS.ErrnoException).code).toBe("ENOENT");
  expect([...readFileSync(destination)]).toEqual([0, 255, 195, 169]);
});

it("removes an owned directory alias without deleting its target, including an absent tree", async () => {
  const root = fixture(), target = join(root, "target"), alias = join(root, "alias");
  mkdirSync(target); writeFileSync(join(target, "keep"), "Keep this target");
  fixtureFiles.directoryLink(target, alias);
  await localFiles.removeTree(alias);
  await localFiles.removeTree(alias);
  expect(existsSync(alias)).toBe(false);
  expect(readFileSync(join(target, "keep"), "utf8")).toBe("Keep this target");
});

it("keeps injected copy and removal failures private, and stale releases cannot clear a newer fault", async () => {
  const root = fixture(), source = join(root, "source"), first = join(root, "first"), second = join(root, "second");
  writeFileSync(source, "Actual file");
  const denied = new FileFaults(), other = new FileFaults();
  const allow = denied.blockCopy(source);
  expect((await rejectionOf(denied.files.copyFile(source, first)) as NodeJS.ErrnoException).code).toBe("EACCES");
  await other.files.copyFile(source, second);
  expect(readFileSync(second, "utf8")).toBe("Actual file");
  allow();
  const releaseNew = denied.blockCopy(source);
  allow();
  expect((await rejectionOf(denied.files.copyFile(source, first)) as NodeJS.ErrnoException).code).toBe("EACCES");
  releaseNew();
  await denied.files.copyFile(source, first);
  const allowRemoval = denied.blockRemoval(first);
  expect((await rejectionOf(denied.files.removeTree(first)) as NodeJS.ErrnoException).code).toBe("EACCES");
  expect(readFileSync(first, "utf8")).toBe("Actual file");
  await denied.files.removeTree(second);
  allowRemoval();
  await denied.files.removeTree(first);
  expect([existsSync(first), existsSync(second)]).toEqual([false, false]);
});
