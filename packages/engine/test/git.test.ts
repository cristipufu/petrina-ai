import { fixtureFiles } from "@petrina/test-support/fixture-files";
import { FileFaults } from "./file-faults.js";
import { expectRejection } from "@petrina/test-support/rejections";
import * as operations from "../src/git.js";
import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { addCopy, commitAll, commitTree, contains, copyFolderName, ensureWorktree, fastForward, fetchBranch, githubRepo, githubRepoOf, isClean, mergeTree, moveTo, patchId, push, removeCopies, removeFinishedCopies, removeWorktree, repoInfo, riskySettings, sameRepo } from "../src/git.js";
import { childState } from "../src/process-tree.js";
import { defunctProcess, firstLine, git, gitWith, makeProduct, removeDir, testGitEnv, waitFor } from "./fixtures.js";

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

  it("unlinks a replaced reviewer folder without following it into an unfinished task", async () => {
    const repo = join(temp, "peer-link-repo");
    mkdirSync(repo);
    await git(repo, "init", "-q", "-b", "main");
    await git(repo, "config", "user.email", "test@example.com");
    await git(repo, "config", "user.name", "Test");
    writeFileSync(join(repo, "README.md"), "kept\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-q", "-m", "init");
    const activeFolder = join(temp, "active.copies");
    const active = join(activeFolder, "review-0");
    const oldFolder = join(temp, "finished.copies");
    const old = join(oldFolder, "review-0");
    const sha = await git(repo, "rev-parse", "HEAD");
    await addCopy(repo, active, sha);
    await addCopy(repo, old, sha);
    await git(repo, "worktree", "lock", old);
    writeFileSync(join(active, "unsaved.txt"), "Keep my work");
    rmSync(oldFolder, { recursive: true, force: true });
    fixtureFiles.directoryLink(activeFolder, oldFolder);
    expect(await removeFinishedCopies(repo, oldFolder)).toBe(true);
    expect(existsSync(oldFolder)).toBe(false);
    expect(readFileSync(join(active, "unsaved.txt"), "utf8")).toBe("Keep my work");
    const registered = await git(repo, "worktree", "list", "--porcelain", "-z");
    expect(registered).toContain(realpathSync.native(active));
    expect(registered).not.toContain(old);
  });

  it("ignores already absent copies when the product moved, but preserves existing folders for recovery", async () => {
    const missing = join(temp, "moved-product"), folder = join(temp, "moved-product.copies");
    const listed = spyOn(operations, "linkedWorktrees");
    try {
      expect(await removeFinishedCopies(missing, folder)).toBe(false);
      expect(await removeWorktree(missing, folder)).toBe(false);
      expect(listed).not.toHaveBeenCalled();
      mkdirSync(folder); writeFileSync(join(folder, "keep.txt"), "Recover me");
      await expectRejection(removeFinishedCopies(missing, folder), "the product's folder could not be found");
      await expectRejection(removeWorktree(missing, folder), "the product's folder could not be found");
      expect(readFileSync(join(folder, "keep.txt"), "utf8")).toBe("Recover me");
      expect(listed).not.toHaveBeenCalled();
    } finally { listed.mockRestore(); }
  });

  it("removes finished locked and missing snapshots with one registration read and one batch verification", async () => {
    const repo = join(temp, "finished-batch"); mkdirSync(repo);
    await git(repo, "init", "-q", "-b", "main"); await git(repo, "config", "user.email", "test@example.com"); await git(repo, "config", "user.name", "Test");
    writeFileSync(join(repo, "README.md"), "Keep the product\n"); await git(repo, "add", "."); await git(repo, "commit", "-qm", "Initial");
    const sha = await git(repo, "rev-parse", "HEAD"), folder = join(temp, "finished-batch.copies");
    const copies = ["one", "two", "three"].map(name => join(folder, name));
    const unrelated = join(temp, "unfinished-review");
    for (const copy of [...copies, unrelated]) await addCopy(repo, copy, sha);
    await git(repo, "worktree", "lock", copies[0]!); await git(repo, "worktree", "lock", copies[1]!);
    rmSync(copies[1]!, { recursive: true, force: true });
    mkdirSync(join(folder, "unregistered"));
    writeFileSync(join(unrelated, "unsaved.txt"), "Still working\n");
    const listed = spyOn(operations, "linkedWorktrees");
    try {
      expect(await removeFinishedCopies(repo, folder)).toBe(true);
      expect(listed).toHaveBeenCalledTimes(2);
      expect(existsSync(folder)).toBe(false);
      const remaining = await git(repo, "worktree", "list", "--porcelain", "-z");
      for (const copy of copies) expect(remaining).not.toContain(copy);
      expect(remaining).toContain(realpathSync.native(unrelated));
      expect(readFileSync(join(unrelated, "unsaved.txt"), "utf8")).toBe("Still working\n");
      listed.mockClear();
      expect(await removeWorktree(repo, join(temp, "already-gone"))).toBe(false);
      expect(listed).toHaveBeenCalledTimes(1);
    } finally { listed.mockRestore(); }
  });

  it("retains a refused worktree's files and Git registration, and retries a partially removed review batch", async () => {
    const repo = await makeProduct(join(temp, "refused-removal")), faults = new FileFaults();
    const sha = await git(repo, "rev-parse", "HEAD"), folder = join(temp, "refused-removal.copies");
    const blocked = join(folder, "blocked"), clear = join(folder, "clear");
    await addCopy(repo, blocked, sha); await addCopy(repo, clear, sha);
    writeFileSync(join(blocked, "keep"), "Still recoverable");
    const release = faults.blockRemoval(blocked);
    try {
      await expectRejection(removeWorktree(repo, blocked, faults.files), "in use or locked");
      expect(readFileSync(join(blocked, "keep"), "utf8")).toBe("Still recoverable");
      expect(await git(repo, "worktree", "list", "--porcelain", "-z")).toContain(realpathSync.native(blocked));
      await expectRejection(removeFinishedCopies(repo, folder, faults.files), "in use or locked");
      expect(existsSync(clear)).toBe(false);
      expect(readFileSync(join(blocked, "keep"), "utf8")).toBe("Still recoverable");
      release();
      expect(await removeFinishedCopies(repo, folder, faults.files)).toBe(true);
      expect(existsSync(folder)).toBe(false);
      const recorded = await git(repo, "worktree", "list", "--porcelain", "-z");
      expect(recorded).not.toContain(blocked); expect(recorded).not.toContain(clear);
      expect(await git(repo, "rev-parse", "HEAD")).toBe(sha);
    } finally { release(); }
  });

  it("prunes deleted review copies in one batch, preserving saved screen copies and unrelated worktrees", async () => {
    const repo = join(temp, "batch-copies"); mkdirSync(repo);
    await git(repo, "init", "-q", "-b", "main"); await git(repo, "config", "user.email", "test@example.com"); await git(repo, "config", "user.name", "Test");
    writeFileSync(join(repo, "README.md"), "Keep the product\n"); await git(repo, "add", "."); await git(repo, "commit", "-qm", "Initial");
    const sha = await git(repo, "rev-parse", "HEAD"), folder = join(temp, "batch.copies");
    const kept = join(folder, "screen"), gone = [join(folder, "review-0"), join(folder, "review-1")], unrelated = join(temp, "other-task");
    for (const copy of [kept, ...gone, unrelated]) await addCopy(repo, copy, sha);
    writeFileSync(join(kept, "screen.txt"), "Keep the screen work");
    rmSync(gone[0]!, { recursive: true, force: true }); // Recover a missing folder's fresh registration too.
    await removeCopies(repo, folder, [kept]);
    const registered = await git(repo, "worktree", "list", "--porcelain", "-z");
    expect(readFileSync(join(kept, "screen.txt"), "utf8")).toBe("Keep the screen work");
    expect(registered).toContain(realpathSync.native(kept)); expect(registered).toContain(realpathSync.native(unrelated));
    for (const copy of gone) { expect(existsSync(copy)).toBe(false); expect(registered).not.toContain(copy); }
    await removeCopies(repo, folder);
    expect(existsSync(folder)).toBe(false);
    expect(await git(repo, "worktree", "list", "--porcelain", "-z")).not.toContain(kept);
    expect(checkedOut(join(unrelated, "README.md"))).toBe("Keep the product\n");
  });

  it("names review copy folders portably and distinctly, keeping ordinary members' names", () => {
    for (const member of ["review-0", "review-12", "vote-opus-high", "vote-sol-high", "vote-3f2a9c1e-7b4d-4e8a-9f00-1a2b3c4d5e6f"]) expect(copyFolderName(member)).toBe(member);
    expect(copyFolderName("vote-third:argon-high")).toBe("vote-third_3aargon-high");
    // Distinct places that naive punctuation replacement, a case-insensitive disk or Windows' rules would merge or refuse.
    const members = [
      "vote-third:argon-high", "vote-third-argon-high", "vote-third_argon-high", "vote-third.argon-high", "vote-third argon-high", "vote-third/argon-high", "vote-third\\argon-high",
      "vote-third_3aargon-high", "vote-Third:argon-high", "vote-third:Argon-high", "vote-third:argon-high.", "vote-third:argon-high ", "vote-thïrd:argon-high", "vote-third:argon-high\u{1F600}",
      "vote-\uD800", "vote-\uDBFF", "con", "CON", "Nul", "com1", "lpt9", "_63on", "_",
    ];
    const names = members.map(copyFolderName);
    expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(members.length);
    const decode = (name: string) => name.replace(/_u([0-9a-f]{4})|_([0-9a-f]{2})/g, (_, wide?: string, narrow?: string) => String.fromCharCode(parseInt(wide ?? narrow!, 16)));
    for (const [index, name] of names.entries()) {
      // Only lowercase letters, digits, dashes and complete escapes: nothing Windows refuses or a disk folds together.
      expect(name).toMatch(/^(?:[a-z0-9-]|_[0-9a-f]{2}|_u[0-9a-f]{4})+$/);
      expect(name).not.toMatch(/^(con|prn|aux|nul|com\d|lpt\d)$/);
      expect(decode(name)).toBe(members[index]!);
      expect(copyFolderName(members[index]!)).toBe(name);
    }
    expect(copyFolderName("")).toBe("_");
    expect(names).not.toContain("_");
  });

  it("creates a separate real copy for each member that a naive or case-insensitive name would merge", async () => {
    const repo = join(temp, "portable-copies"); mkdirSync(repo);
    await git(repo, "init", "-q", "-b", "main"); await git(repo, "config", "user.email", "test@example.com"); await git(repo, "config", "user.name", "Test");
    writeFileSync(join(repo, "README.md"), "Keep the product\n"); await git(repo, "add", "."); await git(repo, "commit", "-qm", "Initial");
    const sha = await git(repo, "rev-parse", "HEAD"), folder = join(temp, "portable.copies");
    const members = ["vote-third:argon-high", "vote-third-argon-high", "vote-third_argon-high", "vote-Third:argon-high", "vote-third:argon-high.", "review-0"];
    const names = members.map(copyFolderName);
    for (const name of names) await addCopy(repo, join(folder, name), sha);
    expect(readdirSync(folder).sort()).toEqual([...names].sort());
    expect((await operations.linkedWorktrees(repo)).map((path) => basename(path)).sort()).toEqual([...names].sort());
    for (const name of names) expect(checkedOut(join(folder, name, "README.md"))).toBe("Keep the product\n");
    await removeCopies(repo, folder, [join(folder, names[0]!)]);
    expect(readdirSync(folder)).toEqual([names[0]!]);
    expect((await operations.linkedWorktrees(repo)).map((path) => basename(path))).toEqual([names[0]!]);
    await removeCopies(repo, folder);
    expect(existsSync(folder)).toBe(false);
  });

  it("does not follow a replaced review parent while preserving a screen conversation", async () => {
    const repo = join(temp, "batch-link"); mkdirSync(repo);
    await git(repo, "init", "-q", "-b", "main"); await git(repo, "config", "user.email", "test@example.com"); await git(repo, "config", "user.name", "Test");
    writeFileSync(join(repo, "README.md"), "Keep\n"); await git(repo, "add", "."); await git(repo, "commit", "-qm", "Initial");
    const real = join(temp, "live.copies"), alias = join(temp, "replaced.copies");
    const screen = join(real, "screen"), peer = join(real, "peer");
    for (const copy of [screen, peer]) await addCopy(repo, copy, await git(repo, "rev-parse", "HEAD"));
    writeFileSync(join(peer, "unsaved.txt"), "Unrelated work");
    fixtureFiles.directoryLink(real, alias);
    await removeCopies(repo, alias, [join(alias, "screen")]);
    expect(existsSync(alias)).toBe(false);
    expect(readFileSync(join(peer, "unsaved.txt"), "utf8")).toBe("Unrelated work");
    expect(await git(repo, "worktree", "list", "--porcelain", "-z")).toContain(realpathSync.native(screen));
  });

  for (const ownHome of [false, true]) it(`removes its private Git helpers on exit${ownHome ? " inside the engine home" : " in the system temp folder"}`, async () => {
    const parent = join(temp, ownHome ? "helper-home" : "helper-temp");
    const release = join(temp, ownHome ? "release-home" : "release-temp");
    mkdirSync(parent);
    const env: NodeJS.ProcessEnv = { ...testGitEnv(), TMPDIR: parent, TMP: parent, TEMP: parent };
    delete env.PETRINA_HOME;
    if (ownHome) env.PETRINA_HOME = parent;
    const script = `import { existsSync } from "node:fs";
import { run } from ${JSON.stringify(join(import.meta.dir, "../src/git.ts"))};
const result = await run(["git", "config", "--get", "core.hooksPath"], ${JSON.stringify(temp)});
if (result.code) throw new Error(result.stderr);
console.log(result.stdout.trim());
while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(20);`;
    const child = Bun.spawn([process.execPath, "-e", script], { cwd: temp, env, stdout: "pipe", stderr: "pipe" });
    try {
      const helper = dirname(await firstLine(child.stdout));
      expect(helper.startsWith(parent + sep)).toBe(true);
      expect(existsSync(join(helper, "hooks"))).toBe(true);
      writeFileSync(release, "go");
      expect(await child.exited).toBe(0);
      expect(existsSync(helper)).toBe(false);
    } finally {
      child.kill();
      await child.exited;
    }
  });

  it("unlinks a finished copy's replacement link without deleting another copy, its unsaved files, or the main clone", async () => {
    const repo = join(temp, "link-repo");
    const finished = join(temp, "link-finished");
    const active = join(temp, "link-active");
    mkdirSync(repo);
    await git(repo, "init", "-q", "-b", "main");
    await git(repo, "config", "user.email", "test@example.com");
    await git(repo, "config", "user.name", "Test");
    writeFileSync(join(repo, "README.md"), "kept\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-q", "-m", "init");
    await ensureWorktree(repo, active, "petrina/active", "main");
    writeFileSync(join(active, "unsaved.txt"), "keep my work\n");
    const refs = await git(repo, "for-each-ref", "--format=%(refname) %(objectname)");
    for (const target of [active, repo]) {
      await ensureWorktree(repo, finished, "petrina/finished", "main");
      rmSync(finished, { recursive: true, force: true });
      fixtureFiles.directoryLink(target, finished);
      expect(await removeWorktree(repo, finished)).toBe(true);
      expect(existsSync(finished)).toBe(false);
      const registered = (await git(repo, "worktree", "list", "--porcelain", "-z")).split("\0").filter((field) => field.startsWith("worktree ")).map((field) => realpathSync.native(field.slice("worktree ".length)));
      expect(new Set(registered)).toEqual(new Set([realpathSync.native(repo), realpathSync.native(active)]));
      expect(readFileSync(join(active, "unsaved.txt"), "utf8")).toBe("keep my work\n");
      expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("kept\n");
      expect(await git(repo, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(`${refs}\nrefs/heads/petrina/finished ${await git(repo, "rev-parse", "main")}`);
    }
  });

  for (const missing of ["neither", "copy", "parent"] as const) it(`matches a registered copy through parent aliases with ${missing === "neither" ? "its folders present" : `its ${missing} already missing`}`, async () => {
    const parent = join(temp, `native identity ${missing}`);
    const alias = join(temp, `parent-alias-${missing}`);
    const repo = join(parent, "product");
    const copies = join(parent, "copies");
    const copy = join(copies, "finished");
    const cache = join(parent, "shared-cache");
    mkdirSync(repo, { recursive: true });
    mkdirSync(cache);
    writeFileSync(join(cache, "keep"), "shared\n");
    await git(repo, "init", "-q", "-b", "main");
    await git(repo, "config", "user.email", "test@example.com");
    await git(repo, "config", "user.name", "Test");
    writeFileSync(join(repo, "README.md"), "product\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-q", "-m", "init");
    // Git records the native folder name; callers can arrive through a parent alias or a Windows
    // short temporary-folder name. Match the record even after the copy's parent is already gone.
    fixtureFiles.directoryLink(parent, alias);
    await ensureWorktree(repo, copy, `petrina/identity-${missing}`, "main");
    fixtureFiles.directoryLink(cache, join(copy, "cache"));
    const refs = await git(repo, "for-each-ref", "--format=%(refname) %(objectname)");
    const registered = async () => (await git(repo, "worktree", "list", "--porcelain", "-z")).split("\0").filter((field) => field.startsWith("worktree "));
    expect(await registered()).toHaveLength(2);
    if (missing !== "neither") rmSync(missing === "copy" ? copy : copies, { recursive: true, force: true });
    const rootAlias = join(alias, "product");
    const copyAlias = join(alias, "copies", "finished");
    expect(await removeWorktree(rootAlias, copyAlias)).toBe(true);
    expect(existsSync(copy)).toBe(false);
    expect(await registered()).toHaveLength(1);
    expect(existsSync(alias)).toBe(true);
    expect(readFileSync(join(cache, "keep"), "utf8")).toBe("shared\n");
    expect(await git(repo, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(refs);
    await expectRejection(removeWorktree(rootAlias, repo), "that folder holds the product itself");
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("product\n");
    expect(await removeWorktree(rootAlias, copyAlias)).toBe(false);
  });

  it("never run hooks or the file monitor an agent planted", async () => {
    const repo = join(temp, "repo");
    mkdirSync(repo, { recursive: true });
    await git(repo, "init", "-q", "-b", "main");
    await git(repo, "config", "user.email", "test@example.com");
    await git(repo, "config", "user.name", "Test");
    const marker = join(temp, "ran");
    const script = join(temp, "evil.sh");
    writeFileSync(script, `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(script, 0o755);
    writeFileSync(join(repo, ".git", "hooks", "pre-commit"), `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(join(repo, ".git", "hooks", "pre-commit"), 0o755);
    await git(repo, "config", "core.fsmonitor", script);
    writeFileSync(join(repo, "a.txt"), "hello\n");

    expect(await isClean(repo)).toBe(false);
    expect(await commitAll(repo, "Add a")).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(marker)).toBe(false);
  });

  it("names the product's repository from its origin, and one cloned from a folder on this computer by the clone's own folder", async () => {
    const repo = join(temp, "named");
    mkdirSync(repo, { recursive: true });
    await git(repo, "init", "-q", "-b", "main");
    await git(repo, "remote", "add", "origin", "git@github.com:acme/shop.git");
    expect(await repoInfo(repo)).toMatchObject({ owner: "acme", name: "shop" });
    for (const folder of ["C:\\Users\\ana\\origin.git", "C:/Users/ana/origin.git", "/home/ana/origin.git", "file:///home/ana/origin.git"]) {
      await git(repo, "remote", "set-url", "origin", folder);
      expect(await repoInfo(repo)).toMatchObject({ owner: "local", name: "named" });
    }
  });

  it("removes a locked working copy's folder and git record, keeps its branch, and refuses the product's own folder", async () => {
    const repo = join(temp, "cleanup-repo");
    const copy = join(temp, "cleanup-copy");
    mkdirSync(repo);
    await git(repo, "init", "-q", "-b", "main");
    await git(repo, "config", "user.email", "test@example.com");
    await git(repo, "config", "user.name", "Test");
    writeFileSync(join(repo, "README.md"), "kept\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-q", "-m", "init");
    const before = await git(repo, "rev-parse", "HEAD");
    await ensureWorktree(repo, copy, "petrina/cleanup", "main");
    await git(repo, "worktree", "lock", copy);
    mkdirSync(join(copy, "target", "release"), { recursive: true });
    writeFileSync(join(copy, "target", "release", "app"), "output");
    expect(await removeWorktree(repo, copy)).toBe(true);
    expect(existsSync(copy)).toBe(false);
    expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain("cleanup-copy");
    expect(await git(repo, "rev-parse", "petrina/cleanup")).toBe(before);
    expect(await removeWorktree(repo, copy)).toBe(false);
    await expectRejection(removeWorktree(repo, repo), "that folder holds the product itself");
    await expectRejection(removeWorktree(repo, temp), "that folder holds the product itself");
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("kept\n");
    expect(await git(repo, "rev-parse", "main")).toBe(before);
  });

  it("will not fetch with the coordinator's login when the repository's settings could misuse it", async () => {
    const repo = join(temp, "risky");
    mkdirSync(repo, { recursive: true });
    await git(repo, "init", "-q", "-b", "main");
    await git(repo, "remote", "add", "origin", "https://github.com/acme/shop.git");
    await git(repo, "config", "branch.main.remote", "origin");
    await git(repo, "config", "core.hooksPath", ".husky");
    expect(await riskySettings(repo)).toEqual([]);
    await git(repo, "config", "credential.helper", "!sh -c 'touch /tmp/stolen'");
    await git(repo, "config", "url.https://evil.example/.insteadOf", "https://github.com/");
    await git(repo, "config", "http.extraHeader", "X-Leak: 1");
    await git(repo, "config", "core.alternateRefsCommand", "sh -c id");
    expect((await riskySettings(repo)).sort()).toEqual(["core.alternaterefscommand", "credential.helper", "http.extraheader", "url.https://evil.example/.insteadof"]);
  });

  it("never waits on a stalled fetch", async () => {
    const origin = join(temp, "origin");
    mkdirSync(origin, { recursive: true });
    await git(origin, "init", "-q", "-b", "main");
    await git(origin, "config", "user.email", "test@example.com");
    await git(origin, "config", "user.name", "Test");
    writeFileSync(join(origin, "a.txt"), "a\n");
    await git(origin, "add", ".");
    await git(origin, "commit", "-q", "-m", "init");
    // An https address that accepts the connection and never answers.
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const started = Date.now();
    const result = await fetchBranch(origin, { url: `https://127.0.0.1:${server.port}/acme/shop.git` }, "main", 1500);
    server.stop(true);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result).toMatchObject({ ok: false, timedOut: true });
    await ensureWorktree(origin, join(temp, "wt"), "petrina/x", "main");
    expect(existsSync(join(temp, "wt", "a.txt"))).toBe(true);
  });

  it.skipIf(process.platform === "win32")("keeps a command that closed its output running inside its allowance, and still reports its exit, its timeout and a lost exit plainly", async () => {
    // A valid command that closes both pipes and keeps working: closed output is no evidence that it ended.
    const started = Date.now();
    const live = await operations.run(["sh", "-c", "exec >&- 2>&-; sleep 6.5; exit 0"], temp, undefined, { timeoutMs: 10_000 });
    expect(live).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(6_000);
    // An exit reported after the pipes close is an ordinary result; the time limit still ends one that runs past it.
    const reported = await operations.run(["sh", "-c", "echo done; exec >&- 2>&-; sleep 1; exit 3"], temp);
    expect(reported).toEqual({ code: 3, stdout: "done", stderr: "" });
    const limited = Date.now();
    const late = await operations.run(["sh", "-c", "exec >&- 2>&-; exec sleep 30"], temp, undefined, { timeoutMs: 2_000 });
    expect(late).toEqual({ code: 124, stdout: "", stderr: "timed out", timedOut: true });
    expect(Date.now() - limited).toBeLessThan(operations.EXIT_GRACE_MS + 2_000);
  });

  it.skipIf(process.platform === "win32")("fails within a bounded grace when a command's exit is never reported, keeping its complete output", async () => {
    // What a lost exit looks like: the output ended, the runtime never reports the exit, and the system shows the
    // child gone or defunct. A real defunct process stands in for the child; the runtime's report never comes.
    const defunct = await defunctProcess();
    const gone = Bun.spawn(["sh", "-c", "exit 0"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    await gone.exited;
    const standIn = (pid: number, out: string, err: string) => ({ pid, exited: new Promise<number>(() => {}), stdout: new Response(out).body!, stderr: new Response(err).body!, kill() {} }) as unknown as ReturnType<typeof Bun.spawn>;
    const spawning = spyOn(Bun, "spawn");
    try {
      await waitFor(async () => (await childState(defunct.pid)) === "ended", "the stand-in to be defunct", 10_000);
      spawning.mockReturnValueOnce(standIn(defunct.pid, "finished\n", "complaint\n"));
      const started = Date.now();
      const lost = await operations.run(["git", "status"], temp);
      const elapsed = Date.now() - started;
      expect(lost).toEqual({ code: 124, stdout: "finished", stderr: `complaint\n${operations.EXIT_UNREPORTED}`, timedOut: true, exitUnreported: true });
      expect(elapsed).toBeGreaterThanOrEqual(operations.EXIT_GRACE_MS);
      expect(elapsed).toBeLessThan(25_000);
      // A child already collected without its exit reported, under a time limit that is not what ends the wait.
      spawning.mockReturnValueOnce(standIn(gone.pid, "", ""));
      const collected = await operations.run(["git", "status"], temp, undefined, { timeoutMs: 60_000 });
      expect(collected).toEqual({ code: 124, stdout: "", stderr: operations.EXIT_UNREPORTED, timedOut: true, exitUnreported: true });
    } finally {
      spawning.mockRestore();
      await defunct.release();
    }
  });

  it.skipIf(process.platform === "win32")("bounds the whole command when an exited parent's child retains its output pipe", async () => {
    // The command's exit is known, but a helper still holds stdout. The explicit deadline
    // must cover draining as well as waiting for the command itself.
    const started = Date.now();
    const result = await operations.run(["sh", "-c", "sleep 2 & exit 0"], temp, undefined, { timeoutMs: 200 });
    expect(result).toMatchObject({ code: 124, timedOut: true });
    expect(result.stderr).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it.skipIf(process.platform === "win32")("detects a lost exit even when the runtime never closes an output stream", async () => {
    const defunct = await defunctProcess();
    let cancelled = false;
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("partial diagnostic\n")); },
      cancel() { cancelled = true; },
    });
    const spawning = spyOn(Bun, "spawn");
    try {
      await waitFor(async () => (await childState(defunct.pid)) === "ended", "the owned process to be defunct");
      spawning.mockReturnValueOnce({ pid: defunct.pid, exited: new Promise<number>(() => {}), stdout, stderr: new Response("").body!, kill() {} } as unknown as ReturnType<typeof Bun.spawn>);
      const started = Date.now();
      const result = await operations.run(["git", "worktree", "prune"], temp);
      expect(result).toEqual({ code: 124, timedOut: true, exitUnreported: true, stdout: "partial diagnostic", stderr: operations.EXIT_UNREPORTED });
      expect(Date.now() - started).toBeLessThan(25_000);
      expect(cancelled).toBe(true);
    } finally { spawning.mockRestore(); await defunct.release(); }
  });

  it("fails a bounded review-copy prune and releases its repository queue for the next cleanup", async () => {
    const calls = spyOn(operations, "run").mockResolvedValueOnce({ code: 124, stdout: "", stderr: "timed out", timedOut: true });
    const folder = join(temp, "bounded-prune.copies");
    try {
      await expectRejection(removeCopies(temp, folder), "review-copy records could not be cleaned");
      expect(calls.mock.calls[0]).toEqual([["git", "worktree", "prune"], temp, undefined, { timeoutMs: 60_000 }]);
      calls.mockResolvedValueOnce({ code: 7, stdout: "", stderr: "prune refused" });
      await expectRejection(removeCopies(temp, folder), "prune refused");
      calls.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
      await removeCopies(temp, folder);
      expect(calls).toHaveBeenCalledTimes(3);
    } finally { calls.mockRestore(); }
  });

  it("knows a GitHub address by its owner and name, SSH host nicknames included", () => {
    expect(githubRepoOf("https://github.com/acme/shop.git")).toBe("acme/shop");
    expect(githubRepoOf("git@github.com:acme/shop.git")).toBe("acme/shop");
    expect(githubRepoOf("git@github-work:acme/shop")).toBe("acme/shop");
    expect(githubRepoOf("ssh://git@github.com:22/acme/shop.git")).toBe("acme/shop");
    expect(githubRepoOf("https://evil.example/acme/shop.git")).toBeUndefined();
    expect(githubRepoOf("--upload-pack=sh:acme/shop")).toBeUndefined();
    // http and git:// on github.com are GitHub too: discovery already listed them, and adding one
    // used to keep the work on this machine because only https counted.
    for (const url of [
      "http://github.com/acme/shop.git",
      "http://www.github.com/acme/shop",
      "git://github.com/acme/shop.git",
      "git://github.com:9418/acme/shop.git",
      "https://github.com:443/acme/shop.git",
      "https://ssh.github.com/acme/shop.git",
    ]) {
      expect(githubRepoOf(url)).toBe("acme/shop");
      expect(githubRepo(url)).toBe("acme/shop");
      expect(sameRepo(url, "acme/shop")).toBe(true);
    }
    expect(githubRepoOf("http://gitlab.com/acme/shop.git")).toBeUndefined();
    expect(githubRepoOf("git://gitlab.com/acme/shop.git")).toBeUndefined();
    expect(githubRepoOf("http://github.com.evil/acme/shop.git")).toBeUndefined();
    expect(sameRepo("git@github-work:Acme/Shop.git", "acme/shop")).toBe(true);
    expect(sameRepo("git@github.com:evil/shop.git", "acme/shop")).toBe(false);
  });

  it("treats a remote section named after an address as unsafe", async () => {
    const repo = join(temp, "named");
    mkdirSync(repo, { recursive: true });
    await git(repo, "init", "-q", "-b", "main");
    await git(repo, "config", "remote.origin.url", "git@github-work:acme/shop");
    expect(await riskySettings(repo)).toEqual([]);
    await git(repo, "config", "remote.git@github-work:acme/shop.url", "/tmp/evil.git");
    expect(await riskySettings(repo)).toEqual(["remote.git@github-work:acme/shop.url"]);
  });

  describe("pushes and local updates", () => {
    const setup = async (name: string) => {
      const remote = join(temp, `${name}.git`);
      await gitWith({}, "init", "-q", "--bare", "-b", "main", remote);
      const repo = join(temp, name);
      mkdirSync(repo, { recursive: true });
      await git(repo, "init", "-q", "-b", "main");
      await git(repo, "config", "user.email", "test@example.com");
      await git(repo, "config", "user.name", "Test");
      await git(repo, "commit", "-q", "--allow-empty", "-m", "one");
      const one = await git(repo, "rev-parse", "HEAD");
      await git(repo, "push", "-q", remote, "main");
      await git(repo, "commit", "-q", "--allow-empty", "-m", "two");
      const two = await git(repo, "rev-parse", "HEAD");
      return { remote, repo, one, two, at: (ref: string) => gitWith({}, "--git-dir", remote, "for-each-ref", "--format=%(objectname)", ref) };
    };

    it("pushes main and a tag all or nothing, and refuses an existing tag", async () => {
      const { remote, repo, one, two, at } = await setup("atomic");
      await gitWith({}, "--git-dir", remote, "update-ref", "refs/tags/v1.0.0", one);
      const pushed = await push(repo, { url: remote, local: true }, [{ sha: two, ref: "refs/heads/main" }, { sha: two, ref: "refs/tags/v1.0.0" }], true);
      expect(pushed.ok).toBe(false);
      expect(await at("refs/heads/main")).toBe(one);
      expect(await at("refs/tags/v1.0.0")).toBe(one);
      expect((await push(repo, { url: remote, local: true }, [{ sha: two, ref: "refs/heads/main" }, { sha: two, ref: "refs/tags/v1.0.1" }], true)).ok).toBe(true);
      expect(await at("refs/heads/main")).toBe(two);
      expect(await at("refs/tags/v1.0.1")).toBe(two);
    });

    it("never forces: a branch that moved elsewhere on GitHub is refused, not overwritten", async () => {
      const { remote, repo, one, two, at } = await setup("forward");
      await git(repo, "commit", "-q", "--allow-empty", "-m", "elsewhere");
      const elsewhere = await git(repo, "rev-parse", "HEAD");
      await git(repo, "push", "-q", remote, "HEAD:main");
      expect((await push(repo, { url: remote, local: true }, [{ sha: two, ref: "refs/heads/main" }])).ok).toBe(false);
      expect(await at("refs/heads/main")).toBe(elsewhere);
      expect((await push(repo, { url: "--receive-pack=sh", local: true }, [{ sha: one, ref: "refs/heads/x" }])).ok).toBe(false);
      // The file transport is only for a test stand-in: without it, a folder is refused.
      expect((await push(repo, { url: remote }, [{ sha: two, ref: "refs/heads/other" }])).ok).toBe(false);
      expect(await at("refs/heads/other")).toBe("");
    });

    it("refuses a local update when the branch moved meanwhile, checked out or not", async () => {
      const { repo, one, two } = await setup("racing");
      // Not checked out: main must still be where Petrina saw it.
      await git(repo, "switch", "-q", "-c", "side", one);
      await git(repo, "commit", "-q", "--allow-empty", "-m", "a teammate's commit");
      const teammate = await git(repo, "rev-parse", "HEAD");
      await git(repo, "branch", "-f", "main", teammate);
      expect((await fastForward(repo, "main", one, two, false)).ok).toBe(false);
      expect(await git(repo, "rev-parse", "main")).toBe(teammate);
      // Checked out: refused just the same, history that is not ahead of it or not.
      await git(repo, "switch", "-q", "main");
      expect((await fastForward(repo, "main", one, two, true)).ok).toBe(false);
      expect(await git(repo, "rev-parse", "main")).toBe(teammate);
      await git(repo, "reset", "-q", "--hard", two);
      writeFileSync(join(repo, "greeting.txt"), "Hello\n");
      await git(repo, "add", "greeting.txt");
      await git(repo, "commit", "-q", "-m", "three");
      const three = await git(repo, "rev-parse", "HEAD");
      // Moved forward since Petrina looked, to a commit the tested one has: still refused, files untouched.
      await git(repo, "reset", "-q", "--hard", two);
      expect((await fastForward(repo, "main", one, three, true)).ok).toBe(false);
      expect(await git(repo, "rev-parse", "main")).toBe(two);
      expect(existsSync(join(repo, "greeting.txt"))).toBe(false);
      // A change in the way: the branch goes back and the change stays.
      writeFileSync(join(repo, "greeting.txt"), "Mine\n");
      expect((await fastForward(repo, "main", two, three, true)).ok).toBe(false);
      expect(await git(repo, "rev-parse", "main")).toBe(two);
      expect(checkedOut(join(repo, "greeting.txt"))).toBe("Mine\n");
      rmSync(join(repo, "greeting.txt"));
      expect((await fastForward(repo, "main", two, three, true)).ok).toBe(true);
      expect(await git(repo, "rev-parse", "main")).toBe(three);
      expect(checkedOut(join(repo, "greeting.txt"))).toBe("Hello\n");
      expect(await git(repo, "status", "--porcelain")).toBe("");
      expect(await git(repo, "rev-list", "--merges", "--count", "main")).toBe("0");
    });

    it("refuses a local update when the main copy switches branches at that moment, and stages nothing anywhere", async () => {
      const { repo, one } = await setup("switching");
      writeFileSync(join(repo, "greeting.txt"), "Hello\n");
      await git(repo, "add", "greeting.txt");
      await git(repo, "commit", "-q", "-m", "greeting");
      const tested = await git(repo, "rev-parse", "HEAD");
      await git(repo, "reset", "-q", "--hard", one);
      const lock = join(repo, ".git", "index.lock");
      const untouched = async () => {
        expect(await git(repo, "rev-parse", "main")).toBe(one);
        expect(await git(repo, "status", "--porcelain")).toBe("");
        expect(existsSync(join(repo, "greeting.txt"))).toBe(false);
      };
      // Petrina saw main open; the coordinator switches to another branch just before the update.
      await git(repo, "switch", "-q", "-c", "feature");
      expect(await fastForward(repo, "main", one, tested, true)).toEqual({ ok: false, error: "the main copy switched branches at that moment, so main stays where it was" });
      await untouched();
      expect(existsSync(lock)).toBe(false);
      // Petrina saw main not open; the copy switches to main just before: refused too.
      await git(repo, "switch", "-q", "main");
      expect((await fastForward(repo, "main", one, tested, false)).ok).toBe(false);
      await untouched();
      // A switch half done: the staging area and files are already another branch's, main still open.
      await git(repo, "switch", "-q", "-c", "other");
      writeFileSync(join(repo, "other.txt"), "Other\n");
      await git(repo, "add", "other.txt");
      await git(repo, "commit", "-q", "-m", "other");
      await git(repo, "symbolic-ref", "HEAD", "refs/heads/main");
      expect((await fastForward(repo, "main", one, tested, true)).ok).toBe(false);
      await git(repo, "symbolic-ref", "HEAD", "refs/heads/other");
      expect(await git(repo, "status", "--porcelain")).toBe("");
      await git(repo, "switch", "-q", "main");
      await untouched();
      // Another git command holds the lock: refused, and its lock stays.
      writeFileSync(lock, "");
      expect(await fastForward(repo, "main", one, tested, true)).toEqual({ ok: false, error: "another git command was working in the main copy at that moment" });
      expect(existsSync(lock)).toBe(true);
      rmSync(lock);
      await untouched();
      // Still on main: it goes through, and leaves no lock behind.
      expect((await fastForward(repo, "main", one, tested, true)).ok).toBe(true);
      expect(await git(repo, "rev-parse", "main")).toBe(tested);
      expect(checkedOut(join(repo, "greeting.txt"))).toBe("Hello\n");
      expect(await git(repo, "status", "--porcelain")).toBe("");
      expect(existsSync(lock)).toBe(false);
    });
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
