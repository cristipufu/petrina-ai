// Credentialed and local-stand-in remote Git operations (fetch, push, remoteRefs, repoInfo).
// This is the sole Git module permitted to pass coordinator credentials (authenticated: true),
// pinned to the product's saved address and gated by the repository settings allowlist.

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { treeEntries } from "../object-format.js";
import { githubRepoOf, isRefName, isSha, REMOTE } from "../identity.js";
import {
  canonical,
  type Check,
  commandFailure,
  FETCH_TIMEOUT_MS,
  isSpawnIntercepted,
  must,
  type Remote,
  run,
} from "./exec.js";
import {
  directRefMatches,
  type GitDirs,
  hasNestedRefsPrefix,
  hasRefDirectoryConflict,
  hasReplaceRefs,
  isPlainSha1CommonDir,
  isSafeSimpleRefName,
  looseAncestorSet,
  type LooseCommit,
  parsePlainGitConfigEntries,
  readLooseCommitObject,
  readLooseRawObject,
  readSimpleRemoteOriginUrl,
  resolveBareGitDirs,
  resolveDirectRef,
  resolveGitDirs,
  resolveOriginDefaultBranchSync,
  tryAtomicUpdateLooseRef,
} from "./loose-objects.js";
import { revParse } from "./revisions.js";

export interface RepoInfo {
  root: string;
  owner: string;
  name: string;
  defaultBranch: string;
  /** The origin address exactly as configured, with no address rewrites applied. */
  remote?: string;
  /** Its origin is a repository on GitHub. */
  github: boolean;
}

/** The origin address exactly as configured: `git remote get-url` would apply address rewrites. */
export async function remoteAddress(root: string): Promise<string | undefined> {
  const fast = readSimpleRemoteOriginUrl(root);
  if (fast) return fast.url;
  const result = await run(["git", "config", "--get", "remote.origin.url"], root);
  return result.code === 0 && result.stdout ? result.stdout : undefined;
}

/** Read what Petrina needs about a local clone, from the folder or any folder inside it. */
export async function repoInfo(path: string): Promise<RepoInfo> {
  const fastDirs = !isSpawnIntercepted() ? resolveGitDirs(path) : undefined;
  const fastBranch = fastDirs ? resolveOriginDefaultBranchSync(fastDirs) : undefined;
  if (fastDirs && fastBranch) {
    const root = canonical(path);
    const remote = await remoteAddress(root);
    const local = /^(?:[A-Za-z]:[\\/]|[\\/]|file:)/.test(remote ?? "");
    const match = local ? null : REMOTE.exec(remote ?? "");
    const segments = match?.[2]?.split("/").filter(Boolean) ?? [];
    const name = segments.at(-1) ?? root.split("/").at(-1) ?? "repo";
    const owner = segments.slice(0, -1).join("/") || "local";
    return {
      root,
      owner,
      name,
      defaultBranch: fastBranch,
      ...(remote ? { remote } : {}),
      github: !local && remote !== undefined && githubRepoOf(remote) !== undefined
    };
  }
  const root = await must(["git", "rev-parse", "--show-toplevel"], path);
  const [remote, branch] = await Promise.all([
    remoteAddress(root), run(["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], root),
  ]);
  // A folder on this computer (C:\ or C:/ on Windows included) has no host: the product goes by its own folder.
  const local = /^(?:[A-Za-z]:[\\/]|[\\/]|file:)/.test(remote ?? "");
  const match = local ? null : REMOTE.exec(remote ?? "");
  const segments = match?.[2]?.split("/").filter(Boolean) ?? [];
  const name = segments.at(-1) ?? root.split("/").at(-1) ?? "repo";
  const owner = segments.slice(0, -1).join("/") || "local";
  const head = branch.stdout;
  const defaultBranch = head.startsWith("origin/") ? head.slice("origin/".length) : (await run(
    [
    "git",
    "rev-parse",
    "--abbrev-ref",
    "HEAD"
  ],
    root
  )).stdout || "main";
  return { root, owner, name, defaultBranch, ...(remote ? { remote } : {}), github: !local && remote !== undefined && githubRepoOf(remote) !== undefined };
}

/** Branch names come from an allowlist, never from raw task text. */
export function branchName(title: string, taskId: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36)
    .replace(/-+$/g, "");
  const suffix = taskId.replace(/[^a-z0-9]/gi, "").slice(-6).toLowerCase();
  return `petrina/${slug || "task"}-${suffix}`;
}

/**
 * The repository-level settings a fetch or push with the coordinator's login may run under. An
 * allowlist: anything else (agents can change these settings) means no credentialed step. Hooks
 * are listed because Petrina's git steps switch them off anyway. Remote names are plain words, so
 * no remote section can be named after the address Petrina uses.
 */
const SAFE_SETTING = new RegExp(
  [
    "core\\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|autocrlf|eol|hookspath)",
    "extensions\\.(worktreeconfig|objectformat)",
    "remote\\.[^.:/@]+\\.(url|fetch|pushurl|tagopt|prune)",
    "branch\\..+\\.(remote|merge|rebase|pushremote|description)",
    "submodule\\..+\\.(url|active)",
    "user\\.(name|email)",
    "(gc\\.auto|gc\\.autodetach|pull\\.rebase|pull\\.ff|push\\.default|push\\.autosetupremote|fetch\\.prune|fetch\\.prunetags|lfs\\.repositoryformatversion)",
  ]
    .map((pattern) => `^${pattern}$`)
    .join("|"),
  "i",
);

function isFastSafeLocalConfig(root: string): boolean {
  if (isSpawnIntercepted() || process.env.GIT_CONFIG) return false;
  const dirs = resolveGitDirs(root);
  if (!dirs || existsSync(join(dirs.gitdir, "config.worktree")) || existsSync(join(dirs.commonDir, "config.worktree"))) {
    return false;
  }
  let text: string;
  try {
    text = readFileSync(join(dirs.commonDir, "config"), "utf8");
  } catch {
    return false;
  }
  const entries = parsePlainGitConfigEntries(text);
  if (!entries) return false;
  for (const entry of entries) {
    if (entry.key.toLowerCase() === "extensions.worktreeconfig" || !SAFE_SETTING.test(entry.key)) {
      return false;
    }
  }
  return true;
}

/** The repository's own settings (agents can change them) that are not known to be safe for a credentialed step. */
export async function riskySettings(root: string): Promise<string[]> {
  if (isFastSafeLocalConfig(root)) return [];
  const listed = await run(["git", "config", "--list", "--show-scope", "--name-only", "-z"], root);
  if (listed.code !== 0) return ["unreadable git settings"];
  // -z: scope and key alternate, each ending in NUL, so no key can be misread.
  const fields = listed.stdout.split("\0");
  const risky: string[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [scope, key] = [fields[index]!, fields[index + 1]!];
    if ((scope === "local" || scope === "worktree") && !SAFE_SETTING.test(key)) risky.push(key);
  }
  return [...new Set(risky)];
}

function collectKnownRefCommitOids(dirs: GitDirs): Set<string> {
  const out = new Set<string>();
  for (const candidate of ["HEAD", "refs/heads/main", "refs/remotes/origin/main"]) {
    const res = resolveDirectRef(dirs, candidate);
    if (res.kind === "oid" && readLooseCommitObject(dirs.commonDir, res.oid)) {
      out.add(res.oid);
    }
  }
  return out;
}

function copySingleLooseFile(srcCommonDir: string, dstCommonDir: string, oid: string): boolean {
  const dstSub = join(dstCommonDir, "objects", oid.slice(0, 2));
  const dstFile = join(dstSub, oid.slice(2));
  if (existsSync(dstFile)) return true;
  const srcFile = join(srcCommonDir, "objects", oid.slice(0, 2), oid.slice(2));
  let tmpPath: string | undefined;
  try {
    const bytes = readFileSync(srcFile);
    mkdirSync(dstSub, { recursive: true });
    tmpPath = join(dstSub, `.tmp_copy_${process.pid}_${Math.random().toString(36).slice(2)}`);
    writeFileSync(tmpPath, bytes);
    renameSync(tmpPath, dstFile);
    return true;
  } catch {
    if (tmpPath) {
      try { rmSync(tmpPath, { force: true }); } catch { /* Best effort. */ }
    }
    return false;
  }
}

function copyMissingLooseTreeClosure(
  srcCommonDir: string,
  dstCommonDir: string,
  rootTreeOid: string,
  visitedTrees: Set<string>,
  visitedBlobs: Set<string>,
): boolean {
  const stack = [rootTreeOid];
  while (stack.length > 0) {
    if (visitedTrees.size + visitedBlobs.size > 2048) return false;
    const treeOid = stack.pop()!;
    if (visitedTrees.has(treeOid)) continue;
    visitedTrees.add(treeOid);
    const rawTree = readLooseRawObject(srcCommonDir, treeOid);
    if (!rawTree || rawTree.type !== "tree" || rawTree.format !== "sha1") return false;
    let entries;
    try {
      entries = treeEntries({ id: treeOid, type: "tree", body: rawTree.body });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const typeBits = entry.mode & 0o170000;
      if (typeBits === 0o160000) return false;
      if (typeBits === 0o040000) {
        if (!visitedTrees.has(entry.id)) stack.push(entry.id);
      } else if (typeBits === 0o100000 || typeBits === 0o120000) {
        if (visitedBlobs.has(entry.id)) continue;
        visitedBlobs.add(entry.id);
        const dstBlob = join(dstCommonDir, "objects", entry.id.slice(0, 2), entry.id.slice(2));
        if (!existsSync(dstBlob)) {
          const rawBlob = readLooseRawObject(srcCommonDir, entry.id);
          if (!rawBlob || rawBlob.type !== "blob" || rawBlob.format !== "sha1") return false;
          if (!copySingleLooseFile(srcCommonDir, dstCommonDir, entry.id)) return false;
        }
      } else {
        return false;
      }
    }
    if (!copySingleLooseFile(srcCommonDir, dstCommonDir, treeOid)) return false;
  }
  return true;
}

function copyMissingLooseCommitClosure(
  srcCommonDir: string,
  dstCommonDir: string,
  rootCommitOid: string,
  knownDstCommits: ReadonlySet<string>,
): boolean {
  const rootCommit = readLooseCommitObject(srcCommonDir, rootCommitOid);
  if (!rootCommit || rootCommit.oid.length !== 40) return false;
  const visitedCommits = new Set<string>();
  const visitedTrees = new Set<string>();
  const visitedBlobs = new Set<string>();
  const commitOrder: LooseCommit[] = [];
  const queue: LooseCommit[] = [rootCommit];
  visitedCommits.add(rootCommit.oid);
  while (queue.length > 0) {
    if (visitedCommits.size > 1024) return false;
    const current = queue.pop()!;
    if (knownDstCommits.has(current.oid) && readLooseCommitObject(dstCommonDir, current.oid)) {
      continue;
    }
    commitOrder.push(current);
    for (const parentOid of current.parents) {
      if (visitedCommits.has(parentOid)) continue;
      visitedCommits.add(parentOid);
      if (knownDstCommits.has(parentOid) && readLooseCommitObject(dstCommonDir, parentOid)) {
        continue;
      }
      const parent = readLooseCommitObject(srcCommonDir, parentOid);
      if (!parent || parent.oid.length !== 40) return false;
      queue.push(parent);
    }
  }
  for (let i = commitOrder.length - 1; i >= 0; i -= 1) {
    const commit = commitOrder[i]!;
    if (!copyMissingLooseTreeClosure(srcCommonDir, dstCommonDir, commit.tree, visitedTrees, visitedBlobs)) return false;
    if (!copySingleLooseFile(srcCommonDir, dstCommonDir, commit.oid)) return false;
  }
  return true;
}

function fastLocalRemoteRefs(root: string, remote: Remote, refs: readonly string[]): Map<string, string> | undefined {
  if (isSpawnIntercepted() || remote.local !== true || remote.url.includes("://")) return undefined;
  const localDirs = resolveGitDirs(root);
  const remoteTarget = resolve(root, remote.url);
  const remoteDirs = resolveBareGitDirs(remoteTarget) ?? resolveGitDirs(remoteTarget);
  if (!localDirs || !remoteDirs || hasReplaceRefs(remoteDirs.commonDir)) return undefined;
  for (const wanted of refs) {
    if (wanted !== "HEAD" && (!wanted.startsWith("refs/") || !isSafeSimpleRefName(wanted) || hasNestedRefsPrefix(remoteDirs.commonDir, wanted))) {
      return undefined;
    }
  }
  const found = new Map<string, string>();
  for (const wanted of new Set(refs)) {
    const resolved = resolveDirectRef(remoteDirs, wanted);
    if (resolved.kind === "fallback") return undefined;
    if (resolved.kind === "missing") continue;
    let obj = readLooseRawObject(remoteDirs.commonDir, resolved.oid);
    if (!obj) return undefined;
    found.set(wanted, resolved.oid);
    if (obj.type === "tag") {
      let peeledOid = resolved.oid;
      let depth = 0;
      while (obj.type === "tag") {
        depth += 1;
        if (depth > 8) return undefined;
        const m = /^object ([0-9a-f]{40}|[0-9a-f]{64})\n/i.exec(obj.body.toString("utf8"));
        if (!m) return undefined;
        peeledOid = m[1]!.toLowerCase();
        const nextObj = readLooseRawObject(remoteDirs.commonDir, peeledOid);
        if (!nextObj) return undefined;
        obj = nextObj;
      }
      found.set(`${wanted}^{}`, peeledOid);
    }
  }
  return found;
}

function fastLocalFetchRef(root: string, remote: Remote, from: string, to: string): Fetched | undefined {
  if (isSpawnIntercepted() || remote.local !== true || remote.url.includes("://")) return undefined;
  if (!from.startsWith("refs/") || !isSafeSimpleRefName(from) || !to.startsWith("refs/") || !isSafeSimpleRefName(to)) {
    return undefined;
  }
  const localDirs = resolveGitDirs(root);
  const remoteTarget = resolve(root, remote.url);
  const remoteDirs = resolveBareGitDirs(remoteTarget) ?? resolveGitDirs(remoteTarget);
  if (!localDirs || !remoteDirs || !isPlainSha1CommonDir(localDirs.commonDir) || !isPlainSha1CommonDir(remoteDirs.commonDir)) {
    return undefined;
  }
  if (hasNestedRefsPrefix(remoteDirs.commonDir, from) || hasNestedRefsPrefix(localDirs.commonDir, to)) return undefined;
  const src = resolveDirectRef(remoteDirs, from);
  if (src.kind !== "oid") return undefined;
  const knownDst = collectKnownRefCommitOids(localDirs);
  const existingTo = resolveDirectRef(localDirs, to);
  if (existingTo.kind === "oid" && readLooseCommitObject(localDirs.commonDir, existingTo.oid)) {
    knownDst.add(existingTo.oid);
  }
  if (!copyMissingLooseCommitClosure(remoteDirs.commonDir, localDirs.commonDir, src.oid, knownDst)) return undefined;
  if (!tryAtomicUpdateLooseRef(localDirs, to, undefined, src.oid)) return undefined;
  return { ok: true, sha: src.oid };
}

function fastLocalPush(root: string, remote: Remote, updates: readonly { sha: string; ref: string }[]): boolean {
  if (isSpawnIntercepted() || remote.local !== true || remote.url.includes("://")) return false;
  const localDirs = resolveGitDirs(root);
  const remoteTarget = resolve(root, remote.url);
  const remoteDirs = resolveBareGitDirs(remoteTarget);
  if (!localDirs || !remoteDirs || !isPlainSha1CommonDir(localDirs.commonDir) || !isPlainSha1CommonDir(remoteDirs.commonDir)) {
    return false;
  }
  if (existsSync(join(remoteDirs.commonDir, "packed-refs.lock"))) return false;
  let remoteConfigText: string;
  try {
    remoteConfigText = readFileSync(join(remoteDirs.commonDir, "config"), "utf8");
  } catch {
    return false;
  }
  const remoteEntries = parsePlainGitConfigEntries(remoteConfigText);
  if (!remoteEntries) return false;
  let isBare = false;
  for (const entry of remoteEntries) {
    const k = entry.key.toLowerCase();
    if (k === "core.bare") isBare = entry.value.toLowerCase() === "true";
    if (k === "core.hookspath" || k.startsWith("receive.") || k === "extensions.worktreeconfig" || k === "extensions.objectformat") {
      return false;
    }
  }
  if (!isBare) return false;
  const hooksDir = join(remoteDirs.commonDir, "hooks");
  if (existsSync(hooksDir)) {
    try {
      for (const name of readdirSync(hooksDir)) {
        if (!name.endsWith(".sample")) return false;
      }
    } catch {
      return false;
    }
  }
  const seenRefs = new Set<string>();
  const planned: { ref: string; targetPath: string; lockPath: string; sha: string; expected: { kind: "oid"; oid: string } | { kind: "missing" } }[] = [];
  for (const update of updates) {
    if (!/^[0-9a-f]{40}$/i.test(update.sha) || !isSafeSimpleRefName(update.ref)) return false;
    if (!update.ref.startsWith("refs/heads/") && !update.ref.startsWith("refs/tags/")) return false;
    if (seenRefs.has(update.ref)) return false;
    seenRefs.add(update.ref);
    if (hasNestedRefsPrefix(remoteDirs.commonDir, update.ref) || hasRefDirectoryConflict(remoteDirs.commonDir, update.ref)) {
      return false;
    }
    const shaLower = update.sha.toLowerCase();
    if (!readLooseCommitObject(localDirs.commonDir, shaLower)) return false;
    const cur = resolveDirectRef(remoteDirs, update.ref);
    if (cur.kind === "fallback") return false;
    if (update.ref.startsWith("refs/tags/")) {
      if (cur.kind !== "missing") return false;
    } else if (cur.kind === "oid" && cur.oid !== shaLower) {
      const ancestors = looseAncestorSet(localDirs.commonDir, shaLower);
      if (!ancestors || !ancestors.has(cur.oid)) return false;
    }
    const targetPath = join(remoteDirs.commonDir, ...update.ref.split("/"));
    planned.push({ ref: update.ref, targetPath, lockPath: `${targetPath}.lock`, sha: shaLower, expected: cur });
  }
  const knownRemote = collectKnownRefCommitOids(remoteDirs);
  for (const item of planned) {
    if (item.expected.kind === "oid" && readLooseCommitObject(remoteDirs.commonDir, item.expected.oid)) {
      knownRemote.add(item.expected.oid);
    }
  }
  for (const item of planned) {
    if (!copyMissingLooseCommitClosure(localDirs.commonDir, remoteDirs.commonDir, item.sha, knownRemote)) return false;
    knownRemote.add(item.sha);
  }
  const acquiredLocks: string[] = [];
  const openFds: number[] = [];
  let committed = false;
  try {
    for (const item of planned) {
      mkdirSync(dirname(item.targetPath), { recursive: true });
      const fd = openSync(item.lockPath, "wx");
      acquiredLocks.push(item.lockPath);
      openFds.push(fd);
    }
    for (let i = 0; i < planned.length; i += 1) {
      const item = planned[i]!;
      if (!directRefMatches(resolveDirectRef(remoteDirs, item.ref), item.expected)) return false;
      writeFileSync(openFds[i]!, `${item.sha}\n`, "utf8");
      closeSync(openFds[i]!);
      openFds[i] = -1;
    }
    for (const item of planned) {
      renameSync(item.lockPath, item.targetPath);
    }
    committed = true;
    return true;
  } catch {
    return false;
  } finally {
    for (const fd of openFds) {
      if (fd >= 0) {
        try { closeSync(fd); } catch { /* Best effort. */ }
      }
    }
    if (!committed) {
      for (const lockPath of acquiredLocks) {
        try { rmSync(lockPath, { force: true }); } catch { /* Best effort. */ }
      }
    }
  }
}

export type Fetched = { ok: true; sha: string } | { ok: false; error: string; risky?: string[]; timedOut?: boolean };

/**
 * Fetch the default branch from the saved address into `origin/<branch>`. Fail closed: never with
 * the coordinator's login while the repository's settings could misuse it.
 */
export async function fetchBranch(root: string, remote: Remote, branch: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<Fetched> {
  if (!isRefName(branch) || remote.url.startsWith("-")) return { ok: false, error: "not a branch Petrina fetches" };
  return fetchRef(root, remote, `refs/heads/${branch}`, `refs/remotes/origin/${branch}`, timeoutMs);
}

/** Fetch an approved source, including a fork PR through the product repository’s PR reference. */
export async function fetchRef(root: string, remote: Remote, from: string, to: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<Fetched> {
  if (!isRefName(from) || !isRefName(to) || remote.url.startsWith("-")) return { ok: false, error: "not a source Petrina fetches" };
  const risky = await riskySettings(root);
  if (risky.length) return { ok: false, error: "unsafe git settings", risky };
  const fast = fastLocalFetchRef(root, remote, from, to);
  if (fast) return fast;
  const fetched = await run(["git", "fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--", remote.url, `+${from}:${to}`], root, undefined, {
    credentials: true,
    local: remote.local === true,
    timeoutMs,
  });
  if (fetched.timedOut) return { ok: false, error: "timed out", timedOut: true };
  if (fetched.code !== 0) return commandFailure(fetched);
  const sha = await revParse(root, to);
  return sha ? { ok: true, sha } : { ok: false, error: `no ${from} after fetching` };
}

/** What GitHub has for these exact ref names (annotated tags also as `<ref>^{}`), asked of GitHub itself. */
export async function remoteRefs(root: string, remote: Remote, refs: readonly string[]): Promise<Check<Map<string, string>>> {
  if (refs.some((ref) => !isRefName(ref)) || remote.url.startsWith("-")) return { ok: false, error: "not a ref Petrina looks up" };
  const risky = await riskySettings(root);
  if (risky.length) return { ok: false, error: `the repository's git settings include ${risky.slice(0, 3).join(", ")}` };
  const fast = fastLocalRemoteRefs(root, remote, refs);
  if (fast) return { ok: true, value: fast };
  const listed = await run(
    [
    "git",
    "ls-remote",
    "--",
    remote.url,
    ...refs
  ],
    root,
    undefined,
    {
    credentials: true,
    local: remote.local === true,
    timeoutMs: FETCH_TIMEOUT_MS
  }
  );
  if (listed.code !== 0) return commandFailure(listed);
  const found = new Map<string, string>();
  for (const line of listed.stdout.split("\n").filter(Boolean)) {
    const [sha, ref] = line.split("\t");
    // ls-remote matches name endings: keep only the exact names asked for.
    if (sha && ref && isSha(sha) && refs.some((wanted) => ref === wanted || ref === `${wanted}^{}`)) found.set(ref, sha);
  }
  return { ok: true, value: found };
}

/**
 * Push exact commits to exact refs at the saved address. Never forced, so it only moves a branch
 * forward and refuses an existing tag; with `atomic`, all refs or none. Nothing else travels: no
 * tags followed, no submodules pushed, whatever the coordinator's settings say.
 */
export async function push(root: string, remote: Remote, updates: readonly { sha: string; ref: string }[], atomic = false): Promise<Check<void>> {
  if (!updates.length || updates.some((update) => !isSha(update.sha) || !/^refs\/(heads|tags)\//.test(update.ref) || !isRefName(update.ref)) || remote.url.startsWith("-")) {
    return { ok: false, error: "not a push Petrina makes" };
  }
  const risky = await riskySettings(root);
  if (risky.length) return { ok: false, error: `the repository's git settings include ${risky.slice(0, 3).join(", ")}` };
  if (fastLocalPush(root, remote, updates)) return { ok: true, value: undefined };
  const pushed = await run(
    [
      "git",
      "push",
      "--quiet",
      "--no-verify",
      "--no-follow-tags",
      "--recurse-submodules=no",
      ...(atomic ? ["--atomic"] : []),
      "--",
      remote.url,
      ...updates.map((update) => `${update.sha}:${update.ref}`)
    ],
    root,
    undefined,
    { credentials: true, local: remote.local === true, timeoutMs: 5 * 60_000 },
  );
  return pushed.code === 0 ? { ok: true, value: undefined } : commandFailure(pushed);
}
