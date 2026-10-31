// Merge-base, in-memory merge-tree, patch-id, diff-stat and tamper checks.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseTamperPacket, tamperProblems } from "../tamper-format.js";
import { isSpawnIntercepted, must, run } from "./exec.js";
import { inspectPlainWorktree, type PlainWorktreeInspection, writeLooseTreeFromMap } from "./loose-index.js";
import {
  canWalkRawLooseHistory,
  collectLooseTreeFiles,
  diffLooseTreeChanges,
  type FileChange,
  FROM_COMMITS,
  FULL_OID,
  type GitDirs,
  hasReplaceRefs,
  haveIdenticalLooseTree,
  isPlainSha1CommonDir,
  looseAncestorSet,
  type LooseCommit,
  RAW_UTF8_DECODER,
  readLooseCommitMessages,
  readLooseCommitObject,
  readLooseRawObject,
  resolveDirectRef,
  resolveGitDirs,
  resolveLooseMergeBaseOid,
  resolveLooseRefCommit,
  SHA,
} from "./loose-objects.js";

export { patchId, tryFastPlainReviewComparison } from "./plain-patch.js";

/** Where two commits' histories meet. */
export async function mergeBase(path: string, a: string, b: string, fromCommits = false): Promise<string | undefined> {
  if (!isSpawnIntercepted()) {
    const dirs = resolveGitDirs(path);
    if (dirs) {
      const fast = resolveLooseMergeBaseOid(dirs, a, b, fromCommits);
      if (fast) return fast.oid;
    }
  }
  const result = await run(["git", ...(fromCommits ? FROM_COMMITS : []), "merge-base", a, b], path);
  return result.code === 0 && SHA.test(result.stdout) ? result.stdout : undefined;
}

function tryFastDisjointMergeTree(
  dirs: GitDirs,
  baseTree: string,
  ontoTree: string,
  refTree: string,
): string | undefined {
  if (!isPlainSha1CommonDir(dirs.commonDir) || baseTree.length !== 40) return undefined;
  const baseFiles = new Map<string, { mode: "100644" | "100755"; oidHex: string }>();
  const ontoFiles = new Map<string, { mode: "100644" | "100755"; oidHex: string }>();
  const refFiles = new Map<string, { mode: "100644" | "100755"; oidHex: string }>();
  if (!collectLooseTreeFiles(dirs.commonDir, baseTree, "sha1", baseFiles)) return undefined;
  if (!collectLooseTreeFiles(dirs.commonDir, ontoTree, "sha1", ontoFiles)) return undefined;
  if (!collectLooseTreeFiles(dirs.commonDir, refTree, "sha1", refFiles)) return undefined;
  for (const relPath of baseFiles.keys()) {
    if (!ontoFiles.has(relPath) || !refFiles.has(relPath)) return undefined;
  }
  const merged = new Map<string, { mode: "100644" | "100755"; oidHex: string }>();
  const allPaths = new Set([...baseFiles.keys(), ...ontoFiles.keys(), ...refFiles.keys()]);
  if (allPaths.size > 256) return undefined;
  for (const relPath of allPaths) {
    const b = baseFiles.get(relPath);
    const o = ontoFiles.get(relPath);
    const r = refFiles.get(relPath);
    const oSame = b?.oidHex === o?.oidHex && b?.mode === o?.mode;
    const rSame = b?.oidHex === r?.oidHex && b?.mode === r?.mode;
    const orSame = o?.oidHex === r?.oidHex && o?.mode === r?.mode;
    if (oSame) {
      if (r) merged.set(relPath, r);
    } else if (rSame || orSame) {
      if (o) merged.set(relPath, o);
    } else {
      return undefined;
    }
  }
  return writeLooseTreeFromMap(dirs.commonDir, merged);
}

const mergeTreeCache = new Map<string, { tree: string; conflicts: readonly string[]; notes: readonly string[] }>();

function canMemoizePlainMergeTree(path: string, dirs: GitDirs, ontoCommit: LooseCommit, refCommit: LooseCommit): boolean {
  if (!isPlainSha1CommonDir(dirs.commonDir) || ontoCommit.oid.length !== 40 || refCommit.oid.length !== 40) return false;
  if (existsSync(join(path, ".gitattributes")) || existsSync(join(dirs.commonDir, "info", "attributes"))) return false;
  try {
    if (/merge\.|conflictstyle|autocrlf/i.test(readFileSync(join(dirs.commonDir, "config"), "utf8"))) return false;
  } catch {
    return false;
  }
  const ontoFiles = new Map<string, { mode: "100644" | "100755"; oidHex: string }>();
  const refFiles = new Map<string, { mode: "100644" | "100755"; oidHex: string }>();
  return (
    collectLooseTreeFiles(dirs.commonDir, ontoCommit.tree, "sha1", ontoFiles) &&
    collectLooseTreeFiles(dirs.commonDir, refCommit.tree, "sha1", refFiles)
  );
}

/**
 * This branch's change applied on top of `onto`, as a tree, without touching the working copy: a three-way
 * merge from where the two met. Conflicting files keep git's conflict markers in the tree.
 */
export async function mergeTree(path: string, onto: string, ref = "HEAD"): Promise<{ tree: string; conflicts: string[]; notes: string[] } | undefined> {
  let cacheKey: string | undefined;
  let cacheCommonDir: string | undefined;
  if (!isSpawnIntercepted() && !("mock" in run) && !onto.startsWith("-") && !ref.startsWith("-")) {
    const dirs = resolveGitDirs(path);
    if (dirs && canWalkRawLooseHistory(dirs.commonDir, false) && !hasReplaceRefs(dirs.commonDir)) {
      const ontoCommit = resolveLooseRefCommit(dirs, onto);
      const refCommit = resolveLooseRefCommit(dirs, ref);
      if (ontoCommit && refCommit) {
        const mb = resolveLooseMergeBaseOid(dirs, ontoCommit.oid, refCommit.oid, false);
        if (mb?.oid) {
          const mbCommit = readLooseCommitObject(dirs.commonDir, mb.oid);
          if (
            (mb.oid === ontoCommit.oid || (mbCommit && ontoCommit.tree === mbCommit.tree)) &&
            readLooseRawObject(dirs.commonDir, refCommit.tree)?.type === "tree"
          ) {
            return { tree: refCommit.tree, conflicts: [], notes: [] };
          }
          if (
            (mb.oid === refCommit.oid || ontoCommit.tree === refCommit.tree || (mbCommit && refCommit.tree === mbCommit.tree)) &&
            readLooseRawObject(dirs.commonDir, ontoCommit.tree)?.type === "tree"
          ) {
            return { tree: ontoCommit.tree, conflicts: [], notes: [] };
          }
          if (mbCommit) {
            const disjointTree = tryFastDisjointMergeTree(dirs, mbCommit.tree, ontoCommit.tree, refCommit.tree);
            if (disjointTree) return { tree: disjointTree, conflicts: [], notes: [] };
          }
        }
        if (canMemoizePlainMergeTree(path, dirs, ontoCommit, refCommit)) {
          cacheCommonDir = dirs.commonDir;
          cacheKey = `${dirs.commonDir}\0${ontoCommit.oid}\0${refCommit.oid}`;
          const cached = mergeTreeCache.get(cacheKey);
          if (cached && readLooseRawObject(dirs.commonDir, cached.tree)?.type === "tree") {
            return { tree: cached.tree, conflicts: [...cached.conflicts], notes: [...cached.notes] };
          }
        }
      }
    }
  }
  const result = await run(["git", "merge-tree", "--write-tree", "--name-only", "-z", onto, ref], path);
  if (result.code !== 0 && result.code !== 1) return undefined;
  // -z: the tree, the conflicting files, an empty field, then each note as its path count, paths, kind and message.
  const fields = result.stdout.split("\0");
  const tree = fields[0] ?? "";
  if (!SHA.test(tree)) return undefined;
  const conflicts: string[] = [];
  let index = 1;
  for (; index < fields.length && fields[index] !== ""; index += 1) conflicts.push(fields[index]!);
  const notes: string[] = [];
  for (index += 1; index < fields.length; ) {
    const count = Number(fields[index]);
    if (!Number.isInteger(count) || count < 0) break;
    const message = fields[index + count + 2];
    if (message) notes.push(message.trim());
    index += count + 3;
  }
  const parsed = { tree, conflicts: [...new Set(conflicts)], notes: notes.filter((note) => note.startsWith("CONFLICT")) };
  if (cacheKey && cacheCommonDir && readLooseRawObject(cacheCommonDir, parsed.tree)?.type === "tree") {
    if (mergeTreeCache.size >= 64) mergeTreeCache.delete(mergeTreeCache.keys().next().value!);
    mergeTreeCache.set(cacheKey, { tree: parsed.tree, conflicts: [...parsed.conflicts], notes: [...parsed.notes] });
  }
  return parsed;
}

/** Files that differ between two commits or trees. A failed read cannot establish that nothing changed. */
export async function changedFiles(path: string, from: string, to: string): Promise<string[]> {
  if (!SHA.test(from) || (to !== "HEAD" && !SHA.test(to))) throw new Error("Could not compare product changes: the saved version is invalid.");
  if (haveIdenticalLooseTree(path, from, to)) return [];
  const fast = diffLooseTreeChanges(path, from, to);
  if (fast) return fast.map((entry) => entry.file);
  return (await must(["git", "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", from, to], path)).split("\0").filter(Boolean);
}

/**
 * The commits in `range` (`from..to`, or everything up to `to`), oldest first, with their messages: the `max` most
 * recent at most. Merge commits are left out: the commits they bring in are listed themselves.
 */
export async function commitMessages(path: string, range: string, max: number): Promise<{ sha: string; message: string }[]> {
  const [from, to] = range.includes("..") ? range.split("..") : [undefined, range];
  if (!SHA.test(to ?? "") || (from !== undefined && !SHA.test(from))) return [];
  const fast = readLooseCommitMessages(path, from, to!, max);
  if (fast) return fast;
  const listed = await run(["git", "log", "--no-merges", "--reverse", `--max-count=${max}`, "--format=%H%x1f%B%x1e", range], path);
  if (listed.code !== 0) return [];
  return listed.stdout
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sha, message] = entry.split("\x1f");
      return { sha: sha!.trim(), message: (message ?? "").trim() };
    });
}

function computePlainTrackedDiffAgainst(
  inspected: PlainWorktreeInspection,
  targetRef: string,
): FileChange[] | undefined {
  const targetCommit = targetRef === "HEAD" ? inspected.headCommit : resolveLooseRefCommit(inspected.dirs, targetRef);
  if (!targetCommit) return undefined;
  const baseFiles = new Map<string, { mode: "100644" | "100755"; oidHex: string }>();
  if (!collectLooseTreeFiles(inspected.dirs.commonDir, targetCommit.tree, inspected.format, baseFiles)) return undefined;
  const allPaths = [...new Set([...baseFiles.keys(), ...inspected.indexFiles.keys()])].sort((a, b) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b)),
  );
  const changes: FileChange[] = [];
  for (const relPath of allPaths) {
    const baseEntry = baseFiles.get(relPath);
    const idxEntry = inspected.indexFiles.get(relPath);
    const diskEntry = inspected.diskTracked.get(relPath);
    if (!idxEntry) {
      changes.push({ change: "removed", file: relPath });
    } else if (!diskEntry) {
      if (!baseEntry) return undefined;
      changes.push({ change: "removed", file: relPath });
    } else if (!baseEntry) {
      changes.push({ change: "added", file: relPath });
    } else if (baseEntry.oidHex !== diskEntry.oidHex || baseEntry.mode !== diskEntry.mode) {
      changes.push({ change: "changed", file: relPath });
    }
  }
  return changes;
}

/** Files added, changed or removed in the working copy since a commit, committed or not. */
export async function changedSince(path: string, sha: string): Promise<FileChange[]> {
  if (!SHA.test(sha)) return [];
  const inspected = inspectPlainWorktree(path, true);
  if (inspected) {
    const trackedDiff = computePlainTrackedDiffAgainst(inspected, sha);
    if (trackedDiff) {
      const sortedUntracked = [...inspected.untrackedFiles].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      for (const file of sortedUntracked) {
        if (!trackedDiff.some((entry) => entry.file === file)) trackedDiff.push({ change: "added", file });
      }
      return trackedDiff;
    }
  }
  const [tracked, untracked] = await Promise.all([
    run(["git", "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-status", "-z", sha], path),
    run(["git", "ls-files", "--others", "--exclude-standard", "-z"], path),
  ]);
  const changes: FileChange[] = [];
  const fields = tracked.code === 0 ? tracked.stdout.split("\0") : [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index]!;
    const file = fields[index + 1]!;
    if (file) changes.push({ change: status.startsWith("A") ? "added" : status.startsWith("D") ? "removed" : "changed", file });
  }
  for (const file of untracked.code === 0 ? untracked.stdout.split("\0") : []) {
    if (file && !changes.some((entry) => entry.file === file)) changes.push({ change: "added", file });
  }
  return changes;
}

/** Tracked files the working copy changed since `sha` (its checked-out commit when omitted), committed or not; untracked files are left out. */
export async function trackedChangesSince(path: string, sha?: string): Promise<string[]> {
  if (sha !== undefined && !SHA.test(sha)) return [];
  const inspected = inspectPlainWorktree(path, false);
  if (inspected) {
    const trackedDiff = computePlainTrackedDiffAgainst(inspected, sha ?? "HEAD");
    if (trackedDiff) return trackedDiff.map((entry) => entry.file);
  }
  const result = await run(["git", "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", sha ?? "HEAD"], path);
  return result.code === 0 ? result.stdout.split("\0").filter(Boolean) : [];
}

/** How many commits `to` (the working copy's branch, unless given) has on top of `sha`. */
export async function commitsSince(path: string, sha: string, to = "HEAD"): Promise<number> {
  if (!SHA.test(sha)) return 0;
  const dirs = !isSpawnIntercepted() ? resolveGitDirs(path) : undefined;
  if (dirs && FULL_OID.test(sha) && canWalkRawLooseHistory(dirs.commonDir, false)) {
    const toResolved =
      to === "HEAD"
        ? resolveDirectRef(dirs, "HEAD")
        : FULL_OID.test(to)
          ? { kind: "oid" as const, oid: to.toLowerCase() }
          : undefined;
    if (toResolved?.kind === "oid") {
      const fromOid = sha.toLowerCase();
      if (toResolved.oid === fromOid && readLooseCommitObject(dirs.commonDir, fromOid)) return 0;
      const toSet = looseAncestorSet(dirs.commonDir, toResolved.oid);
      const fromSet = looseAncestorSet(dirs.commonDir, fromOid);
      if (toSet && fromSet) {
        let count = 0;
        for (const oid of toSet) {
          if (!fromSet.has(oid)) count += 1;
        }
        return count;
      }
    }
  }
  return Number((await run(["git", "rev-list", "--count", `${sha}..${to}`], path)).stdout) || 0;
}

const HALF_DONE: readonly (readonly [string, string])[] = [
  ["MERGE_HEAD", "a merge"],
  ["rebase-merge", "a rebase"],
  ["rebase-apply", "a rebase"],
  ["CHERRY_PICK_HEAD", "a cherry-pick"],
  ["REVERT_HEAD", "a revert"],
];

/** The branch a working copy is on (undefined when it is on none), and a merge, rebase, cherry-pick or revert left half done. */
export async function workingState(path: string): Promise<{ branch?: string; busy?: string }> {
  if (!isSpawnIntercepted()) {
    try {
      const dotGit = join(path, ".git");
      const entry = statSync(dotGit);
      const gitDir = entry.isDirectory()
        ? dotGit
        : entry.isFile()
          ? (() => {
              const text = readFileSync(dotGit, "utf8").trim();
              return text.startsWith("gitdir:") ? resolve(path, text.slice(7).trim()) : undefined;
            })()
          : undefined;
      if (gitDir) {
        const headText = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
        const branch = headText.startsWith("ref: refs/heads/") ? headText.slice("ref: refs/heads/".length) : undefined;
        for (const [marker, what] of HALF_DONE) {
          if (existsSync(join(gitDir, marker))) return { ...(branch ? { branch } : {}), busy: what };
        }
        return branch ? { branch } : {};
      }
    } catch {
      /* Fall back to Git CLI when the worktree root metadata is non-standard. */
    }
  }
  const [branch, where] = await Promise.all([
    run(["git", "symbolic-ref", "--quiet", "--short", "HEAD"], path),
    run(["git", "rev-parse", ...HALF_DONE.flatMap(([marker]) => ["--git-path", marker])], path),
  ]);
  const paths = where.stdout.split("\n");
  for (const [index, [, what]] of HALF_DONE.entries()) {
    if (where.code === 0 && paths[index] && existsSync(resolve(path, paths[index]!))) {
      return { ...(branch.code === 0 ? { branch: branch.stdout } : {}), busy: what };
    }
  }
  return branch.code === 0 && branch.stdout ? { branch: branch.stdout } : {};
}

const TAMPER_TEST_FILE = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py|rs)$/i;

const TAMPER_SKIP_PATTERN = /(\b(it|test|describe)\.(skip|only)\(|\bxit\(|\bxdescribe\(|@(Disabled|Ignore)\b|pytest\.mark\.skip|#\[ignore\]|\.todo\()/;

function countTextLines(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let lines = 0;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0x0a) lines += 1;
  }
  return buf[buf.length - 1] === 0x0a ? lines : lines + 1;
}

function splitLatin1Lines(buf: Buffer): string[] {
  if (buf.length === 0) return [];
  const text = buf.toString("latin1");
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) {
      lines.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

function exactSimpleLineDiff(oldBuf: Buffer, newBuf: Buffer): { additions: number; deletions: number } | undefined {
  if (oldBuf.length > 32_768 || newBuf.length > 32_768) return undefined;
  if (oldBuf.subarray(0, 8000).includes(0) || newBuf.subarray(0, 8000).includes(0)) return undefined;
  const oldLines = splitLatin1Lines(oldBuf);
  const newLines = splitLatin1Lines(newBuf);
  if (oldLines.length > 256 || newLines.length > 256) return undefined;
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    prefix + suffix < oldLines.length &&
    prefix + suffix < newLines.length &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const remOldLen = oldLines.length - prefix - suffix;
  const remNewLen = newLines.length - prefix - suffix;
  if (remOldLen === 0 || remNewLen === 0) return { additions: remNewLen, deletions: remOldLen };
  if (remOldLen > 128 || remNewLen > 128) return undefined;
  let prev = new Uint16Array(remNewLen + 1);
  let curr = new Uint16Array(remNewLen + 1);
  for (let i = 0; i < remOldLen; i += 1) {
    const oldLine = oldLines[prefix + i]!;
    for (let j = 0; j < remNewLen; j += 1) {
      if (oldLine === newLines[prefix + j]!) {
        curr[j + 1] = prev[j]! + 1;
      } else {
        const up = prev[j + 1]!;
        const left = curr[j]!;
        curr[j + 1] = up >= left ? up : left;
      }
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  const lcs = prev[remNewLen]!;
  return { additions: remNewLen - lcs, deletions: remOldLen - lcs };
}

function readFastDiffStat(path: string, base: string): { files: number; additions: number; deletions: number } | undefined {
  if (isSpawnIntercepted() || !base || base.startsWith("-")) return undefined;
  const dirs = resolveGitDirs(path);
  if (!dirs || !canWalkRawLooseHistory(dirs.commonDir, false) || hasReplaceRefs(dirs.commonDir)) return undefined;
  try {
    const cfg = readFileSync(join(dirs.commonDir, "config"), "utf8");
    if (/renames\s*=\s*copies|algorithm\s*=/i.test(cfg)) return undefined;
  } catch {
    return undefined;
  }
  const mb = resolveLooseMergeBaseOid(dirs, base, "HEAD", false);
  const headCommit = resolveLooseRefCommit(dirs, "HEAD");
  if (!mb?.oid || !headCommit) return undefined;
  const baseCommit = readLooseCommitObject(dirs.commonDir, mb.oid);
  if (!baseCommit) return undefined;
  if (baseCommit.tree === headCommit.tree) return { files: 0, additions: 0, deletions: 0 };
  const format = headCommit.oid.length === 64 ? "sha256" : "sha1";
  const baseFiles = new Map<string, { mode: "100644" | "100755"; oidHex: string }>();
  const headFiles = new Map<string, { mode: "100644" | "100755"; oidHex: string }>();
  if (!collectLooseTreeFiles(dirs.commonDir, baseCommit.tree, format, baseFiles)) return undefined;
  if (!collectLooseTreeFiles(dirs.commonDir, headCommit.tree, format, headFiles)) return undefined;
  let files = 0;
  let additions = 0;
  let deletions = 0;
  let addedCount = 0;
  let deletedCount = 0;
  for (const [relPath, baseEntry] of baseFiles) {
    const headEntry = headFiles.get(relPath);
    if (!headEntry) {
      deletedCount += 1;
      const blob = readLooseRawObject(dirs.commonDir, baseEntry.oidHex);
      if (!blob || blob.type !== "blob" || blob.body.subarray(0, 8000).includes(0)) return undefined;
      files += 1;
      deletions += countTextLines(blob.body);
      continue;
    }
    if (headEntry.oidHex === baseEntry.oidHex) {
      if (headEntry.mode !== baseEntry.mode) files += 1;
      continue;
    }
    const oldBlob = readLooseRawObject(dirs.commonDir, baseEntry.oidHex);
    const newBlob = readLooseRawObject(dirs.commonDir, headEntry.oidHex);
    if (!oldBlob || oldBlob.type !== "blob" || !newBlob || newBlob.type !== "blob") return undefined;
    const delta = exactSimpleLineDiff(oldBlob.body, newBlob.body);
    if (!delta) return undefined;
    files += 1;
    additions += delta.additions;
    deletions += delta.deletions;
  }
  for (const [relPath, headEntry] of headFiles) {
    if (baseFiles.has(relPath)) continue;
    addedCount += 1;
    if (deletedCount > 0) return undefined;
    const blob = readLooseRawObject(dirs.commonDir, headEntry.oidHex);
    if (!blob || blob.type !== "blob" || blob.body.subarray(0, 8000).includes(0)) return undefined;
    files += 1;
    additions += countTextLines(blob.body);
  }
  if (deletedCount > 0 && addedCount > 0) return undefined;
  return { files, additions, deletions };
}

function isFastTamperClean(path: string, base: string): boolean {
  if (isSpawnIntercepted() || !base || base.startsWith("-")) return false;
  const dirs = resolveGitDirs(path);
  if (!dirs || !canWalkRawLooseHistory(dirs.commonDir, false) || hasReplaceRefs(dirs.commonDir)) return false;
  const mb = resolveLooseMergeBaseOid(dirs, base, "HEAD", false);
  const headCommit = resolveLooseRefCommit(dirs, "HEAD");
  if (!mb?.oid || !headCommit) return false;
  const baseCommit = readLooseCommitObject(dirs.commonDir, mb.oid);
  if (!baseCommit) return false;
  if (baseCommit.tree === headCommit.tree) return true;
  const format = headCommit.oid.length === 64 ? "sha256" : "sha1";
  const baseFiles = new Map<string, { mode: "100644" | "100755"; oidHex: string }>();
  const headFiles = new Map<string, { mode: "100644" | "100755"; oidHex: string }>();
  if (!collectLooseTreeFiles(dirs.commonDir, baseCommit.tree, format, baseFiles)) return false;
  if (!collectLooseTreeFiles(dirs.commonDir, headCommit.tree, format, headFiles)) return false;
  for (const relPath of baseFiles.keys()) {
    if (!headFiles.has(relPath) && TAMPER_TEST_FILE.test(relPath)) return false;
  }
  for (const [relPath, headEntry] of headFiles) {
    if (baseFiles.get(relPath)?.oidHex === headEntry.oidHex) continue;
    const blob = readLooseRawObject(dirs.commonDir, headEntry.oidHex);
    if (!blob || blob.type !== "blob") return false;
    if (TAMPER_SKIP_PATTERN.test(RAW_UTF8_DECODER.decode(blob.body))) return false;
  }
  return true;
}

export async function diffStat(path: string, base: string): Promise<{ files: number; additions: number; deletions: number }> {
  const fast = readFastDiffStat(path, base);
  if (fast) return fast;
  const out = (await run(["git", "diff", "--no-ext-diff", "--no-textconv", "--numstat", `${base}...HEAD`], path)).stdout;
  let files = 0;
  let additions = 0;
  let deletions = 0;
  for (const line of out.split("\n").filter(Boolean)) {
    const [add, del] = line.split("\t");
    files += 1;
    additions += Number(add) || 0;
    deletions += Number(del) || 0;
  }
  return { files, additions, deletions };
}

/** A mechanical check before review: deleted test files and newly skipped tests block the change. */
export async function tamperCheck(path: string, base: string): Promise<string[]> {
  if (isFastTamperClean(path, base)) return [];
  // Raw deletion records include binary tests and literal names; the patch keeps the existing line semantics.
  const result = await run(["git", "diff", "--no-ext-diff", "--no-textconv", "--raw", "-z", "--patch", "--unified=0", `${base}...HEAD`], path);
  const { deleted, patch } = parseTamperPacket(result.stdout);
  return tamperProblems(deleted, patch);
}
