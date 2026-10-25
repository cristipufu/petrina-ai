import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as operations from "../../../src/git.js";
import { commitAll, commitTree, contains, mergeTree, moveTo, patchId } from "../../../src/git.js";
import { expectRejection } from "@petrina/test-support/rejections";
import { removeDir } from "@petrina/test-support/fixtures";
import { git } from "@petrina/test-support/commands";

const temp = mkdtempSync(join(tmpdir(), "petrina-git-"));

/** A file as checked out, in one line-ending style: git on Windows writes CRLF. */
const checkedOut = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

async function currentVersion(repo: string): Promise<{ head: string; tree: string }> {
  const { head, tree } = await operations.commitVersion(repo);
  if (!head || !tree) throw new Error("The Git fixture has no committed version");
  return { head, tree };
}

describe("Petrina's own git steps", () => {
  afterAll(() => removeDir(temp));

  for (const format of ["sha1", "sha256"] as const) it(`folds ${format} task commits from one observation, preserving edits and returning the exact version`, async () => {
    const repo = join(temp, `fold-${format}`); mkdirSync(repo);
    await git(repo, "init", "-q", "-b", "main", `--object-format=${format}`);
    writeFileSync(join(repo, "README.md"), "Initial\n"); await commitAll(repo, "Initial");
    const baseVersion = await currentVersion(repo), base = baseVersion.head;
    expect(await operations.squash(repo, base, "No empty task commit")).toEqual(baseVersion);
    expect(await operations.head(repo)).toBe(base);
    writeFileSync(join(repo, "README.md"), "Changed\n"); await commitAll(repo, "Task title\n\nTask body");
    const before = await currentVersion(repo);
    let calls = 0;
    const spawn = Bun.spawn;
    const started = spyOn(Bun, "spawn").mockImplementation(((...args: Parameters<typeof Bun.spawn>) => {
      if (args[0][0] === "git") calls++;
      return Reflect.apply(spawn, Bun, args);
    }) as typeof Bun.spawn);
    try {
      expect(await operations.squash(repo, base, "Task title\n\nTask body")).toEqual(before);
      expect(calls).toBe(1);
    } finally { started.mockRestore(); }
    // A message-only change still makes exactly one commit and retains its tree.
    const renamed = await operations.squash(repo, base, "New title\n\nA complete body ✓\n");
    expect(renamed.head).not.toBe(before.head);
    expect(renamed.tree).toBe(before.tree);
    expect(await git(repo, "show", "-s", "--format=%P", "HEAD")).toBe(base);
    expect(await git(repo, "show", "-s", "--format=%B", "HEAD")).toBe("New title\n\nA complete body ✓");
    writeFileSync(join(repo, "second.txt"), "Second commit\n"); await commitAll(repo, "Repair");
    const { tree } = await currentVersion(repo);
    // Folding committed history must preserve both staged and unstaged work and untracked files.
    writeFileSync(join(repo, "README.md"), "Staged work\n"); await git(repo, "add", "README.md");
    writeFileSync(join(repo, "second.txt"), "Unstaged work\n");
    writeFileSync(join(repo, "untracked.txt"), "Keep this\n");
    const status = await git(repo, "status", "--porcelain");
    const folded = await operations.squash(repo, base, "Final task message");
    expect(folded).toEqual({ head: await operations.head(repo), tree });
    expect(await git(repo, "show", "-s", "--format=%P", "HEAD")).toBe(base);
    expect(await git(repo, "rev-list", "--count", `${base}..HEAD`)).toBe("1");
    expect(await git(repo, "status", "--porcelain")).toBe(status);
    expect(checkedOut(join(repo, "README.md"))).toBe("Staged work\n");
    expect(checkedOut(join(repo, "second.txt"))).toBe("Unstaged work\n");
    expect(checkedOut(join(repo, "untracked.txt"))).toBe("Keep this\n");
    writeFileSync(join(repo, ".git", "HEAD.lock"), "Another operation owns the ref\n");
    try { await expectRejection(operations.squash(repo, base, "A blocked message change")); }
    finally { rmSync(join(repo, ".git", "HEAD.lock")); }
    expect(await operations.head(repo)).toBe(folded.head);
    expect(await git(repo, "status", "--porcelain")).toBe(status);
    await expectRejection(operations.squash(repo, "not-a-commit", "Cannot fold"));
    await expectRejection(operations.squash(repo, "f".repeat(base.length), "Cannot fold"));
    expect(await operations.head(repo)).toBe(folded.head);
    expect(await git(repo, "status", "--porcelain")).toBe(status);
  });

  for (const format of ["sha1", "sha256"] as const) it(`compares and restores ${format} versions without treating an invalid version as unchanged`, async () => {
    const repo = join(temp, `maintenance-${format}`); mkdirSync(repo);
    await git(repo, "init", "-q", "-b", "main", `--object-format=${format}`);
    await git(repo, "config", "user.email", "test@example.com"); await git(repo, "config", "user.name", "Test");
    writeFileSync(join(repo, "README.md"), "Initial\n");
    await commitAll(repo, "Initial");
    const initial = await operations.head(repo), first = await operations.commitVersion(repo);
    expect(initial).toHaveLength(format === "sha256" ? 64 : 40);
    expect(first).toEqual({ head: initial, tree: await git(repo, "rev-parse", "HEAD^{tree}") });
    expect(await operations.revParse(repo, "HEAD")).toBe(initial);
    expect(await operations.worktreeStatus(repo)).toEqual({ head: initial, clean: true, trackedChanged: false });
    expect(await operations.changedFiles(repo, initial, initial)).toEqual([]);
    writeFileSync(join(repo, "maintenance.txt"), "A committed maintenance change\n");
    const changed = (await commitAll(repo, "Maintenance"))!;
    expect(await operations.changedFiles(repo, initial, changed)).toEqual(["maintenance.txt"]);
    expect(await operations.changedFiles(repo, initial.slice(0, 12), changed.slice(0, 12))).toEqual(["maintenance.txt"]);
    expect(await operations.treeOf(repo)).toBe(await git(repo, "rev-parse", "HEAD^{tree}"));
    expect(await contains(repo, changed, initial)).toBe(true);
    await expectRejection(operations.changedFiles(repo, "invalid", changed));
    await expectRejection(operations.changedFiles(repo, initial, "invalid"));
    await expectRejection(operations.changedFiles(repo, initial, "f".repeat(initial.length)));
    await expectRejection(operations.resetTo(repo, "invalid"));
    writeFileSync(join(repo, ".git", "index.lock"), "Restore is temporarily unavailable\n");
    try { await expectRejection(operations.resetTo(repo, initial)); }
    finally { rmSync(join(repo, ".git", "index.lock")); }
    expect(await operations.head(repo)).toBe(changed);
    await operations.resetTo(repo, initial);
    expect(await operations.head(repo)).toBe(initial); expect(existsSync(join(repo, "maintenance.txt"))).toBe(false);
    expect(await operations.worktreeStatus(repo)).toEqual({ head: initial, clean: true, trackedChanged: false });
  });

  it("checks ancestry from HEAD directly while preserving hash validation for other inputs", async () => {
    const repo = join(temp, "head-ancestry"); mkdirSync(repo);
    await git(repo, "init", "-q", "-b", "main"); await git(repo, "config", "user.email", "test@example.com"); await git(repo, "config", "user.name", "Test");
    writeFileSync(join(repo, "README.md"), "First\n"); await git(repo, "add", "."); await git(repo, "commit", "-qm", "First");
    const base = await git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "README.md"), "Second\n"); await git(repo, "add", "."); await git(repo, "commit", "-qm", "Second");
    const head = await git(repo, "rev-parse", "HEAD");
    expect(await contains(repo, "HEAD", base)).toBe(true);
    expect(await contains(repo, head, base)).toBe(true);
    expect(await contains(repo, base, head)).toBe(false);
    expect(await contains(repo, "other-reference", base)).toBe(false);
    expect(await contains(repo, "HEAD", "invalid-ancestor")).toBe(false);
  });
});

describe("the change's fingerprint", () => {
  const folder = mkdtempSync(join(tmpdir(), "petrina-patch-"));
  afterAll(() => removeDir(folder));

  /** A repository with a task branch that changes one line in the middle of a file. */
  async function repo(): Promise<{ path: string; run: (...args: string[]) => Promise<string> }> {
    const path = mkdtempSync(join(folder, "repo-"));
    const run = (...args: string[]) => git(path, ...args);
    await run("init", "-q", "-b", "main");
    await run("config", "user.email", "t@example.com");
    await run("config", "user.name", "T");
    writeFileSync(join(path, "app.py"), "def a():\n    return 1\n\n\ndef b():\n    return 2\n");
    await run("add", ".");
    await run("commit", "-q", "-m", "init");
    await run("checkout", "-q", "-b", "task");
    writeFileSync(join(path, "app.py"), "def a():\n    return 1\n\n\ndef b():\n    return 3\n");
    await run("commit", "-qam", "task");
    return { path, run };
  }

  it("stays the same when the change lands lower in a file that grew above it", async () => {
    const { path, run } = await repo();
    const before = await patchId(path, await run("rev-parse", "main"), "HEAD");
    await run("checkout", "-q", "main");
    writeFileSync(join(path, "NEWS.md"), "News\n");
    writeFileSync(join(path, "app.py"), "import os\n\n\ndef a():\n    return 1\n\n\ndef b():\n    return 2\n");
    await run("add", ".");
    await run("commit", "-q", "-m", "main moved");
    await run("checkout", "-q", "task");
    const merged = await mergeTree(path, await run("rev-parse", "main"));
    expect(merged?.conflicts).toEqual([]);
    await moveTo(path, await commitTree(path, merged!.tree, await run("rev-parse", "main"), "task"));
    expect(await patchId(path, await run("rev-parse", "main"), "HEAD")).toBe(before!);
  });

  it("changes when only whitespace differs, which is meaning in Python", async () => {
    const { path, run } = await repo();
    const before = await patchId(path, await run("rev-parse", "main"), "HEAD");
    writeFileSync(join(path, "app.py"), "def a():\n    return 1\n\n\ndef b():\n        return 3\n");
    await run("commit", "-qam", "indented");
    expect(await patchId(path, await run("rev-parse", "main"), "HEAD")).not.toBe(before!);
  });
});