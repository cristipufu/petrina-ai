import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as gitOps from "@petrina/repositories/git";
import { createProductRepository } from "@petrina/test-support/repositories";
import { tempDir } from "../support.js";

interface ReviewSeed {
  root: string;
  initialSha: string;
  headSha: string;
  treeSha: string;
}

const cachedReviewSeeds = new Map<string, Promise<ReviewSeed>>();

function ensureReviewSeed(sourceRepo?: string): Promise<ReviewSeed> {
  const sourceInitial = sourceRepo && existsSync(join(sourceRepo, ".git", "refs", "heads", "main"))
    ? readFileSync(join(sourceRepo, ".git", "refs", "heads", "main"), "utf8").trim()
    : undefined;
  const key = sourceInitial ?? "default";
  const cached = cachedReviewSeeds.get(key);
  if (cached) return cached;
  const pending = (async () => {
    const seedRoot = tempDir("petrina-review-seed-");
    let repo: string;
    let initialSha: string;
    if (sourceRepo && sourceInitial) {
      repo = join(seedRoot, "clone");
      cpSync(sourceRepo, repo, { recursive: true });
      initialSha = sourceInitial;
    } else {
      ({ path: repo, initialSha } = await createProductRepository(seedRoot));
    }
    const worktree = join(seedRoot, "worktree");
    await gitOps.ensureWorktree(repo, worktree, "seed-review-branch", initialSha);
    writeFileSync(join(worktree, "greeting.txt"), "Hello from the actual private review fixture\n");
    await gitOps.commitChanges(worktree, "Prepare the greeting under review");
    const { head: headSha, tree: treeSha } = await gitOps.commitVersion(worktree);
    return { root: seedRoot, initialSha, headSha: headSha!, treeSha: treeSha! };
  })();
  cachedReviewSeeds.set(key, pending);
  return pending;
}

/**
 * Copy a pre-built product repository with a committed review worktree into `root` without
 * spawning `git worktree add`, `git add` or `git commit` per test case.
 */
export async function prepareReviewRepository(
  root: string,
  options: { branch: string; folder: string },
): Promise<{
  repo: string;
  initialSha: string;
  worktree: string;
  branch: string;
  savedVersion: { head: string; tree: string; clean: boolean };
}> {
  const seed = await ensureReviewSeed();
  const origin = join(root, "origin.git");
  const repo = join(root, "clone");
  const worktree = join(root, options.folder);
  rmSync(origin, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
  rmSync(worktree, { recursive: true, force: true });
  cpSync(join(seed.root, "origin.git"), origin, { recursive: true });
  cpSync(join(seed.root, "clone"), repo, { recursive: true });
  cpSync(join(seed.root, "worktree"), worktree, { recursive: true });

  const configPath = join(repo, ".git", "config");
  writeFileSync(configPath, readFileSync(configPath, "utf8").replaceAll(join(seed.root, "origin.git"), origin));

  const worktreeMeta = join(repo, ".git", "worktrees", "worktree");
  writeFileSync(join(worktreeMeta, "gitdir"), `${join(worktree, ".git")}\n`);
  writeFileSync(join(worktreeMeta, "HEAD"), `ref: refs/heads/${options.branch}\n`);
  writeFileSync(join(worktree, ".git"), `gitdir: ${worktreeMeta}\n`);

  const oldRef = join(repo, ".git", "refs", "heads", "seed-review-branch");
  const newRef = join(repo, ".git", "refs", "heads", options.branch);
  if (existsSync(oldRef) && oldRef !== newRef) renameSync(oldRef, newRef);

  const oldLog = join(repo, ".git", "logs", "refs", "heads", "seed-review-branch");
  const newLog = join(repo, ".git", "logs", "refs", "heads", options.branch);
  if (existsSync(oldLog) && oldLog !== newLog) renameSync(oldLog, newLog);

  return {
    repo,
    initialSha: seed.initialSha,
    worktree,
    branch: options.branch,
    savedVersion: { head: seed.headSha, tree: seed.treeSha, clean: true },
  };
}

/**
 * Attach a pre-built committed review worktree to an existing `createProductRepository` clone
 * without spawning `git worktree add`, `git add` or `git commit`.
 */
export async function attachReviewWorktree(
  repo: string,
  options: { worktree: string; branch: string; id?: string },
): Promise<{
  initialSha: string;
  worktree: string;
  branch: string;
  savedVersion: { head: string; tree: string; clean: boolean };
}> {
  const seed = await ensureReviewSeed(repo);
  const id = options.id ?? "worktree";
  cpSync(join(seed.root, "clone", ".git", "objects"), join(repo, ".git", "objects"), { recursive: true });
  mkdirSync(dirname(options.worktree), { recursive: true });
  rmSync(options.worktree, { recursive: true, force: true });
  cpSync(join(seed.root, "worktree"), options.worktree, { recursive: true });

  const worktreeMeta = join(repo, ".git", "worktrees", id);
  rmSync(worktreeMeta, { recursive: true, force: true });
  mkdirSync(dirname(worktreeMeta), { recursive: true });
  cpSync(join(seed.root, "clone", ".git", "worktrees", "worktree"), worktreeMeta, { recursive: true });
  writeFileSync(join(worktreeMeta, "gitdir"), `${join(options.worktree, ".git")}\n`);
  writeFileSync(join(worktreeMeta, "HEAD"), `ref: refs/heads/${options.branch}\n`);
  writeFileSync(join(options.worktree, ".git"), `gitdir: ${worktreeMeta}\n`);

  const refPath = join(repo, ".git", "refs", "heads", options.branch);
  mkdirSync(dirname(refPath), { recursive: true });
  writeFileSync(refPath, `${seed.headSha}\n`);

  return {
    initialSha: seed.initialSha,
    worktree: options.worktree,
    branch: options.branch,
    savedVersion: { head: seed.headSha, tree: seed.treeSha, clean: true },
  };
}
