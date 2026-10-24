import { afterAll, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { localFiles } from "@petrina/platform/file-operations";
import { fixtureFiles } from "@petrina/test-support/fixture-files";
import { removeDir, tempDir } from "@petrina/test-support/fixtures";
import { rejectionOf } from "@petrina/test-support/rejections";

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
