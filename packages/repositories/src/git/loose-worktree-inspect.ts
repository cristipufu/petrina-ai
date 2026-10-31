// Direct loose index v2 parsing and plain worktree inspection fast paths.
// Preserves exact parity with Git CLI semantics and falls back on any non-plain state.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { isSpawnIntercepted, systemCode } from "./exec.js";
import {
  collectLooseTreeFiles,
  FULL_OID,
  type GitDirs,
  hasReplaceRefs,
  isSafeSimpleRefName,
  type LooseCommit,
  readLooseCommitObject,
  resolveDirectRef,
  resolveGitDirs,
} from "./loose-objects.js";

export const BUSY_GITDIR_MARKERS = [
  "index.lock",
  "HEAD.lock",
  "MERGE_HEAD",
  "rebase-merge",
  "rebase-apply",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_LOG",
] as const;

const UNSAFE_WORKTREE_CONFIG = /filter\.|submodule|sparse|worktreeconfig|excludesfile|autocrlf\s*=\s*(?:true|input)|eol\s*=\s*(?:crlf|native)/i;

export function readPlainWorktreeConfig(dirs: GitDirs, needUntracked: boolean, allowOwnedIndexLock = false): { checkExecBit: boolean } | undefined {
  if (
    process.env.GIT_INDEX_FILE ||
    process.env.GIT_CONFIG_PARAMETERS ||
    process.env.GIT_CONFIG_COUNT ||
    process.env.GIT_CONFIG
  ) {
    return undefined;
  }
  for (const marker of BUSY_GITDIR_MARKERS) {
    if (allowOwnedIndexLock && marker === "index.lock") continue;
    if (existsSync(join(dirs.gitdir, marker))) return undefined;
  }
  if (existsSync(join(dirs.commonDir, "info", "attributes")) || existsSync(join(dirs.gitdir, "info", "sparse-checkout"))) {
    return undefined;
  }
  let configText: string;
  try {
    configText = readFileSync(join(dirs.commonDir, "config"), "utf8");
  } catch {
    return undefined;
  }
  if (UNSAFE_WORKTREE_CONFIG.test(configText) || /\[include/i.test(configText)) return undefined;
  const noSystem = process.env.GIT_CONFIG_NOSYSTEM === "1";
  const sysPath = process.env.GIT_CONFIG_SYSTEM;
  const globalPath = process.env.GIT_CONFIG_GLOBAL;
  try {
    if (!noSystem && sysPath && existsSync(sysPath)) {
      const sysText = readFileSync(sysPath, "utf8");
      if (UNSAFE_WORKTREE_CONFIG.test(sysText) || /\[include/i.test(sysText)) return undefined;
    }
    if (globalPath && existsSync(globalPath)) {
      const globalText = readFileSync(globalPath, "utf8");
      if (UNSAFE_WORKTREE_CONFIG.test(globalText) || /\[include/i.test(globalText)) return undefined;
    }
    if (needUntracked) {
      if ((!noSystem && !sysPath) || !globalPath) return undefined;
      const xdg = process.env.XDG_CONFIG_HOME;
      const home = process.env.HOME || process.env.USERPROFILE;
      if (xdg) {
        if (existsSync(join(xdg, "git", "ignore"))) return undefined;
      } else if (home && existsSync(join(home, ".config", "git", "ignore"))) {
        return undefined;
      }
      const excludePath = join(dirs.commonDir, "info", "exclude");
      if (existsSync(excludePath)) {
        for (const rawLine of readFileSync(excludePath, "utf8").split(/\r?\n/)) {
          const trimmed = rawLine.trim();
          if (trimmed && !trimmed.startsWith("#")) return undefined;
        }
      }
    }
  } catch {
    return undefined;
  }
  return { checkExecBit: process.platform !== "win32" && !/filemode\s*=\s*false/i.test(configText) };
}

function readPlainIndexEntries(
  indexPath: string,
  oidByteLen: 20 | 32,
  rejectGitignore: boolean,
): Map<string, { mode: "100644" | "100755"; oidHex: string }> | undefined {
  let buf: Buffer;
  try {
    buf = readFileSync(indexPath);
  } catch {
    return undefined;
  }
  if (buf.length < 12 + oidByteLen) return undefined;
  if (buf[0] !== 0x44 || buf[1] !== 0x49 || buf[2] !== 0x52 || buf[3] !== 0x43) return undefined;
  if (buf.readUInt32BE(4) !== 2) return undefined;
  const entryCount = buf.readUInt32BE(8);
  if (entryCount > 256) return undefined;
  const limit = buf.length - oidByteLen;
  if (createHash(oidByteLen === 32 ? "sha256" : "sha1").update(buf.subarray(0, limit)).digest("hex") !== buf.subarray(limit).toString("hex")) {
    return undefined;
  }
  const out = new Map<string, { mode: "100644" | "100755"; oidHex: string }>();
  let offset = 12;
  for (let i = 0; i < entryCount; i += 1) {
    const fixedEnd = offset + 42 + oidByteLen;
    if (fixedEnd >= limit) return undefined;
    const modeNum = buf.readUInt32BE(offset + 24);
    if (modeNum !== 0o100644 && modeNum !== 0o100755) return undefined;
    const oidHex = buf.subarray(offset + 40, offset + 40 + oidByteLen).toString("hex");
    const flags = buf.readUInt16BE(offset + 40 + oidByteLen);
    if ((flags & 0xf000) !== 0) return undefined;
    const nul = buf.indexOf(0, fixedEnd);
    if (nul <= fixedEnd || nul >= limit) return undefined;
    const relPath = buf.subarray(fixedEnd, nul).toString("utf8");
    const baseName = relPath.slice(relPath.lastIndexOf("/") + 1);
    if (!baseName || baseName === ".gitattributes" || baseName === ".gitmodules" || (rejectGitignore && baseName === ".gitignore")) {
      return undefined;
    }
    out.set(relPath, { mode: modeNum === 0o100755 ? "100755" : "100644", oidHex });
    offset += (42 + oidByteLen + (nul - fixedEnd) + 8) & ~7;
  }
  return offset <= limit ? out : undefined;
}

export interface PlainWorktreeInspection {
  dirs: GitDirs;
  headCommit: LooseCommit;
  branch?: string;
  format: "sha1" | "sha256";
  checkExecBit: boolean;
  indexFiles: Map<string, { mode: "100644" | "100755"; oidHex: string }>;
  diskTracked: Map<string, { mode: "100644" | "100755"; oidHex: string }>;
  untrackedFiles: string[];
}

export function inspectPlainWorktree(path: string, needUntracked: boolean, allowOwnedIndexLock = false): PlainWorktreeInspection | undefined {
  if (isSpawnIntercepted()) return undefined;
  const dirs = resolveGitDirs(path);
  if (!dirs || hasReplaceRefs(dirs.commonDir)) return undefined;
  const cfg = readPlainWorktreeConfig(dirs, needUntracked, allowOwnedIndexLock);
  if (!cfg) return undefined;
  let branch: string | undefined;
  try {
    const headRaw = readFileSync(join(dirs.gitdir, "HEAD"), "utf8").trim();
    if (!headRaw || headRaw === "ref: refs/heads/.invalid") return undefined;
    if (headRaw.startsWith("ref: refs/heads/")) {
      const candidate = headRaw.slice("ref: refs/heads/".length);
      if (!candidate || !isSafeSimpleRefName(candidate)) return undefined;
      branch = candidate;
    } else if (!FULL_OID.test(headRaw)) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  const resolved = resolveDirectRef(dirs, "HEAD");
  if (resolved.kind !== "oid") return undefined;
  const headCommit = readLooseCommitObject(dirs.commonDir, resolved.oid);
  if (!headCommit) return undefined;
  const format = headCommit.oid.length === 64 ? "sha256" : "sha1";
  const oidByteLen = format === "sha256" ? 32 : 20;
  const indexFiles = readPlainIndexEntries(join(dirs.gitdir, "index"), oidByteLen, needUntracked);
  if (!indexFiles) return undefined;
  const diskTracked = new Map<string, { mode: "100644" | "100755"; oidHex: string }>();
  const untrackedFiles: string[] = [];
  if (needUntracked) {
    const walk = (dir: string, relPrefix: string): boolean => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return false;
      }
      for (const entry of entries) {
        if (!relPrefix && entry.name === ".git") continue;
        if (relPrefix && entry.name === ".git") return false;
        if (entry.name === ".gitignore" || entry.name === ".gitattributes" || entry.name === ".gitmodules") return false;
        if (entry.isSymbolicLink()) return false;
        const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!walk(fullPath, relPath)) return false;
          continue;
        }
        if (!entry.isFile()) return false;
        const idxEntry = indexFiles.get(relPath);
        if (!idxEntry) {
          if (untrackedFiles.length >= 256) return false;
          untrackedFiles.push(relPath);
          continue;
        }
        try {
          const st = lstatSync(fullPath);
          if (!st.isFile() || st.size > 262_144) return false;
          const content = readFileSync(fullPath);
          const diskOid = createHash(format).update(`blob ${content.length}\0`).update(content).digest("hex");
          const diskMode = cfg.checkExecBit ? ((st.mode & 0o111) !== 0 ? "100755" : "100644") : idxEntry.mode;
          diskTracked.set(relPath, { mode: diskMode, oidHex: diskOid });
        } catch {
          return false;
        }
      }
      return true;
    };
    if (!walk(path, "")) return undefined;
  } else {
    try {
      if (!statSync(path).isDirectory() || existsSync(join(path, ".gitattributes"))) return undefined;
    } catch {
      return undefined;
    }
    const checkedDirs = new Set<string>();
    const missingDirs = new Set<string>();
    for (const [relPath, idxEntry] of indexFiles) {
      const parts = relPath.split("/");
      let dirFailed = false;
      let dirMissing = false;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const prefix = parts.slice(0, i + 1).join("/");
        if (missingDirs.has(prefix)) {
          dirMissing = true;
          break;
        }
        if (checkedDirs.has(prefix)) continue;
        try {
          const dst = lstatSync(join(path, prefix));
          if (!dst.isDirectory() || existsSync(join(path, prefix, ".gitattributes"))) {
            dirFailed = true;
            break;
          }
          checkedDirs.add(prefix);
        } catch (error) {
          const code = systemCode(error);
          if (code === "ENOENT" || code === "ENOTDIR") {
            missingDirs.add(prefix);
            dirMissing = true;
            break;
          }
          dirFailed = true;
          break;
        }
      }
      if (dirFailed) return undefined;
      if (dirMissing) continue;
      const fullPath = join(path, relPath);
      try {
        const st = lstatSync(fullPath);
        if (!st.isFile() || st.size > 262_144) return undefined;
        const content = readFileSync(fullPath);
        const diskOid = createHash(format).update(`blob ${content.length}\0`).update(content).digest("hex");
        const diskMode = cfg.checkExecBit ? ((st.mode & 0o111) !== 0 ? "100755" : "100644") : idxEntry.mode;
        diskTracked.set(relPath, { mode: diskMode, oidHex: diskOid });
      } catch (error) {
        const code = systemCode(error);
        if (code === "ENOENT" || code === "ENOTDIR") continue;
        return undefined;
      }
    }
  }
  return { dirs, headCommit, ...(branch ? { branch } : {}), format, checkExecBit: cfg.checkExecBit, indexFiles, diskTracked, untrackedFiles };
}

export function computeTrackedDiffersFromHead(inspected: PlainWorktreeInspection): boolean | undefined {
  const headFiles = new Map<string, { mode: "100644" | "100755"; oidHex: string }>();
  if (!collectLooseTreeFiles(inspected.dirs.commonDir, inspected.headCommit.tree, inspected.format, headFiles)) {
    return undefined;
  }
  if (headFiles.size !== inspected.indexFiles.size || inspected.diskTracked.size !== inspected.indexFiles.size) {
    return true;
  }
  for (const [relPath, headEntry] of headFiles) {
    const idxEntry = inspected.indexFiles.get(relPath);
    const diskEntry = inspected.diskTracked.get(relPath);
    if (
      !idxEntry ||
      !diskEntry ||
      headEntry.oidHex !== idxEntry.oidHex ||
      headEntry.mode !== idxEntry.mode ||
      idxEntry.oidHex !== diskEntry.oidHex ||
      idxEntry.mode !== diskEntry.mode
    ) {
      return true;
    }
  }
  return false;
}

export function readFastWorktreeBranchStatus(
  path: string,
  untracked: boolean,
): { head: string; branch?: string; clean: boolean; trackedChanged: boolean } | undefined {
  if (untracked) {
    const full = inspectPlainWorktree(path, true);
    if (full) {
      const trackedChanged = computeTrackedDiffersFromHead(full);
      if (trackedChanged !== undefined) {
        return {
          head: full.headCommit.oid,
          ...(full.branch ? { branch: full.branch } : {}),
          clean: !trackedChanged && full.untrackedFiles.length === 0,
          trackedChanged,
        };
      }
    }
  }
  const trackedOnly = inspectPlainWorktree(path, false);
  if (!trackedOnly) return undefined;
  const trackedChanged = computeTrackedDiffersFromHead(trackedOnly);
  if (trackedChanged === undefined) return undefined;
  if (!untracked || trackedChanged) {
    return {
      head: trackedOnly.headCommit.oid,
      ...(trackedOnly.branch ? { branch: trackedOnly.branch } : {}),
      clean: !trackedChanged,
      trackedChanged,
    };
  }
  return undefined;
}

export function verifyCleanWorktree(path: string): { head: string; tree: string; branch?: string } | undefined {
  const full = inspectPlainWorktree(path, true);
  if (!full || full.untrackedFiles.length > 0) return undefined;
  const trackedChanged = computeTrackedDiffersFromHead(full);
  if (trackedChanged !== false) return undefined;
  return { head: full.headCommit.oid, tree: full.headCommit.tree, ...(full.branch ? { branch: full.branch } : {}) };
}

export function hasNoEmptyDirectories(worktree: string): boolean {
  const walk = (dir: string, isRoot: boolean): boolean => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    let count = 0;
    for (const entry of entries) {
      if (isRoot && entry.name === ".git") continue;
      count += 1;
      if (entry.isDirectory() && !walk(join(dir, entry.name), false)) return false;
    }
    return isRoot || count > 0;
  };
  return walk(worktree, true);
}

export function removeEmptyWorktreeDirs(worktree: string): void {
  const walk = (dir: string, isRoot: boolean): boolean => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    let remaining = 0;
    for (const entry of entries) {
      if (isRoot && entry.name === ".git") continue;
      const childPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (walk(childPath, false)) {
          try {
            rmSync(childPath, { recursive: true });
          } catch {
            remaining += 1;
          }
        } else {
          remaining += 1;
        }
      } else {
        remaining += 1;
      }
    }
    return !isRoot && remaining === 0;
  };
  walk(worktree, true);
}
