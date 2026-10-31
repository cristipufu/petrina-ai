// Plain Git config parsing, loose object type/file lookups, and atomic loose ref updates.

import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { empty, isSpawnIntercepted, systemCode } from "./exec.js";
import {
  findLooseTreeEntry,
  FULL_OID,
  type GitDirs,
  hasNoPacksOrAlternates,
  hasReplaceRefs,
  isDefinitelyAbsentLooseOid,
  isSafeSimpleRefName,
  RAW_UTF8_DECODER,
  readLooseCommitObject,
  readLooseRawObject,
  resolveDirectRef,
  resolveGitDirs,
  resolveLooseTreeOid,
} from "./loose-object-core.js";

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
    if (
      !statSync(join(remotePath, "HEAD")).isFile() ||
      !statSync(join(remotePath, "objects")).isDirectory() ||
      !statSync(join(remotePath, "refs")).isDirectory()
    ) {
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
      try {
        closeSync(fd);
      } catch {
        /* Best effort. */
      }
    }
    if (createdLock && !renamed) {
      try {
        rmSync(lockPath, { force: true });
      } catch {
        /* Best effort. */
      }
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
