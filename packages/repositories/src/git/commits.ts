// Local commit creation, folding, root-file updates and local branch pointer movements.

import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isBranchName, isRefName, isSha } from "../identity.js";
import { type Check, commandFailure, isSpawnIntercepted, must, run } from "./exec.js";
import {
  collectLooseTreeFiles,
  FULL_OID,
  hasNestedRefsPrefix,
  hasReplaceRefs,
  isPlainSha1CommonDir,
  isSimpleValidBranchName,
  readLooseCommitObject,
  readLooseRawObject,
  resolveDirectRef,
  resolveGitDirs,
  SHA,
  tryAtomicUpdateLooseRef,
} from "./loose-objects.js";
import {
  computeTrackedDiffersFromHead,
  inspectPlainWorktree,
  syncCleanWorktreeFilesAndEncodeIndex,
  tryFastCommitChanges,
  tryFastCommitTree,
  tryFastFoldCommit,
  tryFastObserveContentTree,
  tryFastRestoreWorktreeToCommit,
  verifyCleanWorktree,
  writeLooseRootFileTree,
} from "./loose-index.js";
import { contains, currentBranch, head, revParse, treeOf } from "./revisions.js";
import { worktreeStatus } from "./worktrees.js";

/** Undo anything a read-only agent changed in its working copy. Also ends an unfinished merge. */
export async function discardChanges(path: string): Promise<void> {
  if (tryFastRestoreWorktreeToCommit(path, undefined, true)) return;
  await run(["git", "reset", "--hard", "--quiet"], path);
  await run(["git", "clean", "-fd", "--quiet"], path);
}

/** Commit everything in the worktree; confirmation does not require a second version observation. */
export async function commitChanges(path: string, message: string): Promise<boolean> {
  if (verifyCleanWorktree(path)) return false;
  const fast = tryFastCommitChanges(path, message);
  if (fast !== undefined) return fast;
  await must(["git", "add", "-A"], path);
  const committed = await run(["git", "commit", "--quiet", "-F", "-"], path, message);
  if (committed.code === 0) return true;
  if ((await run(["git", "diff", "--cached", "--quiet"], path)).code === 0) return false;
  throw new Error(`git commit --quiet failed: ${committed.stderr || committed.stdout}`);
}

/** Commit everything in the worktree. Returns the new sha, or undefined when there was nothing to commit. */
export async function commitAll(path: string, message: string): Promise<string | undefined> {
  if (!await commitChanges(path, message)) return undefined;
  return head(path);
}

/** Resolve HEAD once, returning the commit and the tree it actually holds. */
export async function commitVersion(path: string): Promise<{ head?: string; tree?: string }> {
  if (!isSpawnIntercepted()) {
    const dirs = resolveGitDirs(path);
    if (dirs && !hasReplaceRefs(dirs.commonDir)) {
      const resolved = resolveDirectRef(dirs, "HEAD");
      if (resolved.kind === "oid") {
        const commit = readLooseCommitObject(dirs.commonDir, resolved.oid);
        if (commit) return { head: commit.oid, tree: commit.tree };
      }
    }
  }
  const result = await run(["git", "show", "--no-patch", "--format=%H%n%T", "HEAD"], path);
  if (result.code !== 0) return {};
  const [head, tree] = result.stdout.split("\n");
  return head && tree && SHA.test(head) && SHA.test(tree) ? { head, tree } : {};
}

/** Observe all committable contents without changing the real staging area. */
export async function contentTree(path: string, saved?: { commit: string; tree: string }): Promise<string | undefined> {
  return (await observeContentTree(path, saved)).tree;
}

export async function observeContentTree(path: string, saved?: { commit: string; tree: string }): Promise<{ head?: string; tree?: string }> {
  const fast = tryFastObserveContentTree(path, saved);
  if (fast) return fast;
  const status = await worktreeStatus(path);
  if (status.clean && status.head) {
    const tree = saved?.commit === status.head && saved.tree ? saved.tree : await treeOf(path, status.head);
    return { head: status.head, tree };
  }
  const folder = mkdtempSync(join(tmpdir(), "petrina-content-tree-"));
  const options = { index: join(folder, "index") };
  try {
    if ((await run(["git", "read-tree", "HEAD"], path, undefined, options)).code !== 0) return { head: status.head };
    if ((await run(["git", "add", "-A"], path, undefined, options)).code !== 0) return { head: status.head };
    const tree = await run(["git", "write-tree"], path, undefined, options);
    return { head: status.head, tree: tree.code === 0 && SHA.test(tree.stdout) ? tree.stdout : undefined };
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

/**
 * The branch's work as one commit on top of its resolved fork, with the same code and `message`.
 * The caller resolves the fork first. Return the exact resulting commit/tree without another observation.
 */
export async function squash(path: string, fork: string, message: string): Promise<{ head: string; tree: string }> {
  if (!isSha(fork)) throw new Error("Not a complete fork commit");
  return (await observeFold(path)).squash(fork, message);
}

export type FoldObservation = ({ kind: "observed"; head: string; tree: string; parents: readonly string[] }
  | { kind: "unavailable" }) & { squash(fork: string, message: string): Promise<{ head: string; tree: string }> };

/** One operation's actual commit metadata and bound, single-use fold; never cached between operations. */
export async function observeFold(path: string): Promise<FoldObservation> {
  let captured: { head: string; tree: string; parents: string[]; body: string } | undefined;
  let failure: { error: unknown } | undefined;
  if (!isSpawnIntercepted()) {
    const dirs = resolveGitDirs(path);
    if (dirs && !hasReplaceRefs(dirs.commonDir) && !existsSync(join(dirs.commonDir, "info", "grafts"))) {
      const resolved = resolveDirectRef(dirs, "HEAD");
      if (resolved.kind === "oid") {
        const commit = readLooseCommitObject(dirs.commonDir, resolved.oid);
        if (commit && isSha(commit.oid) && isSha(commit.tree) && commit.parents.every((parent) => isSha(parent))) {
          captured = { head: commit.oid, tree: commit.tree, parents: [...commit.parents], body: commit.body.trim() };
        }
      }
    }
  }
  if (!captured) {
    try {
      // Raw parents, never the optional commit graph, prove an existing single task commit.
      const [head, tree, parents, ...body] = (await must(
        [
        "git",
        "-c",
        "core.commitGraph=false",
        "show",
        "--no-patch",
        "--format=%H%n%T%n%P%n%B",
        "HEAD"
      ],
        path
      )).split("\n");
      if (!head || !tree || !isSha(head) || !isSha(tree)) throw new Error("The task's current commit could not be read");
      const recordedParents = parents ? parents.split(" ") : [];
      if (recordedParents.some(parent => !isSha(parent))) throw new Error("The task's current commit could not be read");
      captured = { head, tree, parents: recordedParents, body: body.join("\n") };
    } catch (error) { failure = { error }; }
  }
  let consumed = false;
  const fold = async (fork: string, message: string): Promise<{ head: string; tree: string }> => {
    if (!isSha(fork)) throw new Error("Not a complete fork commit");
    if (consumed) throw new Error("A fold observation belongs to one operation");
    consumed = true;
    // An unavailable observation stays unavailable; it must never be retried into successful proof.
    if (failure) throw failure.error;
    const { head, tree, parents, body } = captured!;
    if (head === fork || (parents.length === 1 && parents[0] === fork && body.trim() === message.trim())) return { head, tree };
    const fastSha = tryFastFoldCommit(path, head, tree, fork, message);
    if (fastSha) return { head: fastSha, tree };
    // Create the commit first; move the branch last, preserving the original index/worktree semantics.
    const sha = await must(["git", "commit-tree", tree, "-p", fork, "-F", "-"], path, message);
    if (!isSha(sha)) throw new Error("The folded task commit could not be created");
    await must(["git", "reset", "--soft", "--quiet", sha], path);
    return { head: sha, tree };
  };
  return captured ? { kind: "observed", head: captured.head, tree: captured.tree, parents: Object.freeze([...captured.parents]), squash: fold }
    : { kind: "unavailable", squash: fold };
}

/** `tree` with the root file `name` holding `text`, written without touching any working copy or its staging area. */
export async function withRootFile(path: string, tree: string, name: string, mode: string, text: string): Promise<string> {
  if (!SHA.test(tree) || !/^100(644|755)$/.test(mode) || name.includes("/")) throw new Error("Not a tree or a plain file");
  const fast = writeLooseRootFileTree(path, tree, name, mode, text);
  if (fast) return fast;
  const blob = await must(["git", "hash-object", "-w", "--stdin"], path, text);
  if (!SHA.test(blob)) throw new Error("git hash-object did not return a file");
  const folder = mkdtempSync(join(tmpdir(), "petrina-file-tree-"));
  const options = { index: join(folder, "index") };
  try {
    for (const cmd of [["git", "read-tree", tree], ["git", "update-index", "--add", "--cacheinfo", `${mode},${blob},${name}`]]) {
      const result = await run(cmd, path, undefined, options);
      if (result.code !== 0) throw new Error(`${cmd.slice(0, 2).join(" ")} failed: ${result.stderr || result.stdout}`);
    }
    const written = await run(["git", "write-tree"], path, undefined, options);
    if (written.code !== 0 || !SHA.test(written.stdout)) throw new Error(`git write-tree failed: ${written.stderr || written.stdout}`);
    return written.stdout;
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

/** A commit of `tree` on top of `parent`, made without hooks and without touching any working copy. */
export async function commitTree(path: string, tree: string, parent: string, message: string): Promise<string> {
  const fast = tryFastCommitTree(path, tree, parent, message);
  if (fast) return fast;
  const sha = await must(["git", "commit-tree", tree, "-p", parent, "-F", "-"], path, message);
  if (!SHA.test(sha)) throw new Error("git commit-tree did not return a commit");
  return sha;
}

/** Open an existing local branch in a working copy. */
export async function switchTo(path: string, branch: string): Promise<Check<void>> {
  if (!isRefName(branch)) return { ok: false, error: "not a branch Petrina opens" };
  const switched = await run(["git", "switch", "--quiet", "--no-guess", branch], path);
  return switched.code === 0 ? { ok: true, value: undefined } : commandFailure(switched);
}

/**
 * Move a local branch forward from `from` to `to`, with no network and never a merge commit. The
 * branch moves only if it is still at `from`, in one step, so a branch that moved meanwhile is
 * refused. Checked out in `root`, its files then follow with git's own fast-forward of the files from
 * `from` to `to`, which refuses to overwrite any change; when it cannot, the branch goes back.
 *
 * Throughout, Petrina holds git's own lock on the main copy's staging area, the one every switch,
 * commit and add takes first: the copy cannot switch branches halfway, so the update never lands
 * on another branch. A copy that switched just before is refused, and nothing changes.
 */
export async function fastForward(root: string, branch: string, from: string, to: string, checkedOutHere: boolean): Promise<Check<void>> {
  if (!isRefName(branch) || !isSha(from) || !isSha(to)) return { ok: false, error: "not an update Petrina makes" };
  if (!(await contains(root, to, from))) return { ok: false, error: `${to.slice(0, 7)} is not ahead of ${from.slice(0, 7)}` };
  return moveLocalBranch(root, branch, from, to, checkedOutHere);
}

/** Replace only Petrina's exact unpushed task commit after carrying it onto newer source commits. */
export async function replaceLocalDelivery(root: string, branch: string, from: string, to: string, checkedOutHere: boolean): Promise<Check<void>> {
  if (!isRefName(branch) || !isSha(from) || !isSha(to)) return { ok: false, error: "not a delivery Petrina replaces" };
  const base = await revParse(root, `${from}^`);
  if (!base || !(await contains(root, to, base))) return { ok: false, error: "the new delivery does not preserve the previous source commits" };
  return moveLocalBranch(root, branch, from, to, checkedOutHere);
}

async function moveLocalBranch(root: string, branch: string, from: string, to: string, checkedOutHere: boolean): Promise<Check<void>> {
  const ref = `refs/heads/${branch}`;
  const dirs = !process.env.GIT_INDEX_FILE ? resolveGitDirs(root) : undefined;
  let index: string;
  if (dirs) {
    index = join(dirs.gitdir, "index");
  } else {
    const located = await run(["git", "rev-parse", "--git-path", "index"], root);
    if (located.code !== 0) return commandFailure(located);
    index = resolve(root, located.stdout);
  }
  const lock = `${index}.lock`;
  try {
    closeSync(openSync(lock, "wx"));
  } catch {
    return { ok: false, error: "another git command was working in the main copy at that moment" };
  }
  let installed = false;
  try {
    if (((await currentBranch(root)) === branch) !== checkedOutHere) return {
      ok: false,
      error: `the main copy switched branches at that moment, so ${branch} stays where it was`
    };
    if (!isSpawnIntercepted() && dirs && /^[0-9a-f]{40}$/i.test(from) && /^[0-9a-f]{40}$/i.test(to) && isSimpleValidBranchName(branch) && isPlainSha1CommonDir(dirs.commonDir)) {
      const fromLower = from.toLowerCase();
      const toLower = to.toLowerCase();
      const toCommit = readLooseCommitObject(dirs.commonDir, toLower);
      if (toCommit) {
        if (!checkedOutHere) {
          if (tryAtomicUpdateLooseRef(dirs, ref, { kind: "oid", oid: fromLower }, toLower)) {
            return { ok: true, value: undefined };
          }
        } else if (process.platform !== "win32") {
          const full = inspectPlainWorktree(root, true, true);
          if (
            full &&
            full.format === "sha1" &&
            full.branch === branch &&
            full.headCommit.oid === fromLower &&
            full.untrackedFiles.length === 0 &&
            computeTrackedDiffersFromHead(full) === false
          ) {
            const fromFiles = new Map<string, { mode: "100644" | "100755"; oidHex: string }>();
            const toFiles = new Map<string, { mode: "100644" | "100755"; oidHex: string }>();
            if (
              collectLooseTreeFiles(dirs.commonDir, full.headCommit.tree, "sha1", fromFiles) &&
              collectLooseTreeFiles(dirs.commonDir, toCommit.tree, "sha1", toFiles)
            ) {
              let allBlobsPresent = true;
              for (const [relPath, toEntry] of toFiles) {
                const fromEntry = fromFiles.get(relPath);
                if ((!fromEntry || fromEntry.oidHex !== toEntry.oidHex) && readLooseRawObject(dirs.commonDir, toEntry.oidHex)?.type !== "blob") {
                  allBlobsPresent = false;
                  break;
                }
              }
              if (allBlobsPresent && tryAtomicUpdateLooseRef(dirs, ref, { kind: "oid", oid: fromLower }, toLower)) {
                const indexBytes = syncCleanWorktreeFilesAndEncodeIndex(root, dirs.commonDir, fromFiles, toFiles);
                if (indexBytes && (await currentBranch(root)) === branch) {
                  writeFileSync(lock, indexBytes);
                  renameSync(lock, index);
                  installed = true;
                  return { ok: true, value: undefined };
                }
                tryAtomicUpdateLooseRef(dirs, ref, { kind: "oid", oid: toLower }, fromLower);
              }
            }
          }
        }
      }
    }
    if (checkedOutHere) {
      // The staging area as it is, in the lock: nothing staged, and no switch left half done.
      writeFileSync(lock, readFileSync(index));
      if ((await run(["git", "diff-index", "--cached", "--quiet", from, "--"], root, undefined, { index: lock })).code !== 0) {
        return { ok: false, error: `the main copy's staging area is not ${branch}'s, so ${branch} stays where it was` };
      }
    }
    const moved = await run(["git", "update-ref", "-m", "Delivered by Petrina", ref, to, from], root);
    if (moved.code !== 0) return commandFailure(moved);
    if (!checkedOutHere) return { ok: true, value: undefined };
    await run(["git", "update-index", "-q", "--refresh"], root, undefined, { index: lock });
    const files = await run(["git", "read-tree", "-m", "-u", from, to], root, undefined, { index: lock });
    // A switch already past the staging area before the lock: its files go back, and so does the branch.
    const stayed = files.code === 0 && (await currentBranch(root)) === branch;
    if (!stayed) {
      if (files.code === 0) await run(["git", "read-tree", "-m", "-u", to, from], root, undefined, { index: lock });
      await run(["git", "update-ref", "-m", "Petrina could not update the files", ref, from, to], root);
      return files.code === 0 ? { ok: false, error: `the main copy switched branches at that moment, so ${branch} stays where it was` } : commandFailure(files);
    }
    renameSync(lock, index);
    installed = true;
    return { ok: true, value: undefined };
  } finally {
    if (!installed) rmSync(lock, { force: true });
  }
}

/** Create only an absent local destination, without checking out or touching its files. */
export async function createBranchAt(root: string, branch: string, sha: string): Promise<Check<void>> {
  if (!isBranchName(branch) || !isSha(sha)) return { ok: false, error: "not a local branch Petrina creates" };
  if (!isSpawnIntercepted() && FULL_OID.test(sha) && isSimpleValidBranchName(branch)) {
    const dirs = resolveGitDirs(root);
    const ref = `refs/heads/${branch}`;
    if (
      dirs &&
      !hasNestedRefsPrefix(dirs.commonDir, ref) &&
      resolveDirectRef(dirs, ref).kind === "missing" &&
      readLooseCommitObject(dirs.commonDir, sha) &&
      tryAtomicUpdateLooseRef(dirs, ref, { kind: "missing" }, sha)
    ) {
      return { ok: true, value: undefined };
    }
  }
  const result = await run(["git", "update-ref", `refs/heads/${branch}`, sha, "0".repeat(sha.length)], root);
  return result.code === 0 ? { ok: true, value: undefined } : commandFailure(result);
}
