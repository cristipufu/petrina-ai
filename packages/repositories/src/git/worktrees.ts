// Linked worktree lifecycle, status inspection, hook scanning and copy cleanup.

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { CLEANUP_WORDS, completeAll } from "@petrina/core";
import { localFiles, type FileOperations } from "@petrina/platform/file-operations";
import {
  canonical,
  CLEANUP_GIT_TIMEOUT_MS,
  COMMIT_HOOKS,
  type CommitHook,
  isSpawnIntercepted,
  must,
  oneAtATime,
  Reason,
  run,
  type RunResult,
  systemCode,
  worktreeLocation,
} from "./exec.js";
import {
  collectLooseTreeFiles,
  FULL_OID,
  type GitDirs,
  hasNestedRefsPrefix,
  hasRefDirectoryConflict,
  hasReplaceRefs,
  isPlainSha1CommonDir,
  isSafeSimpleRefName,
  isSimpleValidBranchName,
  type LooseCommit,
  readLooseCommitObject,
  readLooseRawObject,
  resolveDirectRef,
  resolveGitDirs,
  resolveLooseRefCommit,
  SHA,
  tryAtomicUpdateLooseRef,
} from "./loose-objects.js";
import {
  encodePlainIndexV2,
  readFastWorktreeBranchStatus,
  readPlainWorktreeConfig,
  tryFastMoveToClean,
  tryFastOpenOn,
  tryFastRestoreWorktreeToCommit,
  verifyCleanWorktree,
} from "./loose-index.js";

function hasValidWorktreeGitDir(path: string): boolean {
  try {
    const dotGit = join(path, ".git");
    if (!existsSync(dotGit)) return false;
    const raw = readFileSync(dotGit, "utf8");
    if (!raw.startsWith("gitdir:")) return false;
    const gitdir = resolve(path, raw.slice("gitdir:".length).trim());
    return existsSync(join(gitdir, "HEAD")) && existsSync(join(gitdir, "commondir"));
  } catch {
    return false;
  }
}

function fastMaterializePlainWorktree(root: string, path: string, targetRefOrSha: string, branch?: string): boolean {
  if (isSpawnIntercepted() || process.platform === "win32" || path.startsWith("-") || existsSync(path)) {
    return false;
  }
  const dirs = resolveGitDirs(root);
  if (!dirs || dirs.gitdir !== dirs.commonDir || !isPlainSha1CommonDir(dirs.commonDir)) return false;
  if (!readPlainWorktreeConfig(dirs, false)) return false;
  const mainRoot = canonical(root);
  const targetLoc = worktreeLocation(path);
  if (resolve(path) === resolve(root) || targetLoc === mainRoot || mainRoot.startsWith(targetLoc + sep)) {
    return false;
  }
  let commit: LooseCommit | undefined;
  let createBranchRef = false;
  if (branch !== undefined) {
    if (!isSimpleValidBranchName(branch) || existsSync(join(dirs.commonDir, "packed-refs.lock"))) return false;
    const wantedHead = `ref: refs/heads/${branch}`;
    try {
      if (readFileSync(join(dirs.commonDir, "HEAD"), "utf8").trim() === wantedHead) return false;
      const existingWtDir = join(dirs.commonDir, "worktrees");
      if (existsSync(existingWtDir)) {
        for (const entryName of readdirSync(existingWtDir)) {
          const headFile = join(existingWtDir, entryName, "HEAD");
          if (existsSync(headFile) && readFileSync(headFile, "utf8").trim() === wantedHead) return false;
        }
      }
    } catch {
      return false;
    }
    const branchRef = `refs/heads/${branch}`;
    const existing = resolveDirectRef(dirs, branchRef);
    if (existing.kind === "oid") {
      commit = readLooseCommitObject(dirs.commonDir, existing.oid);
    } else if (existing.kind === "missing") {
      if (!targetRefOrSha || targetRefOrSha.startsWith("-") || hasNestedRefsPrefix(dirs.commonDir, branchRef) || hasRefDirectoryConflict(dirs.commonDir, branchRef)) {
        return false;
      }
      commit = resolveLooseRefCommit(dirs, targetRefOrSha);
      createBranchRef = true;
    } else {
      return false;
    }
  } else {
    if (!targetRefOrSha || targetRefOrSha.startsWith("-")) return false;
    commit = resolveLooseRefCommit(dirs, targetRefOrSha);
  }
  if (!commit || commit.oid.length !== 40) return false;
  const treeFiles = new Map<string, { mode: "100644" | "100755"; oidHex: string }>();
  if (!collectLooseTreeFiles(dirs.commonDir, commit.tree, "sha1", treeFiles)) return false;
  const blobs = new Map<string, Buffer>();
  for (const entry of treeFiles.values()) {
    if (!blobs.has(entry.oidHex)) {
      const raw = readLooseRawObject(dirs.commonDir, entry.oidHex);
      if (!raw || raw.type !== "blob") return false;
      blobs.set(entry.oidHex, raw.body);
    }
  }
  const worktreesDir = join(dirs.commonDir, "worktrees");
  let adminName: string | undefined;
  try {
    mkdirSync(worktreesDir, { recursive: true });
    const rawBase = basename(resolve(path)).replace(/[^A-Za-z0-9._-]/g, "-") || "worktree";
    const safeBase = rawBase === "." || rawBase === ".." ? "worktree" : rawBase;
    const takenLower = new Set(readdirSync(worktreesDir).map((n) => n.toLowerCase()));
    for (let suffix = 0; suffix <= 128; suffix += 1) {
      const candidate = suffix === 0 ? safeBase : `${safeBase}${suffix}`;
      if (!takenLower.has(candidate.toLowerCase()) && !existsSync(join(worktreesDir, candidate))) {
        adminName = candidate;
        break;
      }
    }
  } catch {
    return false;
  }
  if (!adminName) return false;
  const wtGitDir = join(worktreesDir, adminName);
  let createdBranch = false;
  let createdWtGitDir = false;
  let createdPath = false;
  try {
    if (createBranchRef) {
      if (!tryAtomicUpdateLooseRef(dirs, `refs/heads/${branch!}`, { kind: "missing" }, commit.oid)) return false;
      createdBranch = true;
    }
    mkdirSync(wtGitDir);
    createdWtGitDir = true;
    mkdirSync(path, { recursive: true });
    createdPath = true;
    const canonicalPath = canonical(path);
    writeFileSync(join(wtGitDir, "commondir"), "../..\n", "utf8");
    writeFileSync(join(wtGitDir, "gitdir"), `${join(canonicalPath, ".git")}\n`, "utf8");
    writeFileSync(join(wtGitDir, "HEAD"), branch !== undefined ? `ref: refs/heads/${branch}\n` : `${commit.oid}\n`, "utf8");
    for (const [relPath, entry] of treeFiles) {
      const fullFile = join(canonicalPath, relPath);
      mkdirSync(dirname(fullFile), { recursive: true });
      writeFileSync(fullFile, blobs.get(entry.oidHex)!, { mode: entry.mode === "100755" ? 0o755 : 0o644 });
    }
    const indexBytes = encodePlainIndexV2(canonicalPath, treeFiles);
    if (!indexBytes) throw new Error("index encode failed");
    writeFileSync(join(wtGitDir, "index"), indexBytes);
    writeFileSync(join(canonicalPath, ".git"), `gitdir: ${wtGitDir}\n`, "utf8");
    return true;
  } catch {
    if (createdPath) {
      try { rmSync(path, { recursive: true, force: true }); } catch { /* Best effort. */ }
    }
    if (createdWtGitDir) {
      try { rmSync(wtGitDir, { recursive: true, force: true }); } catch { /* Best effort. */ }
    }
    if (createdBranch) {
      try { rmSync(join(dirs.commonDir, "refs", "heads", ...branch!.split("/")), { force: true }); } catch { /* Best effort. */ }
    }
    return false;
  }
}

/** Create (or reuse) the task's worktree on its own branch, starting from `base`. */
export async function ensureWorktree(root: string, path: string, branch: string, base: string): Promise<void> {
  if (existsSync(path) && (hasValidWorktreeGitDir(path) || (await run(["git", "rev-parse", "--is-inside-work-tree"], path)).code === 0)) return;
  await mkdir(dirname(path), { recursive: true });
  await oneAtATime(root, async () => {
    if (fastMaterializePlainWorktree(root, path, base, branch)) return;
    if (existsSync(join(root, ".git", "refs", "heads", branch))) {
      await must(["git", "worktree", "add", path, branch], root);
      return;
    }
    const created = await run(["git", "worktree", "add", "-b", branch, path, base], root);
    if (created.code === 0) return;
    if ((await run(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], root)).code === 0) {
      await must(["git", "worktree", "add", path, branch], root);
      return;
    }
    throw new Error(`git worktree add failed: ${created.stderr || created.stdout}`);
  });
}

export async function isClean(path: string): Promise<boolean> {
  const fast = readFastWorktreeBranchStatus(path, true);
  if (fast) return fast.clean;
  return (await run(["git", "status", "--porcelain"], path)).stdout === "";
}

export function readFastTrackedWorktreeHead(path: string): { head: string; clean: boolean } | undefined {
  if (isSpawnIntercepted() || "mock" in run) return undefined;
  const fast = readFastWorktreeBranchStatus(path, false);
  return fast ? { head: fast.head, clean: fast.clean } : undefined;
}

/** One status process supplies both the checked-out commit and tracked/untracked cleanliness. */
export async function worktreeStatus(path: string, untracked = true): Promise<{ head?: string; clean: boolean; trackedChanged: boolean }> {
  const fast = readFastWorktreeBranchStatus(path, untracked);
  if (fast) return { head: fast.head, clean: fast.clean, trackedChanged: fast.trackedChanged };
  const text = await must(["git", "status", "--porcelain=v2", "--branch", `--untracked-files=${untracked ? "normal" : "no"}`], path);
  const lines = text.split("\n").filter(Boolean);
  const head = lines.find((line) => line.startsWith("# branch.oid "))?.slice(13);
  const changes = lines.filter((line) => !line.startsWith("#"));
  return { ...(head && SHA.test(head) ? { head } : {}), clean: !changes.length, trackedChanged: changes.some((line) => !line.startsWith("? ")) };
}

/** One status process supplies the checked-out commit, branch and cleanliness. */
export async function worktreeBranchStatus(path: string, untracked = true): Promise<{ head?: string; branch?: string; clean: boolean; trackedChanged: boolean }> {
  const fast = readFastWorktreeBranchStatus(path, untracked);
  if (fast) return fast;
  const text = await must(["git", "status", "--porcelain=v2", "--branch", `--untracked-files=${untracked ? "normal" : "no"}`], path);
  const lines = text.split("\n").filter(Boolean);
  const head = lines.find((line) => line.startsWith("# branch.oid "))?.slice(13);
  const rawBranch = lines.find((line) => line.startsWith("# branch.head "))?.slice(14);
  const branch = rawBranch && rawBranch !== "(detached)" ? rawBranch : undefined;
  const changes = lines.filter((line) => !line.startsWith("#"));
  return { ...(head && SHA.test(head) ? { head } : {}), ...(branch ? { branch } : {}), clean: !changes.length, trackedChanged: changes.some((line) => !line.startsWith("? ")) };
}

/** Uncommitted work, one line per file. `tracked`: leave out files git does not track. */
export async function changes(path: string, tracked = false): Promise<string[]> {
  if (tracked ? readFastWorktreeBranchStatus(path, false)?.trackedChanged === false : Boolean(verifyCleanWorktree(path))) return [];
  const result = await run(["git", "status", "--porcelain", ...(tracked ? ["--untracked-files=no"] : [])], path);
  if (result.code !== 0) return ["unreadable working copy"];
  return result.stdout.split("\n").filter(Boolean);
}

export async function mergeInProgress(path: string): Promise<boolean> {
  if (!isSpawnIntercepted()) {
    const dirs = resolveGitDirs(path);
    if (dirs && !existsSync(join(dirs.gitdir, "MERGE_HEAD"))) return false;
  }
  return (await run(["git", "rev-parse", "--verify", "--quiet", "MERGE_HEAD"], path)).code === 0;
}

/** The hooks git runs when committing, as the repository has them (core.hooksPath honoured): the ones that exist and git would run. */
export async function commitHooks(path: string): Promise<CommitHook[]> {
  return (await commitHookFiles(path)).map((hook) => hook.name);
}

function resolveFastHooksDir(dirs: GitDirs): string | undefined {
  if (isSpawnIntercepted()) return undefined;
  if (process.env.GIT_CONFIG_PARAMETERS || process.env.GIT_CONFIG_COUNT || process.env.GIT_CONFIG) {
    return undefined;
  }
  const noSystem = process.env.GIT_CONFIG_NOSYSTEM === "1";
  const sysPath = process.env.GIT_CONFIG_SYSTEM;
  if (!noSystem && !sysPath) return undefined;
  const globalPath = process.env.GIT_CONFIG_GLOBAL;
  if (!globalPath) return undefined;
  try {
    if (!noSystem && sysPath && existsSync(sysPath)) {
      const sysLower = readFileSync(sysPath, "utf8").toLowerCase();
      if (sysLower.includes("hookspath") || sysLower.includes("[include")) return undefined;
    }
    const globalLower = existsSync(globalPath) ? readFileSync(globalPath, "utf8").toLowerCase() : "";
    if (globalLower.includes("hookspath") || globalLower.includes("[include")) return undefined;
    const localText = readFileSync(join(dirs.commonDir, "config"), "utf8");
    const localLower = localText.toLowerCase();
    if (localLower.includes("[include") || localLower.includes("worktreeconfig")) return undefined;
    if (!localLower.includes("hookspath")) {
      return join(dirs.commonDir, "hooks");
    }
    if (localLower.includes("[core.")) return undefined;
    let section = "";
    const hookPaths: string[] = [];
    for (const rawLine of localText.split(/\r?\n/)) {
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
      if (trimmed.startsWith("[")) {
        if (!trimmed.endsWith("]") || trimmed.includes("#") || trimmed.includes(";")) return undefined;
        section = trimmed.slice(1, -1).trim().toLowerCase();
        continue;
      }
      if (section !== "core") continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) return undefined;
      const key = trimmed.slice(0, eq).trim().toLowerCase();
      if (key !== "hookspath") continue;
      const val = trimmed.slice(eq + 1).trim();
      if (!val || val.includes('"') || val.includes("\\") || val.includes("#") || val.includes(";") || val.startsWith("~")) return undefined;
      hookPaths.push(val);
    }
    if (hookPaths.length === 1 && isAbsolute(hookPaths[0]!)) {
      return hookPaths[0]!;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** The executable hook files, including local hooks outside the committed tree. */
export async function commitHookFiles(path: string): Promise<{ name: CommitHook; path: string }[]> {
  const dirs = resolveGitDirs(resolve(path));
  const fastHooksDir = dirs ? resolveFastHooksDir(dirs) : undefined;
  if (fastHooksDir) {
    return executableHookFiles(COMMIT_HOOKS.map((name) => join(fastHooksDir, name)));
  }
  const where = await run(["git", "rev-parse", "--path-format=absolute", ...COMMIT_HOOKS.flatMap((name) => ["--git-path", `hooks/${name}`])], path, undefined, { ownHooks: true });
  if (where.code !== 0) return [];
  return executableHookFiles(where.stdout.split("\n"));
}

/** Pinned check inputs share one query; an unreadable input cannot establish a current pass. */
export async function checkInputFiles(path: string, commit?: string): Promise<{ tree?: string; hooks: { name: CommitHook; path: string }[] }> {
  if (commit !== undefined && !SHA.test(commit)) throw new Error("Not a commit");
  const dirs = resolveGitDirs(resolve(path));
  const fastHooksDir = dirs ? resolveFastHooksDir(dirs) : undefined;
  if (dirs && fastHooksDir && !hasReplaceRefs(dirs.commonDir)) {
    if (commit === undefined) {
      return { hooks: await executableHookFiles(COMMIT_HOOKS.map((name) => join(fastHooksDir, name)), true) };
    }
    if (FULL_OID.test(commit)) {
      const commitObj = readLooseCommitObject(dirs.commonDir, commit);
      if (commitObj && readLooseRawObject(dirs.commonDir, commitObj.tree)?.type === "tree") {
        return {
          tree: commitObj.tree,
          hooks: await executableHookFiles(COMMIT_HOOKS.map((name) => join(fastHooksDir, name)), true),
        };
      }
    }
  }
  const result = await run(["git", "rev-parse", "--path-format=absolute", ...COMMIT_HOOKS.flatMap((name) => ["--git-path", `hooks/${name}`]), ...(commit ? ["--verify", "--quiet", `${commit}^{tree}`] : [])], path, undefined, { ownHooks: true });
  const paths = result.stdout.split("\n");
  const tree = commit ? paths.pop() : undefined;
  if (result.code !== 0 || paths.length !== COMMIT_HOOKS.length || paths.some(file => !file) || (commit && (!tree || !SHA.test(tree)))) {
    throw new Error("The check's repository inputs could not be read");
  }
  return { ...(tree ? { tree } : {}), hooks: await executableHookFiles(paths, true) };
}

async function executableHookFiles(paths: readonly string[], strict = false): Promise<{ name: CommitHook; path: string }[]> {
  const hooks = await Promise.all(COMMIT_HOOKS.map(async (name, index) => {
    const file = paths[index];
    if (!file) return [];
    const mode = await stat(file).then(info => info.isFile() ? info.mode : undefined).catch(error => {
      if (strict && !["ENOENT", "ENOTDIR"].includes(systemCode(error) ?? "")) throw error;
      return undefined;
    });
    // Git requires executable hooks, except on Windows where its shell runs them.
    return mode !== undefined && (process.platform === "win32" || (mode & 0o111) !== 0) ? [{ name, path: file }] : [];
  }));
  return hooks.flat();
}

function tryFastDetachAt(path: string, base: string): boolean {
  if (isSpawnIntercepted() || !FULL_OID.test(base)) return false;
  const dirs = resolveGitDirs(path);
  if (!dirs || hasReplaceRefs(dirs.commonDir)) return false;
  const lowerBase = base.toLowerCase();
  if (!readLooseCommitObject(dirs.commonDir, lowerBase)) return false;
  return tryAtomicUpdateLooseRef(dirs, "HEAD", undefined, lowerBase);
}

function tryFastSymbolicHead(path: string, branch: string): boolean {
  if (isSpawnIntercepted() || !isSimpleValidBranchName(branch)) return false;
  const ref = `refs/heads/${branch}`;
  if (!isSafeSimpleRefName(ref)) return false;
  const dirs = resolveGitDirs(path);
  if (!dirs) return false;
  const targetPath = join(dirs.gitdir, "HEAD");
  const lockPath = `${targetPath}.lock`;
  let fd: number | undefined;
  let createdLock = false;
  let renamed = false;
  try {
    fd = openSync(lockPath, "wx");
    createdLock = true;
    writeFileSync(fd, `ref: ${ref}\n`, "utf8");
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

/**
 * Where a hook sees the task's whole change as about to be committed: the working copy's HEAD detached at
 * `base`, with its files and index left as they are. `reattach` puts it back on its branch.
 */
export async function detachAt(path: string, base: string): Promise<void> {
  if (!SHA.test(base)) throw new Error("Not a commit");
  if (tryFastDetachAt(path, base)) return;
  await must(["git", "update-ref", "--no-deref", "HEAD", base], path);
}

/** The working copy back on its branch, with whatever a hook changed in files git tracks undone. */
export async function reattach(path: string, branch: string): Promise<void> {
  if (!tryFastSymbolicHead(path, branch)) {
    await must(["git", "symbolic-ref", "HEAD", `refs/heads/${branch}`], path);
  }
  if (tryFastRestoreWorktreeToCommit(path, undefined, false)) return;
  const dirs = resolveGitDirs(path);
  if (dirs && !existsSync(join(dirs.gitdir, "index.lock")) && !existsSync(join(dirs.gitdir, "HEAD.lock")) && verifyCleanWorktree(path)) {
    return;
  }
  await run(["git", "reset", "--hard", "--quiet"], path);
}

/** Whether files git tracks changed in the working copy (new files aside). */
export async function trackedChanged(path: string): Promise<boolean> {
  const fast = readFastWorktreeBranchStatus(path, false);
  if (fast) return fast.trackedChanged;
  return (await run(["git", "status", "--porcelain", "--untracked-files=no"], path)).stdout !== "";
}

/** Put the files git tracks back as committed, leaving new files alone. */
export async function restoreTracked(path: string): Promise<void> {
  if (tryFastRestoreWorktreeToCommit(path, undefined, false)) return;
  await run(["git", "reset", "--hard", "--quiet"], path);
}

/** Move the working copy's branch to `sha`. It refuses, changing nothing, rather than lose a change in the way. */
export async function moveTo(path: string, sha: string): Promise<void> {
  if (!SHA.test(sha)) throw new Error("Not a commit");
  if (tryFastMoveToClean(path, sha)) return;
  const first = await run(["git", "reset", "--keep", "--quiet", sha], path);
  if (first.code === 0) return;
  if (first.stderr.includes("not uptodate") && verifyCleanWorktree(path)) {
    await run(["git", "update-index", "-q", "--refresh"], path);
    await must(["git", "reset", "--keep", "--quiet", sha], path);
    return;
  }
  throw new Error(`git reset --keep failed: ${first.stderr || first.stdout}`);
}

/**
 * The branch on `onto`, with the working copy and index holding `tree` (a merge's result, conflict markers
 * and all) as changes not committed yet: what an agent resolves and Petrina then commits.
 */
export async function openOn(path: string, onto: string, tree: string): Promise<void> {
  if (!SHA.test(onto) || !SHA.test(tree)) throw new Error("Not a commit or tree");
  if (tryFastOpenOn(path, onto, tree)) return;
  await must(["git", "reset", "--soft", "--quiet", onto], path);
  await must(["git", "read-tree", "-u", "--reset", tree], path);
}

/** Files that still hold git's conflict markers, out of `paths`. */
export async function withMarkers(path: string, paths: readonly string[]): Promise<string[]> {
  const marked = await Promise.all(paths.map(async file => {
    const text = await readFile(join(path, file), "utf8").catch(() => "");
    return /^(<{7}|>{7})( |$)/m.test(text) || /^={7}$/m.test(text);
  }));
  return paths.filter((_, index) => marked[index]);
}

export async function resetTo(path: string, sha: string): Promise<void> {
  if (!SHA.test(sha)) throw new Error("Could not restore the product: the saved version is invalid.");
  if (FULL_OID.test(sha) && tryFastRestoreWorktreeToCommit(path, sha, false)) return;
  await must(["git", "reset", "--hard", "--quiet", sha], path);
}

function readLinkedWorktreesSync(root: string): string[] | undefined {
  if (isSpawnIntercepted()) return undefined;
  const dirs = resolveGitDirs(root);
  if (!dirs || !existsSync(join(dirs.commonDir, "config")) || !existsSync(join(dirs.commonDir, "objects"))) {
    return undefined;
  }
  const worktreesDir = join(dirs.commonDir, "worktrees");
  if (!existsSync(worktreesDir)) return [];
  let names: string[];
  try {
    names = readdirSync(worktreesDir);
  } catch {
    return undefined;
  }
  const out: string[] = [];
  for (const name of names) {
    if (!name || name.startsWith(".")) continue;
    const entryDir = join(worktreesDir, name);
    try {
      if (!statSync(entryDir).isDirectory()) continue;
      if (!statSync(join(entryDir, "HEAD")).isFile() || !statSync(join(entryDir, "gitdir")).isFile()) return undefined;
      const rawTarget = readFileSync(join(entryDir, "gitdir"), "utf8").replace(/\r?\n$/, "");
      if (!rawTarget) return undefined;
      const dotGitTarget = resolve(entryDir, rawTarget);
      if (basename(dotGitTarget) !== ".git") return undefined;
      out.push(dirname(dotGitTarget));
    } catch {
      return undefined;
    }
  }
  return out;
}

/** The working copies the repository keeps a record of, other than its main clone, as git lists them. */
export async function linkedWorktrees(root: string): Promise<string[]> {
  const fast = readLinkedWorktreesSync(root);
  if (fast) return fast;
  const listed = await run(["git", "worktree", "list", "--porcelain", "-z"], root, undefined, { timeoutMs: CLEANUP_GIT_TIMEOUT_MS });
  if (listed.code !== 0) throw new Reason("the product's repository could not be read");
  const paths = listed.stdout.split("\0").filter((field) => field.startsWith("worktree ")).map((field) => field.slice("worktree ".length));
  return paths.slice(1);
}

/** The main clone a working copy belongs to, read from the copy itself (for a product no longer in Petrina). */
export async function mainClone(path: string): Promise<string | undefined> {
  if (!existsSync(path)) return undefined;
  if (!isSpawnIntercepted()) {
    const dirs = resolveGitDirs(path);
    if (dirs && basename(dirs.commonDir) === ".git" && existsSync(join(dirs.commonDir, "config"))) {
      return canonical(dirname(dirs.commonDir));
    }
  }
  const common = await run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], path);
  return common.code === 0 && common.stdout ? dirname(common.stdout) : undefined;
}

/**
 * Remove a task's working copy: the folder with everything in it (ignored packages and build output
 * too), then the repository's record of it. Branches stay. Petrina deletes the folder itself, which
 * never follows a link out of it, so shared caches and the files they link to stay. Safe to run again
 * after a failure or an interruption. Throws a plain-language reason; returns false when nothing was left.
 */
export function removeWorktree(root: string, path: string, files: Pick<FileOperations, "removeTree"> = localFiles): Promise<boolean> {
  return removeKnownWorktree(root, path, undefined, files);
}

function tryFastDropWorktreeRecord(root: string, targetLocation: string): RunResult | undefined {
  if (isSpawnIntercepted()) return undefined;
  const dirs = resolveGitDirs(root);
  if (!dirs || dirs.gitdir !== dirs.commonDir) return undefined;
  const worktreesDir = join(dirs.commonDir, "worktrees");
  if (!existsSync(worktreesDir)) return undefined;
  let matched = 0;
  try {
    for (const name of readdirSync(worktreesDir)) {
      if (!name || name.startsWith(".")) continue;
      const entryDir = join(worktreesDir, name);
      if (!statSync(entryDir).isDirectory()) continue;
      const rawTarget = readFileSync(join(entryDir, "gitdir"), "utf8").replace(/\r?\n$/, "");
      if (!rawTarget) return undefined;
      const dotGitTarget = resolve(entryDir, rawTarget);
      if (basename(dotGitTarget) !== ".git") return undefined;
      if (worktreeLocation(dirname(dotGitTarget)) === targetLocation) {
        if (existsSync(dirname(dotGitTarget))) return undefined;
        rmSync(entryDir, { recursive: true, force: true });
        matched += 1;
      }
    }
  } catch {
    return undefined;
  }
  return matched > 0 ? { code: 0, stdout: "", stderr: "" } : undefined;
}

/** Batch cleanup shares one registration observation, then verifies the complete batch. */
async function removeKnownWorktree(root: string, path: string, known?: readonly string[], files: Pick<FileOperations, "removeTree"> = localFiles): Promise<boolean> {
  try {
    if (!existsSync(root)) {
      const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
      if (!entry) return false;
      throw new Reason("the product's folder could not be found");
    }
    const target = worktreeLocation(path);
    const main = canonical(root);
    if (resolve(path) === resolve(root) || target === main || main.startsWith(target + sep)) throw new Reason("that folder holds the product itself");
    const recorded = async () => (known ?? await linkedWorktrees(root)).find((entry) => worktreeLocation(entry) === target);
    const record = await recorded();
    const there = () =>
      lstat(path).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      );
    const folder = await there();
    if (!folder && !record) return false;
    if (folder) await files.removeTree(path);
    if (await there()) throw new Reason("its folder could not be deleted");
    // With the folder gone, git only drops its record. Forced twice: also when the copy was locked.
    const removed = record ? await oneAtATime(root, async () => tryFastDropWorktreeRecord(root, target) ?? run(["git", "worktree", "remove", "--force", "--force", record], root, undefined, { timeoutMs: CLEANUP_GIT_TIMEOUT_MS })) : undefined;
    if (record && !known && removed?.code !== 0 && await recorded()) throw new Reason("the repository still lists it as a working copy");
    if (record && await there()) throw new Reason("its folder could not be deleted");
    return folder || record !== undefined;
  } catch (error) {
    if (error instanceof Reason) throw error;
    const code = (error as NodeJS.ErrnoException).code ?? "";
    throw new Reason(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"].includes(code) ? CLEANUP_WORDS.locked : "its folder could not be deleted");
  }
}

/**
 * A working copy of one commit for one agent alone (a reviewer working beside others): detached, so it
 * shares no branch, index or HEAD with the task's own copy. Nothing is installed in it.
 */
export async function addCopy(root: string, path: string, sha: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await oneAtATime(root, async () => {
    if (fastMaterializePlainWorktree(root, path, sha)) return;
    await must(["git", "worktree", "add", "--detach", "--quiet", path, sha], root);
  });
}

/** A finished task has no reviewer left to resume. Recover both folders and records left by a crash. */
export async function removeFinishedCopies(root: string, folder: string, files: Pick<FileOperations, "removeTree"> = localFiles): Promise<boolean> {
  const entry = await lstat(folder).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!existsSync(root)) {
    if (!entry) return false;
    throw new Reason("the product's folder could not be found");
  }
  // Unlink a replacement before inspecting children; never follow it into somebody else's copy.
  if (entry && !entry.isDirectory()) await files.removeTree(folder);
  const names = entry?.isDirectory() ? await readdir(folder) : [];
  const location = worktreeLocation(folder);
  const recorded = (await linkedWorktrees(root)).filter((copy) => worktreeLocation(dirname(copy)) === location);
  const copies = [...new Set([...names.map((name) => join(folder, name)), ...recorded])];
  await completeAll(copies.map(copy => removeKnownWorktree(root, copy, recorded, files)));
  if (recorded.length && (await linkedWorktrees(root)).some(copy => worktreeLocation(dirname(copy)) === location)) throw new Reason("the repository still lists it as a working copy");
  await files.removeTree(folder);
  return entry !== undefined || recorded.length > 0;
}

function hasNoStaleWorktreeRegistrations(root: string): boolean {
  try {
    const dotGit = join(root, ".git");
    if (!statSync(dotGit).isDirectory()) return false;
    const worktreesDir = join(dotGit, "worktrees");
    if (!existsSync(worktreesDir)) return true;
    for (const name of readdirSync(worktreesDir)) {
      const entryDir = join(worktreesDir, name);
      const target = resolve(entryDir, readFileSync(join(entryDir, "gitdir"), "utf8").trim());
      if (!existsSync(target)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function tryFastPruneStaleWorktrees(root: string): boolean {
  if (isSpawnIntercepted()) return false;
  try {
    const dotGit = join(root, ".git");
    if (!statSync(dotGit).isDirectory()) return false;
    const worktreesDir = join(dotGit, "worktrees");
    if (!existsSync(worktreesDir)) return true;
    for (const name of readdirSync(worktreesDir)) {
      if (!name || name.startsWith(".")) continue;
      const entryDir = join(worktreesDir, name);
      if (!statSync(entryDir).isDirectory()) return false;
      const rawTarget = readFileSync(join(entryDir, "gitdir"), "utf8").trim();
      if (!rawTarget) return false;
      const target = resolve(entryDir, rawTarget);
      if (!existsSync(target) && !existsSync(join(entryDir, "locked"))) {
        rmSync(entryDir, { recursive: true, force: true });
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Remove copies and git's records, keeping only conversations that are waiting for the screen. */
export async function removeCopies(root: string, folder: string, keep: readonly string[] = []): Promise<void> {
  const kept = new Set(keep);
  await oneAtATime(root, async () => {
    const entry = await lstat(folder).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    // A replaced parent is unlinked, never traversed into another task's working copies.
    if (entry && !entry.isDirectory()) await rm(folder, { force: true });
    else if (!kept.size) await rm(folder, { recursive: true, force: true });
    else if (entry) {
      const names = await readdir(folder);
      await completeAll(names.map((name) => join(folder, name)).filter((copy) => !kept.has(copy))
        .map((copy) => rm(copy, { recursive: true, force: true })));
    }
    if (tryFastPruneStaleWorktrees(root)) return;
    if (!("mock" in run) && hasNoStaleWorktreeRegistrations(root)) return;
    // These copies are detached: one prune drops all missing unlocked registrations.
    const pruned = await run(["git", "worktree", "prune"], root, undefined, { timeoutMs: CLEANUP_GIT_TIMEOUT_MS });
    if (pruned.code !== 0) throw new Reason(`the repository's review-copy records could not be cleaned: ${pruned.stderr || pruned.stdout || `exit ${pruned.code}`}`);
  });
}
