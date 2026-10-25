import { afterAll, expect, it } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../../../src/commands.js";
import { headNow } from "../../../src/repository-head.js";
import { makeProduct, repositorySeed } from "../../../src/repositories.js";
import { removeDir, tempDir } from "../../../src/fixtures.js";
import { rejectionOf } from "../../../src/rejections.js";
const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

it("leaves no reusable seed or partial folder behind when preparing one fails, and prepares it afresh", async () => {
  // Git refuses an unknown object format, so this recipe's preparation fails.
  const broken = "sha999" as "sha1";
  const folderOf = (error: unknown) => /starting repository in (.+?): /.exec((error as Error).message)?.[1];
  const together = await Promise.all([rejectionOf(repositorySeed(undefined, false, broken)), rejectionOf(repositorySeed(undefined, false, broken))]);
  expect(together[1]).toBe(together[0]);
  expect((together[0] as Error).message).toContain("sha999");
  const failed = folderOf(together[0]);
  expect(failed).toBeDefined();
  expect(existsSync(failed!)).toBe(false);
  const again = await rejectionOf(repositorySeed(undefined, false, broken));
  expect(folderOf(again)).toBeDefined();
  expect(folderOf(again)).not.toBe(failed);
  expect(existsSync(folderOf(again)!)).toBe(false);
});

it("reads a working copy's HEAD from Git's files as Git itself does, for callbacks that cannot wait", async () => {
  const root = tempDir("petrina-head-now-"); roots.push(root);
  const clone = await makeProduct(root);
  expect(headNow(clone)).toBe(await git(clone, "rev-parse", "HEAD"));
  // An engine-style linked working copy on its own branch, then moved by a commit.
  const copy = join(root, "copy");
  await git(clone, "worktree", "add", "-q", "-b", "task", copy);
  writeFileSync(join(copy, "change.txt"), "A change\n");
  await git(copy, "add", "."); await git(copy, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qm", "A change");
  expect(headNow(copy)).toBe(await git(copy, "rev-parse", "HEAD"));
  expect(headNow(copy)).not.toBe(headNow(clone));
  // Packed branch refs, and a detached head.
  await git(clone, "pack-refs", "--all");
  expect(existsSync(join(clone, ".git", "refs", "heads", "task"))).toBe(false);
  expect(headNow(copy)).toBe(await git(copy, "rev-parse", "HEAD"));
  await git(copy, "switch", "-q", "--detach", "HEAD~1");
  expect(headNow(copy)).toBe(await git(clone, "rev-parse", "main"));
  expect(() => headNow(join(root, "missing"))).toThrow();
});
