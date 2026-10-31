// Direct read-only inspection of plain loose Git objects, trees, commits and refs.
// Falls back cleanly whenever packs, alternates, grafts, submodules or non-plain configs exist.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { treeEntries } from "../object-format.js";
import { isSpawnIntercepted, systemCode } from "./exec.js";

/** Full or abbreviated native object ids, for either Git object format. */
export const SHA = /^[0-9a-f]{7,64}$/i;

export const FULL_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

const SIMPLE_REF_CHARS = /^[A-Za-z0-9._/-]+$/;

export interface GitDirs {
  gitdir: string;
  commonDir: string;
}

export interface LooseCommit {
  oid: string;
  tree: string;
  parents: string[];
  body: string;
}

export function resolveGitDirs(path: string): GitDirs | undefined {
  try {
    const dotGit = join(path, ".git");
    const entry = statSync(dotGit);
    let gitdir: string;
    if (entry.isDirectory()) {
      gitdir = dotGit;
    } else if (entry.isFile()) {
      const text = readFileSync(dotGit, "utf8").trim();
      if (!text.startsWith("gitdir:")) return undefined;
      gitdir = resolve(path, text.slice("gitdir:".length).trim());
    } else {
      return undefined;
    }
    const commonFile = join(gitdir, "commondir");
    const commonDir = existsSync(commonFile)
      ? resolve(gitdir, readFileSync(commonFile, "utf8").trim())
      : gitdir;
    if (existsSync(join(commonDir, "reftable"))) return undefined;
    if (!statSync(join(gitdir, "HEAD")).isFile() || !statSync(join(commonDir, "HEAD")).isFile()) return undefined;
    return { gitdir, commonDir };
  } catch {
    return undefined;
  }
}

export function isSafeSimpleRefName(ref: string): boolean {
  if (!SIMPLE_REF_CHARS.test(ref)) return false;
  if (ref.includes("..") || ref.includes("//") || ref.startsWith("/") || ref.endsWith("/") || ref.endsWith(".lock")) return false;
  return !ref.split("/").some((part) => !part || part.startsWith("."));
}

export function resolveDirectRef(
  dirs: GitDirs,
  ref: string,
  depth = 0,
): { kind: "oid"; oid: string } | { kind: "missing" } | { kind: "fallback" } {
  if (depth > 5) return { kind: "fallback" };
  if (ref === "HEAD") {
    try {
      const text = readFileSync(join(dirs.gitdir, "HEAD"), "utf8").trim();
      if (!text || text === "ref: refs/heads/.invalid") return { kind: "fallback" };
      if (text.startsWith("ref:")) {
        const target = text.slice(4).trim();
        if (!target.startsWith("refs/") || !isSafeSimpleRefName(target)) return { kind: "fallback" };
        return resolveDirectRef(dirs, target, depth + 1);
      }
      return FULL_OID.test(text) ? { kind: "oid", oid: text.toLowerCase() } : { kind: "fallback" };
    } catch {
      return { kind: "fallback" };
    }
  }
  if (!ref.startsWith("refs/") || !isSafeSimpleRefName(ref)) return { kind: "fallback" };
  const baseDir = ref.startsWith("refs/worktree/") || ref.startsWith("refs/bisect/") ? dirs.gitdir : dirs.commonDir;
  const loosePath = join(baseDir, ...ref.split("/"));
  try {
    const info = statSync(loosePath);
    if (info.isDirectory()) return { kind: "missing" };
    if (!info.isFile()) return { kind: "fallback" };
    const text = readFileSync(loosePath, "utf8").trim();
    if (text.startsWith("ref:")) {
      const target = text.slice(4).trim();
      if (!target.startsWith("refs/") || !isSafeSimpleRefName(target)) return { kind: "fallback" };
      return resolveDirectRef(dirs, target, depth + 1);
    }
    return FULL_OID.test(text) ? { kind: "oid", oid: text.toLowerCase() } : { kind: "fallback" };
  } catch (error) {
    const code = systemCode(error);
    if (code !== "ENOENT" && code !== "ENOTDIR") return { kind: "fallback" };
  }
  const packedPath = join(dirs.commonDir, "packed-refs");
  if (!existsSync(packedPath)) return { kind: "missing" };
  try {
    const packed = readFileSync(packedPath, "utf8");
    for (const rawLine of packed.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || line.startsWith("^")) continue;
      const space = line.indexOf(" ");
      if (space <= 0) continue;
      const name = line.slice(space + 1).trim();
      if (name === ref) {
        const oid = line.slice(0, space);
        return FULL_OID.test(oid) ? { kind: "oid", oid: oid.toLowerCase() } : { kind: "fallback" };
      }
    }
    return { kind: "missing" };
  } catch {
    return { kind: "fallback" };
  }
}

export function hasNestedRefsPrefix(commonDir: string, ref: string): boolean {
  if (
    existsSync(join(commonDir, "refs", "refs")) ||
    existsSync(join(commonDir, "refs", "heads", "refs")) ||
    existsSync(join(commonDir, "refs", "tags", "refs")) ||
    existsSync(join(commonDir, "refs", "remotes", "refs"))
  ) {
    return true;
  }
  const packedPath = join(commonDir, "packed-refs");
  if (!existsSync(packedPath)) return false;
  try {
    return readFileSync(packedPath, "utf8").includes(`/${ref}`);
  } catch {
    return true;
  }
}

export function readLooseCommitObject(commonDir: string, oid: string): LooseCommit | undefined {
  if (!FULL_OID.test(oid)) return undefined;
  const lower = oid.toLowerCase();
  let compressed: Buffer;
  try {
    compressed = readFileSync(join(commonDir, "objects", lower.slice(0, 2), lower.slice(2)));
  } catch {
    return undefined;
  }
  let raw: Buffer;
  try {
    raw = inflateSync(compressed);
  } catch {
    return undefined;
  }
  const nul = raw.indexOf(0);
  if (nul <= 7) return undefined;
  const header = raw.subarray(0, nul).toString("utf8");
  if (!header.startsWith("commit ")) return undefined;
  const size = Number(header.slice(7));
  const contentBytes = raw.subarray(nul + 1);
  if (!Number.isInteger(size) || size !== contentBytes.length) return undefined;
  if (createHash(lower.length === 64 ? "sha256" : "sha1").update(raw).digest("hex") !== lower) return undefined;
  const text = contentBytes.toString("utf8");
  const splitAt = text.indexOf("\n\n");
  const headerBlock = splitAt >= 0 ? text.slice(0, splitAt) : text;
  const body = splitAt >= 0 ? text.slice(splitAt + 2) : "";
  let tree: string | undefined;
  const parents: string[] = [];
  for (const line of headerBlock.split("\n")) {
    if (line.startsWith("tree ")) {
      const candidate = line.slice(5).trim();
      if (!FULL_OID.test(candidate)) return undefined;
      tree = candidate.toLowerCase();
    } else if (line.startsWith("parent ")) {
      const candidate = line.slice(7).trim();
      if (!FULL_OID.test(candidate)) return undefined;
      parents.push(candidate.toLowerCase());
    }
  }
  return tree ? { oid: lower, tree, parents, body } : undefined;
}

export function canWalkRawLooseHistory(commonDir: string, ignoreCommitGraph: boolean): boolean {
  if (existsSync(join(commonDir, "shallow")) || existsSync(join(commonDir, "info", "grafts"))) return false;
  if (
    !ignoreCommitGraph &&
    (existsSync(join(commonDir, "objects", "info", "commit-graph")) || existsSync(join(commonDir, "objects", "info", "commit-graphs")))
  ) {
    return false;
  }
  return true;
}

export function looseAncestorSet(commonDir: string, startOid: string, limit = 4096): Set<string> | undefined {
  const start = readLooseCommitObject(commonDir, startOid);
  if (!start) return undefined;
  const visited = new Set<string>([start.oid]);
  const queue: LooseCommit[] = [start];
  while (queue.length > 0) {
    if (visited.size > limit) return undefined;
    const current = queue.pop()!;
    for (const parentOid of current.parents) {
      if (visited.has(parentOid)) continue;
      const parent = readLooseCommitObject(commonDir, parentOid);
      if (!parent) return undefined;
      visited.add(parent.oid);
      queue.push(parent);
    }
  }
  return visited;
}

export function collectLooseTreeFiles(
  commonDir: string,
  treeOid: string,
  format: "sha1" | "sha256",
  out: Map<string, { mode: "100644" | "100755"; oidHex: string }>,
  prefix = "",
): boolean {
  const oidByteLen = format === "sha256" ? 32 : 20;
  let compressed: Buffer;
  try {
    compressed = readFileSync(join(commonDir, "objects", treeOid.slice(0, 2), treeOid.slice(2)));
  } catch {
    return false;
  }
  let raw: Buffer;
  try {
    raw = inflateSync(compressed);
  } catch {
    return false;
  }
  const nul = raw.indexOf(0);
  if (nul <= 5) return false;
  const header = raw.subarray(0, nul).toString("utf8");
  if (!header.startsWith("tree ")) return false;
  const size = Number(header.slice(5));
  const body = raw.subarray(nul + 1);
  if (!Number.isInteger(size) || size !== body.length) return false;
  if (createHash(format).update(raw).digest("hex") !== treeOid) return false;
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space <= offset) return false;
    const entryNul = body.indexOf(0x00, space + 1);
    if (entryNul <= space + 1 || entryNul + 1 + oidByteLen > body.length) return false;
    const mode = body.subarray(offset, space).toString("utf8");
    const name = body.subarray(space + 1, entryNul).toString("utf8");
    if (!name || name === ".gitattributes" || name === ".gitmodules") return false;
    const entryOid = body.subarray(entryNul + 1, entryNul + 1 + oidByteLen).toString("hex");
    const relPath = prefix ? `${prefix}/${name}` : name;
    offset = entryNul + 1 + oidByteLen;
    if (mode === "40000" || mode === "040000") {
      if (!collectLooseTreeFiles(commonDir, entryOid, format, out, relPath)) return false;
    } else if (mode === "100644" || mode === "100755") {
      if (out.size >= 256) return false;
      out.set(relPath, { mode, oidHex: entryOid });
    } else {
      return false;
    }
  }
  return true;
}

export function haveIdenticalLooseTree(path: string, from: string, to: string): boolean {
  if (isSpawnIntercepted()) return false;
  const dirs = resolveGitDirs(path);
  if (!dirs) return false;
  const fromResolved =
    from === "HEAD" ? resolveDirectRef(dirs, "HEAD") : FULL_OID.test(from) ? { kind: "oid" as const, oid: from.toLowerCase() } : undefined;
  const toResolved =
    to === "HEAD" ? resolveDirectRef(dirs, "HEAD") : FULL_OID.test(to) ? { kind: "oid" as const, oid: to.toLowerCase() } : undefined;
  if (fromResolved?.kind !== "oid" || toResolved?.kind !== "oid") return false;
  const fromCommit = readLooseCommitObject(dirs.commonDir, fromResolved.oid);
  const toCommit = readLooseCommitObject(dirs.commonDir, toResolved.oid);
  if (!fromCommit || !toCommit || fromCommit.tree !== toCommit.tree) return false;
  return existsSync(join(dirs.commonDir, "objects", fromCommit.tree.slice(0, 2), fromCommit.tree.slice(2)));
}

export const RAW_UTF8_DECODER = new TextDecoder("utf-8", { ignoreBOM: true });

export function readLooseRawObject(commonDir: string, oid: string): { type: string; body: Buffer; format: "sha1" | "sha256" } | undefined {
  if (!FULL_OID.test(oid)) return undefined;
  const lower = oid.toLowerCase();
  let compressed: Buffer;
  try {
    compressed = readFileSync(join(commonDir, "objects", lower.slice(0, 2), lower.slice(2)));
  } catch {
    return undefined;
  }
  let raw: Buffer;
  try {
    raw = inflateSync(compressed);
  } catch {
    return undefined;
  }
  const nul = raw.indexOf(0);
  if (nul <= 4) return undefined;
  const header = raw.subarray(0, nul).toString("utf8");
  const space = header.indexOf(" ");
  if (space <= 0) return undefined;
  const type = header.slice(0, space);
  const size = Number(header.slice(space + 1));
  const body = raw.subarray(nul + 1);
  if (!Number.isInteger(size) || size !== body.length) return undefined;
  const format = lower.length === 64 ? "sha256" : "sha1";
  if (createHash(format).update(raw).digest("hex") !== lower) return undefined;
  return { type, body, format };
}

export function findLooseTreeEntry(
  treeOid: string,
  body: Buffer,
  targetName: string,
): { found: true; mode: string; oid: string } | { found: false } | undefined {
  let parsed;
  try {
    parsed = treeEntries({ id: treeOid.toLowerCase(), type: "tree", body });
  } catch {
    return undefined;
  }
  const wanted = Buffer.from(targetName);
  const matches = parsed.filter((entry) => entry.name.equals(wanted));
  if (matches.length === 0) return { found: false };
  if (matches.length > 1) return undefined;
  const entry = matches[0]!;
  const typeBits = entry.mode & 0o170000;
  if (typeBits === 0o100000) return { found: true, mode: entry.mode & 0o100 ? "100755" : "100644", oid: entry.id };
  if (typeBits === 0o040000) return { found: true, mode: "40000", oid: entry.id };
  if (typeBits === 0o120000) return { found: true, mode: "120000", oid: entry.id };
  if (typeBits === 0o160000) return { found: true, mode: "160000", oid: entry.id };
  return undefined;
}

export function hasReplaceRefs(commonDir: string): boolean {
  if (existsSync(join(commonDir, "refs", "replace"))) return true;
  const packedPath = join(commonDir, "packed-refs");
  if (!existsSync(packedPath)) return false;
  try {
    return readFileSync(packedPath, "utf8").includes("refs/replace/");
  } catch {
    return true;
  }
}

export function hasNoPacksOrAlternates(commonDir: string): boolean {
  if (
    existsSync(join(commonDir, "objects", "info", "alternates")) ||
    existsSync(join(commonDir, "shallow")) ||
    hasReplaceRefs(commonDir)
  ) {
    return false;
  }
  const packDir = join(commonDir, "objects", "pack");
  if (!existsSync(packDir)) return existsSync(join(commonDir, "objects"));
  try {
    return readdirSync(packDir).every((name) => !name.endsWith(".pack"));
  } catch {
    return false;
  }
}

export function isDefinitelyAbsentLooseOid(commonDir: string, oid: string): boolean {
  if (!FULL_OID.test(oid) || !hasNoPacksOrAlternates(commonDir)) return false;
  const lower = oid.toLowerCase();
  return !existsSync(join(commonDir, "objects", lower.slice(0, 2), lower.slice(2)));
}

export function isDefinitelyAbsentSimpleRef(dirs: GitDirs, ref: string): boolean {
  if (!isSafeSimpleRefName(ref) || SHA.test(ref) || ref === "HEAD" || ref.startsWith("refs/") || ref.startsWith("origin/")) {
    return false;
  }
  return (
    !existsSync(join(dirs.gitdir, ...ref.split("/"))) &&
    !existsSync(join(dirs.commonDir, ...ref.split("/"))) &&
    resolveDirectRef(dirs, `refs/${ref}`).kind === "missing" &&
    resolveDirectRef(dirs, `refs/tags/${ref}`).kind === "missing" &&
    resolveDirectRef(dirs, `refs/heads/${ref}`).kind === "missing" &&
    !hasNestedRefsPrefix(dirs.commonDir, `refs/heads/${ref}`) &&
    resolveDirectRef(dirs, `refs/remotes/${ref}`).kind === "missing" &&
    !hasNestedRefsPrefix(dirs.commonDir, `refs/remotes/${ref}`)
  );
}

export function resolveLooseRefCommit(dirs: GitDirs, ref: string): LooseCommit | undefined {
  if (ref === "HEAD") {
    const resolved = resolveDirectRef(dirs, "HEAD");
    return resolved.kind === "oid" ? readLooseCommitObject(dirs.commonDir, resolved.oid) : undefined;
  }
  if (FULL_OID.test(ref)) {
    return readLooseCommitObject(dirs.commonDir, ref);
  }
  if (ref.startsWith("refs/") && isSafeSimpleRefName(ref)) {
    const resolved = resolveDirectRef(dirs, ref);
    return resolved.kind === "oid" ? readLooseCommitObject(dirs.commonDir, resolved.oid) : undefined;
  }
  if (ref.startsWith("origin/") && isSafeSimpleRefName(ref)) {
    if (
      !existsSync(join(dirs.gitdir, ...ref.split("/"))) &&
      !existsSync(join(dirs.commonDir, ...ref.split("/"))) &&
      resolveDirectRef(dirs, `refs/${ref}`).kind === "missing" &&
      resolveDirectRef(dirs, `refs/tags/${ref}`).kind === "missing" &&
      resolveDirectRef(dirs, `refs/heads/${ref}`).kind === "missing"
    ) {
      const remoteResolved = resolveDirectRef(dirs, `refs/remotes/${ref}`);
      return remoteResolved.kind === "oid" ? readLooseCommitObject(dirs.commonDir, remoteResolved.oid) : undefined;
    }
    return undefined;
  }
  if (isSafeSimpleRefName(ref)) {
    if (
      !existsSync(join(dirs.gitdir, ...ref.split("/"))) &&
      !existsSync(join(dirs.commonDir, ...ref.split("/"))) &&
      resolveDirectRef(dirs, `refs/${ref}`).kind === "missing" &&
      resolveDirectRef(dirs, `refs/tags/${ref}`).kind === "missing"
    ) {
      const headResolved = resolveDirectRef(dirs, `refs/heads/${ref}`);
      return headResolved.kind === "oid" ? readLooseCommitObject(dirs.commonDir, headResolved.oid) : undefined;
    }
  }
  return undefined;
}

export function resolveLooseTreeOid(dirs: GitDirs, ref: string): string | undefined {
  const commit = resolveLooseRefCommit(dirs, ref);
  if (commit) return commit.tree;
  if (FULL_OID.test(ref)) {
    const raw = readLooseRawObject(dirs.commonDir, ref);
    return raw?.type === "tree" ? ref.toLowerCase() : undefined;
  }
  return undefined;
}

export function isSimpleValidBranchName(name: string): boolean {
  if (isSpawnIntercepted()) return false;
  if (!name || name === "HEAD" || name === "@" || name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) {
    return false;
  }
  if (name.includes("..") || name.includes("//")) return false;
  const parts = name.split("/");
  return parts.every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) && !part.endsWith(".") && !part.endsWith(".lock"));
}
