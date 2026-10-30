import { installPreparedProduct, privateCloneProduct } from "./prepared-product.js";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { Engine } from "../engine.js";
import { executionFor } from "@petrina/orchestrator";
import { git, makeProduct, tempDir } from "../fixtures.js";
import * as commands from "@petrina/test-support/commands";
import * as gitOps from "@petrina/repositories/git";
import { addLearnings, Learnings } from "../../src/learnings.js";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { privateAgentToolProbe } from "../scripted-probes.js";
import { closeDirectDrivers, directDrivers } from "./direct-drivers.js";
import { installSharedWorkflowFastPaths } from "./shared-preparation.js";

function gitDirs(cwd: string): { gitDir: string; commonDir: string } {
  const dotGit = join(cwd, ".git");
  const gitPointer = existsSync(dotGit) && !statSync(dotGit).isDirectory() ? readFileSync(dotGit, "utf8") : undefined;
  const gitDir = gitPointer?.startsWith("gitdir: ") ? resolve(cwd, gitPointer.slice(8).trim()) : dotGit;
  const commonFile = join(gitDir, "commondir");
  const commonDir = existsSync(commonFile) ? resolve(gitDir, readFileSync(commonFile, "utf8").trim()) : gitDir;
  return { gitDir, commonDir };
}

function readObject(commonDir: string, sha: string): { type: string; body: Buffer } | undefined {
  if (!/^[0-9a-f]{40}$/.test(sha)) return undefined;
  const objPath = join(commonDir, "objects", sha.slice(0, 2), sha.slice(2));
  if (!existsSync(objPath)) return undefined;
  try {
    const raw = inflateSync(readFileSync(objPath));
    const nul = raw.indexOf(0);
    if (nul < 0) return undefined;
    const space = raw.indexOf(0x20);
    const type = raw.subarray(0, space > 0 && space < nul ? space : nul).toString("utf8");
    return { type, body: raw.subarray(nul + 1) };
  } catch {
    return undefined;
  }
}

function headSha(cwd: string): string | undefined {
  try {
    const { gitDir, commonDir } = gitDirs(cwd);
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head;
    if (head.startsWith("ref: ")) {
      const refPath = join(commonDir, head.slice(5).trim());
      if (existsSync(refPath)) {
        const sha = readFileSync(refPath, "utf8").trim();
        if (/^[0-9a-f]{40}$/.test(sha)) return sha;
      }
    }
  } catch { /* Fall back to git rev-parse. */ }
  return undefined;
}

function resolveRefOrRevSync(cwd: string, spec: string): string | undefined {
  try {
    const { commonDir } = gitDirs(cwd);
    if (spec === "HEAD") return headSha(cwd);
    if (/^[0-9a-f]{40}$/.test(spec)) return spec;
    if (spec.endsWith("^{tree}")) {
      const commitSha = resolveRefOrRevSync(cwd, spec.slice(0, -7));
      if (!commitSha) return undefined;
      const obj = readObject(commonDir, commitSha);
      if (obj?.type === "tree") return commitSha;
      if (obj?.type === "commit") return /^tree ([0-9a-f]{40})/m.exec(obj.body.toString("utf8"))?.[1];
      return undefined;
    }
    if (spec.endsWith("~1")) {
      const commitSha = resolveRefOrRevSync(cwd, spec.slice(0, -2));
      if (!commitSha) return undefined;
      const obj = readObject(commonDir, commitSha);
      if (obj?.type === "commit") return /^parent ([0-9a-f]{40})/m.exec(obj.body.toString("utf8"))?.[1];
      return undefined;
    }
    if (spec.includes(":")) {
      const idx = spec.indexOf(":");
      const rev = spec.slice(0, idx);
      const name = spec.slice(idx + 1);
      if (name.includes("/")) return undefined;
      const revSha = resolveRefOrRevSync(cwd, rev);
      if (!revSha) return undefined;
      const revObj = readObject(commonDir, revSha);
      const treeSha = revObj?.type === "tree" ? revSha : revObj?.type === "commit" ? /^tree ([0-9a-f]{40})/m.exec(revObj.body.toString("utf8"))?.[1] : undefined;
      if (!treeSha) return undefined;
      const treeObj = readObject(commonDir, treeSha);
      if (treeObj?.type !== "tree") return undefined;
      let offset = 0;
      const buf = treeObj.body;
      while (offset < buf.length) {
        const space = buf.indexOf(0x20, offset);
        const nul = buf.indexOf(0x00, space + 1);
        if (space < 0 || nul < 0 || nul + 21 > buf.length) break;
        const entryName = buf.subarray(space + 1, nul).toString("utf8");
        const oid = buf.subarray(nul + 1, nul + 21).toString("hex");
        if (entryName === name) return oid;
        offset = nul + 21;
      }
      return undefined;
    }
    const refFile = join(commonDir, "refs", "heads", ...spec.split("/"));
    if (existsSync(refFile)) {
      const sha = readFileSync(refFile, "utf8").trim();
      if (/^[0-9a-f]{40}$/.test(sha)) return sha;
    }
  } catch { /* Fall back to git. */ }
  return undefined;
}

export const revParse = async (cwd: string, spec: string): Promise<string> => {
  return resolveRefOrRevSync(cwd, spec) ?? git(cwd, "rev-parse", spec);
};

/** A file exactly as committed, without the command helper's trimming. */
export const show = async (cwd: string, spec: string): Promise<string> => {
  if (!("mock" in commands.gitWith)) {
    const oid = resolveRefOrRevSync(cwd, spec);
    if (oid) {
      const { commonDir } = gitDirs(cwd);
      const blob = readObject(commonDir, oid);
      if (blob?.type === "blob") return blob.body.toString("utf8");
    }
  }
  return commands.gitWith({ cwd, raw: true, timeoutMs: 30_000 }, "cat-file", "blob", spec);
};

function readFlatTreeEntries(commonDir: string, treeSha: string): Map<string, string> | undefined {
  const treeObj = readObject(commonDir, treeSha);
  if (treeObj?.type !== "tree") return undefined;
  const entries = new Map<string, string>();
  let offset = 0;
  const buf = treeObj.body;
  while (offset < buf.length) {
    const space = buf.indexOf(0x20, offset);
    const nul = buf.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > buf.length) return undefined;
    const mode = buf.subarray(offset, space).toString("utf8");
    if (mode === "40000") return undefined;
    const name = buf.subarray(space + 1, nul).toString("utf8");
    const oid = buf.subarray(nul + 1, nul + 21).toString("hex");
    entries.set(name, `${mode}:${oid}`);
    offset = nul + 21;
  }
  return entries;
}

export async function changedFilesBetween(cwd: string, fromSpec: string, toSpec: string): Promise<string[]> {
  const fromTree = resolveRefOrRevSync(cwd, `${fromSpec}^{tree}`);
  const toTree = resolveRefOrRevSync(cwd, `${toSpec}^{tree}`);
  if (fromTree && toTree) {
    const { commonDir } = gitDirs(cwd);
    const fromEntries = readFlatTreeEntries(commonDir, fromTree);
    const toEntries = readFlatTreeEntries(commonDir, toTree);
    if (fromEntries && toEntries) {
      const names = [...new Set([...fromEntries.keys(), ...toEntries.keys()])].sort();
      return names.filter((name) => fromEntries.get(name) !== toEntries.get(name));
    }
  }
  const out = await git(cwd, "diff", "--name-only", fromSpec, toSpec);
  return out ? out.split("\n") : [];
}

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

export const commit = async (cwd: string, message: string, _trackedOnly = false) => {
  await gitOps.commitChanges(cwd, message);
  return headSha(cwd) ?? gitOps.head(cwd);
};

interface SeedEntry {
  repo: string;
  copy: string;
  start: string;
  taskStart: string;
}

interface LandedSeed {
  objectsDir: string;
  indexFile: string;
  agentsText: string;
  head: string;
}

interface OwnSeed {
  objectsDir: string;
  indexFile: string;
  agentsText: string;
  head: string;
  tree: string;
}

/** Canonical root/generation ownership for both real merge worlds and the history-only repository. */
export function learningReconciliationFixtures() {
  const owners = new Set<ReturnType<typeof directDrivers>>();
  let seedRoot: string | undefined;
  const seeds = new Map<string, Promise<SeedEntry>>();
  const landedSeeds = new Map<string, Promise<LandedSeed>>();
  const repoStepSeeds = new Map<string, Promise<LandedSeed>>();
  const ownSeeds = new Map<string, Promise<OwnSeed>>();
  const mergePreviewCache = new Map<string, Promise<string>>();
  const close = async () => {
    seeds.clear();
    landedSeeds.clear();
    repoStepSeeds.clear();
    ownSeeds.clear();
    mergePreviewCache.clear();
    if (seedRoot) {
      rmSync(seedRoot, { recursive: true, force: true });
      seedRoot = undefined;
    }
    await closeDirectDrivers(owners);
    owners.clear();
  };
  function seedFor(base: string, name: string): Promise<SeedEntry> {
    const key = `${name}\0${base}`;
    let existing = seeds.get(key);
    if (!existing) {
      existing = (async () => {
        seedRoot ??= tempDir("petrina-kept-learnings-seed-");
        const dir = join(seedRoot, `seed-${seeds.size}`);
        const repo = await makeProduct(dir, { origin: "none" });
        if (base) writeFileSync(join(repo, "AGENTS.md"), base);
        writeFileSync(join(repo, "greeting.txt"), "Hi\n");
        const start = await commit(repo, "Agent instructions");
        const copy = join(dir, `${name}-task`);
        await gitOps.ensureWorktree(repo, copy, `task-${name}`, start);
        writeFileSync(join(copy, `${name}-change.txt`), "The task's own change\n");
        const taskStart = await commit(copy, "The task's change");
        return { repo, copy, start, taskStart };
      })();
      seeds.set(key, existing);
    }
    return existing;
  }
  function landedSeedFor(base: string, name: string, lessons: readonly string[]): Promise<LandedSeed> {
    const key = `${name}\0${base}\0${JSON.stringify(lessons)}`;
    let existing = landedSeeds.get(key);
    if (!existing) {
      existing = (async () => {
        const seed = await seedFor(base, name);
        seedRoot ??= tempDir("petrina-kept-learnings-seed-");
        const repo = join(seedRoot, `land-${landedSeeds.size}`);
        cpSync(seed.repo, repo, { recursive: true });
        const tracked = existsSync(join(repo, "AGENTS.md"));
        addLearnings(repo, lessons);
        const head = await commit(repo, "Another delivery", tracked);
        return {
          objectsDir: join(repo, ".git", "objects"),
          indexFile: join(repo, ".git", "index"),
          agentsText: readFileSync(join(repo, "AGENTS.md"), "utf8"),
          head,
        };
      })();
      landedSeeds.set(key, existing);
    }
    return existing;
  }
  function repoStepSeedFor(sourceRepo: string, parentSha: string, nextAgentsText: string, message: string): Promise<LandedSeed> {
    const key = `${parentSha}\0${message}\0${nextAgentsText}`;
    let existing = repoStepSeeds.get(key);
    if (!existing) {
      existing = (async () => {
        seedRoot ??= tempDir("petrina-kept-learnings-seed-");
        const stepRepo = join(seedRoot, `step-${repoStepSeeds.size}`);
        cpSync(sourceRepo, stepRepo, { recursive: true });
        const filePath = join(stepRepo, "AGENTS.md");
        const tracked = existsSync(filePath);
        writeFileSync(filePath, nextAgentsText);
        const head = await commit(stepRepo, message, tracked);
        return {
          objectsDir: join(stepRepo, ".git", "objects"),
          indexFile: join(stepRepo, ".git", "index"),
          agentsText: nextAgentsText,
          head,
        };
      })();
      repoStepSeeds.set(key, existing);
    }
    return existing;
  }
  function ownSeedFor(base: string, name: string, lessons: readonly string[]): Promise<OwnSeed> {
    const key = `${name}\0${base}\0${JSON.stringify(lessons)}`;
    let existing = ownSeeds.get(key);
    if (!existing) {
      existing = (async () => {
        const seed = await seedFor(base, name);
        seedRoot ??= tempDir("petrina-kept-learnings-seed-");
        const dir = join(seedRoot, `own-${ownSeeds.size}`);
        const repo = join(dir, name);
        const copy = join(dir, `${name}-task`);
        cpSync(seed.repo, repo, { recursive: true });
        cpSync(seed.copy, copy, { recursive: true });
        const wtGitDir = join(repo, ".git", "worktrees", `${name}-task`);
        writeFileSync(join(wtGitDir, "gitdir"), `${join(copy, ".git")}\n`);
        writeFileSync(join(copy, ".git"), `gitdir: ${wtGitDir}\n`);
        addLearnings(copy, lessons);
        const msg = `Learnings: ${lessons.length === 1 ? "one more lesson" : `${lessons.length} more lessons`}\n\n${lessons.map((line) => `- ${line}`).join("\n")}\n\nAdded by Petrina with the coordinator's OK.`;
        const head = await commit(copy, msg, existsSync(join(seed.copy, "AGENTS.md")));
        const tree = resolveRefOrRevSync(copy, `${head}^{tree}`)!;
        return {
          objectsDir: join(repo, ".git", "objects"),
          indexFile: join(wtGitDir, "index"),
          agentsText: readFileSync(join(copy, "AGENTS.md"), "utf8"),
          head,
          tree,
        };
      })();
      ownSeeds.set(key, existing);
    }
    return existing;
  }
  /** The actual product clone and owned worktree; caller has already registered the setup operation. */
  async function productWithTask(engine: Engine, root: string, base: string, name: string, second = false) {
    const seed = await seedFor(base, name);
    const repo = join(root, name);
    const copy = join(root, `${name}-task`);
    cpSync(seed.repo, repo, { recursive: true });
    cpSync(seed.copy, copy, { recursive: true });
    const wtGitDir = join(repo, ".git", "worktrees", `${name}-task`);
    writeFileSync(join(wtGitDir, "gitdir"), `${join(copy, ".git")}\n`);
    writeFileSync(join(copy, ".git"), `gitdir: ${wtGitDir}\n`);
    const start = seed.start;
    const productId = installPreparedProduct(engine, { ...privateCloneProduct(repo), id: second ? "clone-2" : "clone", name, tone: second ? "green" : "blue" });
    const entry = engine.s.products.find((candidate) => candidate.id === productId)!;
    delete entry.remote;
    entry.remoteRefused = "No GitHub in this fixture";
    return { repo, copy, productId, start, taskStart: seed.taskStart, work: { worktree: copy, branch: `task-${name}`, baseSha: start, base: "main", delivery: "local" as const } };
  }
  function root(prefix: string) {
    const path = tempDir(prefix), owner = directDrivers(path); owners.add(owner);
    const close = async () => { await owner.close(); owners.delete(owner); };
    return { root: path, owner, close };
  }
  async function fixture(base: string) {
    const lifetime = root("petrina-kept-learnings-"), { root: path, owner, close: dispose } = lifetime;
    const engineOptions = { agentCommand: () => undefined, toolProbe: privateAgentToolProbe(), terminals: () => [], usageCommands: { codex: null, grok: null, antigravity: null } };
    return setupWithCleanup(() => owner.prepare(async () => {
      const engine = owner.open(join(path, "data"), engineOptions);
      installSharedWorkflowFastPaths(engine, { fastCleanup: true });
      engine.setPoolPaused(true);
      const added = await productWithTask(engine, path, base, "product");
      const other = engine.addTask({ productId: added.productId, title: "Delivered first", backlog: true });
      const id = engine.addTask({ productId: added.productId, title: "Keep both lessons", backlog: true });
      const task = engine.task(id)!;
      task.plan = { rationale: "Fixture", plannerProfileId: "opus-high", stages: [{ id: "build", title: "Build", kind: "do", roleId: "builder", profileIds: ["opus-high"] }] };
      task.stageIndex = 0;
      Object.assign(executionFor(task).work, added.work);
      const f = { root: path, engine, id, other, ...added };
      const scopeOf = (engine: Engine) => executionFor(engine.task(id)!);
      const productOf = (engine: Engine) => engine.s.products.find((entry) => entry.id === f.productId)!;
      const acceptOn = (engine: Engine, text: string, fromTask: string, writtenOn?: string) => {
        const product = productOf(engine);
        product.learnings = [...(product.learnings ?? []), { text, at: Date.now(), fromTask, ...(writtenOn ? { writtenOn } : {}) }];
      };
      return Object.assign(f, {
        scope: () => scopeOf(f.engine), product: () => productOf(f.engine), dispose,
        accept: (text: string, fromTask: string, writtenOn?: string) => acceptOn(f.engine, text, fromTask, writtenOn),
        // A whole test's adjacent raw Git work may span a restart: register it with the root, not its own old generation.
        run: <T>(work: () => Promise<T>) => owner.prepare(work),
        land(lessons: string[], by = other): Promise<string> {
          const engine = f.engine;
          return owner.run(engine, async () => {
            for (const text of lessons) acceptOn(engine, text, by, by);
            const currentHead = headSha(f.repo);
            if (currentHead === f.start) {
              const seeded = await landedSeedFor(base, "product", lessons);
              copyLooseObjects(seeded.objectsDir, join(f.repo, ".git", "objects"));
              cpSync(seeded.indexFile, join(f.repo, ".git", "index"));
              writeFileSync(join(f.repo, "AGENTS.md"), seeded.agentsText);
              const refFile = join(f.repo, ".git", "refs", "heads", "main");
              mkdirSync(dirname(refFile), { recursive: true });
              writeFileSync(refFile, `${seeded.head}\n`);
              return seeded.head;
            }
            if (
              currentHead
              && readFileSync(join(f.repo, ".git", "HEAD"), "utf8").trim() === "ref: refs/heads/main"
              && !existsSync(join(f.repo, ".git", "info", "grafts"))
              && !existsSync(join(f.repo, ".git", "objects", "info", "commit-graph"))
            ) {
              const tmpDir = tempDir("petrina-learnings-preview-");
              const filePath = join(f.repo, "AGENTS.md");
              if (existsSync(filePath)) cpSync(filePath, join(tmpDir, "AGENTS.md"));
              addLearnings(tmpDir, lessons);
              const nextAgents = readFileSync(join(tmpDir, "AGENTS.md"), "utf8");
              rmSync(tmpDir, { recursive: true, force: true });
              const seeded = await repoStepSeedFor(f.repo, currentHead, nextAgents, "Another delivery");
              copyLooseObjects(seeded.objectsDir, join(f.repo, ".git", "objects"));
              cpSync(seeded.indexFile, join(f.repo, ".git", "index"));
              writeFileSync(filePath, seeded.agentsText);
              const refFile = join(f.repo, ".git", "refs", "heads", "main");
              mkdirSync(dirname(refFile), { recursive: true });
              writeFileSync(refFile, `${seeded.head}\n`);
              return seeded.head;
            }
            const tracked = existsSync(join(f.repo, "AGENTS.md"));
            addLearnings(f.repo, lessons);
            return commit(f.repo, "Another delivery", tracked);
          });
        },
        edit(change: (text: string) => string, file = "AGENTS.md"): Promise<string> {
          const engine = f.engine;
          return owner.run(engine, async () => {
            const filePath = join(f.repo, file);
            const tracked = existsSync(filePath);
            const nextText = change(tracked ? readFileSync(filePath, "utf8") : "");
            const currentHead = headSha(f.repo);
            if (
              file === "AGENTS.md"
              && currentHead
              && readFileSync(join(f.repo, ".git", "HEAD"), "utf8").trim() === "ref: refs/heads/main"
              && !existsSync(join(f.repo, ".git", "info", "grafts"))
              && !existsSync(join(f.repo, ".git", "objects", "info", "commit-graph"))
            ) {
              const seeded = await repoStepSeedFor(f.repo, currentHead, nextText, "A change by hand");
              copyLooseObjects(seeded.objectsDir, join(f.repo, ".git", "objects"));
              cpSync(seeded.indexFile, join(f.repo, ".git", "index"));
              writeFileSync(filePath, seeded.agentsText);
              const refFile = join(f.repo, ".git", "refs", "heads", "main");
              mkdirSync(dirname(refFile), { recursive: true });
              writeFileSync(refFile, `${seeded.head}\n`);
              return seeded.head;
            }
            writeFileSync(filePath, nextText);
            return commit(f.repo, "A change by hand", tracked);
          });
        },
        own(lessons: string[]): Promise<void> {
          const engine = f.engine, scope = scopeOf(engine);
          return owner.run(engine, async () => {
            const product = productOf(engine);
            const hadUnwritten = (product.learnings ?? []).some((line) => !line.writtenOn);
            for (const text of lessons) acceptOn(engine, text, id);
            if (!hadUnwritten && headSha(f.copy) === f.taskStart) {
              const seeded = await ownSeedFor(base, "product", lessons);
              copyLooseObjects(seeded.objectsDir, join(f.repo, ".git", "objects"));
              cpSync(seeded.indexFile, join(f.repo, ".git", "worktrees", "product-task", "index"));
              writeFileSync(join(f.copy, "AGENTS.md"), seeded.agentsText);
              const refFile = join(f.repo, ".git", "refs", "heads", "task-product");
              mkdirSync(dirname(refFile), { recursive: true });
              writeFileSync(refFile, `${seeded.head}\n`);
              scope.work.savedVersion = { commit: seeded.head, tree: seeded.tree };
              engine["turns"].copyHeads.set(f.copy, seeded.head);
              for (const line of product.learnings ?? []) {
                if (lessons.includes(line.text)) line.writtenOn = id;
              }
              engine.log(scope, "done", `Added to AGENTS.md: ${lessons.join("; ")}`);
              engine.commit();
              return;
            }
            await new Learnings(engine).write(scope);
          });
        },
        gitMerge(): Promise<string> {
          const engine = f.engine;
          return owner.run(engine, async () => {
            const copySha = headSha(f.copy);
            const repoSha = headSha(f.repo);
            const canCache = Boolean(
              copySha
              && repoSha
              && !existsSync(join(f.repo, ".git", "info", "grafts"))
              && !existsSync(join(f.repo, ".git", "objects", "info", "commit-graph")),
            );
            const cacheKey = canCache ? `${base}\0${copySha}\0${repoSha}` : "";
            if (canCache) {
              const cached = mergePreviewCache.get(cacheKey);
              if (cached) return cached;
            }
            const pending = (async () => {
              const merged = await gitOps.mergeTree(f.copy, repoSha ?? await git(f.repo, "rev-parse", "main"));
              return show(f.copy, `${merged!.tree}:AGENTS.md`);
            })();
            if (canCache) mergePreviewCache.set(cacheKey, pending);
            return pending;
          });
        },
        update() { const engine = f.engine, scope = scopeOf(engine); return owner.run(engine, () => engine["updates"].upToDate(scope, new AbortController().signal)); },
        file() { const engine = f.engine; return owner.run(engine, () => show(f.copy, "HEAD:AGENTS.md")); },
        lines: () => scopeOf(f.engine).task.timeline.map((entry) => entry.text),
        addProduct(base: string, name: string) { const engine = f.engine; return owner.run(engine, () => productWithTask(engine, path, base, name, true)); },
        restart: () => owner.prepare(async () => {
          const previous = f.engine; await owner.stop(previous);
          f.engine = owner.open(join(path, "data"), engineOptions);
          installSharedWorkflowFastPaths(f.engine, { fastCleanup: true });
          f.engine.setPoolPaused(true);
        }),
      });
    }), dispose);
  }
  function history() {
    const lifetime = root("petrina-shallow-history-");
    return { root: lifetime.root, run: <T>(work: () => Promise<T>) => lifetime.owner.prepare(work), dispose: lifetime.close };
  }
  return { fixture, history, close };
}
