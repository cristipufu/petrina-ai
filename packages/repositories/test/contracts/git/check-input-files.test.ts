import { expect, it, spyOn } from "bun:test";
import { cpSync, rmSync, writeFileSync } from "node:fs";
import * as files from "node:fs/promises";
import { join, resolve } from "node:path";
import { git } from "@petrina/test-support/commands";
import { tempDir } from "@petrina/test-support/fixtures";
import { repositorySeed } from "@petrina/test-support/repositories";
import { writeGitProgram } from "@petrina/test-support/git-program";
import { expectRejection, rejectionOf } from "@petrina/test-support/rejections";
import { checkInputFiles } from "../../../src/git.js";

for (const format of ["sha1", "sha256"] as const) it(`reads pinned ${format} check inputs and custom hooks in one Git process`, async () => {
  const root = tempDir("petrina-check-inputs-");
  try {
    const seed = await repositorySeed(undefined, false, format), repo = join(root, "repo");
    cpSync(seed.clone, repo, { recursive: true });
    const before = await git(repo, "rev-parse", "HEAD"), tree = await git(repo, "rev-parse", "HEAD^{tree}");
    const hooks = join(root, "custom hooks");
    writeGitProgram(join(hooks, "pre-commit"), "exit 99");
    writeGitProgram(join(hooks, "commit-msg"), "exit 99");
    await git(repo, "config", "core.hooksPath", hooks);
    // HEAD changes, but the captured commit remains the input for this operation.
    writeFileSync(join(repo, "later.txt"), "A later commit\n");
    await git(repo, "add", "."); await git(repo, "-c", "core.hooksPath=", "commit", "-qm", "Later");
    let calls = 0;
    const native = Bun.spawn, watch = spyOn(Bun, "spawn").mockImplementation(((...args: Parameters<typeof Bun.spawn>) => {
      if (args[0][0] === "git") calls++;
      return Reflect.apply(native, Bun, args);
    }) as typeof Bun.spawn);
    try {
      const input = await checkInputFiles(repo, before);
      expect({ ...input, hooks: input.hooks.map(hook => ({ ...hook, path: resolve(hook.path) })) }).toEqual({ tree, hooks: [{ name: "pre-commit", path: join(hooks, "pre-commit") }, { name: "commit-msg", path: join(hooks, "commit-msg") }] });
      expect(calls).toBe(1);
    } finally { watch.mockRestore(); }
    expect(await git(repo, "rev-parse", "HEAD^{tree}")).not.toBe(tree);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("resolves a linked working copy's hook paths through its owning repository", async () => {
  const root = tempDir("petrina-check-linked-");
  try {
    const seed = await repositorySeed(), repo = join(root, "repo"), copy = join(root, "copy");
    cpSync(seed.clone, repo, { recursive: true });
    await git(repo, "worktree", "add", "--detach", "-q", copy, "HEAD");
    const sha = await git(copy, "rev-parse", "HEAD"), tree = await git(copy, "rev-parse", "HEAD^{tree}");
    writeGitProgram(join(repo, ".git", "hooks", "pre-commit"), "exit 99");
    const input = await checkInputFiles(copy, sha);
    expect({ ...input, hooks: input.hooks.map(hook => ({ ...hook, path: resolve(hook.path) })) }).toEqual({ tree, hooks: [{ name: "pre-commit", path: join(repo, ".git", "hooks", "pre-commit") }] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("keeps an unborn repository without a tree, and rejects unknown or invalid commit inputs", async () => {
  const root = tempDir("petrina-check-unborn-");
  try {
    await git(root, "init", "-q", "-b", "main");
    expect(await checkInputFiles(root)).toEqual({ hooks: [] });
    await expectRejection(checkInputFiles(root, "0".repeat(40)), "could not be read");
    await expectRejection(checkInputFiles(root, "HEAD"), "Not a commit");
    await expectRejection(checkInputFiles(join(root, "missing")), "could not be read");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("does not turn an unreadable hook observation into no configured hooks", async () => {
  const root = tempDir("petrina-check-hook-read-");
  let watch: ReturnType<typeof spyOn> | undefined;
  try {
    await git(root, "init", "-q", "-b", "main");
    const hook = join(root, ".git", "hooks", "pre-commit"), failure = Object.assign(new Error("Hook could not be inspected"), { code: "EACCES" });
    writeGitProgram(hook, "exit 99");
    const native = files.stat;
    watch = spyOn(files, "stat").mockImplementation(((file: Parameters<typeof files.stat>[0], ...args: unknown[]) => {
      if (typeof file === "string" && resolve(file) === hook) return Promise.reject(failure);
      return Reflect.apply(native, files, [file, ...args]);
    }) as typeof files.stat);
    expect(await rejectionOf(checkInputFiles(root))).toBe(failure);
  } finally { watch?.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});
