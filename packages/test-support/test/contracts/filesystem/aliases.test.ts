import { afterAll, expect, it } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureFiles } from "@petrina/test-support/fixture-files";
import { removeDir, tempDir } from "@petrina/test-support/fixtures";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

it("resolves a relative directory alias and removes only the alias", () => {
  const root = tempDir("petrina-native-directory-"); roots.push(root);
  const target = join(root, "target"), links = join(root, "links"), alias = join(links, "alias");
  mkdirSync(target); mkdirSync(links); writeFileSync(join(target, "kept"), "Owned target\n");
  fixtureFiles.directoryLink("../target", alias);
  expect(lstatSync(alias).isSymbolicLink()).toBe(true);
  expect(readFileSync(join(alias, "kept"), "utf8")).toBe("Owned target\n");
  expect(fixtureFiles.canonical(alias)).toBe(fixtureFiles.canonical(target));
  rmSync(alias, { recursive: true });
  expect(existsSync(alias)).toBe(false);
  expect(readFileSync(join(target, "kept"), "utf8")).toBe("Owned target\n");
});

it("keeps real file-link chains and missing targets instead of substituting ordinary files", () => {
  const root = tempDir("petrina-native-file-link-"); roots.push(root);
  const target = join(root, "target.txt"), first = join(root, "first.txt"), second = join(root, "second.txt");
  fixtureFiles.fileLink("target.txt", first);
  fixtureFiles.fileLink("first.txt", second);
  expect(lstatSync(first).isSymbolicLink()).toBe(true);
  expect(lstatSync(second).isSymbolicLink()).toBe(true);
  expect(existsSync(second)).toBe(false);
  writeFileSync(target, "Published target\n");
  expect(readFileSync(second, "utf8")).toBe("Published target\n");
  expect(fixtureFiles.canonical(second)).toBe(fixtureFiles.canonical(target));
  rmSync(first);
  expect(existsSync(second)).toBe(false);
  expect(readFileSync(target, "utf8")).toBe("Published target\n");
});
