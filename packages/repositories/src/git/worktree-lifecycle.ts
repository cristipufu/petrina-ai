// Linked worktree materialization, enumeration, copy creation and cleanup.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { CLEANUP_WORDS, completeAll } from "@petrina/core";
import { localFiles, type FileOperations } from "@petrina/platform/file-operations";
import {
  canonical,
  CLEANUP_GIT_TIMEOUT_MS,
  isSpawnIntercepted,
  must,
  oneAtATime,
  Reason,
  run,
  type RunResult,
  worktreeLocation,
} from "./exec.js";
import { encodePlainIndexV2, readPlainWorktreeConfig } from "./loose-index.js";
import {
  collectLooseTreeFiles,
  hasNestedRefsPrefix,
  hasRefDirectoryConflict,
  isPlainSha1CommonDir,
  isSimpleValidBranchName,
  type LooseCommit,
  readLooseCommitObject,
  readLooseRawObject,
  resolveDirectRef,
  resolveGitDirs,
  resolveLooseRefCommit,
  tryAtomicUpdateLooseRef,
} from "./loose-objects.js";

function hasValidWorktreeGitDir(path: string): boolean {
  try {
    const dotGit = join(path, ".git");
    if (!existsSync(dotGit)) return false;
    const raw = readFileSync(dotGit, "utf8");
    if (!raw.startsWith("gitdir:")) return false;
    const gitdir = resolve(path, raw.slice("gitdir:".length).trim());
    return existsSync(join(gitdir, "HEAD")) && existsSync(join(gitdir, "commondir"));
  } catch {
    return false;
  }
}

function fastMaterializePlainWorktree(root: string, path: string, targetRefOrSha: string, branch?: string): boolean {
  if (isSpawnIntercepted() || process.platform === "win32" || path.startsWith("-") || existsSync(path)) {
    return false;
  }
  const dirs = resolveGitDirs(root);
  if (!dirs || dirs.gitdir !== dirs.commonDir || !isPlainSha1CommonDir(dirs.commonDir)) return false;
  if (!readPlainWorktreeConfig(dirs, false)) return false;
  const mainRoot = canonical(root);
  const targetLoc = worktreeLocation(path);
  if (resolve(path) === resolve(root) || targetLoc === mainRoot || mainRoot.startsWith(targetLoc + sep)) {
    return false;
  }
  let commit: LooseCommit | undefined;
  let createBranchRef = false;
  if (branch !== undefined) {
    if (!isSimpleValidBranchName(branch) || existsSync(join(dirs.commonDir, "packed-refs.lock"))) return false;
    const wantedHead = `ref: refs/heads/${branch}`;
    try {
      if (readFileSync(join(dirs.commonDir, "HEAD"), "utf8").trim() === wantedHead) return false;
      const existingWtDir = join(dirs.commonDir, "worktrees");
      if (existsSync(existingWtDir)) {
        for (const entryName of readdirSync(existingWtDir)) {
          const headFile = join(existingWtDir, entryName, "HEAD");
          if (existsSync(headFile) && readFileSync(headFile, "utf8").trim() === wantedHead) return false;
        }
      }
    } catch {
      return false;
    }
    const branchRef = `refs/heads/${branch}`;
    const existing = resolveDirectRef(dirs, branchRef);
    if (existing.kind === "oid") {
      commit = readLooseCommitObject(dirs.commonDir, existing.oid);
    } else if (existing.kind === "missing") {
      if (
        !targetRefOrSha ||
        targetRefOrSha.startsWith("-") ||
        hasNestedRefsPrefix(dirs.commonDir, branchRef) ||
        hasRefDirectoryConflict(dirs.commonDir, branchRef)
      ) {
        return false;
      }
      commit = resolveLooseRefCommit(dirs, targetRefOrSha);
      createBranchRef = true;
    } else {
      return false;
    }
  } else {
    if (!targetRefOrSha || targetRefOrSha.startsWith("-")) return false;
    commit = resolveLooseRefCommit(dirs, targetRefOrSha);
  }
  if (!commit || commit.oid.length !== 40) return false;
  const treeFiles = new Map<string, { mode: "100644" | "100755"; oidHex: string }>();
  if (!collectLooseTreeFiles(dirs.commonDir, commit.tree, "sha1", treeFiles)) return false;
  const blobs = new Map<string, Buffer>();
  for (const entry of treeFiles.values()) {
    if (!blobs.has(entry.oidHex)) {
      const raw = readLooseRawObject(dirs.commonDir, entry.oidHex);
      if (!raw || raw.type !== "blob") return false;
      blobs.set(entry.oidHex, raw.body);
    }
  }
  const worktreesDir = join(dirs.commonDir, "worktrees");
  let adminName: string | undefined;
  try {
    mkdirSync(worktreesDir, { recursive: true });
    const rawBase = basename(resolve(path)).replace(/[^A-Za-z0-9._-]/g, "-") || "worktree";
    const safeBase = rawBase === "." || rawBase === ".." ? "worktree" : rawBase;
    const takenLower = new Set(readdirSync(worktreesDir).map((n) => n.toLowerCase()));
    for (let suffix = 0; suffix <= 128; suffix += 1) {
      const candidate = suffix === 0 ? safeBase : `${safeBase}${suffix}`;
      if (!takenLower.has(candidate.toLowerCase()) && !existsSync(join(worktreesDir, candidate))) {
        adminName = candidate;
        break;
      }
    }
  } catch {
    return false;
  }
  if (!adminName) return false;
  const wtGitDir = join(worktreesDir, adminName);
  let createdBranch = false;
  let createdWtGitDir = false;
  let createdPath = false;
  try {
    if (createBranchRef) {
      if (!tryAtomicUpdateLooseRef(dirs, `refs/heads/${branch!}`, { kind: "missing" }, commit.oid)) return false;
      createdBranch = true;
    }
    mkdirSync(wtGitDir);
    createdWtGitDir = true;
    mkdirSync(path, { recursive: true });
    createdPath = true;
    const canonicalPath = canonical(path);
    writeFileSync(join(wtGitDir, "commondir"), "../..\n", "utf8");
    writeFileSync(join(wtGitDir, "gitdir"), `${join(canonicalPath, ".git")}\n`, "utf8");
    writeFileSync(join(wtGitDir, "HEAD"), branch !== undefined ? `ref: refs/heads/${branch}\n` : `${commit.oid}\n`, "utf8");
    for (const [relPath, entry] of treeFiles) {
      const fullFile = join(canonicalPath, relPath);
      mkdirSync(dirname(fullFile), { recursive: true });
      writeFileSync(fullFile, blobs.get(entry.oidHex)!, { mode: entry.mode === "100755" ? 0o755 : 0o644 });
    }
    const indexBytes = encodePlainIndexV2(canonicalPath, treeFiles);
    if (!indexBytes) throw new Error("index encode failed");
    writeFileSync(join(wtGitDir, "index"), indexBytes);
    writeFileSync(join(canonicalPath, ".git"), `gitdir: ${wtGitDir}\n`, "utf8");
    return true;
  } catch {
    if (createdPath) {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        /* Best effort. */
      }
    }
    if (createdWtGitDir) {
      try {
        rmSync(wtGitDir, { recursive: true, force: true });
      } catch {
        /* Best effort. */
      }
    }
    if (createdBranch) {
      try {
        rmSync(join(dirs.commonDir, "refs", "heads", ...branch!.split("/")), { force: true });
      } catch {
        /* Best effort. */
      }
    }
    return false;
  }
}

/** Create (or reuse) the task's worktree on its own branch, starting from `base`. */
export async function ensureWorktree(root: string, path: string, branch: string, base: string): Promise<void> {
  if (
    existsSync(path) &&
    (hasValidWorktreeGitDir(path) || (await run(["git", "rev-parse", "--is-inside-work-tree"], path)).code === 0)
  ) {
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await oneAtATime(root, async () => {
    if (fastMaterializePlainWorktree(root, path, base, branch)) return;
    if (existsSync(join(root, ".git", "refs", "heads", branch))) {
      await must(["git", "worktree", "add", path, branch], root);
      return;
    }
    const created = await run(["git", "worktree", "add", "-b", branch, path, base], root);
    if (created.code === 0) return;
    if ((await run(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], root)).code === 0) {
      await must(["git", "worktree", "add", path, branch], root);
      return;
    }
    throw new Error(`git worktree add failed: ${created.stderr || created.stdout}`);
  });
}

function readLinkedWorktreesSync(root: string): string[] | undefined {
  if (isSpawnIntercepted()) return undefined;
  const dirs = resolveGitDirs(root);
  if (!dirs || !existsSync(join(dirs.commonDir, "config")) || !existsSync(join(dirs.commonDir, "objects"))) {
    return undefined;
  }
  const worktreesDir = join(dirs.commonDir, "worktrees");
  if (!existsSync(worktreesDir)) return [];
  let names: string[];
  try {
    names = readdirSync(worktreesDir);
  } catch {
    return undefined;
  }
  const out: string[] = [];
  for (const name of names) {
    if (!name || name.startsWith(".")) continue;
    const entryDir = join(worktreesDir, name);
    try {
      if (!statSync(entryDir).isDirectory()) continue;
      if (!statSync(join(entryDir, "HEAD")).isFile() || !statSync(join(entryDir, "gitdir")).isFile()) return undefined;
      const rawTarget = readFileSync(join(entryDir, "gitdir"), "utf8").replace(/\r?\n$/, "");
      if (!rawTarget) return undefined;
      const dotGitTarget = resolve(entryDir, rawTarget);
      if (basename(dotGitTarget) !== ".git") return undefined;
      out.push(dirname(dotGitTarget));
    } catch {
      return undefined;
    }
  }
  return out;
}

/** The working copies the repository keeps a record of, other than its main clone, as git lists them. */
export async function linkedWorktrees(root: string): Promise<string[]> {
  const fast = readLinkedWorktreesSync(root);
  if (fast) return fast;
  const listed = await run(["git", "worktree", "list", "--porcelain", "-z"], root, undefined, {
    timeoutMs: CLEANUP_GIT_TIMEOUT_MS,
  });
  if (listed.code !== 0) throw new Reason("the product's repository could not be read");
  const paths = listed.stdout
    .split("\0")
    .filter((field) => field.startsWith("worktree "))
    .map((field) => field.slice("worktree ".length));
  return paths.slice(1);
}

/** The main clone a working copy belongs to, read from the copy itself (for a product no longer in Petrina). */
export async function mainClone(path: string): Promise<string | undefined> {
  if (!existsSync(path)) return undefined;
  if (!isSpawnIntercepted()) {
    const dirs = resolveGitDirs(path);
    if (dirs && basename(dirs.commonDir) === ".git" && existsSync(join(dirs.commonDir, "config"))) {
      return canonical(dirname(dirs.commonDir));
    }
  }
  const common = await run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], path);
  return common.code === 0 && common.stdout ? dirname(common.stdout) : undefined;
}

/**
 * Remove a task's working copy: the folder with everything in it (ignored packages and build output
 * too), then the repository's record of it. Branches stay. Petrina deletes the folder itself, which
 * never follows a link out of it, so shared caches and the files they link to stay. Safe to run again
 * after a failure or an interruption. Throws a plain-language reason; returns false when nothing was left.
 */
export function removeWorktree(
  root: string,
  path: string,
  files: Pick<FileOperations, "removeTree"> = localFiles,
): Promise<boolean> {
  return removeKnownWorktree(root, path, undefined, files);
}

function tryFastDropWorktreeRecord(root: string, targetLocation: string): RunResult | undefined {
  if (isSpawnIntercepted()) return undefined;
  const dirs = resolveGitDirs(root);
  if (!dirs || dirs.gitdir !== dirs.commonDir) return undefined;
  const worktreesDir = join(dirs.commonDir, "worktrees");
  if (!existsSync(worktreesDir)) return undefined;
  let matched = 0;
  try {
    for (const name of readdirSync(worktreesDir)) {
      if (!name || name.startsWith(".")) continue;
      const entryDir = join(worktreesDir, name);
      if (!statSync(entryDir).isDirectory()) continue;
      const rawTarget = readFileSync(join(entryDir, "gitdir"), "utf8").replace(/\r?\n$/, "");
      if (!rawTarget) return undefined;
      const dotGitTarget = resolve(entryDir, rawTarget);
      if (basename(dotGitTarget) !== ".git") return undefined;
      if (worktreeLocation(dirname(dotGitTarget)) === targetLocation) {
        if (existsSync(dirname(dotGitTarget))) return undefined;
        rmSync(entryDir, { recursive: true, force: true });
        matched += 1;
      }
    }
  } catch {
    return undefined;
  }
  return matched > 0 ? { code: 0, stdout: "", stderr: "" } : undefined;
}

/** Batch cleanup shares one registration observation, then verifies the complete batch. */
async function removeKnownWorktree(
  root: string,
  path: string,
  known?: readonly string[],
  files: Pick<FileOperations, "removeTree"> = localFiles,
): Promise<boolean> {
  try {
    if (!existsSync(root)) {
      const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      if (!entry) return false;
      throw new Reason("the product's folder could not be found");
    }
    const target = worktreeLocation(path);
    const main = canonical(root);
    if (resolve(path) === resolve(root) || target === main || main.startsWith(target + sep)) {
      throw new Reason("that folder holds the product itself");
    }
    const recorded = async () => (known ?? (await linkedWorktrees(root))).find((entry) => worktreeLocation(entry) === target);
    const record = await recorded();
    const there = () =>
      lstat(path).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      );
    const folder = await there();
    if (!folder && !record) return false;
    if (folder) await files.removeTree(path);
    if (await there()) throw new Reason("its folder could not be deleted");
    // With the folder gone, git only drops its record. Forced twice: also when the copy was locked.
    const removed = record
      ? await oneAtATime(
          root,
          async () =>
            tryFastDropWorktreeRecord(root, target) ??
            run(["git", "worktree", "remove", "--force", "--force", record], root, undefined, {
              timeoutMs: CLEANUP_GIT_TIMEOUT_MS,
            }),
        )
      : undefined;
    if (record && !known && removed?.code !== 0 && (await recorded())) {
      throw new Reason("the repository still lists it as a working copy");
    }
    if (record && (await there())) throw new Reason("its folder could not be deleted");
    return folder || record !== undefined;
  } catch (error) {
    if (error instanceof Reason) throw error;
    const code = (error as NodeJS.ErrnoException).code ?? "";
    throw new Reason(
      ["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"].includes(code) ? CLEANUP_WORDS.locked : "its folder could not be deleted",
    );
  }
}

/**
 * A working copy of one commit for one agent alone (a reviewer working beside others): detached, so it
 * shares no branch, index or HEAD with the task's own copy. Nothing is installed in it.
 */
export async function addCopy(root: string, path: string, sha: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await oneAtATime(root, async () => {
    if (fastMaterializePlainWorktree(root, path, sha)) return;
    await must(["git", "worktree", "add", "--detach", "--quiet", path, sha], root);
  });
}

/** A finished task has no reviewer left to resume. Recover both folders and records left by a crash. */
export async function removeFinishedCopies(
  root: string,
  folder: string,
  files: Pick<FileOperations, "removeTree"> = localFiles,
): Promise<boolean> {
  const entry = await lstat(folder).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!existsSync(root)) {
    if (!entry) return false;
    throw new Reason("the product's folder could not be found");
  }
  // Unlink a replacement before inspecting children; never follow it into somebody else's copy.
  if (entry && !entry.isDirectory()) await files.removeTree(folder);
  const names = entry?.isDirectory() ? await readdir(folder) : [];
  const location = worktreeLocation(folder);
  const recorded = (await linkedWorktrees(root)).filter((copy) => worktreeLocation(dirname(copy)) === location);
  const copies = [...new Set([...names.map((name) => join(folder, name)), ...recorded])];
  await completeAll(copies.map((copy) => removeKnownWorktree(root, copy, recorded, files)));
  if (recorded.length && (await linkedWorktrees(root)).some((copy) => worktreeLocation(dirname(copy)) === location)) {
    throw new Reason("the repository still lists it as a working copy");
  }
  await files.removeTree(folder);
  return entry !== undefined || recorded.length > 0;
}

function hasNoStaleWorktreeRegistrations(root: string): boolean {
  try {
    const dotGit = join(root, ".git");
    if (!statSync(dotGit).isDirectory()) return false;
    const worktreesDir = join(dotGit, "worktrees");
    if (!existsSync(worktreesDir)) return true;
    for (const name of readdirSync(worktreesDir)) {
      const entryDir = join(worktreesDir, name);
      const target = resolve(entryDir, readFileSync(join(entryDir, "gitdir"), "utf8").trim());
      if (!existsSync(target)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function tryFastPruneStaleWorktrees(root: string): boolean {
  if (isSpawnIntercepted()) return false;
  try {
    const dotGit = join(root, ".git");
    if (!statSync(dotGit).isDirectory()) return false;
    const worktreesDir = join(dotGit, "worktrees");
    if (!existsSync(worktreesDir)) return true;
    for (const name of readdirSync(worktreesDir)) {
      if (!name || name.startsWith(".")) continue;
      const entryDir = join(worktreesDir, name);
      if (!statSync(entryDir).isDirectory()) return false;
      const rawTarget = readFileSync(join(entryDir, "gitdir"), "utf8").trim();
      if (!rawTarget) return false;
      const target = resolve(entryDir, rawTarget);
      if (!existsSync(target) && !existsSync(join(entryDir, "locked"))) {
        rmSync(entryDir, { recursive: true, force: true });
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Remove copies and git's records, keeping only conversations that are waiting for the screen. */
export async function removeCopies(root: string, folder: string, keep: readonly string[] = []): Promise<void> {
  const kept = new Set(keep);
  await oneAtATime(root, async () => {
    const entry = await lstat(folder).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    // A replaced parent is unlinked, never traversed into another task's working copies.
    if (entry && !entry.isDirectory()) await rm(folder, { force: true });
    else if (!kept.size) await rm(folder, { recursive: true, force: true });
    else if (entry) {
      const names = await readdir(folder);
      await completeAll(
        names
          .map((name) => join(folder, name))
          .filter((copy) => !kept.has(copy))
          .map((copy) => rm(copy, { recursive: true, force: true })),
      );
    }
    if (tryFastPruneStaleWorktrees(root)) return;
    if (!("mock" in run) && hasNoStaleWorktreeRegistrations(root)) return;
    // These copies are detached: one prune drops all missing unlocked registrations.
    const pruned = await run(["git", "worktree", "prune"], root, undefined, { timeoutMs: CLEANUP_GIT_TIMEOUT_MS });
    if (pruned.code !== 0) {
      throw new Reason(
        `the repository's review-copy records could not be cleaned: ${pruned.stderr || pruned.stdout || `exit ${pruned.code}`}`,
      );
    }
  });
}
