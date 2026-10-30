// Direct loose SHA-1 index v2 and worktree inspection/materialization fast paths.
// Preserves exact parity with Git CLI semantics and falls back on any non-plain state.

import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { deflateSync } from "node:zlib";
import { treeEntries } from "../object-format.js";
import { isSpawnIntercepted, systemCode } from "./exec.js";
import {
  collectLooseTreeFiles,
  FULL_OID,
  type GitDirs,
  hasRefDirectoryConflict,
  hasReplaceRefs,
  isPlainSha1CommonDir,
  isSafeSimpleRefName,
  type LooseCommit,
  parsePlainGitConfigEntries,
  readLooseCommitObject,
  readLooseRawObject,
  resolveDirectRef,
  resolveGitDirs,
  tryAtomicUpdateLooseRef,
} from "./loose-objects.js";

const BUSY_GITDIR_MARKERS = ["index.lock", "HEAD.lock", "MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG"] as const;

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

function hasNoEmptyDirectories(worktree: string): boolean {
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

function removeEmptyWorktreeDirs(worktree: string): void {
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

interface FastCommitIdentity {
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
  timestamp: number;
  tz: string;
}

function isCleanIdentityField(val: string | undefined): val is string {
  return Boolean(val && val.trim() && !/[\0\r\n<>]/.test(val));
}

function resolveFastCommitIdentity(dirs: GitDirs, checkGpgSign: boolean): FastCommitIdentity | undefined {
  if (
    isSpawnIntercepted() ||
    process.env.GIT_CONFIG_PARAMETERS ||
    process.env.GIT_CONFIG_COUNT ||
    process.env.GIT_CONFIG ||
    process.env.GIT_AUTHOR_DATE ||
    process.env.GIT_COMMITTER_DATE
  ) {
    return undefined;
  }
  if (existsSync(join(dirs.gitdir, "config.worktree")) || existsSync(join(dirs.commonDir, "config.worktree"))) {
    return undefined;
  }
  const noSystem = process.env.GIT_CONFIG_NOSYSTEM === "1";
  const sysPath = process.env.GIT_CONFIG_SYSTEM;
  const globalPath = process.env.GIT_CONFIG_GLOBAL;
  if ((!noSystem && !sysPath) || !globalPath) return undefined;
  const layers: { key: string; value: string }[][] = [];
  try {
    if (!noSystem && sysPath && existsSync(sysPath)) {
      const parsed = parsePlainGitConfigEntries(readFileSync(sysPath, "utf8"));
      if (!parsed) return undefined;
      layers.push(parsed);
    }
    if (existsSync(globalPath)) {
      const parsed = parsePlainGitConfigEntries(readFileSync(globalPath, "utf8"));
      if (!parsed) return undefined;
      layers.push(parsed);
    }
    const localParsed = parsePlainGitConfigEntries(readFileSync(join(dirs.commonDir, "config"), "utf8"));
    if (!localParsed) return undefined;
    layers.push(localParsed);
  } catch {
    return undefined;
  }
  let userName: string | undefined;
  let userEmail: string | undefined;
  let gpgSign: string | undefined;
  for (const entries of layers) {
    for (const entry of entries) {
      const k = entry.key.toLowerCase();
      if (
        k === "extensions.objectformat" ||
        k === "extensions.worktreeconfig" ||
        k === "commit.cleanup" ||
        k === "commit.template" ||
        k === "i18n.commitencoding"
      ) {
        return undefined;
      }
      if (k === "user.name") userName = entry.value;
      else if (k === "user.email") userEmail = entry.value;
      else if (k === "commit.gpgsign") gpgSign = entry.value.trim().toLowerCase();
    }
  }
  if (checkGpgSign && gpgSign !== undefined && gpgSign !== "" && gpgSign !== "false" && gpgSign !== "0" && gpgSign !== "no" && gpgSign !== "off") {
    return undefined;
  }
  const authorName = process.env.GIT_AUTHOR_NAME || userName;
  const authorEmail = process.env.GIT_AUTHOR_EMAIL || userEmail;
  const committerName = process.env.GIT_COMMITTER_NAME || userName;
  const committerEmail = process.env.GIT_COMMITTER_EMAIL || userEmail;
  if (
    !isCleanIdentityField(authorName) ||
    !isCleanIdentityField(authorEmail) ||
    !isCleanIdentityField(committerName) ||
    !isCleanIdentityField(committerEmail)
  ) {
    return undefined;
  }
  const nowMs = Date.now();
  const timestamp = Math.floor(nowMs / 1000);
  const tzMin = -new Date(nowMs).getTimezoneOffset();
  const sign = tzMin >= 0 ? "+" : "-";
  const abs = Math.abs(tzMin);
  const tz = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}${String(abs % 60).padStart(2, "0")}`;
  return {
    authorName: authorName.trim(),
    authorEmail: authorEmail.trim(),
    committerName: committerName.trim(),
    committerEmail: committerEmail.trim(),
    timestamp,
    tz,
  };
}

interface TreeBuildDir {
  children: Map<string, { kind: "file"; mode: "100644" | "100755"; oidHex: string } | { kind: "dir"; dir: TreeBuildDir }>;
}

export const SLASH_BYTE = Buffer.from("/");

export function writeLooseTreeFromMap(
  commonDir: string,
  files: ReadonlyMap<string, { mode: "100644" | "100755"; oidHex: string }>,
): string | undefined {
  const root: TreeBuildDir = { children: new Map() };
  for (const [relPath, entry] of files) {
    if (!relPath || relPath.includes("\0") || !/^[0-9a-f]{40}$/i.test(entry.oidHex)) return undefined;
    const parts = relPath.split("/");
    let cur = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const seg = parts[i]!;
      if (!seg || seg === "." || seg === ".." || seg === ".git") return undefined;
      const existing = cur.children.get(seg);
      if (!existing) {
        const nextDir: TreeBuildDir = { children: new Map() };
        cur.children.set(seg, { kind: "dir", dir: nextDir });
        cur = nextDir;
      } else if (existing.kind === "dir") {
        cur = existing.dir;
      } else {
        return undefined;
      }
    }
    const leaf = parts[parts.length - 1]!;
    if (!leaf || leaf === "." || leaf === ".." || leaf === ".git" || cur.children.has(leaf)) return undefined;
    cur.children.set(leaf, { kind: "file", mode: entry.mode, oidHex: entry.oidHex.toLowerCase() });
  }
  const encodeDir = (node: TreeBuildDir): string | undefined => {
    const items: { modeStr: string; isDir: boolean; nameBuf: Buffer; sortKey: Buffer; oidHex: string }[] = [];
    for (const [name, child] of node.children) {
      const nameBuf = Buffer.from(name, "utf8");
      if (child.kind === "dir") {
        if (child.dir.children.size === 0) continue;
        const subOid = encodeDir(child.dir);
        if (!subOid) return undefined;
        items.push({
          modeStr: "40000",
          isDir: true,
          nameBuf,
          sortKey: Buffer.concat([nameBuf, SLASH_BYTE]),
          oidHex: subOid,
        });
      } else {
        items.push({
          modeStr: child.mode,
          isDir: false,
          nameBuf,
          sortKey: nameBuf,
          oidHex: child.oidHex,
        });
      }
    }
    items.sort((a, b) => Buffer.compare(a.sortKey, b.sortKey));
    const chunks: Buffer[] = [];
    for (const item of items) {
      chunks.push(Buffer.from(`${item.modeStr} `, "utf8"), item.nameBuf, Buffer.from([0]), Buffer.from(item.oidHex, "hex"));
    }
    const body = Buffer.concat(chunks);
    const raw = Buffer.concat([Buffer.from(`tree ${body.length}\0`, "utf8"), body]);
    const oid = createHash("sha1").update(raw).digest("hex");
    return writeLooseSha1Object(commonDir, oid, raw) ? oid : undefined;
  };
  return encodeDir(root);
}

function writeLooseSha1Commit(
  commonDir: string,
  treeOid: string,
  parents: readonly string[],
  id: FastCommitIdentity,
  bodyWithNewline: string,
): string | undefined {
  const lines = [
    `tree ${treeOid.toLowerCase()}`,
    ...parents.map((parent) => `parent ${parent.toLowerCase()}`),
    `author ${id.authorName} <${id.authorEmail}> ${id.timestamp} ${id.tz}`,
    `committer ${id.committerName} <${id.committerEmail}> ${id.timestamp} ${id.tz}`,
  ];
  const content = Buffer.from(`${lines.join("\n")}\n\n${bodyWithNewline}`, "utf8");
  const raw = Buffer.concat([Buffer.from(`commit ${content.length}\0`, "utf8"), content]);
  const oid = createHash("sha1").update(raw).digest("hex");
  return writeLooseSha1Object(commonDir, oid, raw) ? oid : undefined;
}

export function encodePlainIndexV2(
  worktreePath: string,
  files: ReadonlyMap<string, { mode: "100644" | "100755"; oidHex: string }>,
): Buffer | undefined {
  if (process.platform === "win32" || files.size > 256) return undefined;
  const sorted = [...files.entries()].sort(([a], [b]) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
  const header = Buffer.alloc(12);
  header.write("DIRC", 0, 4, "ascii");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  const parts: Buffer[] = [header];
  for (const [relPath, entry] of sorted) {
    if (!/^[0-9a-f]{40}$/i.test(entry.oidHex)) return undefined;
    const pathBytes = Buffer.from(relPath, "utf8");
    let st;
    try {
      st = lstatSync(join(worktreePath, relPath), { bigint: true });
    } catch {
      return undefined;
    }
    if (!st.isFile()) return undefined;
    const totalLen = (62 + pathBytes.length + 8) & ~7;
    const buf = Buffer.alloc(totalLen, 0);
    buf.writeUInt32BE(Number(st.ctimeNs / 1_000_000_000n) >>> 0, 0);
    buf.writeUInt32BE(Number(st.ctimeNs % 1_000_000_000n) >>> 0, 4);
    buf.writeUInt32BE(Number(st.mtimeNs / 1_000_000_000n) >>> 0, 8);
    buf.writeUInt32BE(Number(st.mtimeNs % 1_000_000_000n) >>> 0, 12);
    buf.writeUInt32BE(Number(st.dev & 0xffffffffn) >>> 0, 16);
    buf.writeUInt32BE(Number(st.ino & 0xffffffffn) >>> 0, 20);
    buf.writeUInt32BE(entry.mode === "100755" ? 0o100755 : 0o100644, 24);
    buf.writeUInt32BE(Number(st.uid & 0xffffffffn) >>> 0, 28);
    buf.writeUInt32BE(Number(st.gid & 0xffffffffn) >>> 0, 32);
    buf.writeUInt32BE(Number(st.size & 0xffffffffn) >>> 0, 36);
    Buffer.from(entry.oidHex.toLowerCase(), "hex").copy(buf, 40);
    buf.writeUInt16BE(Math.min(pathBytes.length, 0x0fff), 60);
    pathBytes.copy(buf, 62);
    parts.push(buf);
  }
  const content = Buffer.concat(parts);
  const checksum = createHash("sha1").update(content).digest();
  return Buffer.concat([content, checksum]);
}

function collectAndWriteWorktreeLooseBlobs(
  worktreePath: string,
  inspected: PlainWorktreeInspection,
): Map<string, { mode: "100644" | "100755"; oidHex: string }> | undefined {
  if (inspected.format !== "sha1" || !isPlainSha1CommonDir(inspected.dirs.commonDir)) return undefined;
  const nextFiles = new Map<string, { mode: "100644" | "100755"; oidHex: string }>();
  for (const [relPath, entry] of inspected.diskTracked) {
    const objFile = join(inspected.dirs.commonDir, "objects", entry.oidHex.slice(0, 2), entry.oidHex.slice(2));
    if (!existsSync(objFile)) {
      let content: Buffer;
      try {
        content = readFileSync(join(worktreePath, relPath));
      } catch {
        return undefined;
      }
      const raw = Buffer.concat([Buffer.from(`blob ${content.length}\0`, "utf8"), content]);
      const oid = createHash("sha1").update(raw).digest("hex");
      if (oid !== entry.oidHex || !writeLooseSha1Object(inspected.dirs.commonDir, oid, raw)) return undefined;
    }
    nextFiles.set(relPath, entry);
  }
  for (const relPath of inspected.untrackedFiles) {
    if (nextFiles.size >= 256) return undefined;
    const fullPath = join(worktreePath, relPath);
    let st;
    let content: Buffer;
    try {
      st = lstatSync(fullPath);
      if (!st.isFile() || st.size > 262_144) return undefined;
      content = readFileSync(fullPath);
    } catch {
      return undefined;
    }
    const raw = Buffer.concat([Buffer.from(`blob ${content.length}\0`, "utf8"), content]);
    const oid = createHash("sha1").update(raw).digest("hex");
    if (!writeLooseSha1Object(inspected.dirs.commonDir, oid, raw)) return undefined;
    const mode = inspected.checkExecBit && (st.mode & 0o111) !== 0 ? "100755" : "100644";
    nextFiles.set(relPath, { mode, oidHex: oid });
  }
  return nextFiles;
}

export function tryFastCommitChanges(path: string, message: string): boolean | undefined {
  if (
    isSpawnIntercepted() ||
    process.platform === "win32" ||
    !message.trim() ||
    message.includes("\0") ||
    message.includes("\r") ||
    /[ \t]\n|^\n|\n{3,}/.test(message)
  ) {
    return undefined;
  }
  const full = inspectPlainWorktree(path, true);
  if (!full || full.format !== "sha1") return undefined;
  const id = resolveFastCommitIdentity(full.dirs, true);
  if (!id) return undefined;
  const targetRef = full.branch ? `refs/heads/${full.branch}` : "HEAD";
  if (full.branch && (existsSync(join(full.dirs.commonDir, "packed-refs.lock")) || hasRefDirectoryConflict(full.dirs.commonDir, targetRef))) {
    return undefined;
  }
  const indexPath = join(full.dirs.gitdir, "index");
  const indexLock = `${indexPath}.lock`;
  let lockFd: number | undefined;
  let createdLock = false;
  let indexInstalled = false;
  try {
    lockFd = openSync(indexLock, "wx");
    createdLock = true;
    const nextFiles = collectAndWriteWorktreeLooseBlobs(path, full);
    if (!nextFiles) return undefined;
    const treeOid = writeLooseTreeFromMap(full.dirs.commonDir, nextFiles);
    if (!treeOid || treeOid === full.headCommit.tree) return undefined;
    const body = message.endsWith("\n") ? message : `${message}\n`;
    const commitOid = writeLooseSha1Commit(full.dirs.commonDir, treeOid, [full.headCommit.oid], id, body);
    if (!commitOid) return undefined;
    const indexBytes = encodePlainIndexV2(path, nextFiles);
    if (!indexBytes) return undefined;
    writeFileSync(lockFd, indexBytes);
    closeSync(lockFd);
    lockFd = undefined;
    if (full.branch) {
      const curHead = readFileSync(join(full.dirs.gitdir, "HEAD"), "utf8").trim();
      if (curHead !== `ref: ${targetRef}`) return undefined;
    }
    if (!tryAtomicUpdateLooseRef(full.dirs, targetRef, { kind: "oid", oid: full.headCommit.oid }, commitOid)) {
      return undefined;
    }
    renameSync(indexLock, indexPath);
    indexInstalled = true;
    return true;
  } catch {
    return undefined;
  } finally {
    if (lockFd !== undefined) {
      try { closeSync(lockFd); } catch { /* Best effort. */ }
    }
    if (createdLock && !indexInstalled) {
      try { rmSync(indexLock, { force: true }); } catch { /* Best effort. */ }
    }
  }
}

export function tryFastObserveContentTree(
  path: string,
  saved?: { commit: string; tree: string },
): { head: string; tree: string } | undefined {
  if (isSpawnIntercepted()) return undefined;
  const full = inspectPlainWorktree(path, true);
  if (!full) return undefined;
  const trackedChanged = computeTrackedDiffersFromHead(full);
  if (trackedChanged === false && full.untrackedFiles.length === 0) {
    const tree = saved?.commit === full.headCommit.oid && saved.tree ? saved.tree : full.headCommit.tree;
    return { head: full.headCommit.oid, tree };
  }
  const nextFiles = collectAndWriteWorktreeLooseBlobs(path, full);
  if (!nextFiles) return undefined;
  const tree = writeLooseTreeFromMap(full.dirs.commonDir, nextFiles);
  return tree ? { head: full.headCommit.oid, tree } : undefined;
}

export function tryFastFoldCommit(
  path: string,
  expectedHead: string,
  tree: string,
  fork: string,
  message: string,
): string | undefined {
  if (
    isSpawnIntercepted() ||
    !/^[0-9a-f]{40}$/i.test(tree) ||
    !/^[0-9a-f]{40}$/i.test(fork) ||
    !message ||
    message.includes("\0") ||
    message.includes("\r")
  ) {
    return undefined;
  }
  const dirs = resolveGitDirs(path);
  if (!dirs || !isPlainSha1CommonDir(dirs.commonDir)) return undefined;
  for (const marker of BUSY_GITDIR_MARKERS) {
    if (existsSync(join(dirs.gitdir, marker))) return undefined;
  }
  const id = resolveFastCommitIdentity(dirs, false);
  if (!id) return undefined;
  if (readLooseRawObject(dirs.commonDir, tree)?.type !== "tree") return undefined;
  if (!readLooseCommitObject(dirs.commonDir, fork)) return undefined;
  let targetRef = "HEAD";
  try {
    const rawHead = readFileSync(join(dirs.gitdir, "HEAD"), "utf8").trim();
    if (rawHead === "ref: refs/heads/.invalid") return undefined;
    if (rawHead.startsWith("ref: ")) {
      const candidate = rawHead.slice(5).trim();
      if (!candidate.startsWith("refs/heads/") || !isSafeSimpleRefName(candidate)) return undefined;
      targetRef = candidate;
    } else if (!FULL_OID.test(rawHead)) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  const curResolved = resolveDirectRef(dirs, "HEAD");
  if (curResolved.kind !== "oid" || curResolved.oid !== expectedHead.toLowerCase()) return undefined;
  const body = message.endsWith("\n") ? message : `${message}\n`;
  const sha = writeLooseSha1Commit(dirs.commonDir, tree, [fork], id, body);
  if (!sha) return undefined;
  if (!tryAtomicUpdateLooseRef(dirs, targetRef, { kind: "oid", oid: expectedHead.toLowerCase() }, sha)) {
    return undefined;
  }
  return sha;
}

function writeLooseSha1Object(commonDir: string, oid: string, raw: Buffer): boolean {
  const subDir = join(commonDir, "objects", oid.slice(0, 2));
  const dest = join(subDir, oid.slice(2));
  if (existsSync(dest)) return true;
  let tmpPath: string | undefined;
  try {
    mkdirSync(subDir, { recursive: true });
    tmpPath = join(subDir, `.tmp_obj_${process.pid}_${Math.random().toString(36).slice(2)}`);
    writeFileSync(tmpPath, deflateSync(raw));
    renameSync(tmpPath, dest);
    return true;
  } catch {
    if (tmpPath) {
      try { rmSync(tmpPath, { force: true }); } catch { /* Best effort. */ }
    }
    return false;
  }
}

export function writeLooseRootFileTree(path: string, tree: string, name: string, mode: string, text: string): string | undefined {
  if (isSpawnIntercepted() || !/^[0-9a-f]{40}$/i.test(tree) || !name || name.includes("/") || name.includes("\0")) {
    return undefined;
  }
  const dirs = resolveGitDirs(path);
  if (!dirs || hasReplaceRefs(dirs.commonDir)) return undefined;
  try {
    if (/objectformat/i.test(readFileSync(join(dirs.commonDir, "config"), "utf8"))) return undefined;
  } catch {
    return undefined;
  }
  const treeObj = readLooseRawObject(dirs.commonDir, tree);
  if (!treeObj || treeObj.type !== "tree" || treeObj.format !== "sha1") return undefined;
  let parsed;
  try {
    parsed = treeEntries({ id: tree.toLowerCase(), type: "tree", body: treeObj.body });
  } catch {
    return undefined;
  }
  const canonicalModes = new Set([0o040000, 0o100644, 0o100755, 0o120000, 0o160000]);
  if (parsed.some((entry) => !canonicalModes.has(entry.mode) || entry.id.length !== 40)) return undefined;
  const textBytes = Buffer.from(text, "utf8");
  const rawBlob = Buffer.concat([Buffer.from(`blob ${textBytes.length}\0`, "utf8"), textBytes]);
  const blobOid = createHash("sha1").update(rawBlob).digest("hex");
  if (!writeLooseSha1Object(dirs.commonDir, blobOid, rawBlob)) return undefined;
  const targetName = Buffer.from(name, "utf8");
  const nextEntries = parsed.filter((entry) => !entry.name.equals(targetName));
  nextEntries.push({ mode: mode === "100755" ? 0o100755 : 0o100644, name: targetName, id: blobOid });
  const sortKey = (entry: { mode: number; name: Buffer }) =>
    (entry.mode & 0o170000) === 0o040000 ? Buffer.concat([entry.name, Buffer.from("/")]) : entry.name;
  nextEntries.sort((a, b) => Buffer.compare(sortKey(a), sortKey(b)));
  const encodedParts: Buffer[] = [];
  for (const entry of nextEntries) {
    const modeStr = entry.mode === 0o040000 ? "40000" : entry.mode.toString(8);
    encodedParts.push(Buffer.from(`${modeStr} `, "utf8"), entry.name, Buffer.from([0]), Buffer.from(entry.id, "hex"));
  }
  const treeBody = Buffer.concat(encodedParts);
  const rawTree = Buffer.concat([Buffer.from(`tree ${treeBody.length}\0`, "utf8"), treeBody]);
  const treeOid = createHash("sha1").update(rawTree).digest("hex");
  return writeLooseSha1Object(dirs.commonDir, treeOid, rawTree) ? treeOid : undefined;
}

export function tryFastCommitTree(path: string, tree: string, parent: string, message: string): string | undefined {
  if (
    isSpawnIntercepted() ||
    !/^[0-9a-f]{40}$/i.test(tree) ||
    !/^[0-9a-f]{40}$/i.test(parent) ||
    message.includes("\0") ||
    message.includes("\r")
  ) {
    return undefined;
  }
  const dirs = resolveGitDirs(path);
  if (!dirs || !isPlainSha1CommonDir(dirs.commonDir)) return undefined;
  const id = resolveFastCommitIdentity(dirs, false);
  if (!id) return undefined;
  if (readLooseRawObject(dirs.commonDir, tree)?.type !== "tree") return undefined;
  if (!readLooseCommitObject(dirs.commonDir, parent)) return undefined;
  const body = message.endsWith("\n") ? message : `${message}\n`;
  return writeLooseSha1Commit(dirs.commonDir, tree, [parent], id, body);
}

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
      try { closeSync(lockFd); } catch { /* Best effort. */ }
    }
    if (createdLock && !installed) {
      try { rmSync(indexLock, { force: true }); } catch { /* Best effort. */ }
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
      try { closeSync(lockFd); } catch { /* Best effort. */ }
    }
    if (createdLock && !installed) {
      try { rmSync(indexLock, { force: true }); } catch { /* Best effort. */ }
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
      try { closeSync(lockFd); } catch { /* Best effort. */ }
    }
    if (createdLock && !installed) {
      try { rmSync(indexLock, { force: true }); } catch { /* Best effort. */ }
    }
  }
}
