import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalizePlan, type DeepMutable } from "@petrina/core";
import { executionFor, repositoryView } from "@petrina/orchestrator";
import { commitChanges, commitVersion } from "@petrina/repositories/git";
import { fixtureFiles } from "@petrina/test-support/fixture-files";
import type { ProductRepository } from "@petrina/test-support/repositories";
import type { Engine } from "../engine.js";
import { createProductRepository, removeDir, tempDir } from "../fixtures.js";
import { checkBrief, checkPlan, type CheckScript } from "./check-agents.js";

interface PreparedWorktreeSeed {
  root: string;
  repo: string;
  worktree: string;
  index: string;
  head: string;
  tree: string;
}

const preparedSeeds = new Map<string, Promise<PreparedWorktreeSeed>>();
process.once("exit", () => {
  for (const seed of preparedSeeds.values()) {
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

function getPreparedSeed(base: string, message: string): Promise<PreparedWorktreeSeed> {
  const key = `${base}:${message}`;
  let pending = preparedSeeds.get(key);
  if (!pending) {
    pending = (async () => {
      const root = tempDir("petrina-checks-prepared-seed-");
      const { path: repo } = await createProductRepository(root, { origin: "none" });
      writeFileSync(join(repo, "greeting.txt"), "Hello\n");
      await commitChanges(repo, message);
      const { head = "", tree = "" } = await commitVersion(repo);
      return { root, repo, worktree: repo, index: join(repo, ".git", "index"), head, tree };
    })();
    preparedSeeds.set(key, pending);
  }
  return pending;
}

/** The canonical caller supplies its unchanged private product; every check and later repair still runs normally. */
export async function checksPrepared(engine: Engine, root: string, productId: string, repository: ProductRepository, script: CheckScript, available: () => void, entry: "built" | "exhausted-repairs" = "built") {
  available();
  const product = engine.s.products.find(product => product.id === productId);
  if (!product) throw new Error("The prepared checks require their registered private product");
  const path = fixtureFiles.canonical(repository.path);
  const active = () => {
    available(); engine.stopRequested.signal.throwIfAborted();
    if (engine.s.products.find(product => product.id === productId) !== product || product.path !== path || product.defaultBranch !== "main")
      throw new Error("The prepared checks lost their private initial product");
  };
  active();
  engine.setPoolPaused(true);
  await engine.waitUntilReady();
  active();
  const id = engine.addTask({ productId, title: "Add a greeting", description: "[no-check]", backlog: true });
  const task = engine.task(id)!, scope = executionFor(task);
  const base = repository.initialSha, branch = `prepared-checks-${id}`;
  const worktree = join(root, "built-work");
  available();
  Object.assign(scope.work, {
    worktree, branch, base: "main", baseSha: base, delivery: "local", preparation: "ready",
    report: { summary: "Added a greeting.", changes: ["People see a greeting"], tests: "Petrina runs the product checks." },
    source: { product: { ...product }, start: { kind: "default", branch: "main" },
      destination: { kind: "branch", mode: "local", repo: product.repo, branch: "main" }, confirmed: true, initialSha: base },
  });
  const plan = normalizePlan({ task: repositoryView(scope), result: checkPlan(script), roles: engine.s.roles,
    profiles: engine.s.profiles, plannerProfileId: "sol-high", releaseManagerProfileId: "opus-high", onUsable: id => engine.onUsable(id) });
  task.plan = structuredClone(plan) as DeepMutable<typeof plan>;
  const seed = await getPreparedSeed(base, engine["updates"].message(scope));
  available();
  copyLooseObjects(join(seed.repo, ".git", "objects"), join(path, ".git", "objects"));
  mkdirSync(worktree, { recursive: true });
  for (const entryName of readdirSync(seed.worktree)) {
    if (entryName === ".git") continue;
    cpSync(join(seed.worktree, entryName), join(worktree, entryName), { recursive: true });
  }
  const wtGitDir = join(path, ".git", "worktrees", branch);
  mkdirSync(wtGitDir, { recursive: true });
  writeFileSync(join(wtGitDir, "commondir"), "../..\n");
  writeFileSync(join(wtGitDir, "gitdir"), `${join(worktree, ".git")}\n`);
  writeFileSync(join(wtGitDir, "HEAD"), `ref: refs/heads/${branch}\n`);
  cpSync(seed.index, join(wtGitDir, "index"));
  writeFileSync(join(worktree, ".git"), `gitdir: ${wtGitDir}\n`);
  const refFile = join(path, ".git", "refs", "heads", branch);
  mkdirSync(dirname(refFile), { recursive: true });
  writeFileSync(refFile, `${seed.head}\n`);
  scope.work.savedVersion = { commit: seed.head, tree: seed.tree };
  const build = plan.stages.findIndex(stage => stage.kind === "do" && engine.role(stage.roleId, task)?.result === "build");
  if (build < 0) throw new Error("The prepared check recipe has no initial Builder stage");
  const brief = checkBrief();
  task.brief = { summary: brief.summary, forUsers: brief.forUsers, areas: brief.areas,
    acceptance: brief.acceptance.map(text => ({ text })), risks: brief.risks };
  scope.work.completedStages = plan.stages.slice(0, build + 1).map(stage => stage.id);
  task.risk = { level: "medium", why: "The planner did not rate it." };
  task.stageIndex = build + 1; task.sub = 0; task.startedAt = Date.now(); task.state = "waiting";
  task.column = engine.columnFor(task);
  // Hook/input contracts begin with the automatic repair allowance already spent. Their first
  // native failure still creates its own evidence and decision; later manual repairs run normally.
  if (entry === "exhausted-repairs") scope.work.checkReturns = 2;
  if (task.stageIndex !== build + 1 || scope.work.checks || scope.work.checkSetup || task.findings.length)
    throw new Error("The prepared check boundary must precede its first actual check observation");
  // No result, setup observation, passing check, approval or participant session is invented here.
  engine.commitNow(task);
  return id;
}
