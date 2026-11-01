import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { executionFor, scopesFor } from "@petrina/orchestrator";
import * as git from "@petrina/repositories/git";
import type { Engine } from "../engine.js";
import { removeDir, tempDir } from "../fixtures.js";

const configuredCheckStubEngines = new WeakSet<Engine>();

interface SharedDeliverySeed {
  root: string;
  repo: string;
  worktree: string;
  index: string;
  head: string;
  tree: string;
  patch: string;
}

const sharedDeliverySeeds = new Map<string, Promise<SharedDeliverySeed>>();
process.once("exit", () => {
  for (const seed of sharedDeliverySeeds.values()) {
    void seed.then(entry => removeDir(entry.root)).catch(() => {});
  }
});

function copyLooseObjects(srcObjects: string, dstObjects: string): void {
  for (const entry of readdirSync(srcObjects)) {
    if (entry.length !== 2) continue;
    const sub = join(srcObjects, entry);
    const dstSub = join(dstObjects, entry);
    mkdirSync(dstSub, { recursive: true });
    for (const file of readdirSync(sub)) {
      const dstFile = join(dstSub, file);
      if (!existsSync(dstFile)) cpSync(join(sub, file), dstFile);
    }
  }
}

export function readRef(gitDir: string, ref: string): string | undefined {
  try {
    const file = join(gitDir, ...ref.split("/"));
    if (existsSync(file)) {
      const sha = readFileSync(file, "utf8").trim();
      if (/^[0-9a-f]{40,64}$/.test(sha)) return sha;
    }
    const packed = join(gitDir, "packed-refs");
    if (existsSync(packed)) {
      for (const line of readFileSync(packed, "utf8").split("\n")) {
        if (line.endsWith(` ${ref}`)) {
          const sha = line.slice(0, line.indexOf(" ")).trim();
          if (/^[0-9a-f]{40,64}$/.test(sha)) return sha;
        }
      }
    }
  } catch {
    // Unreadable or non-standard git directory falls back to native git.
  }
  return undefined;
}

function commonGitDirOf(worktreeOrRepo: string): { gitdir: string; commonDir: string } | undefined {
  try {
    const dotGit = join(worktreeOrRepo, ".git");
    if (!existsSync(dotGit)) return undefined;
    let gitdir = dotGit;
    try {
      const raw = readFileSync(dotGit, "utf8");
      if (raw.startsWith("gitdir:")) gitdir = resolve(worktreeOrRepo, raw.slice("gitdir:".length).trim());
    } catch {
      // dotGit is a directory
    }
    const commonDir = existsSync(join(gitdir, "commondir"))
      ? resolve(gitdir, readFileSync(join(gitdir, "commondir"), "utf8").trim())
      : gitdir;
    return { gitdir, commonDir };
  } catch {
    return undefined;
  }
}

export function readLooseCommit(commonDir: string, commit: string): { commit: string; tree: string; parents: string[]; body: string } | undefined {
  try {
    if (!/^[0-9a-f]{40,64}$/.test(commit)) return undefined;
    const objectPath = join(commonDir, "objects", commit.slice(0, 2), commit.slice(2));
    if (!existsSync(objectPath)) return undefined;
    const rawObject = inflateSync(readFileSync(objectPath)).toString("utf8");
    const tree = /\0tree ([0-9a-f]{40,64})\n/.exec(rawObject)?.[1];
    if (!tree) return undefined;
    const headerEnd = rawObject.indexOf("\n\n");
    const headerText = headerEnd >= 0 ? rawObject.slice(0, headerEnd) : rawObject;
    const body = headerEnd >= 0 ? rawObject.slice(headerEnd + 2) : "";
    const parents = [...headerText.matchAll(/^parent ([0-9a-f]{40,64})$/gm)].map((m) => m[1]!);
    return { commit, tree, parents, body };
  } catch {
    return undefined;
  }
}

export function readWorktreeCommit(worktree: string): { commit: string; tree: string; parents: string[]; body: string } | undefined {
  try {
    const dirs = commonGitDirOf(worktree);
    if (!dirs) return undefined;
    const headPath = join(dirs.gitdir, "HEAD");
    if (!existsSync(headPath)) return undefined;
    const headRaw = readFileSync(headPath, "utf8").trim();
    const commit = headRaw.startsWith("ref: ")
      ? readRef(dirs.commonDir, headRaw.slice("ref: ".length))
      : (/^[0-9a-f]{40,64}$/.test(headRaw) ? headRaw : undefined);
    if (!commit) return undefined;
    return readLooseCommit(dirs.commonDir, commit);
  } catch {
    return undefined;
  }
}

function looseAncestors(commonDir: string, startSha: string): Map<string, string[]> | undefined {
  if (!/^[0-9a-f]{40,64}$/.test(startSha)) return undefined;
  const graph = new Map<string, string[]>();
  const queue = [startSha];
  while (queue.length) {
    const current = queue.pop()!;
    if (graph.has(current)) continue;
    const lc = readLooseCommit(commonDir, current);
    if (!lc) return undefined;
    graph.set(current, lc.parents);
    for (const parent of lc.parents) {
      if (!graph.has(parent)) queue.push(parent);
    }
  }
  return graph;
}

export function looseContains(commonDir: string, descendant: string, ancestor: string): boolean | undefined {
  if (!/^[0-9a-f]{40,64}$/.test(descendant) || !/^[0-9a-f]{40,64}$/.test(ancestor)) return undefined;
  if (descendant === ancestor) return readLooseCommit(commonDir, descendant) ? true : undefined;
  const graph = looseAncestors(commonDir, descendant);
  return graph ? graph.has(ancestor) : undefined;
}

export function looseMergeBase(commonDir: string, a: string, b: string): string | undefined {
  if (!/^[0-9a-f]{40,64}$/.test(a) || !/^[0-9a-f]{40,64}$/.test(b)) return undefined;
  if (a === b) return readLooseCommit(commonDir, a) ? a : undefined;
  const ancA = looseAncestors(commonDir, a);
  if (!ancA) return undefined;
  if (ancA.has(b)) return b;
  const ancB = looseAncestors(commonDir, b);
  if (!ancB) return undefined;
  if (ancB.has(a)) return a;
  const common = [...ancA.keys()].filter((sha) => ancB.has(sha));
  if (common.length === 1) return common[0];
  if (common.length > 1) {
    const dominated = new Set<string>();
    for (const c of common) {
      const stack = [...(ancA.get(c) ?? [])];
      while (stack.length) {
        const p = stack.pop()!;
        if (dominated.has(p)) continue;
        dominated.add(p);
        for (const gp of ancA.get(p) ?? []) stack.push(gp);
      }
    }
    const best = common.filter((c) => !dominated.has(c));
    if (best.length === 1) return best[0];
  }
  return undefined;
}

function writeLooseGitObject(gitDir: string, type: "blob" | "tree" | "commit", body: Buffer, format: "sha1" | "sha256" = "sha1"): string {
  const header = Buffer.from(`${type} ${body.length}\0`, "utf8");
  const full = Buffer.concat([header, body]);
  const sha = createHash(format).update(full).digest("hex");
  const objPath = join(gitDir, "objects", sha.slice(0, 2), sha.slice(2));
  if (!existsSync(objPath)) {
    mkdirSync(dirname(objPath), { recursive: true });
    writeFileSync(objPath, deflateSync(full));
  }
  return sha;
}

function writeLooseSha1Object(gitDir: string, type: "blob" | "tree" | "commit", body: Buffer): string {
  return writeLooseGitObject(gitDir, type, body, "sha1");
}

function writeLooseCommit(commonDir: string, tree: string, parents: readonly string[], message: string): string | undefined {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(tree)) return undefined;
  const format = tree.length === 64 ? "sha256" : "sha1";
  const expectedLen = format === "sha256" ? 64 : 40;
  if (parents.some((parent) => parent.length !== expectedLen || !/^[0-9a-f]+$/i.test(parent))) return undefined;
  const author = "Test <test@example.com>";
  const msg = message.endsWith("\n") ? message : `${message}\n`;
  const parentLines = parents.map((parent) => `parent ${parent.toLowerCase()}\n`).join("");
  const commitText = `tree ${tree.toLowerCase()}\n${parentLines}author ${author} 1700000000 +0000\ncommitter ${author} 1700000000 +0000\n\n${msg}`;
  return writeLooseGitObject(commonDir, "commit", Buffer.from(commitText, "utf8"), format);
}

export function readLooseTreeEntries(commonDir: string, treeSha: string): Map<string, { mode: string; name: string; oid: Buffer }> | undefined {
  try {
    if (!/^[0-9a-f]{40}$/.test(treeSha)) return undefined;
    const objPath = join(commonDir, "objects", treeSha.slice(0, 2), treeSha.slice(2));
    if (!existsSync(objPath)) return undefined;
    const raw = inflateSync(readFileSync(objPath));
    const nul = raw.indexOf(0);
    if (nul <= 0 || !raw.subarray(0, nul).toString("utf8").startsWith("tree ")) return undefined;
    const buf = raw.subarray(nul + 1);
    const entries = new Map<string, { mode: string; name: string; oid: Buffer }>();
    let offset = 0;
    while (offset < buf.length) {
      const space = buf.indexOf(0x20, offset);
      const entryNul = buf.indexOf(0x00, space + 1);
      if (space < 0 || entryNul < 0 || entryNul + 21 > buf.length) return undefined;
      const mode = buf.subarray(offset, space).toString("utf8");
      const name = buf.subarray(space + 1, entryNul).toString("utf8");
      const oid = Buffer.from(buf.subarray(entryNul + 1, entryNul + 21));
      entries.set(name, { mode, name, oid });
      offset = entryNul + 21;
    }
    return entries;
  } catch {
    return undefined;
  }
}

export function readLooseBlobInCommit(commonDir: string, commitSha: string, fileName: string): string | undefined {
  try {
    if (fileName.includes("/")) return undefined;
    const commit = readLooseCommit(commonDir, commitSha);
    if (!commit) return undefined;
    const entries = readLooseTreeEntries(commonDir, commit.tree);
    const entry = entries?.get(fileName);
    if (!entry) return undefined;
    const blobSha = entry.oid.toString("hex");
    const blobPath = join(commonDir, "objects", blobSha.slice(0, 2), blobSha.slice(2));
    if (!existsSync(blobPath)) return undefined;
    const raw = inflateSync(readFileSync(blobPath));
    const nul = raw.indexOf(0);
    if (nul <= 0 || !raw.subarray(0, nul).toString("utf8").startsWith("blob ")) return undefined;
    return raw.subarray(nul + 1).toString("utf8");
  } catch {
    return undefined;
  }
}

export function commitLooseOnRef(
  gitDir: string,
  options: {
    parentSha?: string;
    ref?: string;
    file?: { name: string; content: string };
    message: string;
    author?: string;
  },
): string | undefined {
  const parentSha = options.parentSha ?? (options.ref ? readRef(gitDir, options.ref) : undefined);
  if (!parentSha || !/^[0-9a-f]{40}$/.test(parentSha)) return undefined;
  const parentCommit = readLooseCommit(gitDir, parentSha);
  if (!parentCommit || !/^[0-9a-f]{40}$/.test(parentCommit.tree)) return undefined;
  let treeSha = parentCommit.tree;
  if (options.file) {
    if (options.file.name.includes("/")) return undefined;
    const entries = readLooseTreeEntries(gitDir, parentCommit.tree);
    if (!entries) return undefined;
    const blobSha = writeLooseSha1Object(gitDir, "blob", Buffer.from(options.file.content, "utf8"));
    entries.set(options.file.name, { mode: "100644", name: options.file.name, oid: Buffer.from(blobSha, "hex") });
    const sorted = [...entries.values()].sort((a, b) =>
      Buffer.compare(
        Buffer.from(a.mode === "40000" ? `${a.name}/` : a.name, "utf8"),
        Buffer.from(b.mode === "40000" ? `${b.name}/` : b.name, "utf8"),
      ),
    );
    const treeBody = Buffer.concat(
      sorted.map((entry) => Buffer.concat([Buffer.from(`${entry.mode} ${entry.name}\0`, "utf8"), entry.oid])),
    );
    treeSha = writeLooseSha1Object(gitDir, "tree", treeBody);
  }
  const author = options.author ?? "Test <test@example.com>";
  const msg = options.message.endsWith("\n") ? options.message : `${options.message}\n`;
  const commitText = `tree ${treeSha}\nparent ${parentSha}\nauthor ${author} 1700000000 +0000\ncommitter ${author} 1700000000 +0000\n\n${msg}`;
  const commitSha = writeLooseSha1Object(gitDir, "commit", Buffer.from(commitText, "utf8"));
  if (options.ref) {
    const refFile = join(gitDir, ...options.ref.split("/"));
    mkdirSync(dirname(refFile), { recursive: true });
    writeFileSync(refFile, `${commitSha}\n`);
  }
  return commitSha;
}

function hasCleanStandardGitConfig(repoPath: string): boolean {
  const configFile = join(repoPath, ".git", "config");
  if (!existsSync(configFile)) return false;
  const text = readFileSync(configFile, "utf8");
  if (/(?:fsmonitor|hook|credential|http\.|remote\..*\.receivepack|remote\..*\.uploadpack|core\.sshCommand|core\.askPass|core\.pager|core\.editor)/i.test(text)) return false;
  const hooksDir = join(repoPath, ".git", "hooks");
  if (existsSync(hooksDir)) {
    for (const name of readdirSync(hooksDir)) {
      if (!name.endsWith(".sample")) return false;
    }
  }
  return true;
}

function getCleanWorktreeSeed(productPath: string, baseSha: string): Promise<SharedDeliverySeed> {
  const key = `clean\0${baseSha}`;
  let pending = sharedDeliverySeeds.get(key);
  if (!pending) {
    pending = (async () => {
      const root = tempDir("petrina-clean-worktree-seed-");
      const repo = join(root, "repo");
      cpSync(productPath, repo, { recursive: true });
      const worktree = join(root, "work");
      await git.ensureWorktree(repo, worktree, "seed-clean", baseSha);
      const gitDir = resolve(worktree, readFileSync(join(worktree, ".git"), "utf8").replace(/^gitdir:\s*/, "").trim());
      const raw = inflateSync(readFileSync(join(repo, ".git", "objects", baseSha.slice(0, 2), baseSha.slice(2)))).toString("utf8");
      const tree = /\0tree ([0-9a-f]{40,64})\n/.exec(raw)?.[1] ?? "";
      return { root, repo, worktree, index: join(gitDir, "index"), head: baseSha, tree, patch: "" };
    })();
    sharedDeliverySeeds.set(key, pending);
  }
  return pending;
}

export async function materializeCleanWorktree(
  engine: Engine,
  scope: ReturnType<typeof executionFor>,
  productPath: string,
  baseName: string,
  baseSha: string,
): Promise<{ head: string; tree: string }> {
  const { task } = scope;
  const own = task.repositories?.find((work) => work.productId === scope.work.productId);
  const savedCopy = own?.preparingCopy;
  const branch = scope.work.branch ?? savedCopy?.branch ?? git.branchName(task.title, task.id);
  const worktree = scope.work.worktree ?? savedCopy?.path ?? join(engine.dataDir, "worktrees", scope.work.productId, task.id);
  if (!scope.work.branch) engine.log(scope, "milestone", "Set up a fresh working copy");
  scope.work.branch = branch;
  scope.work.worktree = worktree;
  scope.work.base = scope.work.base ?? baseName;
  scope.work.baseSha = baseSha;
  if (scope.work.source) scope.work.source.initialSha ??= baseSha;
  const directCommit = readWorktreeCommit(productPath);
  const canCopyDirect = Boolean(
    directCommit?.commit === baseSha
    && existsSync(join(productPath, ".git", "index"))
    && await git.isClean(productPath),
  );
  const seed = canCopyDirect
    ? { worktree: productPath, index: join(productPath, ".git", "index"), head: baseSha, tree: directCommit!.tree }
    : await getCleanWorktreeSeed(productPath, baseSha);
  mkdirSync(worktree, { recursive: true });
  for (const entryName of readdirSync(seed.worktree)) {
    if (entryName === ".git") continue;
    cpSync(join(seed.worktree, entryName), join(worktree, entryName), { recursive: true });
  }
  const wtGitDir = join(productPath, ".git", "worktrees", branch.replace(/\//g, "-"));
  mkdirSync(wtGitDir, { recursive: true });
  writeFileSync(join(wtGitDir, "commondir"), "../..\n");
  writeFileSync(join(wtGitDir, "gitdir"), `${join(worktree, ".git")}\n`);
  writeFileSync(join(wtGitDir, "HEAD"), `ref: refs/heads/${branch}\n`);
  cpSync(seed.index, join(wtGitDir, "index"));
  writeFileSync(join(worktree, ".git"), `gitdir: ${wtGitDir}\n`);
  if (baseName.startsWith("origin/")) {
    const originRefFile = join(productPath, ".git", "refs", "remotes", ...baseName.split("/"));
    mkdirSync(dirname(originRefFile), { recursive: true });
    writeFileSync(originRefFile, `${baseSha}\n`);
  }
  const refFile = join(productPath, ".git", "refs", "heads", ...branch.split("/"));
  mkdirSync(dirname(refFile), { recursive: true });
  writeFileSync(refFile, `${seed.head}\n`);
  scope.work.savedVersion = { commit: seed.head, tree: seed.tree };
  engine["turns"].copyHeads.set(worktree, seed.head);
  if (own) delete own.preparingCopy;
  return { head: seed.head, tree: seed.tree };
}

function getSharedDeliverySeed(
  productPath: string,
  baseSha: string,
  fileName = "greeting.txt",
  fileContent = "Hello\n",
  extraFiles?: Record<string, string>,
): Promise<SharedDeliverySeed> {
  const extraKey = extraFiles ? JSON.stringify(Object.entries(extraFiles).sort(([a], [b]) => a.localeCompare(b))) : "";
  const key = `${baseSha}\0${fileName}\0${fileContent}\0${extraKey}`;
  let pending = sharedDeliverySeeds.get(key);
  if (!pending) {
    pending = (async () => {
      const root = tempDir("petrina-shared-delivery-seed-");
      const repo = join(root, "repo");
      cpSync(productPath, repo, { recursive: true });
      const worktree = join(root, "work");
      await git.ensureWorktree(repo, worktree, "seed-greeting", baseSha);
      mkdirSync(dirname(join(worktree, fileName)), { recursive: true });
      writeFileSync(join(worktree, fileName), fileContent);
      if (extraFiles) {
        for (const [name, content] of Object.entries(extraFiles)) {
          mkdirSync(dirname(join(worktree, name)), { recursive: true });
          writeFileSync(join(worktree, name), content);
        }
      }
      await git.commitChanges(worktree, "seed");
      const gitDir = resolve(worktree, readFileSync(join(worktree, ".git"), "utf8").replace(/^gitdir:\s*/, "").trim());
      const head = readFileSync(join(repo, ".git", "refs", "heads", "seed-greeting"), "utf8").trim();
      const raw = inflateSync(readFileSync(join(repo, ".git", "objects", head.slice(0, 2), head.slice(2)))).toString("utf8");
      const tree = /\0tree ([0-9a-f]{40,64})\n/.exec(raw)?.[1] ?? "";
      const patch = (await git.patchId(worktree, baseSha, head)) ?? "";
      return { root, repo, worktree, index: join(gitDir, "index"), head, tree, patch };
    })();
    sharedDeliverySeeds.set(key, pending);
  }
  return pending;
}

export async function materializePreparedWorktree(
  engine: Engine,
  scope: ReturnType<typeof executionFor>,
  productPath: string,
  baseName: string,
  baseSha: string,
  fileName = "greeting.txt",
  fileContent = "Hello\n",
  customMessage?: string,
  extraFiles?: Record<string, string>,
): Promise<{ head: string; tree: string; patch: string }> {
  const { task } = scope;
  const branch = scope.work.branch ?? git.branchName(task.title, task.id);
  const worktree = scope.work.worktree ?? join(engine.dataDir, "worktrees", scope.work.productId, task.id);
  if (!scope.work.branch) engine.log(scope, "milestone", "Set up a fresh working copy");
  scope.work.branch = branch;
  scope.work.worktree = worktree;
  scope.work.base = scope.work.base ?? baseName;
  scope.work.baseSha = baseSha;
  if (scope.work.source) scope.work.source.initialSha ??= baseSha;
  const message = customMessage ?? engine["updates"].message(scope);
  const seed = await getSharedDeliverySeed(productPath, baseSha, fileName, fileContent, extraFiles);
  copyLooseObjects(join(seed.repo, ".git", "objects"), join(productPath, ".git", "objects"));
  const head = writeLooseCommit(join(productPath, ".git"), seed.tree, [baseSha], message) ?? seed.head;
  mkdirSync(worktree, { recursive: true });
  for (const entryName of readdirSync(seed.worktree)) {
    if (entryName === ".git") continue;
    cpSync(join(seed.worktree, entryName), join(worktree, entryName), { recursive: true });
  }
  const wtGitDir = join(productPath, ".git", "worktrees", branch.replace(/\//g, "-"));
  mkdirSync(wtGitDir, { recursive: true });
  writeFileSync(join(wtGitDir, "commondir"), "../..\n");
  writeFileSync(join(wtGitDir, "gitdir"), `${join(worktree, ".git")}\n`);
  writeFileSync(join(wtGitDir, "HEAD"), `ref: refs/heads/${branch}\n`);
  cpSync(seed.index, join(wtGitDir, "index"));
  writeFileSync(join(worktree, ".git"), `gitdir: ${wtGitDir}\n`);
  if (baseName.startsWith("origin/")) {
    const originRefFile = join(productPath, ".git", "refs", "remotes", ...baseName.split("/"));
    mkdirSync(dirname(originRefFile), { recursive: true });
    writeFileSync(originRefFile, `${baseSha}\n`);
  }
  const refFile = join(productPath, ".git", "refs", "heads", ...branch.split("/"));
  mkdirSync(dirname(refFile), { recursive: true });
  writeFileSync(refFile, `${head}\n`);
  scope.work.savedVersion = { commit: head, tree: seed.tree };
  engine["turns"].copyHeads.set(worktree, head);
  return { head, tree: seed.tree, patch: seed.patch };
}

export interface SharedWorkflowFastPathOptions {
  skipDriverPrepare?: boolean;
  keepFetchInPrepare?: boolean;
  skipUpToDate?: boolean;
  skipPrepareChecks?: boolean;
  skipReviewCopies?: boolean;
  skipReviewInputDiffs?: boolean;
  fastCheckCapture?: boolean;
  fastCleanup?: boolean;
  fastCheckpoints?: boolean;
}

/**
 * Supply a deterministic outcome for the synthetic `["git", "--version"]` placeholder check used by
 * workflow tests when probing check commands is unrelated. All repository, review, check-state, and
 * cleanup steps run through the real Engine and `@petrina/repositories` implementations.
 */
export function installSharedWorkflowFastPaths(
  engine: Engine,
  _options: SharedWorkflowFastPathOptions = {},
): Engine {
  if (!configuredCheckStubEngines.has(engine)) {
    configuredCheckStubEngines.add(engine);
    const prevRunCheckCommand = engine.options.runCheckCommand;
    engine.options.runCheckCommand = async (req) => {
      if (prevRunCheckCommand) {
        const res = await prevRunCheckCommand(req);
        if (res) return res;
      }
      if (req.argv.length === 2 && req.argv[0] === "git" && req.argv[1] === "--version") {
        return { code: 0, stdout: "git version 2.45.0\n" };
      }
      if (req.argv.length === 2 && req.argv[0] === "git" && req.argv[1] === "no-such-subcommand-petrina") {
        return { code: 1, stderr: "git: 'no-such-subcommand-petrina' is not a git command. See 'git --help'.\n" };
      }
      if (
        req.argv.length === 3
        && req.argv[0] === process.execPath
        && req.argv[1] === "-e"
        && req.argv[2] === "console.error('reproduced check failure');process.exit(1)"
      ) {
        return { code: 1, stderr: "reproduced check failure\n" };
      }
      return undefined;
    };
  }
  return engine;
}

/**
 * Delivery-only contracts begin with an already built/reviewed change. Resolve its actual sources and make
 * real task worktrees, instead of running an unrelated Planner, design convergence and review panel. Native
 * check admission and the delivery gate are never replaced. A contract asserting Builder receipts requests
 * real build turns; other contracts supply an ordinary saved build result as their explicit input.
 */
export async function prepareSharedDelivery(engine: Engine, id: string, options: { build?: "run"; acceptance?: boolean; risk?: "low"; checks?: "none"; content?: string } = {}) {
  const signal = engine.stopRequested.signal;
  const available = () => signal.throwIfAborted();
  available();
  await engine.waitUntilReady();
  available();
  const task = engine.task(id)!;
  if (task.state !== "backlog" || engine.drivers.has(id)) throw new Error("Prepare only a private, unstarted backlog fixture");
  installSharedWorkflowFastPaths(engine);
  const schedule = engine.schedule, paused = engine.s.pool.paused;
  const greetingContent = options.content ?? "Hello\n";
  engine.schedule = () => {};
  try {
    engine.setPoolPaused(false);
    task.plan = { rationale: "Delivery's already completed prerequisites", plannerProfileId: "sonnet-medium", stages: [
      { id: "build", title: "Build", kind: "do", roleId: "builder", profileIds: ["sol-xhigh"] },
      { id: "review", title: "Review", kind: "review-chain", roleId: "code-reviewer", profileIds: ["opus-high"], maxRounds: 2 },
      { id: "delivery-check", title: "Your delivery check", kind: "gate", gate: "delivery", roleId: "release-manager", profileIds: [] },
      { id: "ship", title: "Deliver", kind: "do", roleId: "release-manager", profileIds: ["sol-high"] },
    ] };
    task.stageIndex = 0;
    const sources = engine["sources"];
    const approval = task.approveDelivery;
    await sources.propose(task, task.selectedProducts);
    available();
    sources.confirm(task);
    // The test's explicit coordinator choice is the saved plan input, after source resolution.
    task.approveDelivery = approval;
    task.state = "running";
    task.startedAt = Date.now();
    const build = task.plan.stages[0]!;
    const fastPrepared = new Set<string>();
    for (const scope of scopesFor(task)) {
      const product = engine.s.products.find(product => product.id === scope.work.productId)!;
      if (options.checks === "none") {
        if (product.checks?.length) throw new Error("A no-command delivery input cannot replace configured checks");
        product.checks = []; product.checksBy = "coordinator";
      } else if (!product.checks) engine.setProductChecks(product.id, [{ name: "Version", command: "git --version" }]);
      const defaultBranch = product.defaultBranch ?? "main";
      let fastBaseSha: string | undefined;
      let fastBaseName: string | undefined;
      if (
        options.build !== "run"
        && product.path
        && !scope.work.worktree
        && !scope.work.hooking
        && (!scope.work.source || scope.work.source.start.kind === "default")
        && hasCleanStandardGitConfig(product.path)
      ) {
        if (scope.work.delivery === "local") {
          const localSha = readRef(join(product.path, ".git"), `refs/heads/${defaultBranch}`);
          if (localSha) {
            fastBaseSha = localSha;
            fastBaseName = defaultBranch;
          }
        } else if (product.remote && git.sameRepo(product.remote, product.repo)) {
          const remoteDir = engine.options.remotes?.[product.repo] ?? engine.options.remote;
          if (remoteDir && existsSync(join(remoteDir, "HEAD"))) {
            const remoteSha = readRef(remoteDir, `refs/heads/${defaultBranch}`);
            const localOriginSha = readRef(join(product.path, ".git"), `refs/remotes/origin/${defaultBranch}`);
            const localHeadSha = readRef(join(product.path, ".git"), `refs/heads/${defaultBranch}`);
            if (remoteSha && (remoteSha === localOriginSha || remoteSha === localHeadSha) && readLooseCommit(join(product.path, ".git"), remoteSha)) {
              fastBaseSha = remoteSha;
              fastBaseName = `origin/${defaultBranch}`;
            }
          }
        }
      }
      if (fastBaseSha && fastBaseName && product.path) {
        scope.work.report = { summary: "Added a greeting.", changes: ["People see a greeting"], tests: "Petrina runs the configured checks." };
        const seed = await materializePreparedWorktree(engine, scope, product.path, fastBaseName, fastBaseSha, "greeting.txt", greetingContent);
        available();
        (scope.work.completedStages ??= []).push(build.id);
        scope.work.reviewedTree = seed.tree;
        scope.work.reviewedSha = seed.head;
        scope.work.preparation = "ready";
        fastPrepared.add(scope.work.productId);
      } else {
        await engine["driver"]["prepare"](scope, signal);
        available();
        scope.work.preparation = "ready";
      }
    }
    for (const scope of scopesFor(task)) {
      if (fastPrepared.has(scope.work.productId)) continue;
      task.activeProductId = scope.work.productId;
      if (options.build === "run") {
        await engine["work"].runDo(scope, build, signal);
        available();
      }
      else {
        scope.work.report = { summary: "Added a greeting.", changes: ["People see a greeting"], tests: "Petrina runs the configured checks." };
        writeFileSync(join(scope.work.worktree!, "greeting.txt"), greetingContent);
        await git.commitChanges(scope.work.worktree!, engine["updates"].message(scope));
        available();
        (scope.work.completedStages ??= []).push(build.id);
      }
      // Review is a saved prerequisite here. These observations identify its actual private code.
      const wc = readWorktreeCommit(scope.work.worktree!);
      const observed = wc ? { head: wc.commit, tree: wc.tree } : await git.commitVersion(scope.work.worktree!);
      available();
      scope.work.savedVersion = observed.head && observed.tree ? { commit: observed.head, tree: observed.tree } : undefined;
      scope.work.reviewedTree = observed.tree;
      scope.work.reviewedSha = observed.head;
    }
    if (options.acceptance) {
      const versions = Object.fromEntries(scopesFor(task).map(({ work }) => [work.productId, work.reviewedTree ?? "unavailable"]));
      task.brief = { summary: "A shared greeting", forUsers: [], areas: [], risks: [], acceptance: [
        { text: "A greeting file exists", productIds: task.repositories!.map(work => work.productId), versions, met: true, verification: "passed" },
      ] };
      task.acceptancePassed = true;
    }
    if (options.risk) task.risk = { level: options.risk, why: "Only the greeting's words change." };
    task.activeProductId = executionFor(task, task.leadProductId).work.productId;
    task.stageIndex = 2;
    task.sub = 0;
    task.state = "waiting";
    task.holdsSlot = false;
    engine.commitNow(task);
    return task;
  } finally {
    if (!signal.aborted) engine.setPoolPaused(paused);
    engine.schedule = schedule;
  }
}
