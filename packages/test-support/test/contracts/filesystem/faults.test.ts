import { afterAll, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FileFaults } from "@petrina/test-support/file-faults";
import { removeDir, tempDir } from "../../../src/fixtures.js";
import { rejectionOf } from "@petrina/test-support/rejections";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
function fixture() { const root = tempDir("petrina-file-effects-"); roots.push(root); return root; }

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
