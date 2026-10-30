// Direct read-only inspection of plain loose SHA-1 Git objects, refs and trees.
// Falls back cleanly whenever packs, alternates, grafts, submodules or non-plain configs exist.

import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { type GitObject, treeEntries } from "../object-format.js";
import { empty, isSpawnIntercepted, run, systemCode } from "./exec.js";

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

export function resolveDirectRef(dirs: GitDirs, ref: string, depth = 0): { kind: "oid"; oid: string } | { kind: "missing" } | { kind: "fallback" } {
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
  if (!ignoreCommitGraph && (existsSync(join(commonDir, "objects", "info", "commit-graph")) || existsSync(join(commonDir, "objects", "info", "commit-graphs")))) {
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
  const fromResolved = from === "HEAD" ? resolveDirectRef(dirs, "HEAD") : FULL_OID.test(from) ? { kind: "oid" as const, oid: from.toLowerCase() } : undefined;
  const toResolved = to === "HEAD" ? resolveDirectRef(dirs, "HEAD") : FULL_OID.test(to) ? { kind: "oid" as const, oid: to.toLowerCase() } : undefined;
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

function findLooseTreeEntry(
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

function hasNoPacksOrAlternates(commonDir: string): boolean {
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

function isDefinitelyAbsentSimpleRef(dirs: GitDirs, ref: string): boolean {
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

export function readLooseObjectPacket(path: string, requests: readonly string[]): (GitObject | undefined)[] | undefined {
  if (isSpawnIntercepted()) return undefined;
  const dirs = resolveGitDirs(path);
  if (!dirs || hasReplaceRefs(dirs.commonDir)) return undefined;
  const noPacks = hasNoPacksOrAlternates(dirs.commonDir);
  const out: (GitObject | undefined)[] = [];
  for (const request of requests) {
    if (request.includes("\n") || request.includes("\r")) return undefined;
    if (FULL_OID.test(request)) {
      const raw = readLooseRawObject(dirs.commonDir, request);
      if (!raw) {
        if (noPacks && isDefinitelyAbsentLooseOid(dirs.commonDir, request)) {
          out.push(undefined);
          continue;
        }
        return undefined;
      }
      if (raw.type !== "blob" && raw.type !== "tree" && raw.type !== "commit" && raw.type !== "tag") return undefined;
      out.push({ id: request.toLowerCase(), type: raw.type, body: raw.body });
      continue;
    }
    if (request.endsWith("^{commit}")) {
      const refPart = request.slice(0, -9);
      if (!refPart) return undefined;
      const commit = resolveLooseRefCommit(dirs, refPart);
      if (!commit) {
        if (noPacks && (isDefinitelyAbsentLooseOid(dirs.commonDir, refPart) || isDefinitelyAbsentSimpleRef(dirs, refPart))) {
          out.push(undefined);
          continue;
        }
        return undefined;
      }
      const raw = readLooseRawObject(dirs.commonDir, commit.oid);
      if (!raw || raw.type !== "commit") return undefined;
      out.push({ id: commit.oid, type: "commit", body: raw.body });
      continue;
    }
    if (request.endsWith("^{tree}")) {
      const refPart = request.slice(0, -7);
      if (!refPart) return undefined;
      const treeOid = resolveLooseTreeOid(dirs, refPart);
      if (!treeOid) {
        if (noPacks && (isDefinitelyAbsentLooseOid(dirs.commonDir, refPart) || isDefinitelyAbsentSimpleRef(dirs, refPart))) {
          out.push(undefined);
          continue;
        }
        return undefined;
      }
      const raw = readLooseRawObject(dirs.commonDir, treeOid);
      if (!raw || raw.type !== "tree") return undefined;
      out.push({ id: treeOid, type: "tree", body: raw.body });
      continue;
    }
    const colon = request.indexOf(":");
    if (colon >= 0) {
      const refPart = request.slice(0, colon);
      const relPath = request.slice(colon + 1);
      if (!refPart || !relPath || relPath.startsWith("/") || relPath.endsWith("/")) return undefined;
      const segments = relPath.split("/");
      if (segments.some((part) => !part || part === "." || part === "..")) return undefined;
      let currentTreeOid = resolveLooseTreeOid(dirs, refPart);
      if (!currentTreeOid) {
        if (noPacks && (isDefinitelyAbsentLooseOid(dirs.commonDir, refPart) || isDefinitelyAbsentSimpleRef(dirs, refPart))) {
          out.push(undefined);
          continue;
        }
        return undefined;
      }
      let resolved = false;
      for (let i = 0; i < segments.length; i += 1) {
        const treeObj = readLooseRawObject(dirs.commonDir, currentTreeOid);
        if (!treeObj || treeObj.type !== "tree") return undefined;
        const entry = findLooseTreeEntry(currentTreeOid, treeObj.body, segments[i]!);
        if (!entry) return undefined;
        if (!entry.found) {
          out.push(undefined);
          resolved = true;
          break;
        }
        if (i < segments.length - 1) {
          if (entry.mode === "40000" || entry.mode === "040000") {
            currentTreeOid = entry.oid;
            continue;
          }
          if (entry.mode === "100644" || entry.mode === "100755") {
            out.push(undefined);
            resolved = true;
            break;
          }
          return undefined;
        }
        if (entry.mode === "160000") return undefined;
        const target = readLooseRawObject(dirs.commonDir, entry.oid);
        if (!target || (target.type !== "blob" && target.type !== "tree" && target.type !== "commit" && target.type !== "tag")) return undefined;
        out.push({ id: entry.oid, type: target.type, body: target.body });
        resolved = true;
      }
      if (!resolved) return undefined;
      continue;
    }
    const commit = resolveLooseRefCommit(dirs, request);
    if (!commit) {
      if (noPacks && isDefinitelyAbsentSimpleRef(dirs, request)) {
        out.push(undefined);
        continue;
      }
      return undefined;
    }
    const raw = readLooseRawObject(dirs.commonDir, commit.oid);
    if (!raw || raw.type !== "commit") return undefined;
    out.push({ id: commit.oid, type: "commit", body: raw.body });
  }
  return out;
}

export function readLooseObjectTypes(path: string, specs: readonly string[]): Map<string, { oid: string; type: string }> | undefined {
  if (isSpawnIntercepted()) return undefined;
  const dirs = resolveGitDirs(path);
  if (!dirs || hasReplaceRefs(dirs.commonDir)) return undefined;
  const noPacks = hasNoPacksOrAlternates(dirs.commonDir);
  const out = new Map<string, { oid: string; type: string }>();
  for (const spec of specs) {
    if (FULL_OID.test(spec)) {
      const raw = readLooseRawObject(dirs.commonDir, spec);
      if (!raw) {
        if (noPacks && isDefinitelyAbsentLooseOid(dirs.commonDir, spec)) continue;
        return undefined;
      }
      if (raw.type !== "commit" && raw.type !== "tree" && raw.type !== "blob" && raw.type !== "tag") return undefined;
      out.set(spec, { oid: spec.toLowerCase(), type: raw.type });
      continue;
    }
    if (spec.endsWith("^{commit}")) {
      const base = spec.slice(0, -9);
      if (!FULL_OID.test(base)) return undefined;
      const raw = readLooseRawObject(dirs.commonDir, base);
      if (!raw) {
        if (noPacks && isDefinitelyAbsentLooseOid(dirs.commonDir, base)) continue;
        return undefined;
      }
      if (raw.type === "commit") {
        out.set(spec, { oid: base.toLowerCase(), type: "commit" });
        continue;
      }
      if (raw.type === "tree" || raw.type === "blob") continue;
      return undefined;
    }
    if (spec.endsWith("^{tree}")) {
      const base = spec.slice(0, -7);
      if (!FULL_OID.test(base)) return undefined;
      const raw = readLooseRawObject(dirs.commonDir, base);
      if (!raw) {
        if (noPacks && isDefinitelyAbsentLooseOid(dirs.commonDir, base)) continue;
        return undefined;
      }
      if (raw.type === "tree") {
        out.set(spec, { oid: base.toLowerCase(), type: "tree" });
        continue;
      }
      if (raw.type === "commit") {
        const commit = readLooseCommitObject(dirs.commonDir, base);
        if (!commit) return undefined;
        const treeRaw = readLooseRawObject(dirs.commonDir, commit.tree);
        if (treeRaw?.type === "tree") {
          out.set(spec, { oid: commit.tree, type: "tree" });
          continue;
        }
        if (!treeRaw && noPacks && isDefinitelyAbsentLooseOid(dirs.commonDir, commit.tree)) continue;
        return undefined;
      }
      if (raw.type === "blob") continue;
      return undefined;
    }
    return undefined;
  }
  return out;
}

export function readLooseFileAt(root: string, ref: string, filePath: string): { found: boolean; text?: string } | undefined {
  if (isSpawnIntercepted()) return undefined;
  if (!empty && process.env.PETRINA_HOME) {
    try {
      if (!statSync(process.env.PETRINA_HOME).isDirectory()) return undefined;
    } catch (error) {
      if (systemCode(error) !== "ENOENT") return undefined;
    }
  }
  if (!filePath || filePath.startsWith("/") || filePath.endsWith("/") || filePath.includes("\0")) return undefined;
  const segments = filePath.split("/");
  if (segments.some((part) => !part || part === "." || part === "..")) return undefined;
  const dirs = resolveGitDirs(root);
  if (!dirs || hasReplaceRefs(dirs.commonDir)) return undefined;
  let currentTreeOid = resolveLooseTreeOid(dirs, ref);
  if (!currentTreeOid) {
    if (isDefinitelyAbsentLooseOid(dirs.commonDir, ref)) return { found: false };
    return undefined;
  }
  for (let i = 0; i < segments.length; i += 1) {
    const treeObj = readLooseRawObject(dirs.commonDir, currentTreeOid);
    if (!treeObj || treeObj.type !== "tree") return undefined;
    const entry = findLooseTreeEntry(currentTreeOid, treeObj.body, segments[i]!);
    if (!entry) return undefined;
    if (!entry.found) return { found: false };
    if (i < segments.length - 1) {
      if (entry.mode === "40000" || entry.mode === "040000") {
        currentTreeOid = entry.oid;
        continue;
      }
      if (entry.mode === "100644" || entry.mode === "100755") return { found: false };
      return undefined;
    }
    if (entry.mode === "40000" || entry.mode === "040000" || entry.mode === "160000") return { found: false };
    if (entry.mode !== "100644" && entry.mode !== "100755" && entry.mode !== "120000") return undefined;
    const blobObj = readLooseRawObject(dirs.commonDir, entry.oid);
    if (!blobObj) return undefined;
    if (blobObj.type !== "blob") return { found: false };
    return { found: true, text: RAW_UTF8_DECODER.decode(blobObj.body) };
  }
  return undefined;
}

export function parsePlainGitConfigEntries(text: string): { key: string; value: string }[] | undefined {
  if (/\[include/i.test(text)) return undefined;
  let section = "";
  let subsection: string | undefined;
  const entries: { key: string; value: string }[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let pos = 0;
    while (pos < rawLine.length && (rawLine[pos] === " " || rawLine[pos] === "\t")) pos += 1;
    if (pos >= rawLine.length || rawLine[pos] === "#" || rawLine[pos] === ";") continue;
    if (rawLine[pos] === "[") {
      pos += 1;
      let secEnd = pos;
      while (secEnd < rawLine.length && /[A-Za-z0-9-]/.test(rawLine[secEnd]!)) secEnd += 1;
      if (secEnd === pos) return undefined;
      const nextSection = rawLine.slice(pos, secEnd).toLowerCase();
      pos = secEnd;
      let nextSub: string | undefined;
      if (pos < rawLine.length && rawLine[pos] === "]") {
        pos += 1;
      } else if (pos < rawLine.length && (rawLine[pos] === " " || rawLine[pos] === "\t")) {
        while (pos < rawLine.length && (rawLine[pos] === " " || rawLine[pos] === "\t")) pos += 1;
        if (rawLine[pos] !== '"') return undefined;
        pos += 1;
        let sub = "";
        let closed = false;
        while (pos < rawLine.length) {
          const ch = rawLine[pos]!;
          if (ch === '"') {
            pos += 1;
            closed = true;
            break;
          }
          if (ch === "\\") {
            if (pos + 1 >= rawLine.length) return undefined;
            const esc = rawLine[pos + 1]!;
            if (esc !== "\\" && esc !== '"') return undefined;
            sub += esc;
            pos += 2;
            continue;
          }
          sub += ch;
          pos += 1;
        }
        if (!closed || rawLine[pos] !== "]") return undefined;
        pos += 1;
        nextSub = sub;
      } else {
        return undefined;
      }
      while (pos < rawLine.length && (rawLine[pos] === " " || rawLine[pos] === "\t")) pos += 1;
      if (pos < rawLine.length && rawLine[pos] !== "#" && rawLine[pos] !== ";") return undefined;
      section = nextSection;
      subsection = nextSub;
      continue;
    }
    if (!section) return undefined;
    const eq = rawLine.indexOf("=", pos);
    if (eq < 0) return undefined;
    const rawKey = rawLine.slice(pos, eq).trim();
    if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(rawKey)) return undefined;
    const fullKey = subsection !== undefined ? `${section}.${subsection}.${rawKey.toLowerCase()}` : `${section}.${rawKey.toLowerCase()}`;
    let vPos = eq + 1;
    while (vPos < rawLine.length && (rawLine[vPos] === " " || rawLine[vPos] === "\t")) vPos += 1;
    let inQuotes = false;
    let out = "";
    let trailingSpaceStart = -1;
    for (let i = vPos; i < rawLine.length; i += 1) {
      const ch = rawLine[i]!;
      if (!inQuotes && (ch === "#" || ch === ";")) break;
      if (ch === '"') {
        inQuotes = !inQuotes;
        trailingSpaceStart = -1;
        continue;
      }
      if (ch === "\\") {
        if (i + 1 >= rawLine.length) return undefined;
        const esc = rawLine[i + 1]!;
        if (esc === "\\" || esc === '"') out += esc;
        else if (esc === "n") out += "\n";
        else if (esc === "t") out += "\t";
        else if (esc === "b") out += "\b";
        else return undefined;
        trailingSpaceStart = -1;
        i += 1;
        continue;
      }
      if (!inQuotes && (ch === " " || ch === "\t")) {
        if (trailingSpaceStart < 0) trailingSpaceStart = out.length;
        out += ch;
        continue;
      }
      trailingSpaceStart = -1;
      out += ch;
    }
    if (inQuotes) return undefined;
    if (trailingSpaceStart >= 0) out = out.slice(0, trailingSpaceStart);
    entries.push({ key: fullKey, value: out });
  }
  return entries;
}

export function readSimpleRemoteOriginUrl(root: string): { found: true; url: string | undefined } | undefined {
  if (isSpawnIntercepted()) return undefined;
  if (process.env.GIT_CONFIG_PARAMETERS || process.env.GIT_CONFIG_COUNT || process.env.GIT_CONFIG) {
    return undefined;
  }
  const dirs = resolveGitDirs(root);
  if (!dirs || existsSync(join(dirs.gitdir, "config.worktree")) || existsSync(join(dirs.commonDir, "config.worktree"))) {
    return undefined;
  }
  let text: string;
  try {
    text = readFileSync(join(dirs.commonDir, "config"), "utf8");
  } catch {
    return undefined;
  }
  const entries = parsePlainGitConfigEntries(text);
  if (!entries) return undefined;
  const urls: string[] = [];
  for (const entry of entries) {
    const lowerKey = entry.key.toLowerCase();
    if (lowerKey === "extensions.worktreeconfig") return undefined;
    if (lowerKey === "remote.origin.url") {
      if (entry.key !== "remote.origin.url") return undefined;
      urls.push(entry.value);
    }
  }
  if (urls.length === 1 && urls[0]) {
    return { found: true, url: urls[0] };
  }
  const lower = text.toLowerCase();
  if (urls.length === 0 && !lower.includes("origin")) {
    const noSystem = process.env.GIT_CONFIG_NOSYSTEM === "1";
    const sysPath = process.env.GIT_CONFIG_SYSTEM;
    const globalPath = process.env.GIT_CONFIG_GLOBAL;
    if ((noSystem || sysPath) && globalPath) {
      try {
        if (!noSystem && sysPath && existsSync(sysPath)) {
          const sysLower = readFileSync(sysPath, "utf8").toLowerCase();
          if (sysLower.includes("origin") || sysLower.includes("[include")) return undefined;
        }
        const globalLower = existsSync(globalPath) ? readFileSync(globalPath, "utf8").toLowerCase() : "";
        if (!globalLower.includes("origin") && !globalLower.includes("[include")) return { found: true, url: undefined };
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function resolveOriginDefaultBranchSync(dirs: GitDirs): string | undefined {
  const originHead = join(dirs.commonDir, "refs", "remotes", "origin", "HEAD");
  try {
    if (existsSync(originHead)) {
      const text = readFileSync(originHead, "utf8").trim();
      if (text.startsWith("ref: refs/remotes/origin/")) {
        const branch = text.slice("ref: refs/remotes/origin/".length);
        if (branch && isSafeSimpleRefName(branch)) return branch;
      }
      return undefined;
    }
    const packedPath = join(dirs.commonDir, "packed-refs");
    if (existsSync(packedPath) && readFileSync(packedPath, "utf8").includes("refs/remotes/origin/HEAD")) {
      return undefined;
    }
    const headText = readFileSync(join(dirs.gitdir, "HEAD"), "utf8").trim();
    if (headText === "ref: refs/heads/.invalid") return undefined;
    if (headText.startsWith("ref: refs/heads/")) {
      const branch = headText.slice("ref: refs/heads/".length);
      return branch && isSafeSimpleRefName(branch) ? branch : undefined;
    }
    if (FULL_OID.test(headText)) return "HEAD";
  } catch {
    return undefined;
  }
  return undefined;
}

export function resolveBareGitDirs(remotePath: string): GitDirs | undefined {
  try {
    if (!statSync(remotePath).isDirectory() || existsSync(join(remotePath, ".git")) || existsSync(join(remotePath, "reftable"))) {
      return undefined;
    }
    if (!statSync(join(remotePath, "HEAD")).isFile() || !statSync(join(remotePath, "objects")).isDirectory() || !statSync(join(remotePath, "refs")).isDirectory()) {
      return undefined;
    }
    return { gitdir: remotePath, commonDir: remotePath };
  } catch {
    return undefined;
  }
}

export function hasRefDirectoryConflict(commonDir: string, ref: string): boolean {
  const parts = ref.split("/");
  for (let i = 0; i < parts.length - 1; i += 1) {
    const prefixPath = join(commonDir, ...parts.slice(0, i + 1));
    try {
      if (!lstatSync(prefixPath).isDirectory()) return true;
    } catch (error) {
      if (systemCode(error) !== "ENOENT") return true;
    }
  }
  const targetPath = join(commonDir, ...parts);
  try {
    if (!lstatSync(targetPath).isFile()) return true;
  } catch (error) {
    if (systemCode(error) !== "ENOENT") return true;
  }
  if (existsSync(`${targetPath}.lock`)) return true;
  const packedPath = join(commonDir, "packed-refs");
  if (existsSync(packedPath)) {
    try {
      for (const rawLine of readFileSync(packedPath, "utf8").split("\n")) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#") || line.startsWith("^")) continue;
        const space = line.indexOf(" ");
        if (space <= 0) continue;
        const name = line.slice(space + 1).trim();
        if (name.startsWith(`${ref}/`) || ref.startsWith(`${name}/`)) return true;
      }
    } catch {
      return true;
    }
  }
  return false;
}

export function directRefMatches(
  actual: ReturnType<typeof resolveDirectRef>,
  expected: { kind: "oid"; oid: string } | { kind: "missing" },
): boolean {
  if (expected.kind === "missing") return actual.kind === "missing";
  return actual.kind === "oid" && actual.oid === expected.oid;
}

export function tryAtomicUpdateLooseRef(
  dirs: GitDirs,
  ref: string,
  expected: { kind: "oid"; oid: string } | { kind: "missing" } | undefined,
  nextOid: string,
): boolean {
  if (!FULL_OID.test(nextOid)) return false;
  const lowerNext = nextOid.toLowerCase();
  let targetPath: string;
  if (ref === "HEAD") {
    targetPath = join(dirs.gitdir, "HEAD");
  } else if (ref.startsWith("refs/") && isSafeSimpleRefName(ref)) {
    if (ref.startsWith("refs/worktree/") || ref.startsWith("refs/bisect/")) return false;
    if (existsSync(join(dirs.commonDir, "packed-refs.lock")) || hasRefDirectoryConflict(dirs.commonDir, ref)) return false;
    targetPath = join(dirs.commonDir, ...ref.split("/"));
  } else {
    return false;
  }
  const lockPath = `${targetPath}.lock`;
  let fd: number | undefined;
  let createdLock = false;
  let renamed = false;
  try {
    mkdirSync(dirname(targetPath), { recursive: true });
    fd = openSync(lockPath, "wx");
    createdLock = true;
    if (expected !== undefined) {
      if (ref === "HEAD") {
        const rawHead = readFileSync(targetPath, "utf8").trim();
        if (rawHead.startsWith("ref:")) return false;
      }
      if (!directRefMatches(resolveDirectRef(dirs, ref), expected)) return false;
    }
    writeFileSync(fd, `${lowerNext}\n`, "utf8");
    closeSync(fd);
    fd = undefined;
    renameSync(lockPath, targetPath);
    renamed = true;
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* Best effort. */ }
    }
    if (createdLock && !renamed) {
      try { rmSync(lockPath, { force: true }); } catch { /* Best effort. */ }
    }
  }
}

export function isPlainSha1CommonDir(commonDir: string): boolean {
  if (
    existsSync(join(commonDir, "shallow")) ||
    existsSync(join(commonDir, "info", "grafts")) ||
    existsSync(join(commonDir, "objects", "info", "alternates")) ||
    hasReplaceRefs(commonDir)
  ) {
    return false;
  }
  try {
    return !/objectformat/i.test(readFileSync(join(commonDir, "config"), "utf8"));
  } catch {
    return false;
  }
}

/**
 * Parents as the commits themselves record them, for reads a decision about history rests on. Git's commit index
 * (commit-graph) is an optional cache of each commit's parents, and an edited one can report others.
 */
export const FROM_COMMITS = ["-c", "core.commitGraph=false"] as const;

export function resolveLooseMergeBaseOid(dirs: GitDirs, a: string, b: string, ignoreCommitGraph: boolean): { found: true; oid?: string } | undefined {
  if (!a || !b || a.startsWith("-") || b.startsWith("-")) return undefined;
  if (!canWalkRawLooseHistory(dirs.commonDir, ignoreCommitGraph) || hasReplaceRefs(dirs.commonDir)) return undefined;
  if (isDefinitelyAbsentLooseOid(dirs.commonDir, a) || isDefinitelyAbsentLooseOid(dirs.commonDir, b)) {
    return { found: true, oid: undefined };
  }
  const commitA = resolveLooseRefCommit(dirs, a);
  const commitB = resolveLooseRefCommit(dirs, b);
  if (!commitA || !commitB) return undefined;
  if (commitA.oid === commitB.oid) return { found: true, oid: commitA.oid };
  const ancA = looseAncestorSet(dirs.commonDir, commitA.oid);
  const ancB = looseAncestorSet(dirs.commonDir, commitB.oid);
  if (!ancA || !ancB) return undefined;
  if (ancA.has(commitB.oid)) return { found: true, oid: commitB.oid };
  if (ancB.has(commitA.oid)) return { found: true, oid: commitA.oid };
  const common: string[] = [];
  for (const oid of ancA) {
    if (ancB.has(oid)) common.push(oid);
  }
  if (common.length === 0) return { found: true, oid: undefined };
  const parentOfCommon = new Set<string>();
  for (const oid of common) {
    const commit = readLooseCommitObject(dirs.commonDir, oid);
    if (!commit) return undefined;
    for (const parent of commit.parents) parentOfCommon.add(parent);
  }
  const lcas = common.filter((oid) => !parentOfCommon.has(oid));
  return lcas.length === 1 ? { found: true, oid: lcas[0]! } : undefined;
}

export function readFastLooseMergeBase(path: string, a: string, b: string): { found: true; oid?: string } | undefined {
  if (isSpawnIntercepted() || "mock" in run) return undefined;
  const dirs = resolveGitDirs(path);
  return dirs ? resolveLooseMergeBaseOid(dirs, a, b, false) : undefined;
}

export function readLoosePlainRootFile(path: string, ref: string, name: string): { hit: true; value?: { mode: string; text: string } } | undefined {
  if (isSpawnIntercepted() || !name || name.includes("\0")) return undefined;
  const dirs = resolveGitDirs(path);
  if (!dirs || hasReplaceRefs(dirs.commonDir)) return undefined;
  const treeOid = resolveLooseTreeOid(dirs, ref);
  if (!treeOid) return undefined;
  const treeObj = readLooseRawObject(dirs.commonDir, treeOid);
  if (!treeObj || treeObj.type !== "tree") return undefined;
  const entry = findLooseTreeEntry(treeOid, treeObj.body, name);
  if (!entry) return undefined;
  if (!entry.found || (entry.mode !== "100644" && entry.mode !== "100755")) return { hit: true, value: undefined };
  const blobObj = readLooseRawObject(dirs.commonDir, entry.oid);
  if (!blobObj) return undefined;
  if (blobObj.type !== "blob") return { hit: true, value: undefined };
  return { hit: true, value: { mode: entry.mode, text: RAW_UTF8_DECODER.decode(blobObj.body) } };
}

export function readLooseVersionsBetween(path: string, from: string, to: string, name: string): string[] | "shallow" | undefined {
  if (isSpawnIntercepted() || !FULL_OID.test(from) || !FULL_OID.test(to) || !name || name.includes("\0")) return undefined;
  const dirs = resolveGitDirs(path);
  if (!dirs || hasReplaceRefs(dirs.commonDir) || existsSync(join(dirs.commonDir, "info", "grafts"))) return undefined;
  if (existsSync(join(dirs.commonDir, "shallow"))) return "shallow";
  const fromOid = from.toLowerCase();
  const toOid = to.toLowerCase();
  const fromSet = looseAncestorSet(dirs.commonDir, fromOid);
  const toSet = looseAncestorSet(dirs.commonDir, toOid);
  if (!fromSet || !toSet) return undefined;
  const diff: string[] = [];
  for (const oid of toSet) {
    if (!fromSet.has(oid)) diff.push(oid);
  }
  if (diff.length === 0) return [];
  if (diff.length > 64) return undefined;
  const seenBlobs = new Set<string>();
  const blobs: string[] = [];
  const rememberBlob = (oid: string | undefined) => {
    if (oid && !seenBlobs.has(oid)) {
      seenBlobs.add(oid);
      blobs.push(oid);
    }
  };
  for (const commitOid of diff) {
    const commit = readLooseCommitObject(dirs.commonDir, commitOid);
    if (!commit) return undefined;
    const commitTree = readLooseRawObject(dirs.commonDir, commit.tree);
    if (!commitTree || commitTree.type !== "tree") return undefined;
    const afterEntry = findLooseTreeEntry(commit.tree, commitTree.body, name);
    if (!afterEntry) return undefined;
    if (afterEntry.found && afterEntry.mode === "160000") return undefined;
    if (commit.parents.length === 0) {
      if (afterEntry.found) rememberBlob(afterEntry.oid);
      continue;
    }
    for (const parentOid of commit.parents) {
      const parent = readLooseCommitObject(dirs.commonDir, parentOid);
      if (!parent) return undefined;
      const parentTree = readLooseRawObject(dirs.commonDir, parent.tree);
      if (!parentTree || parentTree.type !== "tree") return undefined;
      const beforeEntry = findLooseTreeEntry(parent.tree, parentTree.body, name);
      if (!beforeEntry) return undefined;
      if (beforeEntry.found && beforeEntry.mode === "160000") return undefined;
      const beforeMode = beforeEntry.found ? beforeEntry.mode : "";
      const afterMode = afterEntry.found ? afterEntry.mode : "";
      const beforeOid = beforeEntry.found ? beforeEntry.oid : undefined;
      const afterOid = afterEntry.found ? afterEntry.oid : undefined;
      if (beforeOid !== afterOid || beforeMode !== afterMode) {
        rememberBlob(beforeOid);
        rememberBlob(afterOid);
      }
    }
  }
  if (blobs.length === 0) return [];
  const texts: string[] = [];
  for (const blobOid of blobs) {
    const blob = readLooseRawObject(dirs.commonDir, blobOid);
    if (!blob || blob.type !== "blob") return undefined;
    texts.push(blob.body.toString("utf8"));
  }
  return texts;
}

function collectLooseComparableFiles(
  commonDir: string,
  treeOid: string,
  out: Map<string, { mode: string; oidHex: string }>,
  prefix = "",
): boolean {
  const raw = readLooseRawObject(commonDir, treeOid);
  if (!raw || raw.type !== "tree") return false;
  let entries;
  try {
    entries = treeEntries({ id: treeOid.toLowerCase(), type: "tree", body: raw.body });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const name = entry.name.toString("utf8");
    if (!name || name === ".gitmodules" || name.includes("\n") || name.includes("\r")) return false;
    const relPath = prefix ? `${prefix}/${name}` : name;
    const typeBits = entry.mode & 0o170000;
    if (typeBits === 0o040000) {
      if (!collectLooseComparableFiles(commonDir, entry.id, out, relPath)) return false;
    } else if (typeBits === 0o100000) {
      if (out.size >= 512) return false;
      out.set(relPath, { mode: entry.mode & 0o100 ? "100755" : "100644", oidHex: entry.id });
    } else if (typeBits === 0o120000) {
      if (out.size >= 512) return false;
      out.set(relPath, { mode: "120000", oidHex: entry.id });
    } else {
      return false;
    }
  }
  return true;
}

export function diffLooseTreeChanges(path: string, fromRef: string, toRef: string): FileChange[] | undefined {
  if (isSpawnIntercepted() || !fromRef || !toRef || fromRef.startsWith("-") || toRef.startsWith("-")) return undefined;
  const dirs = resolveGitDirs(path);
  if (!dirs || hasReplaceRefs(dirs.commonDir)) return undefined;
  const fromTree = resolveLooseTreeOid(dirs, fromRef);
  const toTree = resolveLooseTreeOid(dirs, toRef);
  if (!fromTree || !toTree) return undefined;
  if (fromTree === toTree) {
    return readLooseRawObject(dirs.commonDir, fromTree)?.type === "tree" ? [] : undefined;
  }
  const fromFiles = new Map<string, { mode: string; oidHex: string }>();
  const toFiles = new Map<string, { mode: string; oidHex: string }>();
  if (!collectLooseComparableFiles(dirs.commonDir, fromTree, fromFiles)) return undefined;
  if (!collectLooseComparableFiles(dirs.commonDir, toTree, toFiles)) return undefined;
  const allPaths = [...new Set([...fromFiles.keys(), ...toFiles.keys()])].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const changes: FileChange[] = [];
  for (const file of allPaths) {
    const before = fromFiles.get(file);
    const after = toFiles.get(file);
    if (!before) changes.push({ change: "added", file });
    else if (!after) changes.push({ change: "removed", file });
    else if (before.oidHex !== after.oidHex || before.mode !== after.mode) changes.push({ change: "changed", file });
  }
  return changes;
}

export function hasNoLooseLockfileChangesInRange(
  path: string,
  from: string,
  to: string,
  lockfiles: readonly string[],
): boolean {
  if (isSpawnIntercepted() || "mock" in run || !FULL_OID.test(from) || !FULL_OID.test(to)) return false;
  const dirs = resolveGitDirs(path);
  if (!dirs || !canWalkRawLooseHistory(dirs.commonDir, false) || hasReplaceRefs(dirs.commonDir)) return false;
  const fromOid = from.toLowerCase();
  const toOid = to.toLowerCase();
  if (fromOid === toOid) return Boolean(readLooseCommitObject(dirs.commonDir, fromOid));
  const fromSet = looseAncestorSet(dirs.commonDir, fromOid);
  const toSet = looseAncestorSet(dirs.commonDir, toOid);
  if (!fromSet || !toSet) return false;
  const diff: string[] = [];
  for (const oid of toSet) {
    if (!fromSet.has(oid)) diff.push(oid);
  }
  if (diff.length === 0) return true;
  if (diff.length > 64) return false;
  const isLockfile = (filePath: string) => lockfiles.includes(basename(filePath));
  const treeCache = new Map<string, Map<string, { mode: string; oidHex: string }>>();
  const getTreeFiles = (treeOid: string): Map<string, { mode: string; oidHex: string }> | undefined => {
    let cached = treeCache.get(treeOid);
    if (!cached) {
      const files = new Map<string, { mode: string; oidHex: string }>();
      if (!collectLooseComparableFiles(dirs.commonDir, treeOid, files)) return undefined;
      cached = files;
      treeCache.set(treeOid, cached);
    }
    return cached;
  };
  for (const oid of diff) {
    const commit = readLooseCommitObject(dirs.commonDir, oid);
    if (!commit) return false;
    const commitFiles = getTreeFiles(commit.tree);
    if (!commitFiles) return false;
    if (commit.parents.length === 0) {
      for (const file of commitFiles.keys()) {
        if (isLockfile(file)) return false;
      }
      continue;
    }
    for (const parentOid of commit.parents) {
      const parent = readLooseCommitObject(dirs.commonDir, parentOid);
      if (!parent) return false;
      if (parent.tree === commit.tree) continue;
      const parentFiles = getTreeFiles(parent.tree);
      if (!parentFiles) return false;
      for (const [file, after] of commitFiles) {
        const before = parentFiles.get(file);
        if ((!before || before.oidHex !== after.oidHex || before.mode !== after.mode) && isLockfile(file)) {
          return false;
        }
      }
      for (const file of parentFiles.keys()) {
        if (!commitFiles.has(file) && isLockfile(file)) return false;
      }
    }
  }
  return true;
}

export function haveIdenticalLooseRange(path: string, range: string, files?: readonly string[]): boolean {
  if (isSpawnIntercepted()) return false;
  const dirs = resolveGitDirs(path);
  if (!dirs || hasReplaceRefs(dirs.commonDir)) return false;
  let fromRef: string;
  let toRef: string;
  const threeDot = range.indexOf("...");
  if (threeDot > 0) {
    const left = range.slice(0, threeDot);
    const right = range.slice(threeDot + 3);
    if (!right || right.includes(".")) return false;
    const mb = resolveLooseMergeBaseOid(dirs, left, right, false);
    if (!mb?.oid) return false;
    fromRef = mb.oid;
    toRef = right;
  } else {
    const twoDot = range.indexOf("..");
    if (twoDot <= 0) return false;
    const left = range.slice(0, twoDot);
    const right = range.slice(twoDot + 2);
    if (!right || right.includes(".")) return false;
    fromRef = left;
    toRef = right;
  }
  const changes = diffLooseTreeChanges(path, fromRef, toRef);
  if (!changes) return false;
  if (changes.length === 0) return true;
  if (!files) return false;
  return !changes.some((entry) => files.some((wanted) => entry.file === wanted || entry.file.startsWith(`${wanted}/`)));
}

export function readLooseCommitMessages(path: string, from: string | undefined, to: string, max: number): { sha: string; message: string }[] | undefined {
  if (isSpawnIntercepted() || max <= 0 || !FULL_OID.test(to) || (from !== undefined && !FULL_OID.test(from))) return undefined;
  const dirs = resolveGitDirs(path);
  if (!dirs || !canWalkRawLooseHistory(dirs.commonDir, false) || hasReplaceRefs(dirs.commonDir)) return undefined;
  const toCommit = readLooseCommitObject(dirs.commonDir, to);
  if (!toCommit) return undefined;
  const stopOid = from?.toLowerCase();
  if (stopOid !== undefined && !readLooseCommitObject(dirs.commonDir, stopOid)) return undefined;
  const chain: { sha: string; message: string }[] = [];
  let current: LooseCommit | undefined = toCommit;
  for (let steps = 0; steps < 256 && current; steps += 1) {
    if (stopOid !== undefined && current.oid === stopOid) {
      return chain.slice(0, max).reverse();
    }
    if (current.parents.length > 1) return undefined;
    chain.push({ sha: current.oid, message: current.body.trim() });
    if (current.parents.length === 0) {
      if (stopOid === undefined) return chain.slice(0, max).reverse();
      break;
    }
    current = readLooseCommitObject(dirs.commonDir, current.parents[0]!);
    if (!current) return undefined;
  }
  if (stopOid !== undefined && looseAncestorSet(dirs.commonDir, stopOid)?.has(toCommit.oid)) {
    return [];
  }
  return undefined;
}

export interface FileChange {
  change: "added" | "changed" | "removed";
  file: string;
}
