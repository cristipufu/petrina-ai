// Merge-base, in-memory merge-tree, patch-id, diff-stat and tamper checks.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { treeEntries } from "../object-format.js";
import { parseTamperPacket, tamperProblems } from "../tamper-format.js";
import { isSpawnIntercepted, must, run } from "./exec.js";
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
  resolveLooseTreeOid,
  SHA,
} from "./loose-objects.js";
import { inspectPlainWorktree, type PlainWorktreeInspection, SLASH_BYTE, writeLooseTreeFromMap } from "./loose-index.js";

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

function canUsePlainDiffConfig(dirs: GitDirs): boolean {
  if (
    process.env.GIT_CONFIG_PARAMETERS ||
    process.env.GIT_CONFIG_COUNT ||
    process.env.GIT_CONFIG ||
    existsSync(join(dirs.commonDir, "info", "attributes"))
  ) {
    return false;
  }
  const noSystem = process.env.GIT_CONFIG_NOSYSTEM === "1";
  const sysPath = process.env.GIT_CONFIG_SYSTEM;
  const globalPath = process.env.GIT_CONFIG_GLOBAL;
  if ((!noSystem && !sysPath) || !globalPath) return false;
  try {
    if (!noSystem && sysPath && existsSync(sysPath)) {
      const t = readFileSync(sysPath, "utf8");
      if (/\[diff|\[include/i.test(t)) return false;
    }
    if (existsSync(globalPath)) {
      const t = readFileSync(globalPath, "utf8");
      if (/\[diff|\[include/i.test(t)) return false;
    }
    const localText = readFileSync(join(dirs.commonDir, "config"), "utf8");
    if (/\[diff|\[include|worktreeconfig/i.test(localText)) return false;
  } catch {
    return false;
  }
  return true;
}

type OrderedTreeDiffItem =
  | { kind: "added"; path: string; mode: "100644" | "100755"; newOid: string }
  | { kind: "deleted"; path: string; mode: "100644" | "100755"; oldOid: string }
  | { kind: "modified"; path: string; oldMode: "100644" | "100755"; newMode: "100644" | "100755"; oldOid: string; newOid: string };

function collectSubtreeDiffItems(
  commonDir: string,
  treeOid: string,
  prefix: string,
  kind: "added" | "deleted",
  out: OrderedTreeDiffItem[],
): boolean {
  const raw = readLooseRawObject(commonDir, treeOid);
  if (!raw || raw.type !== "tree") return false;
  let entries;
  try {
    entries = treeEntries({ id: treeOid, type: "tree", body: raw.body });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const name = entry.name.toString("utf8");
    if (!name || name === ".gitattributes" || name === ".gitmodules" || !/^[A-Za-z0-9._-]+$/.test(name)) return false;
    const relPath = prefix ? `${prefix}/${name}` : name;
    const typeBits = entry.mode & 0o170000;
    if (typeBits === 0o040000) {
      if (!collectSubtreeDiffItems(commonDir, entry.id, relPath, kind, out)) return false;
    } else if (typeBits === 0o100000) {
      if (out.length >= 64) return false;
      const mode = entry.mode & 0o100 ? "100755" : "100644";
      if (kind === "added") out.push({ kind: "added", path: relPath, mode, newOid: entry.id });
      else out.push({ kind: "deleted", path: relPath, mode, oldOid: entry.id });
    } else {
      return false;
    }
  }
  return true;
}

function diffLooseTreesInGitOrder(
  commonDir: string,
  fromTree: string,
  toTree: string,
  prefix: string,
  out: OrderedTreeDiffItem[],
): boolean {
  const fromRaw = readLooseRawObject(commonDir, fromTree);
  const toRaw = readLooseRawObject(commonDir, toTree);
  if (!fromRaw || fromRaw.type !== "tree" || !toRaw || toRaw.type !== "tree") return false;
  let aEntries;
  let bEntries;
  try {
    aEntries = treeEntries({ id: fromTree, type: "tree", body: fromRaw.body });
    bEntries = treeEntries({ id: toTree, type: "tree", body: toRaw.body });
  } catch {
    return false;
  }
  const aKinds = new Map<string, boolean>();
  for (const e of aEntries) {
    const name = e.name.toString("utf8");
    if (!name || name === ".gitattributes" || name === ".gitmodules" || !/^[A-Za-z0-9._-]+$/.test(name)) return false;
    const tb = e.mode & 0o170000;
    if (tb !== 0o040000 && tb !== 0o100000) return false;
    aKinds.set(name, tb === 0o040000);
  }
  for (const e of bEntries) {
    const name = e.name.toString("utf8");
    if (!name || name === ".gitattributes" || name === ".gitmodules" || !/^[A-Za-z0-9._-]+$/.test(name)) return false;
    const tb = e.mode & 0o170000;
    if (tb !== 0o040000 && tb !== 0o100000) return false;
    const prevIsDir = aKinds.get(name);
    if (prevIsDir !== undefined && prevIsDir !== (tb === 0o040000)) return false;
  }
  const sortKey = (entry: { mode: number; name: Buffer }) =>
    (entry.mode & 0o170000) === 0o040000 ? Buffer.concat([entry.name, SLASH_BYTE]) : entry.name;
  let i = 0;
  let j = 0;
  while (i < aEntries.length || j < bEntries.length) {
    const cmp =
      i >= aEntries.length
        ? 1
        : j >= bEntries.length
          ? -1
          : Buffer.compare(sortKey(aEntries[i]!), sortKey(bEntries[j]!));
    if (cmp < 0) {
      const a = aEntries[i]!;
      const relPath = prefix ? `${prefix}/${a.name.toString("utf8")}` : a.name.toString("utf8");
      if ((a.mode & 0o170000) === 0o040000) {
        if (!collectSubtreeDiffItems(commonDir, a.id, relPath, "deleted", out)) return false;
      } else {
        if (out.length >= 64) return false;
        out.push({ kind: "deleted", path: relPath, mode: a.mode & 0o100 ? "100755" : "100644", oldOid: a.id });
      }
      i += 1;
    } else if (cmp > 0) {
      const b = bEntries[j]!;
      const relPath = prefix ? `${prefix}/${b.name.toString("utf8")}` : b.name.toString("utf8");
      if ((b.mode & 0o170000) === 0o040000) {
        if (!collectSubtreeDiffItems(commonDir, b.id, relPath, "added", out)) return false;
      } else {
        if (out.length >= 64) return false;
        out.push({ kind: "added", path: relPath, mode: b.mode & 0o100 ? "100755" : "100644", newOid: b.id });
      }
      j += 1;
    } else {
      const a = aEntries[i]!;
      const b = bEntries[j]!;
      const relPath = prefix ? `${prefix}/${a.name.toString("utf8")}` : a.name.toString("utf8");
      if ((a.mode & 0o170000) === 0o040000) {
        if (a.id !== b.id && !diffLooseTreesInGitOrder(commonDir, a.id, b.id, relPath, out)) return false;
      } else {
        const oldMode = a.mode & 0o100 ? "100755" : "100644";
        const newMode = b.mode & 0o100 ? "100755" : "100644";
        if (a.id !== b.id || oldMode !== newMode) {
          if (out.length >= 64) return false;
          out.push({ kind: "modified", path: relPath, oldMode, newMode, oldOid: a.id, newOid: b.id });
        }
      }
      i += 1;
      j += 1;
    }
  }
  return true;
}

function computeFastPlainPatchId(commonDir: string, fromTree: string, toTree: string): string | undefined {
  if (fromTree === toTree) return "empty";
  const items: OrderedTreeDiffItem[] = [];
  if (!diffLooseTreesInGitOrder(commonDir, fromTree, toTree, "", items)) return undefined;
  if (items.length === 0) return "empty";
  const blocks: string[] = [];
  for (const item of items) {
    if (item.kind === "added") {
      const blob = readLooseRawObject(commonDir, item.newOid);
      if (!blob || blob.type !== "blob" || blob.body.includes(0)) return undefined;
      if (blob.body.length === 0) {
        blocks.push(`diff --git a/${item.path} b/${item.path}\nnew file mode ${item.mode}\nindex`);
      } else {
        const hasLf = blob.body[blob.body.length - 1] === 0x0a;
        if (!hasLf && blob.body.includes(0x0d)) return undefined;
        const decoded = RAW_UTF8_DECODER.decode(blob.body);
        const lines = (hasLf ? decoded.slice(0, -1) : decoded).split("\n");
        if (lines.length > 256) return undefined;
        const noNl = hasLf ? "" : "\n\\ No newline at end of file";
        blocks.push(
          `diff --git a/${item.path} b/${item.path}\nnew file mode ${item.mode}\nindex\n--- /dev/null\n+++ b/${item.path}\n@@\n${lines.map((l) => `+${l}`).join("\n")}${noNl}`,
        );
      }
    } else if (item.kind === "deleted") {
      const blob = readLooseRawObject(commonDir, item.oldOid);
      if (!blob || blob.type !== "blob" || blob.body.includes(0)) return undefined;
      if (blob.body.length === 0) {
        blocks.push(`diff --git a/${item.path} b/${item.path}\ndeleted file mode ${item.mode}\nindex`);
      } else {
        const hasLf = blob.body[blob.body.length - 1] === 0x0a;
        if (!hasLf && blob.body.includes(0x0d)) return undefined;
        const decoded = RAW_UTF8_DECODER.decode(blob.body);
        const lines = (hasLf ? decoded.slice(0, -1) : decoded).split("\n");
        if (lines.length > 256) return undefined;
        const noNl = hasLf ? "" : "\n\\ No newline at end of file";
        blocks.push(
          `diff --git a/${item.path} b/${item.path}\ndeleted file mode ${item.mode}\nindex\n--- a/${item.path}\n+++ /dev/null\n@@\n${lines.map((l) => `-${l}`).join("\n")}${noNl}`,
        );
      }
    } else if (item.oldOid === item.newOid) {
      blocks.push(`diff --git a/${item.path} b/${item.path}\nold mode ${item.oldMode}\nnew mode ${item.newMode}`);
    } else {
      if (item.oldMode !== item.newMode) return undefined;
      const oldBlob = readLooseRawObject(commonDir, item.oldOid);
      const newBlob = readLooseRawObject(commonDir, item.newOid);
      if (!oldBlob || oldBlob.type !== "blob" || !newBlob || newBlob.type !== "blob") return undefined;
      if (oldBlob.body.includes(0) || newBlob.body.includes(0)) return undefined;
      if ((oldBlob.body.length > 0 && oldBlob.body[oldBlob.body.length - 1] !== 0x0a) || (newBlob.body.length > 0 && newBlob.body[newBlob.body.length - 1] !== 0x0a)) {
        return undefined;
      }
      const oldLines = oldBlob.body.length === 0 ? [] : RAW_UTF8_DECODER.decode(oldBlob.body).slice(0, -1).split("\n");
      const newLines = newBlob.body.length === 0 ? [] : RAW_UTF8_DECODER.decode(newBlob.body).slice(0, -1).split("\n");
      if (oldLines.length > 256 || newLines.length > 256) return undefined;
      let prefix = 0;
      while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
        prefix += 1;
      }
      if (prefix > 3) return undefined;
      let suffix = 0;
      while (
        prefix + suffix < oldLines.length &&
        prefix + suffix < newLines.length &&
        oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
      ) {
        suffix += 1;
      }
      const remOld = oldLines.slice(prefix, oldLines.length - suffix);
      const remNew = newLines.slice(prefix, newLines.length - suffix);
      if (remOld.length > 0 && remNew.length > 0) {
        const remNewSet = new Set(remNew);
        for (const line of remOld) {
          if (remNewSet.has(line)) return undefined;
        }
      }
      const ctxBefore = oldLines.slice(0, prefix).map((l) => ` ${l}`);
      const delLines = remOld.map((l) => `-${l}`);
      const addLines = remNew.map((l) => `+${l}`);
      const ctxAfter = oldLines.slice(oldLines.length - suffix, oldLines.length - suffix + Math.min(3, suffix)).map((l) => ` ${l}`);
      blocks.push(
        `diff --git a/${item.path} b/${item.path}\nindex\n--- a/${item.path}\n+++ b/${item.path}\n@@\n${[...ctxBefore, ...delLines, ...addLines, ...ctxAfter].join("\n")}`,
      );
    }
  }
  const placed = blocks.join("\n").trim();
  return placed ? createHash("sha256").update(placed).digest("hex") : "empty";
}

function shortLooseSha1(commonDir: string, oid: string): string | undefined {
  if (oid.length !== 40) return undefined;
  const fanout = oid.slice(0, 2);
  const restPrefix = oid.slice(2, 7);
  const expectedRest = oid.slice(2);
  let entries: string[];
  try {
    entries = readdirSync(join(commonDir, "objects", fanout));
  } catch {
    return undefined;
  }
  let matched = false;
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    if (name.startsWith(restPrefix)) {
      if (name !== expectedRest || matched) return undefined;
      matched = true;
    }
  }
  return matched ? oid.slice(0, 7) : undefined;
}

export function tryFastPlainReviewComparison(
  path: string,
  range: string,
  files: readonly string[] | undefined,
  lockfiles: readonly string[],
): { stat: string; patch: string; locks: string } | undefined {
  if (isSpawnIntercepted()) return undefined;
  if (files !== undefined) {
    if (files.length === 0) return { stat: "", patch: "", locks: "" };
    for (const f of files) {
      if (!f || f.startsWith("/") || f.endsWith("/") || f.includes("\\") || f.includes(":")) return undefined;
    }
  }
  const dirs = resolveGitDirs(path);
  if (!dirs || !isPlainSha1CommonDir(dirs.commonDir) || hasReplaceRefs(dirs.commonDir) || !canUsePlainDiffConfig(dirs)) {
    return undefined;
  }
  try {
    const localCfg = readFileSync(join(dirs.commonDir, "config"), "utf8");
    if (/abbrev/i.test(localCfg)) return undefined;
    const globalPath = process.env.GIT_CONFIG_GLOBAL;
    if (globalPath && existsSync(globalPath) && /abbrev/i.test(readFileSync(globalPath, "utf8"))) return undefined;
    const sysPath = process.env.GIT_CONFIG_NOSYSTEM === "1" ? undefined : process.env.GIT_CONFIG_SYSTEM;
    if (sysPath && existsSync(sysPath) && /abbrev/i.test(readFileSync(sysPath, "utf8"))) return undefined;
  } catch {
    return undefined;
  }
  let fromCommit: LooseCommit | undefined;
  let toCommit: LooseCommit | undefined;
  const threeDot = range.indexOf("...");
  if (threeDot > 0) {
    if (!canWalkRawLooseHistory(dirs.commonDir, false)) return undefined;
    const left = range.slice(0, threeDot);
    const right = range.slice(threeDot + 3);
    if (!right || right.includes(".")) return undefined;
    const mb = resolveLooseMergeBaseOid(dirs, left, right, false);
    if (!mb?.oid) return undefined;
    fromCommit = readLooseCommitObject(dirs.commonDir, mb.oid);
    toCommit = resolveLooseRefCommit(dirs, right);
  } else {
    const twoDot = range.indexOf("..");
    if (twoDot <= 0) return undefined;
    const left = range.slice(0, twoDot);
    const right = range.slice(twoDot + 2);
    if (!right || right.includes(".")) return undefined;
    fromCommit = resolveLooseRefCommit(dirs, left);
    toCommit = resolveLooseRefCommit(dirs, right);
  }
  if (!fromCommit || !toCommit) return undefined;
  if (fromCommit.tree === toCommit.tree) {
    return readLooseRawObject(dirs.commonDir, fromCommit.tree)?.type === "tree" ? { stat: "", patch: "", locks: "" } : undefined;
  }
  const allItems: OrderedTreeDiffItem[] = [];
  if (!diffLooseTreesInGitOrder(dirs.commonDir, fromCommit.tree, toCommit.tree, "", allItems)) return undefined;
  const items = files
    ? allItems.filter((item) => files.some((wanted) => item.path === wanted || item.path.startsWith(`${wanted}/`)))
    : allItems;
  if (items.length === 0) return { stat: "", patch: "", locks: "" };
  let hasAdded = false;
  let hasDeleted = false;
  for (const item of items) {
    if (item.path.length > 45) return undefined;
    const baseName = item.path.slice(item.path.lastIndexOf("/") + 1);
    if (lockfiles.includes(baseName)) return undefined;
    if (item.kind === "added") hasAdded = true;
    else if (item.kind === "deleted") hasDeleted = true;
  }
  if (hasAdded && hasDeleted) return undefined;

  const fmtRange = (start: number, count: number): string =>
    count === 0 ? "0,0" : count === 1 ? `${start}` : `${start},${count}`;
  const statEntries: { path: string; ins: number; del: number }[] = [];
  const patchBlocks: string[] = [];

  for (const item of items) {
    if (item.kind === "added") {
      const shortNew = shortLooseSha1(dirs.commonDir, item.newOid);
      if (!shortNew) return undefined;
      const blob = readLooseRawObject(dirs.commonDir, item.newOid);
      if (!blob || blob.type !== "blob" || blob.body.length === 0 || blob.body.includes(0) || blob.body.includes(0x0d)) {
        return undefined;
      }
      if (blob.body[blob.body.length - 1] !== 0x0a) return undefined;
      const lines = RAW_UTF8_DECODER.decode(blob.body).slice(0, -1).split("\n");
      if (lines.length === 0 || lines.length > 40) return undefined;
      statEntries.push({ path: item.path, ins: lines.length, del: 0 });
      patchBlocks.push(
        `diff --git a/${item.path} b/${item.path}\nnew file mode ${item.mode}\nindex 0000000..${shortNew}\n--- /dev/null\n+++ b/${item.path}\n@@ -0,0 +${fmtRange(1, lines.length)} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`,
      );
    } else if (item.kind === "deleted") {
      const shortOld = shortLooseSha1(dirs.commonDir, item.oldOid);
      if (!shortOld) return undefined;
      const blob = readLooseRawObject(dirs.commonDir, item.oldOid);
      if (!blob || blob.type !== "blob" || blob.body.length === 0 || blob.body.includes(0) || blob.body.includes(0x0d)) {
        return undefined;
      }
      if (blob.body[blob.body.length - 1] !== 0x0a) return undefined;
      const lines = RAW_UTF8_DECODER.decode(blob.body).slice(0, -1).split("\n");
      if (lines.length === 0 || lines.length > 40) return undefined;
      statEntries.push({ path: item.path, ins: 0, del: lines.length });
      patchBlocks.push(
        `diff --git a/${item.path} b/${item.path}\ndeleted file mode ${item.mode}\nindex ${shortOld}..0000000\n--- a/${item.path}\n+++ /dev/null\n@@ -${fmtRange(1, lines.length)} +0,0 @@\n${lines.map((l) => `-${l}`).join("\n")}\n`,
      );
    } else {
      if (item.oldMode !== item.newMode || item.oldOid === item.newOid) return undefined;
      const shortOld = shortLooseSha1(dirs.commonDir, item.oldOid);
      const shortNew = shortLooseSha1(dirs.commonDir, item.newOid);
      if (!shortOld || !shortNew) return undefined;
      const oldBlob = readLooseRawObject(dirs.commonDir, item.oldOid);
      const newBlob = readLooseRawObject(dirs.commonDir, item.newOid);
      if (!oldBlob || oldBlob.type !== "blob" || !newBlob || newBlob.type !== "blob") return undefined;
      if (oldBlob.body.includes(0) || newBlob.body.includes(0) || oldBlob.body.includes(0x0d) || newBlob.body.includes(0x0d)) {
        return undefined;
      }
      if (
        (oldBlob.body.length > 0 && oldBlob.body[oldBlob.body.length - 1] !== 0x0a) ||
        (newBlob.body.length > 0 && newBlob.body[newBlob.body.length - 1] !== 0x0a)
      ) {
        return undefined;
      }
      const oldLines = oldBlob.body.length === 0 ? [] : RAW_UTF8_DECODER.decode(oldBlob.body).slice(0, -1).split("\n");
      const newLines = newBlob.body.length === 0 ? [] : RAW_UTF8_DECODER.decode(newBlob.body).slice(0, -1).split("\n");
      if (oldLines.length > 256 || newLines.length > 256) return undefined;
      let prefix = 0;
      while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
        prefix += 1;
      }
      if (prefix > 3) return undefined;
      let suffix = 0;
      while (
        prefix + suffix < oldLines.length &&
        prefix + suffix < newLines.length &&
        oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
      ) {
        suffix += 1;
      }
      const remOld = oldLines.slice(prefix, oldLines.length - suffix);
      const remNew = newLines.slice(prefix, newLines.length - suffix);
      if (remOld.length + remNew.length === 0 || remOld.length + remNew.length > 40) return undefined;
      if (remOld.length > 0 && remNew.length > 0) {
        const remNewSet = new Set(remNew);
        for (const line of remOld) {
          if (remNewSet.has(line)) return undefined;
        }
      }
      const afterCount = Math.min(3, suffix);
      const oldCount = prefix + remOld.length + afterCount;
      const newCount = prefix + remNew.length + afterCount;
      const ctxBefore = oldLines.slice(0, prefix).map((l) => ` ${l}`);
      const delLines = remOld.map((l) => `-${l}`);
      const addLines = remNew.map((l) => `+${l}`);
      const ctxAfter = oldLines.slice(oldLines.length - suffix, oldLines.length - suffix + afterCount).map((l) => ` ${l}`);
      statEntries.push({ path: item.path, ins: remNew.length, del: remOld.length });
      patchBlocks.push(
        `diff --git a/${item.path} b/${item.path}\nindex ${shortOld}..${shortNew} ${item.oldMode}\n--- a/${item.path}\n+++ b/${item.path}\n@@ -${fmtRange(oldCount === 0 ? 0 : 1, oldCount)} +${fmtRange(newCount === 0 ? 0 : 1, newCount)} @@\n${[...ctxBefore, ...delLines, ...addLines, ...ctxAfter].join("\n")}\n`,
      );
    }
  }

  let maxNameLen = 0;
  let maxChange = 0;
  let totalIns = 0;
  let totalDel = 0;
  for (const entry of statEntries) {
    if (entry.path.length > maxNameLen) maxNameLen = entry.path.length;
    if (entry.ins + entry.del > maxChange) maxChange = entry.ins + entry.del;
    totalIns += entry.ins;
    totalDel += entry.del;
  }
  const countWidth = String(maxChange).length;
  if (1 + maxNameLen + 3 + countWidth + 1 + maxChange > 75) return undefined;
  const statLines = statEntries.map(
    (e) => ` ${e.path.padEnd(maxNameLen)} | ${String(e.ins + e.del).padStart(countWidth)} ${"+".repeat(e.ins)}${"-".repeat(e.del)}\n`,
  );
  const summary = ` ${statEntries.length} ${statEntries.length === 1 ? "file" : "files"} changed${totalIns > 0 ? `, ${totalIns} ${totalIns === 1 ? "insertion" : "insertions"}(+)` : ""}${totalDel > 0 ? `, ${totalDel} ${totalDel === 1 ? "deletion" : "deletions"}(-)` : ""}\n`;
  return { stat: `${statLines.join("")}${summary}`, patch: patchBlocks.join(""), locks: "" };
}

/**
 * An exact fingerprint of the change from `from` to `to`: its whole diff, every character and space of it,
 * with only what moves when the same change sits on another commit left out (line numbers and blob ids).
 * Unlike git's patch-id it never ignores whitespace, which is meaning in Python, YAML or a Makefile.
 * "empty" for no change.
 */
export async function patchId(path: string, from: string, to: string): Promise<string | undefined> {
  if (haveIdenticalLooseTree(path, from, to)) return "empty";
  if (!isSpawnIntercepted() && !from.startsWith("-") && !to.startsWith("-")) {
    const dirs = resolveGitDirs(path);
    if (dirs && !hasReplaceRefs(dirs.commonDir) && canUsePlainDiffConfig(dirs)) {
      const fromTree = resolveLooseTreeOid(dirs, from);
      const toTree = resolveLooseTreeOid(dirs, to);
      if (fromTree && toTree) {
        if (fromTree === toTree && readLooseRawObject(dirs.commonDir, fromTree)?.type === "tree") {
          return "empty";
        }
        const fast = computeFastPlainPatchId(dirs.commonDir, fromTree, toTree);
        if (fast !== undefined) return fast;
      }
    }
  }
  const diff = await run(["git", "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--binary", "--full-index", "-U3", "--src-prefix=a/", "--dst-prefix=b/", from, to], path);
  if (diff.code !== 0) return undefined;
  if (!diff.stdout) return "empty";
  const placed = diff.stdout.replace(/^index [0-9a-f]+\.\.[0-9a-f]+.*$/gm, "index").replace(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/gm, "@@");
  return createHash("sha256").update(placed).digest("hex");
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
  return collectLooseTreeFiles(dirs.commonDir, ontoCommit.tree, "sha1", ontoFiles) &&
    collectLooseTreeFiles(dirs.commonDir, refCommit.tree, "sha1", refFiles);
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
          if ((mb.oid === ontoCommit.oid || (mbCommit && ontoCommit.tree === mbCommit.tree)) && readLooseRawObject(dirs.commonDir, refCommit.tree)?.type === "tree") {
            return { tree: refCommit.tree, conflicts: [], notes: [] };
          }
          if ((mb.oid === refCommit.oid || ontoCommit.tree === refCommit.tree || (mbCommit && refCommit.tree === mbCommit.tree)) && readLooseRawObject(dirs.commonDir, ontoCommit.tree)?.type === "tree") {
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
    const toResolved = to === "HEAD"
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
    } catch { /* Fall back to Git CLI when the worktree root metadata is non-standard. */ }
  }
  const [branch, where] = await Promise.all([
    run(["git", "symbolic-ref", "--quiet", "--short", "HEAD"], path),
    run(["git", "rev-parse", ...HALF_DONE.flatMap(([marker]) => ["--git-path", marker])], path),
  ]);
  const paths = where.stdout.split("\n");
  for (const [index, [, what]] of HALF_DONE.entries()) {
    if (where.code === 0 && paths[index] && existsSync(resolve(path, paths[index]!))) return { ...(branch.code === 0 ? { branch: branch.stdout } : {}), busy: what };
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
