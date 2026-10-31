// Fast loose-object patch fingerprinting and plain-diff review comparison.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { treeEntries } from "../object-format.js";
import { isSpawnIntercepted, run } from "./exec.js";
import { SLASH_BYTE } from "./loose-index.js";
import {
  canWalkRawLooseHistory,
  type GitDirs,
  hasReplaceRefs,
  haveIdenticalLooseTree,
  isPlainSha1CommonDir,
  type LooseCommit,
  RAW_UTF8_DECODER,
  readLooseCommitObject,
  readLooseRawObject,
  resolveGitDirs,
  resolveLooseMergeBaseOid,
  resolveLooseRefCommit,
  resolveLooseTreeOid,
} from "./loose-objects.js";

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
        `diff --git a/${item.path} b/${item.path}\nindex\n--- a/${item.path}\n+++ b/${item.path}\n@@\n${[
          ...ctxBefore,
          ...delLines,
          ...addLines,
          ...ctxAfter
        ].join("\n")}`,
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
        `diff --git a/${item.path} b/${item.path}\nnew file mode ${item.mode}\nindex 0000000..${shortNew}\n--- /dev/null\n+++ b/${item.path}\n@@ -0,0 +${fmtRange(
          1,
          lines.length
        )} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`,
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
        `diff --git a/${item.path} b/${item.path}\ndeleted file mode ${item.mode}\nindex ${shortOld}..0000000\n--- a/${item.path}\n+++ /dev/null\n@@ -${fmtRange(
          1,
          lines.length
        )} +0,0 @@\n${lines.map((l) => `-${l}`).join("\n")}\n`,
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
        `diff --git a/${item.path} b/${item.path}\nindex ${shortOld}..${shortNew} ${item.oldMode}\n--- a/${item.path}\n+++ b/${item.path}\n@@ -${fmtRange(
          oldCount === 0 ? 0 : 1,
          oldCount
        )} +${fmtRange(
          newCount === 0 ? 0 : 1,
          newCount
        )} @@\n${[
          ...ctxBefore,
          ...delLines,
          ...addLines,
          ...ctxAfter
        ].join("\n")}\n`,
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
  const diff = await run(
    [
      "git",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--no-renames",
      "--binary",
      "--full-index",
      "-U3",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      from,
      to
    ],
    path,
  );
  if (diff.code !== 0) return undefined;
  if (!diff.stdout) return "empty";
  const placed = diff.stdout.replace(/^index [0-9a-f]+\.\.[0-9a-f]+.*$/gm, "index").replace(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/gm, "@@");
  return createHash("sha256").update(placed).digest("hex");
}
