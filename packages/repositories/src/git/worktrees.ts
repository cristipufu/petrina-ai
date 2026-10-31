// Linked worktree status inspection, hook scanning, HEAD/branch positioning and lifecycle facade.

import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  COMMIT_HOOKS,
  type CommitHook,
  isSpawnIntercepted,
  must,
  run,
  systemCode,
} from "./exec.js";
import {
  readFastWorktreeBranchStatus,
  tryFastMoveToClean,
  tryFastOpenOn,
  tryFastRestoreWorktreeToCommit,
  verifyCleanWorktree,
} from "./loose-index.js";
import {
  FULL_OID,
  type GitDirs,
  hasReplaceRefs,
  isSafeSimpleRefName,
  isSimpleValidBranchName,
  readLooseCommitObject,
  readLooseRawObject,
  resolveGitDirs,
  SHA,
  tryAtomicUpdateLooseRef,
} from "./loose-objects.js";

export {
  addCopy,
  ensureWorktree,
  linkedWorktrees,
  mainClone,
  removeCopies,
  removeFinishedCopies,
  removeWorktree,
} from "./worktree-lifecycle.js";

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
export async function worktreeStatus(
  path: string,
  untracked = true,
): Promise<{ head?: string; clean: boolean; trackedChanged: boolean }> {
  const fast = readFastWorktreeBranchStatus(path, untracked);
  if (fast) return { head: fast.head, clean: fast.clean, trackedChanged: fast.trackedChanged };
  const text = await must(
    ["git", "status", "--porcelain=v2", "--branch", `--untracked-files=${untracked ? "normal" : "no"}`],
    path,
  );
  const lines = text.split("\n").filter(Boolean);
  const head = lines.find((line) => line.startsWith("# branch.oid "))?.slice(13);
  const changes = lines.filter((line) => !line.startsWith("#"));
  return {
    ...(head && SHA.test(head) ? { head } : {}),
    clean: !changes.length,
    trackedChanged: changes.some((line) => !line.startsWith("? ")),
  };
}

/** One status process supplies the checked-out commit, branch and cleanliness. */
export async function worktreeBranchStatus(
  path: string,
  untracked = true,
): Promise<{ head?: string; branch?: string; clean: boolean; trackedChanged: boolean }> {
  const fast = readFastWorktreeBranchStatus(path, untracked);
  if (fast) return fast;
  const text = await must(
    ["git", "status", "--porcelain=v2", "--branch", `--untracked-files=${untracked ? "normal" : "no"}`],
    path,
  );
  const lines = text.split("\n").filter(Boolean);
  const head = lines.find((line) => line.startsWith("# branch.oid "))?.slice(13);
  const rawBranch = lines.find((line) => line.startsWith("# branch.head "))?.slice(14);
  const branch = rawBranch && rawBranch !== "(detached)" ? rawBranch : undefined;
  const changes = lines.filter((line) => !line.startsWith("#"));
  return {
    ...(head && SHA.test(head) ? { head } : {}),
    ...(branch ? { branch } : {}),
    clean: !changes.length,
    trackedChanged: changes.some((line) => !line.startsWith("? ")),
  };
}

/** Uncommitted work, one line per file. `tracked`: leave out files git does not track. */
export async function changes(path: string, tracked = false): Promise<string[]> {
  if (
    tracked
      ? readFastWorktreeBranchStatus(path, false)?.trackedChanged === false
      : Boolean(verifyCleanWorktree(path))
  ) {
    return [];
  }
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
      if (!val || val.includes('"') || val.includes("\\") || val.includes("#") || val.includes(";") || val.startsWith("~")) {
        return undefined;
      }
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
  const where = await run(
    ["git", "rev-parse", "--path-format=absolute", ...COMMIT_HOOKS.flatMap((name) => ["--git-path", `hooks/${name}`])],
    path,
    undefined,
    { ownHooks: true },
  );
  if (where.code !== 0) return [];
  return executableHookFiles(where.stdout.split("\n"));
}

/** Pinned check inputs share one query; an unreadable input cannot establish a current pass. */
export async function checkInputFiles(
  path: string,
  commit?: string,
): Promise<{ tree?: string; hooks: { name: CommitHook; path: string }[] }> {
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
  const result = await run(
    [
      "git",
      "rev-parse",
      "--path-format=absolute",
      ...COMMIT_HOOKS.flatMap((name) => ["--git-path", `hooks/${name}`]),
      ...(commit ? ["--verify", "--quiet", `${commit}^{tree}`] : []),
    ],
    path,
    undefined,
    { ownHooks: true },
  );
  const paths = result.stdout.split("\n");
  const tree = commit ? paths.pop() : undefined;
  if (
    result.code !== 0 ||
    paths.length !== COMMIT_HOOKS.length ||
    paths.some((file) => !file) ||
    (commit && (!tree || !SHA.test(tree)))
  ) {
    throw new Error("The check's repository inputs could not be read");
  }
  return { ...(tree ? { tree } : {}), hooks: await executableHookFiles(paths, true) };
}

async function executableHookFiles(
  paths: readonly string[],
  strict = false,
): Promise<{ name: CommitHook; path: string }[]> {
  const hooks = await Promise.all(
    COMMIT_HOOKS.map(async (name, index) => {
      const file = paths[index];
      if (!file) return [];
      const mode = await stat(file)
        .then((info) => (info.isFile() ? info.mode : undefined))
        .catch((error) => {
          if (strict && !["ENOENT", "ENOTDIR"].includes(systemCode(error) ?? "")) throw error;
          return undefined;
        });
      // Git requires executable hooks, except on Windows where its shell runs them.
      return mode !== undefined && (process.platform === "win32" || (mode & 0o111) !== 0) ? [{ name, path: file }] : [];
    }),
  );
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
  if (
    dirs &&
    !existsSync(join(dirs.gitdir, "index.lock")) &&
    !existsSync(join(dirs.gitdir, "HEAD.lock")) &&
    verifyCleanWorktree(path)
  ) {
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
  const marked = await Promise.all(
    paths.map(async (file) => {
      const text = await readFile(join(path, file), "utf8").catch(() => "");
      return /^(<{7}|>{7})( |$)/m.test(text) || /^={7}$/m.test(text);
    }),
  );
  return paths.filter((_, index) => marked[index]);
}

export async function resetTo(path: string, sha: string): Promise<void> {
  if (!SHA.test(sha)) throw new Error("Could not restore the product: the saved version is invalid.");
  if (FULL_OID.test(sha) && tryFastRestoreWorktreeToCommit(path, sha, false)) return;
  await must(["git", "reset", "--hard", "--quiet", sha], path);
}
