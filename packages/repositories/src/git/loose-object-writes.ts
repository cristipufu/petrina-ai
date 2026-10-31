// Direct loose SHA-1 blob, tree, commit and index v2 encoders and commit fast paths.

import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { treeEntries } from "../object-format.js";
import { isSpawnIntercepted } from "./exec.js";
import {
  FULL_OID,
  type GitDirs,
  hasRefDirectoryConflict,
  hasReplaceRefs,
  isPlainSha1CommonDir,
  isSafeSimpleRefName,
  parsePlainGitConfigEntries,
  readLooseCommitObject,
  readLooseRawObject,
  resolveDirectRef,
  resolveGitDirs,
  tryAtomicUpdateLooseRef,
} from "./loose-objects.js";
import {
  BUSY_GITDIR_MARKERS,
  computeTrackedDiffersFromHead,
  inspectPlainWorktree,
  type PlainWorktreeInspection,
} from "./loose-worktree-inspect.js";

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
      try {
        closeSync(lockFd);
      } catch {
        /* Best effort. */
      }
    }
    if (createdLock && !indexInstalled) {
      try {
        rmSync(indexLock, { force: true });
      } catch {
        /* Best effort. */
      }
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
      try {
        rmSync(tmpPath, { force: true });
      } catch {
        /* Best effort. */
      }
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
