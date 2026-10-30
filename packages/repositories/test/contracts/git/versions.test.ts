import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as operations from "../../../src/git.js";
import { commitAll, commitTree, contains, mergeTree, moveTo, patchId } from "../../../src/git.js";
import { expectRejection } from "@petrina/test-support/rejections";
import { tempDir } from "@petrina/test-support/fixtures";
import { headNow } from "@petrina/test-support/repository-head";
import { committedRepositoryFixtures } from "../../fixtures/committed-repositories.js";
import { git } from "@petrina/test-support/commands";

const temp = tempDir("petrina-git-");
const repositories = committedRepositoryFixtures(temp);
afterAll(() => repositories.close());

/** A file as checked out, in one line-ending style: git on Windows writes CRLF. */
const checkedOut = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

async function currentVersion(repo: string): Promise<{ head: string; tree: string }> {
  const { head, tree } = await operations.commitVersion(repo);
  if (!head || !tree) throw new Error("The Git fixture has no committed version");
  return { head, tree };
}

describe("Petrina's own git steps", () => {

  for (const format of ["sha1", "sha256"] as const) it(`commits ${format} changes without an unused HEAD read, retaining the SHA-returning API`, () => repositories.run(async () => {
    const repo = join(temp, `commit-changes-${format}`); mkdirSync(repo);
    await repositories.copy(repo, { contents: "Initial\n", message: "Initial", format });
    const initial = await operations.head(repo);
    writeFileSync(join(repo, "README.md"), "Changed without inspecting HEAD\n");
    const native = Bun.spawn;
    let reads = 0, watch: ReturnType<typeof spyOn<typeof Bun, "spawn">> | undefined;
    const cleanup = () => { watch?.mockRestore(); };
    await setupWithCleanup(async () => {
      watch = spyOn(Bun, "spawn");
      watch.mockImplementation(((...args: Parameters<typeof Bun.spawn>) => {
        if (args[0][0] === "git" && args[1]?.cwd === repo && args[0].includes("rev-parse")) {
          reads++;
          throw new Error("This commit owner does not need a HEAD observation");
        }
        return Reflect.apply(native, Bun, args);
      }) as typeof Bun.spawn);
      expect(await operations.commitChanges(repo, "Changed without a version query")).toBe(true);
      expect(await operations.commitChanges(repo, "No empty commit")).toBe(false);
      expect(reads).toBe(0);
    }, cleanup);
    cleanup();
    const changed = await operations.head(repo);
    expect(changed).not.toBe(initial);
    expect(await git(repo, "show", "-s", "--format=%P", "HEAD")).toBe(initial);
    expect(await git(repo, "show", "-s", "--format=%B", "HEAD")).toBe("Changed without a version query");
    expect(await git(repo, "show", "HEAD:README.md")).toBe("Changed without inspecting HEAD");
    expect(await git(repo, "status", "--porcelain")).toBe("");
    expect(await commitAll(repo, "Still no empty commit")).toBeUndefined();
    writeFileSync(join(repo, "README.md"), "A caller still needs the new SHA\n");
    const named = await commitAll(repo, "A named commit");
    expect(named).toBe(await operations.head(repo));
    expect(named).toHaveLength(format === "sha256" ? 64 : 40);
    writeFileSync(join(repo, "README.md"), "Blocked by the real index lock\n");
    writeFileSync(join(repo, ".git", "index.lock"), "Another Git operation owns the index\n");
    try { await expectRejection(operations.commitChanges(repo, "Must not succeed")); }
    finally { rmSync(join(repo, ".git", "index.lock")); }
    expect(await operations.head(repo)).toBe(named!);
    expect(checkedOut(join(repo, "README.md"))).toBe("Blocked by the real index lock\n");
  }));

  for (const format of ["sha1", "sha256"] as const) it(`folds ${format} task commits from one observation, preserving edits and returning the exact version`, () => repositories.run(async () => {
    const repo = join(temp, `fold-${format}`); mkdirSync(repo);
    await repositories.copy(repo, { contents: "Initial\n", message: "Initial", format });
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
  }));

  for (const format of ["sha1", "sha256"] as const) it(`compares and restores ${format} versions without treating an invalid version as unchanged`, () => repositories.run(async () => {
    const repo = join(temp, `maintenance-${format}`); mkdirSync(repo);
    await repositories.copy(repo, { contents: "Initial\n", message: "Initial", format });
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
  }));

  it("checks ancestry from HEAD directly while preserving hash validation for other inputs", () => repositories.run(async () => {
    const repo = join(temp, "head-ancestry");
    mkdirSync(repo);
    await repositories.copy(repo, { contents: "First\n", message: "First" });
    const base = headNow(repo);
    writeFileSync(join(repo, "README.md"), "Second\n");
    const head = (await commitAll(repo, "Second"))!;
    expect(await contains(repo, "HEAD", base)).toBe(true);
    expect(await contains(repo, head, base)).toBe(true);
    expect(await contains(repo, base, head)).toBe(false);
    expect(await contains(repo, "other-reference", base)).toBe(false);
    expect(await contains(repo, "HEAD", "invalid-ancestor")).toBe(false);
  }));

  for (const format of ["sha1", "sha256"] as const) it(`owns one ${format} fold observation and observes each later operation afresh`, () => repositories.run(async () => {
    const repo = join(temp, `observed-fold-${format}`); mkdirSync(repo);
    await repositories.copy(repo, { contents: "Initial\n", message: "Initial", format });
    const base = await operations.head(repo);
    writeFileSync(join(repo, "README.md"), "Actual task contents\n"); await commitAll(repo, "Task");
    const first = await operations.observeFold(repo);
    expect(first.kind).toBe("observed");
    if (first.kind !== "observed") throw new Error("The committed task was unavailable");
    expect(first.parents).toEqual([base]);
    expect(first.head).toBe(await operations.head(repo));
    expect(first.tree).toBe(await git(repo, "rev-parse", "HEAD^{tree}"));
    expect(await first.squash(base, "Task")).toEqual({ head: first.head, tree: first.tree });
    await expectRejection(first.squash(base, "Must not reuse an earlier operation"), "one operation");
    writeFileSync(join(repo, "later.txt"), "A later mutation\n"); await commitAll(repo, "Later");
    const later = await operations.observeFold(repo);
    expect(later.kind).toBe("observed");
    if (later.kind !== "observed") throw new Error("The later committed task was unavailable");
    expect(later.head).not.toBe(first.head); expect(later.tree).not.toBe(first.tree);
    expect(later.parents).toEqual([first.head]);
    const result = await later.squash(base, "Final message");
    expect(result).toEqual({ head: await operations.head(repo), tree: later.tree });
    expect(await git(repo, "show", "-s", "--format=%P", "HEAD")).toBe(base);
    expect(await git(repo, "show", "HEAD:later.txt")).toBe("A later mutation");
  }));

  for (const format of ["sha1", "sha256"] as const) it(`detaches for hooks, reattaches restoring tracked edits, and opens merged trees on ${format}`, () => repositories.run(async () => {
    const repo = join(temp, `detach-open-${format}`); mkdirSync(repo);
    await repositories.copy(repo, { contents: "Base\n", message: "Base", format });
    const base = await operations.head(repo);
    writeFileSync(join(repo, "README.md"), "Task change\n");
    const taskSha = (await commitAll(repo, "Task"))!;
    writeFileSync(join(repo, ".git", "HEAD.lock"), "Blocked HEAD\n");
    try { await expectRejection(operations.detachAt(repo, base)); }
    finally { rmSync(join(repo, ".git", "HEAD.lock")); }
    await operations.detachAt(repo, base);
    expect(await operations.currentBranch(repo)).toBeUndefined();
    expect(await git(repo, "rev-parse", "HEAD")).toBe(base);
    writeFileSync(join(repo, "README.md"), "Hook dirtied tracked file\n");
    writeFileSync(join(repo, "untracked-hook.txt"), "Untracked stays\n");
    await operations.reattach(repo, "main");
    expect(await git(repo, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
    expect(await git(repo, "rev-parse", "HEAD")).toBe(taskSha);
    expect(checkedOut(join(repo, "README.md"))).toBe("Task change\n");
    expect(checkedOut(join(repo, "untracked-hook.txt"))).toBe("Untracked stays\n");
    rmSync(join(repo, "untracked-hook.txt"));
    expect(await git(repo, "status", "--porcelain")).toBe("");
    const taskTree = await git(repo, "rev-parse", `${taskSha}^{tree}`);
    writeFileSync(join(repo, ".git", "index.lock"), "Blocked index\n");
    try { await expectRejection(operations.openOn(repo, base, taskTree)); }
    finally { rmSync(join(repo, ".git", "index.lock")); }
    await operations.openOn(repo, base, taskTree);
    expect(await git(repo, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
    expect(await git(repo, "rev-parse", "HEAD")).toBe(base);
    expect(checkedOut(join(repo, "README.md"))).toBe("Task change\n");
    expect(await git(repo, "diff", "--name-only")).toBe("");
    expect(await git(repo, "diff", "--cached", "--name-only")).toBe("README.md");
  }));
});

describe("the change's fingerprint", () => {
  const folder = join(temp, "fingerprints");
  mkdirSync(folder);

  let seedPromise: Promise<{ seedPath: string; mainSha: string }> | undefined;
  const ensureSeed = () => {
    seedPromise ??= (async () => {
      const seedPath = join(folder, "_seed");
      mkdirSync(seedPath);
      const run = (...args: string[]) => git(seedPath, ...args);
      await run("init", "-q", "-b", "main");
      await run("config", "user.email", "t@example.com");
      await run("config", "user.name", "T");
      writeFileSync(join(seedPath, "app.py"), "def a():\n    return 1\n\n\ndef b():\n    return 2\n");
      await run("add", ".");
      await run("commit", "-q", "-m", "init");
      const mainSha = headNow(seedPath);
      await run("checkout", "-q", "-b", "task");
      writeFileSync(join(seedPath, "app.py"), "def a():\n    return 1\n\n\ndef b():\n    return 3\n");
      await run("commit", "-qam", "task");
      return { seedPath, mainSha };
    })();
    return seedPromise;
  };

  /** A repository with a task branch that changes one line in the middle of a file. */
  async function repo(): Promise<{ path: string; mainSha: string; run: (...args: string[]) => Promise<string> }> {
    const seed = await ensureSeed();
    const path = mkdtempSync(join(folder, "repo-"));
    cpSync(seed.seedPath, path, { recursive: true });
    return { path, mainSha: seed.mainSha, run: (...args: string[]) => git(path, ...args) };
  }

  it("stays the same when the change lands lower in a file that grew above it", () => repositories.run(async () => {
    const { path, mainSha, run } = await repo();
    const before = await patchId(path, mainSha, "HEAD");
    await run("checkout", "-q", "main");
    writeFileSync(join(path, "NEWS.md"), "News\n");
    writeFileSync(join(path, "app.py"), "import os\n\n\ndef a():\n    return 1\n\n\ndef b():\n    return 2\n");
    await run("add", ".");
    await run("commit", "-q", "-m", "main moved");
    const movedMain = headNow(path);
    await run("checkout", "-q", "task");
    const merged = await mergeTree(path, movedMain);
    expect(merged?.conflicts).toEqual([]);
    await moveTo(path, await commitTree(path, merged!.tree, movedMain, "task"));
    expect(await patchId(path, movedMain, "HEAD")).toBe(before!);
  }));

  it("changes when only whitespace differs, which is meaning in Python", () => repositories.run(async () => {
    const { path, mainSha, run } = await repo();
    const before = await patchId(path, mainSha, "HEAD");
    writeFileSync(join(path, "app.py"), "def a():\n    return 1\n\n\ndef b():\n        return 3\n");
    await run("commit", "-qam", "indented");
    expect(await patchId(path, mainSha, "HEAD")).not.toBe(before!);
  }));
});
