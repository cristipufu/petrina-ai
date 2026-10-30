// Commit, tree, branch and file queries against local repository history.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseObjectBatch } from "../object-format.js";
import { canonical, isSpawnIntercepted, must, run } from "./exec.js";
import {
  canWalkRawLooseHistory,
  FROM_COMMITS,
  FULL_OID,
  hasNestedRefsPrefix,
  hasReplaceRefs,
  isDefinitelyAbsentLooseOid,
  isSafeSimpleRefName,
  looseAncestorSet,
  readLooseCommitObject,
  readLooseFileAt,
  readLoosePlainRootFile,
  readLooseVersionsBetween,
  resolveDirectRef,
  resolveGitDirs,
  resolveLooseRefCommit,
  resolveLooseTreeOid,
  SHA,
} from "./loose-objects.js";

/** A file as committed at `ref`, read straight from git's objects: no filters, no links followed. Undefined when absent. */
export async function fileAt(root: string, ref: string, path: string, timeoutMs = 30_000): Promise<string | undefined> {
  if (ref.startsWith("-") || path.startsWith("-")) return undefined;
  const fast = readLooseFileAt(root, ref, path);
  if (fast) return fast.found ? fast.text : undefined;
  const result = await run(["git", "cat-file", "blob", `${ref}:${path}`], root, undefined, { timeoutMs, rawOutput: true });
  if (result.timedOut) throw new Error("Git did not finish reading the repository's saved files");
  if (result.startFailure) throw new Error(`Git could not read the repository's saved files: ${result.startFailure.message}`, { cause: result.startFailure });
  if (result.code === 127) throw new Error("Git could not read the repository's saved files");
  return result.code === 0 ? result.stdout : undefined;
}

/** The message at a captured commit, or the working copy's current HEAD. */
export async function message(path: string, ref = "HEAD"): Promise<string> {
  if (!isSpawnIntercepted() && !ref.startsWith("-")) {
    const dirs = resolveGitDirs(path);
    if (dirs && !hasReplaceRefs(dirs.commonDir)) {
      const commit = resolveLooseRefCommit(dirs, ref);
      if (commit) return commit.body.trim();
    }
  }
  return (await run(["git", "log", "-1", "--format=%B", ref], path)).stdout;
}

/** The tree a commit holds: the same code, whichever commit carries it. */
export async function treeOf(path: string, ref = "HEAD"): Promise<string | undefined> {
  if (!isSpawnIntercepted() && !ref.startsWith("-")) {
    const dirs = resolveGitDirs(path);
    if (dirs) {
      const tree = resolveLooseTreeOid(dirs, ref);
      if (tree && existsSync(join(dirs.commonDir, "objects", tree.slice(0, 2), tree.slice(2)))) return tree;
    }
  }
  const result = await run(["git", "rev-parse", "--verify", "--quiet", `${ref}^{tree}`], path);
  return result.code === 0 && SHA.test(result.stdout) ? result.stdout : undefined;
}

/** A file at the root of `ref`'s tree, with its mode, when it is a plain file there (not a link, folder or submodule). */
export async function plainFileAt(path: string, ref: string, name: string): Promise<{ mode: string; text: string } | undefined> {
  if (ref.startsWith("-") || name.startsWith("-") || name.includes("/")) return undefined;
  const fast = readLoosePlainRootFile(path, ref, name);
  if (fast) return fast.value;
  const listed = await run(["git", "ls-tree", "-z", ref, "--", name], path, undefined, { rawOutput: true });
  const entry = /^(100644|100755) blob [0-9a-f]+\t([^\0]*)\0$/.exec(listed.stdout);
  if (listed.code !== 0 || !entry || entry[2] !== name) return undefined;
  const text = await fileAt(path, ref, name);
  return text === undefined ? undefined : { mode: entry[1]!, text };
}

/**
 * Every version of the root file `name` in the commits `to` has and `from` has not, merged branches included, with
 * the versions they changed it from. Each commit is compared with every parent, from the trees and the commits
 * themselves, so a version whose saved copy is unavailable fails the read rather than passing for a commit without
 * the file. A shallow copy may lack some of those commits, so it fails too.
 */
export async function versionsBetween(path: string, from: string, to: string, name: string): Promise<string[]> {
  if (!SHA.test(from) || !SHA.test(to) || name.startsWith("-") || name.includes("/")) throw new Error("Not a commit or a root file");
  const fast = readLooseVersionsBetween(path, from, to, name);
  if (fast === "shallow") throw new Error("Part of the history is not in this copy");
  if (fast) return fast;
  if ((await must(["git", "rev-parse", "--is-shallow-repository"], path)) !== "false") throw new Error("Part of the history is not in this copy");
  const commits = await must(["git", ...FROM_COMMITS, "rev-list", `${from}..${to}`], path);
  if (!commits) return [];
  const changes = await must(["git", ...FROM_COMMITS, "diff-tree", "--stdin", "-m", "--root", "--no-renames", "--raw", "--", name], path, `${commits}\n`);
  const blobs = [...new Set(changes.split("\n").flatMap((line) => /^:\d{6} \d{6} ([0-9a-f]+) ([0-9a-f]+) /.exec(line)?.slice(1) ?? []).filter((oid) => !/^0+$/.test(oid)))];
  if (!blobs.length) return [];
  const read = await run(["git", "cat-file", "--batch"], path, `${blobs.join("\n")}\n`, { binaryOutput: true });
  if (read.code !== 0 || !read.stdoutBytes) throw new Error(`git cat-file failed: ${read.stderr || "no complete answer"}`);
  const parsed = parseObjectBatch(read.stdoutBytes, blobs);
  return parsed.map((object) => {
    if (object?.type !== "blob") throw new Error("git cat-file failed: missing blob");
    return object.body.toString("utf8");
  });
}

export async function head(path: string): Promise<string> {
  const dirs = !isSpawnIntercepted() ? resolveGitDirs(path) : undefined;
  if (dirs) {
    const resolved = resolveDirectRef(dirs, "HEAD");
    if (resolved.kind === "oid") {
      const commit = readLooseCommitObject(dirs.commonDir, resolved.oid);
      if (commit) return commit.oid;
    }
  }
  return must(["git", "rev-parse", "HEAD"], path);
}

/** The branch a working copy has open, or undefined when it has none (a detached copy). */
export async function currentBranch(path: string): Promise<string | undefined> {
  const dirs = !isSpawnIntercepted() ? resolveGitDirs(path) : undefined;
  if (dirs) {
    try {
      const text = readFileSync(join(dirs.gitdir, "HEAD"), "utf8").trim();
      if (text !== "ref: refs/heads/.invalid") {
        if (text.startsWith("ref: refs/heads/")) {
          const branch = text.slice("ref: refs/heads/".length);
          if (branch && isSafeSimpleRefName(branch)) return branch;
        } else if (FULL_OID.test(text)) {
          return undefined;
        }
      }
    } catch { /* Fall back to Git CLI. */ }
  }
  const result = await run(["git", "symbolic-ref", "--quiet", "--short", "HEAD"], path);
  return result.code === 0 && result.stdout ? result.stdout : undefined;
}

/** The commit a ref or sha names, or undefined when there is none. */
export async function revParse(path: string, ref: string): Promise<string | undefined> {
  if (ref.startsWith("-")) return undefined;
  const dirs = !isSpawnIntercepted() ? resolveGitDirs(path) : undefined;
  if (dirs) {
    if (ref === "HEAD") {
      const resolved = resolveDirectRef(dirs, "HEAD");
      if (resolved.kind === "missing") return undefined;
      if (resolved.kind === "oid") {
        const commit = readLooseCommitObject(dirs.commonDir, resolved.oid);
        if (commit) return commit.oid;
      }
    } else if (FULL_OID.test(ref)) {
      const commit = readLooseCommitObject(dirs.commonDir, ref);
      if (commit) return commit.oid;
    } else if (ref.endsWith("^") && FULL_OID.test(ref.slice(0, -1)) && canWalkRawLooseHistory(dirs.commonDir, false)) {
      const commit = readLooseCommitObject(dirs.commonDir, ref.slice(0, -1));
      if (commit && commit.parents.length === 0 && !isSpawnIntercepted() && !hasReplaceRefs(dirs.commonDir)) return undefined;
      const parentOid = commit?.parents[0];
      if (parentOid && readLooseCommitObject(dirs.commonDir, parentOid)) return parentOid;
    } else if (ref.startsWith("refs/") && isSafeSimpleRefName(ref)) {
      const resolved = resolveDirectRef(dirs, ref);
      if (resolved.kind === "missing" && !hasNestedRefsPrefix(dirs.commonDir, ref)) return undefined;
      if (resolved.kind === "oid") {
        const commit = readLooseCommitObject(dirs.commonDir, resolved.oid);
        if (commit) return commit.oid;
      }
    } else if (ref.startsWith("origin/") && isSafeSimpleRefName(ref)) {
      if (
        !existsSync(join(dirs.gitdir, ...ref.split("/"))) &&
        !existsSync(join(dirs.commonDir, ...ref.split("/"))) &&
        resolveDirectRef(dirs, `refs/${ref}`).kind === "missing" &&
        resolveDirectRef(dirs, `refs/tags/${ref}`).kind === "missing" &&
        resolveDirectRef(dirs, `refs/heads/${ref}`).kind === "missing"
      ) {
        const remoteResolved = resolveDirectRef(dirs, `refs/remotes/${ref}`);
        if (remoteResolved.kind === "oid") {
          const commit = readLooseCommitObject(dirs.commonDir, remoteResolved.oid);
          if (commit) return commit.oid;
        }
      }
    } else if (!isSpawnIntercepted() && isSafeSimpleRefName(ref)) {
      if (
        !existsSync(join(dirs.gitdir, ...ref.split("/"))) &&
        !existsSync(join(dirs.commonDir, ...ref.split("/"))) &&
        resolveDirectRef(dirs, `refs/${ref}`).kind === "missing" &&
        resolveDirectRef(dirs, `refs/tags/${ref}`).kind === "missing"
      ) {
        const headResolved = resolveDirectRef(dirs, `refs/heads/${ref}`);
        if (headResolved.kind === "oid") {
          const commit = readLooseCommitObject(dirs.commonDir, headResolved.oid);
          if (commit) return commit.oid;
        } else if (
          !SHA.test(ref) &&
          headResolved.kind === "missing" &&
          !hasNestedRefsPrefix(dirs.commonDir, `refs/heads/${ref}`) &&
          resolveDirectRef(dirs, `refs/remotes/${ref}`).kind === "missing" &&
          !hasNestedRefsPrefix(dirs.commonDir, `refs/remotes/${ref}`)
        ) {
          return undefined;
        }
      }
    }
  }
  const result = await run(["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], path);
  return result.code === 0 && SHA.test(result.stdout) ? result.stdout : undefined;
}

/** Does `descendant` contain `ancestor`? */
export async function contains(path: string, descendant: string, ancestor: string, fromCommits = false): Promise<boolean> {
  if ((descendant !== "HEAD" && !SHA.test(descendant)) || !SHA.test(ancestor)) return false;
  const dirs = !isSpawnIntercepted() ? resolveGitDirs(path) : undefined;
  if (dirs && FULL_OID.test(ancestor) && canWalkRawLooseHistory(dirs.commonDir, fromCommits)) {
    const descResolved = descendant === "HEAD"
      ? resolveDirectRef(dirs, "HEAD")
      : FULL_OID.test(descendant)
        ? { kind: "oid" as const, oid: descendant.toLowerCase() }
        : undefined;
    if (descResolved?.kind === "oid") {
      if (isDefinitelyAbsentLooseOid(dirs.commonDir, descResolved.oid) || isDefinitelyAbsentLooseOid(dirs.commonDir, ancestor)) {
        return false;
      }
      if (readLooseCommitObject(dirs.commonDir, ancestor)) {
        const ancestors = looseAncestorSet(dirs.commonDir, descResolved.oid);
        if (ancestors) return ancestors.has(ancestor.toLowerCase());
      }
    }
  }
  return (await run(["git", ...(fromCommits ? FROM_COMMITS : []), "merge-base", "--is-ancestor", ancestor, descendant], path)).code === 0;
}

export async function parents(path: string, sha: string): Promise<string[]> {
  if (!SHA.test(sha)) return [];
  const dirs = !isSpawnIntercepted() ? resolveGitDirs(path) : undefined;
  if (dirs && FULL_OID.test(sha) && canWalkRawLooseHistory(dirs.commonDir, false)) {
    const commit = readLooseCommitObject(dirs.commonDir, sha);
    if (commit) return [...commit.parents];
  }
  return (await run(["git", "rev-list", "--parents", "--max-count=1", sha], path)).stdout.split(/\s+/).filter(Boolean).slice(1);
}

/** The working copies where `branch` is checked out. */
export async function checkedOut(root: string, branch: string): Promise<string[]> {
  if (!isSpawnIntercepted()) {
    try {
      const dotGit = join(root, ".git");
      if (statSync(dotGit).isDirectory() && !existsSync(join(dotGit, "reftable"))) {
        const wanted = `ref: refs/heads/${branch}`;
        const places: string[] = [];
        const mainHead = readFileSync(join(dotGit, "HEAD"), "utf8").trim();
        if (mainHead === "ref: refs/heads/.invalid") throw new Error("reftable");
        if (mainHead === wanted) places.push(canonical(root));
        const worktreesDir = join(dotGit, "worktrees");
        if (existsSync(worktreesDir)) {
          for (const name of readdirSync(worktreesDir)) {
            const entryDir = join(worktreesDir, name);
            const headText = readFileSync(join(entryDir, "HEAD"), "utf8").trim();
            if (headText === wanted) {
              const target = resolve(entryDir, readFileSync(join(entryDir, "gitdir"), "utf8").trim());
              places.push(dirname(target));
            }
          }
        }
        return places;
      }
    } catch { /* Fall back to Git CLI. */ }
  }
  const listed = await run(["git", "worktree", "list", "--porcelain", "-z"], root);
  const places: string[] = [];
  let at = "";
  for (const line of listed.stdout.split("\0")) {
    if (line.startsWith("worktree ")) at = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}`) places.push(at);
  }
  return places;
}
