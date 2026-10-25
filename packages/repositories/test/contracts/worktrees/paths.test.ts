import { afterAll, expect, it } from "bun:test";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { checkedOut } from "../../../src/git.js";
import { realPath } from "../../../src/paths.js";
import { git } from "@petrina/test-support/commands";
import { makeProduct } from "@petrina/test-support/repositories";
import { removeDir, tempDir } from "@petrina/test-support/fixtures";
import { fixtureFiles } from "@petrina/test-support/fixture-files";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

  it("recognizes Git's own main copy through native, runtime and linked path spellings", async () => {
  const root = tempDir("petrina-delivery-paths-"); roots.push(root);
  const product = await makeProduct(root), alias = join(root, "same-copy");
  fixtureFiles.directoryLink(fixtureFiles.canonical(product), alias);
  const places = await checkedOut(product, "main");
  expect(places).toHaveLength(1);
  const native = realpathSync.native(product);
  for (const path of [product, realpathSync(product), native, alias]) {
    expect(places.map(realPath)).toEqual([realPath(path)]);
    expect(realPath(path)).toBe(native);
  }
});

  it("keeps another checked-out working copy distinct while resolving aliases of each", async () => {
  const root = tempDir("petrina-separate-paths-"); roots.push(root);
  const product = await makeProduct(root), companion = join(root, "companion");
  await git(product, "worktree", "add", "-qb", "companion", companion, "main");
  const links = join(root, "links"); mkdirSync(links);
  const first = join(links, "main"), second = join(links, "companion");
  for (const [path, alias] of [[product, first], [companion, second]] as const) fixtureFiles.directoryLink(fixtureFiles.canonical(path), alias);
  expect((await checkedOut(product, "main")).map(realPath)).toEqual([realPath(first)]);
  expect((await checkedOut(product, "companion")).map(realPath)).toEqual([realPath(second)]);
  expect(realPath(first)).not.toBe(realPath(second));
});
