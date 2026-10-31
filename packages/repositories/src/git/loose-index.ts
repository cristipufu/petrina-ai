// Direct loose SHA-1 index v2 and worktree inspection/materialization fast paths.
// Preserves exact parity with Git CLI semantics and falls back on any non-plain state.

import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { isSpawnIntercepted } from "./exec.js";
import { encodePlainIndexV2 } from "./loose-object-writes.js";
import {
  collectLooseTreeFiles,
  isPlainSha1CommonDir,
  readLooseCommitObject,
  readLooseRawObject,
  tryAtomicUpdateLooseRef,
} from "./loose-objects.js";
import {
  computeTrackedDiffersFromHead,
  hasNoEmptyDirectories,
  inspectPlainWorktree,
  removeEmptyWorktreeDirs,
} from "./loose-worktree-inspect.js";

export {
  encodePlainIndexV2,
  SLASH_BYTE,
  tryFastCommitChanges,
  tryFastCommitTree,
  tryFastFoldCommit,
  tryFastObserveContentTree,
  writeLooseRootFileTree,
  writeLooseTreeFromMap,
} from "./loose-object-writes.js";
export {
  computeTrackedDiffersFromHead,
  inspectPlainWorktree,
  type PlainWorktreeInspection,
  readFastWorktreeBranchStatus,
  readPlainWorktreeConfig,
  verifyCleanWorktree,
} from "./loose-worktree-inspect.js";

export function syncCleanWorktreeFilesAndEncodeIndex(
  worktreePath: string,
  commonDir: string,
  fromFiles: ReadonlyMap<string, { mode: "100644" | "100755"; oidHex: string }>,
  toFiles: ReadonlyMap<string, { mode: "100644" | "100755"; oidHex: string }>,
): Buffer | undefined {
  if (process.platform === "win32") return undefined;
  const filesToDelete: string[] = [];
  const blobsToWrite: { relPath: string; buf: Buffer; modeNum: number; needChmod: boolean }[] = [];
  const modesToChmod: { relPath: string; modeNum: number }[] = [];
  for (const relPath of fromFiles.keys()) {
    if (!toFiles.has(relPath)) filesToDelete.push(relPath);
  }
  for (const [relPath, toEntry] of toFiles) {
    const fromEntry = fromFiles.get(relPath);
    const modeNum = toEntry.mode === "100755" ? 0o755 : 0o644;
    if (!fromEntry || fromEntry.oidHex !== toEntry.oidHex) {
      const blob = readLooseRawObject(commonDir, toEntry.oidHex);
      if (!blob || blob.type !== "blob") return undefined;
      blobsToWrite.push({
        relPath,
        buf: blob.body,
        modeNum,
        needChmod: Boolean(fromEntry && fromEntry.mode !== toEntry.mode),
      });
    } else if (fromEntry.mode !== toEntry.mode) {
      modesToChmod.push({ relPath, modeNum });
    }
  }
  try {
    const rootAbs = resolve(worktreePath);
    for (const relPath of filesToDelete) {
      const fullPath = join(worktreePath, relPath);
      rmSync(fullPath, { force: true });
      let parentDir = dirname(resolve(fullPath));
      while (parentDir !== rootAbs && parentDir.startsWith(rootAbs + sep)) {
        if (readdirSync(parentDir).length > 0) break;
        rmSync(parentDir, { recursive: true });
        parentDir = dirname(parentDir);
      }
    }
    for (const item of blobsToWrite) {
      const fullPath = join(worktreePath, item.relPath);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, item.buf, { mode: item.modeNum });
      if (item.needChmod) chmodSync(fullPath, item.modeNum);
    }
    for (const item of modesToChmod) {
      chmodSync(join(worktreePath, item.relPath), item.modeNum);
    }
    return encodePlainIndexV2(worktreePath, toFiles);
  } catch {
    return undefined;
  }
}

export function tryFastMoveToClean(path: string, sha: string): boolean {
  if (isSpawnIntercepted() || process.platform === "win32" || !/^[0-9a-f]{40}$/i.test(sha)) return false;
  const full = inspectPlainWorktree(path, true);
  if (!full || full.format !== "sha1" || full.untrackedFiles.length > 0 || !isPlainSha1CommonDir(full.dirs.commonDir)) {
    return false;
  }
  if (computeTrackedDiffersFromHead(full) !== false) return false;
  const targetOid = sha.toLowerCase();
  if (full.headCommit.oid === targetOid) return true;
  const toCommit = readLooseCommitObject(full.dirs.commonDir, targetOid);
  if (!toCommit) return false;
  const fromFiles = new Map<string, { mode: "100644" | "100755"; oidHex: string }>();
  const toFiles = new Map<string, { mode: "100644" | "100755"; oidHex: string }>();
  if (!collectLooseTreeFiles(full.dirs.commonDir, full.headCommit.tree, "sha1", fromFiles)) return false;
  if (!collectLooseTreeFiles(full.dirs.commonDir, toCommit.tree, "sha1", toFiles)) return false;
  for (const [relPath, toEntry] of toFiles) {
    const fromEntry = fromFiles.get(relPath);
    if (!fromEntry || fromEntry.oidHex !== toEntry.oidHex) {
      if (readLooseRawObject(full.dirs.commonDir, toEntry.oidHex)?.type !== "blob") return false;
    }
  }
  const targetRef = full.branch ? `refs/heads/${full.branch}` : "HEAD";
  const indexPath = join(full.dirs.gitdir, "index");
  const indexLock = `${indexPath}.lock`;
  let lockFd: number | undefined;
  let createdLock = false;
  let installed = false;
  try {
    lockFd = openSync(indexLock, "wx");
    createdLock = true;
    if (full.branch && readFileSync(join(full.dirs.gitdir, "HEAD"), "utf8").trim() !== `ref: ${targetRef}`) {
      return false;
    }
    if (!tryAtomicUpdateLooseRef(full.dirs, targetRef, { kind: "oid", oid: full.headCommit.oid }, targetOid)) {
      return false;
    }
    const indexBytes = syncCleanWorktreeFilesAndEncodeIndex(path, full.dirs.commonDir, fromFiles, toFiles);
    if (!indexBytes) {
      tryAtomicUpdateLooseRef(full.dirs, targetRef, { kind: "oid", oid: targetOid }, full.headCommit.oid);
      return false;
    }
    writeFileSync(lockFd, indexBytes);
    closeSync(lockFd);
    lockFd = undefined;
    renameSync(indexLock, indexPath);
    installed = true;
    return true;
  } catch {
    return false;
  } finally {
    if (lockFd !== undefined) {
      try {
        closeSync(lockFd);
      } catch {
        /* Best effort. */
      }
    }
    if (createdLock && !installed) {
      try {
        rmSync(indexLock, { force: true });
      } catch {
        /* Best effort. */
      }
    }
  }
}

export function tryFastOpenOn(path: string, onto: string, tree: string): boolean {
  if (isSpawnIntercepted() || process.platform === "win32" || !/^[0-9a-f]{40}$/i.test(onto) || !/^[0-9a-f]{40}$/i.test(tree)) {
    return false;
  }
  const full = inspectPlainWorktree(path, true);
  if (
    !full ||
    full.format !== "sha1" ||
    full.untrackedFiles.length > 0 ||
    !isPlainSha1CommonDir(full.dirs.commonDir) ||
    !hasNoEmptyDirectories(path) ||
    !hasStandardWritableWorktreePermissions(path)
  ) {
    return false;
  }
  const ontoOid = onto.toLowerCase();
  const treeOid = tree.toLowerCase();
  if (!readLooseCommitObject(full.dirs.commonDir, ontoOid)) return false;
  const toFiles = new Map<string, { mode: "100644" | "100755"; oidHex: string }>();
  if (!collectLooseTreeFiles(full.dirs.commonDir, treeOid, "sha1", toFiles)) return false;
  for (const [relPath, toEntry] of toFiles) {
    const diskEntry = full.diskTracked.get(relPath);
    if (!diskEntry || diskEntry.oidHex !== toEntry.oidHex) {
      if (readLooseRawObject(full.dirs.commonDir, toEntry.oidHex)?.type !== "blob") return false;
    }
  }
  const targetRef = full.branch ? `refs/heads/${full.branch}` : "HEAD";
  const indexPath = join(full.dirs.gitdir, "index");
  const indexLock = `${indexPath}.lock`;
  let lockFd: number | undefined;
  let createdLock = false;
  let installed = false;
  try {
    lockFd = openSync(indexLock, "wx");
    createdLock = true;
    if (full.branch) {
      if (readFileSync(join(full.dirs.gitdir, "HEAD"), "utf8").trim() !== `ref: ${targetRef}`) return false;
    } else if (readFileSync(join(full.dirs.gitdir, "HEAD"), "utf8").trim().toLowerCase() !== full.headCommit.oid) {
      return false;
    }
    if (ontoOid !== full.headCommit.oid) {
      if (!tryAtomicUpdateLooseRef(full.dirs, targetRef, { kind: "oid", oid: full.headCommit.oid }, ontoOid)) {
        return false;
      }
    }
    const indexBytes = syncCleanWorktreeFilesAndEncodeIndex(path, full.dirs.commonDir, full.diskTracked, toFiles);
    if (!indexBytes) {
      if (ontoOid !== full.headCommit.oid) {
        tryAtomicUpdateLooseRef(full.dirs, targetRef, { kind: "oid", oid: ontoOid }, full.headCommit.oid);
      }
      return false;
    }
    writeFileSync(lockFd, indexBytes);
    closeSync(lockFd);
    lockFd = undefined;
    renameSync(indexLock, indexPath);
    installed = true;
    return true;
  } catch {
    return false;
  } finally {
    if (lockFd !== undefined) {
      try {
        closeSync(lockFd);
      } catch {
        /* Best effort. */
      }
    }
    if (createdLock && !installed) {
      try {
        rmSync(indexLock, { force: true });
      } catch {
        /* Best effort. */
      }
    }
  }
}

function hasStandardWritableWorktreePermissions(worktree: string): boolean {
  const walk = (dir: string, isRoot: boolean): boolean => {
    let dst;
    try {
      dst = lstatSync(dir);
    } catch {
      return false;
    }
    if (!dst.isDirectory() || (dst.mode & 0o700) !== 0o700) return false;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (isRoot && entry.name === ".git") continue;
      if (entry.isSymbolicLink()) return false;
      const childPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!walk(childPath, false)) return false;
      } else if (entry.isFile()) {
        try {
          if ((lstatSync(childPath).mode & 0o200) === 0) return false;
        } catch {
          return false;
        }
      } else {
        return false;
      }
    }
    return true;
  };
  return walk(worktree, true);
}

export function tryFastRestoreWorktreeToCommit(path: string, targetSha: string | undefined, removeUntracked: boolean): boolean {
  if (isSpawnIntercepted() || process.platform === "win32") return false;
  if (targetSha !== undefined && !/^[0-9a-f]{40}$/i.test(targetSha)) return false;
  const full = inspectPlainWorktree(path, true);
  if (!full || full.format !== "sha1" || !isPlainSha1CommonDir(full.dirs.commonDir)) return false;
  const targetOid = targetSha ? targetSha.toLowerCase() : full.headCommit.oid;
  const trackedDiffers = computeTrackedDiffersFromHead(full);
  if (trackedDiffers === undefined) return false;
  if (
    targetOid === full.headCommit.oid &&
    !trackedDiffers &&
    (!removeUntracked || (full.untrackedFiles.length === 0 && hasNoEmptyDirectories(path)))
  ) {
    return true;
  }
  const toCommit = targetOid === full.headCommit.oid ? full.headCommit : readLooseCommitObject(full.dirs.commonDir, targetOid);
  if (!toCommit) return false;
  const toFiles = new Map<string, { mode: "100644" | "100755"; oidHex: string }>();
  if (!collectLooseTreeFiles(full.dirs.commonDir, toCommit.tree, "sha1", toFiles)) return false;
  if (!hasStandardWritableWorktreePermissions(path)) return false;
  if (full.untrackedFiles.length > 0) {
    const toDirPrefixes = new Set<string>();
    for (const relPath of toFiles.keys()) {
      const parts = relPath.split("/");
      for (let i = 1; i < parts.length; i += 1) {
        toDirPrefixes.add(parts.slice(0, i).join("/"));
      }
    }
    for (const untracked of full.untrackedFiles) {
      if (toFiles.has(untracked) || toDirPrefixes.has(untracked)) return false;
      const parts = untracked.split("/");
      for (let i = 1; i < parts.length; i += 1) {
        if (toFiles.has(parts.slice(0, i).join("/"))) return false;
      }
    }
  }
  for (const [relPath, toEntry] of toFiles) {
    const diskEntry = full.diskTracked.get(relPath);
    if (!diskEntry || diskEntry.oidHex !== toEntry.oidHex) {
      if (readLooseRawObject(full.dirs.commonDir, toEntry.oidHex)?.type !== "blob") return false;
    }
  }
  const targetRef = full.branch ? `refs/heads/${full.branch}` : "HEAD";
  const indexPath = join(full.dirs.gitdir, "index");
  const indexLock = `${indexPath}.lock`;
  let lockFd: number | undefined;
  let createdLock = false;
  let installed = false;
  try {
    lockFd = openSync(indexLock, "wx");
    createdLock = true;
    if (full.branch) {
      if (readFileSync(join(full.dirs.gitdir, "HEAD"), "utf8").trim() !== `ref: ${targetRef}`) return false;
    } else if (readFileSync(join(full.dirs.gitdir, "HEAD"), "utf8").trim().toLowerCase() !== full.headCommit.oid) {
      return false;
    }
    if (targetOid !== full.headCommit.oid) {
      if (!tryAtomicUpdateLooseRef(full.dirs, targetRef, { kind: "oid", oid: full.headCommit.oid }, targetOid)) {
        return false;
      }
    }
    const indexBytes = syncCleanWorktreeFilesAndEncodeIndex(path, full.dirs.commonDir, full.diskTracked, toFiles);
    if (!indexBytes) {
      if (targetOid !== full.headCommit.oid) {
        tryAtomicUpdateLooseRef(full.dirs, targetRef, { kind: "oid", oid: targetOid }, full.headCommit.oid);
      }
      return false;
    }
    if (removeUntracked) {
      for (const untracked of full.untrackedFiles) {
        rmSync(join(path, untracked), { force: true });
      }
      removeEmptyWorktreeDirs(path);
    }
    writeFileSync(lockFd, indexBytes);
    closeSync(lockFd);
    lockFd = undefined;
    renameSync(indexLock, indexPath);
    installed = true;
    return true;
  } catch {
    return false;
  } finally {
    if (lockFd !== undefined) {
      try {
        closeSync(lockFd);
      } catch {
        /* Best effort. */
      }
    }
    if (createdLock && !installed) {
      try {
        rmSync(indexLock, { force: true });
      } catch {
        /* Best effort. */
      }
    }
  }
}
