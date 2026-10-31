// Direct read-only inspection of plain loose SHA-1 Git objects, refs and trees.
// Falls back cleanly whenever packs, alternates, grafts, submodules or non-plain configs exist.

import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { type GitObject, treeEntries } from "../object-format.js";
import { isSpawnIntercepted, run } from "./exec.js";
import {
  canWalkRawLooseHistory,
  findLooseTreeEntry,
  FULL_OID,
  type GitDirs,
  hasNoPacksOrAlternates,
  hasReplaceRefs,
  isDefinitelyAbsentLooseOid,
  isDefinitelyAbsentSimpleRef,
  looseAncestorSet,
  type LooseCommit,
  RAW_UTF8_DECODER,
  readLooseCommitObject,
  readLooseRawObject,
  resolveGitDirs,
  resolveLooseRefCommit,
  resolveLooseTreeOid,
} from "./loose-object-core.js";

export {
  directRefMatches,
  hasRefDirectoryConflict,
  isPlainSha1CommonDir,
  parsePlainGitConfigEntries,
  readLooseFileAt,
  readLooseObjectTypes,
  readSimpleRemoteOriginUrl,
  resolveBareGitDirs,
  resolveOriginDefaultBranchSync,
  tryAtomicUpdateLooseRef,
} from "./loose-config-refs.js";
export {
  canWalkRawLooseHistory,
  collectLooseTreeFiles,
  FULL_OID,
  type GitDirs,
  hasNestedRefsPrefix,
  hasReplaceRefs,
  haveIdenticalLooseTree,
  isDefinitelyAbsentLooseOid,
  isSafeSimpleRefName,
  isSimpleValidBranchName,
  looseAncestorSet,
  type LooseCommit,
  RAW_UTF8_DECODER,
  readLooseCommitObject,
  readLooseRawObject,
  resolveDirectRef,
  resolveGitDirs,
  resolveLooseRefCommit,
  resolveLooseTreeOid,
  SHA,
} from "./loose-object-core.js";

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
