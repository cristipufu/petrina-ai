import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import * as operations from "../../../src/git.js";
import { addCopy, ensureWorktree, removeCopies, removeFinishedCopies, removeWorktree } from "../../../src/git.js";
import { copyFolderName } from "../../../src/copy-name.js";
import { fixtureFiles } from "@petrina/test-support/fixture-files";
import { FileFaults } from "@petrina/test-support/file-faults";
import { expectRejection } from "@petrina/test-support/rejections";
import { committedRepositoryFixtures } from "../../fixtures/committed-repositories.js";
import { git } from "@petrina/test-support/commands";
import { makeProduct } from "@petrina/test-support/repositories";

const temp = mkdtempSync(join(tmpdir(), "petrina-git-"));
const repositories = committedRepositoryFixtures(temp);

/** A file as checked out, in one line-ending style: git on Windows writes CRLF. */
const checkedOut = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

describe("Petrina's own git steps", () => {
  afterAll(() => repositories.close());

  it("unlinks a replaced reviewer folder without following it into an unfinished task", () => repositories.run(async () => {
    const repo = join(temp, "peer-link-repo");
    mkdirSync(repo);
    await repositories.copy(repo, { contents: "kept\n", message: "init" });
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
  }));

  it("ignores already absent copies when the product moved, but preserves existing folders for recovery", () => repositories.run(async () => {
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
  }));

  it("removes finished locked and missing snapshots with one registration read and one batch verification", () => repositories.run(async () => {
    const repo = join(temp, "finished-batch"); mkdirSync(repo);
    await repositories.copy(repo, { contents: "Keep the product\n", message: "Initial" });
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
  }));

  it("retains a refused worktree's files and Git registration, and retries a partially removed review batch", () => repositories.run(async () => {
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
  }));

  it("prunes deleted review copies in one batch, preserving saved screen copies and unrelated worktrees", () => repositories.run(async () => {
    const repo = join(temp, "batch-copies"); mkdirSync(repo);
    await repositories.copy(repo, { contents: "Keep the product\n", message: "Initial" });
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
  }));

  it("creates a separate real copy for each member that a naive or case-insensitive name would merge", () => repositories.run(async () => {
    const repo = join(temp, "portable-copies"); mkdirSync(repo);
    await repositories.copy(repo, { contents: "Keep the product\n", message: "Initial" });
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
  }));

  it("does not follow a replaced review parent while preserving a screen conversation", () => repositories.run(async () => {
    const repo = join(temp, "batch-link"); mkdirSync(repo);
    await repositories.copy(repo, { contents: "Keep\n", message: "Initial" });
    const real = join(temp, "live.copies"), alias = join(temp, "replaced.copies");
    const screen = join(real, "screen"), peer = join(real, "peer");
    for (const copy of [screen, peer]) await addCopy(repo, copy, await git(repo, "rev-parse", "HEAD"));
    writeFileSync(join(peer, "unsaved.txt"), "Unrelated work");
    fixtureFiles.directoryLink(real, alias);
    await removeCopies(repo, alias, [join(alias, "screen")]);
    expect(existsSync(alias)).toBe(false);
    expect(readFileSync(join(peer, "unsaved.txt"), "utf8")).toBe("Unrelated work");
    expect(await git(repo, "worktree", "list", "--porcelain", "-z")).toContain(realpathSync.native(screen));
  }));

  it("unlinks a finished copy's replacement link without deleting another copy, its unsaved files, or the main clone", () => repositories.run(async () => {
    const repo = join(temp, "link-repo");
    const finished = join(temp, "link-finished");
    const active = join(temp, "link-active");
    mkdirSync(repo);
    await repositories.copy(repo, { contents: "kept\n", message: "init" });
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
  }));

  for (const missing of ["neither", "copy", "parent"] as const) it(`matches a registered copy through parent aliases with ${missing === "neither" ? "its folders present" : `its ${missing} already missing`}`, () => repositories.run(async () => {
    const parent = join(temp, `native identity ${missing}`);
    const alias = join(temp, `parent-alias-${missing}`);
    const repo = join(parent, "product");
    const copies = join(parent, "copies");
    const copy = join(copies, "finished");
    const cache = join(parent, "shared-cache");
    mkdirSync(repo, { recursive: true });
    mkdirSync(cache);
    writeFileSync(join(cache, "keep"), "shared\n");
    await repositories.copy(repo, { contents: "product\n", message: "init" });
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
  }));

  it("removes a locked working copy's folder and git record, keeps its branch, and refuses the product's own folder", () => repositories.run(async () => {
    const repo = join(temp, "cleanup-repo");
    const copy = join(temp, "cleanup-copy");
    mkdirSync(repo);
    await repositories.copy(repo, { contents: "kept\n", message: "init" });
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
  }));

  it("fails a bounded review-copy prune and releases its repository queue for the next cleanup", () => repositories.run(async () => {
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
  }));
});
