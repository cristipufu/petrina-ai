import { installPreparedProduct, privateCloneProduct } from "./prepared-product.js";
import { installSharedWorkflowFastPaths } from "./shared-preparation.js";
import type { EngineCaseOwner } from "./engine-cases.js";
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { commandInputText } from "../../src/checks.js";
import { executionFor } from "@petrina/orchestrator";
import * as gitOps from "@petrina/repositories/git";
import { git, createProductRepository, removeDir, tempDir } from "../fixtures.js";
import { privateAgentToolProbe } from "../scripted-probes.js";

function readLooseCommit(commonDir: string, sha: string): { tree: string; parents: string[] } {
  const raw = inflateSync(readFileSync(join(commonDir, "objects", sha.slice(0, 2), sha.slice(2)))).toString("utf8");
  const body = raw.slice(raw.indexOf("\0") + 1);
  const tree = /^tree ([0-9a-f]{40,64})$/m.exec(body)?.[1] ?? "";
  const parents = [...body.matchAll(/^parent ([0-9a-f]{40,64})$/gm)].map(match => match[1]!);
  return { tree, parents };
}

function readRef(commonDir: string, ref: string): string {
  const refPath = join(commonDir, ref);
  if (existsSync(refPath)) return readFileSync(refPath, "utf8").trim();
  const packed = join(commonDir, "packed-refs");
  if (existsSync(packed)) {
    for (const line of readFileSync(packed, "utf8").split("\n")) {
      if (line.endsWith(` ${ref}`)) return line.slice(0, line.indexOf(" ")).trim();
    }
  }
  return "";
}

function readWorktreeHead(dir: string): { sha: string; tree: string; commonDir: string } {
  const dotGit = join(dir, ".git");
  const gitDir = statSync(dotGit).isFile()
    ? resolve(dir, readFileSync(dotGit, "utf8").replace(/^gitdir:\s*/, "").trim())
    : dotGit;
  const commonDir = existsSync(join(gitDir, "commondir"))
    ? resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim())
    : gitDir;
  const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
  const sha = head.startsWith("ref: ") ? readRef(commonDir, head.slice(5).trim()) : head;
  return { sha, tree: readLooseCommit(commonDir, sha).tree, commonDir };
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

interface AdmissionSeed {
  root: string;
  repo: string;
  initial: string;
  worktrees: Map<string, { sha: string; tree: string; copy: string; index: string }>;
  lands: Map<string, { sha: string; index: string }>;
}

let cachedSeed: Promise<AdmissionSeed> | undefined;
process.once("exit", () => {
  if (!cachedSeed) return;
  void cachedSeed.then(seed => removeDir(seed.root)).catch(() => {});
});

function getAdmissionSeed(): Promise<AdmissionSeed> {
  return cachedSeed ??= (async () => {
    const root = tempDir("petrina-admission-seed-");
    const { path: repo, initialSha: initial } = await createProductRepository(root, { origin: "none" });
    return { root, repo, initial, worktrees: new Map(), lands: new Map() };
  })();
}

async function ensureWorktreeTemplate(seed: AdmissionSeed, name: string, needsFix: boolean, conflict: boolean) {
  const key = `${name}:${needsFix ? 1 : 0}:${conflict ? 1 : 0}`;
  let tpl = seed.worktrees.get(key);
  if (!tpl) {
    const id = seed.worktrees.size + 1;
    const copy = join(seed.root, `wt-${id}`), branch = `seed-wt-${id}`;
    await gitOps.ensureWorktree(seed.repo, copy, branch, seed.initial);
    writeFileSync(join(copy, "task-name"), name);
    if (needsFix) writeFileSync(join(copy, "needs-main-fix.txt"), "This task needs the already-landed fix\n");
    if (conflict) writeFileSync(join(copy, "README.md"), "The task rewrites this file\n");
    const message = `Improve ${name}\n\nImprove ${name}\n\n- Improved ${name}\n\nBuilt by Petrina: Builder (GPT-5.4, high)`;
    await gitOps.commitChanges(copy, message);
    const { sha, tree } = readWorktreeHead(copy);
    const gitDir = resolve(copy, readFileSync(join(copy, ".git"), "utf8").replace(/^gitdir:\s*/, "").trim());
    tpl = { sha, tree, copy, index: join(gitDir, "index") };
    seed.worktrees.set(key, tpl);
  }
  return tpl;
}

async function ensureLandTemplate(seed: AdmissionSeed, conflict: boolean, discovery: boolean) {
  const key = `${conflict ? 1 : 0}:${discovery ? 1 : 0}`;
  let tpl = seed.lands.get(key);
  if (!tpl) {
    const id = seed.lands.size + 1;
    const copy = join(seed.root, `land-${id}`), branch = `seed-land-${id}`;
    await gitOps.ensureWorktree(seed.repo, copy, branch, seed.initial);
    writeFileSync(join(copy, conflict ? "README.md" : "main-fix.txt"), conflict ? "Main rewrites this file differently\n" : "The previously landed fix\n");
    if (discovery) writeFileSync(join(copy, "package.json"), JSON.stringify({ name: "changed-check-inputs", scripts: { test: "the new required command" } }));
    await gitOps.commitChanges(copy, "Land the current fix");
    const { sha } = readWorktreeHead(copy);
    const gitDir = resolve(copy, readFileSync(join(copy, ".git"), "utf8").replace(/^gitdir:\s*/, "").trim());
    tpl = { sha, index: join(gitDir, "index") };
    seed.lands.set(key, tpl);
  }
  return tpl;
}

/** Only review preparation is exercised: no planning, building or reviewer process is needed. */
async function prepareCheckAdmission(owner: EngineCaseOwner) {
  const root = owner.root;
  const log = join(root, "checks.jsonl"), script = join(root, "check.ts");
  const engine = installSharedWorkflowFastPaths(
    owner.open(join(root, "data"), {
      agentCommand: () => { throw new Error("Review preparation must not start an agent"); },
      toolProbe: privateAgentToolProbe(),
      terminals: () => [],
      runCheckCommand: async (req) => {
        if (req.argv[0] !== process.execPath || req.argv[1] !== script) return undefined;
        const [targetLog, targetRoot, command] = req.argv.slice(2);
        const name = readFileSync(join(req.cwd, "task-name"), "utf8");
        const { sha, tree } = readWorktreeHead(req.cwd);
        const fix = existsSync(join(req.cwd, "main-fix.txt"));
        appendFileSync(targetLog!, `${JSON.stringify({ name, sha, tree, fix, command })}\n`);
        writeFileSync(join(targetRoot!, `${name}.started`), "ready");
        if (name === "first") {
          while (!existsSync(join(targetRoot!, "release-first")) && !req.signal?.aborted) await Bun.sleep(5);
        }
        if (req.signal?.aborted) return { code: 130 };
        return { code: existsSync(join(req.cwd, "needs-main-fix.txt")) && !fix ? 1 : 0 };
      },
    }),
    { skipDriverPrepare: false, skipUpToDate: true, fastCheckCapture: true },
  );
  engine.schedule = () => engine.checkQueue.pump();
  engine["cleanup"].sweep = async () => {};
  await engine.waitUntilReady();
  const admissionSeed = await getAdmissionSeed();
  const clone = join(root, "clone"), initial = admissionSeed.initial;
  cpSync(admissionSeed.repo, clone, { recursive: true });
  const productId = installPreparedProduct(engine, privateCloneProduct(clone));

  // check-admission never starts a reviewer; avoid building git diff/status review inputs after checks pass.
  engine["reviews"]["workflow"]["effects"].input = async () => ({ file: "", digest: "", heads: {}, trees: {} });
  engine["reviews"]["prepareChecks"] = async (scope, signal) => {
    engine["updates"].clearObservedHead(scope);
    if (await engine["updates"].upToDate(scope, signal) === "conflict") return false;
    delete scope.task.handChanges;
    const sha = engine["updates"].consumeObservedHead(scope) ?? readWorktreeHead(scope.work.worktree!).sha;
    scope.work.tamper = { at: Date.now(), sha, problems: [] };
    engine.log(scope, "done", "Tamper check passed: no tests removed or skipped");
    return true;
  };
  const origUpToDate = engine["updates"].upToDate.bind(engine["updates"]);
  engine["updates"].upToDate = async (scope, signal) => {
    if (!scope.work.updating && scope.work.savedVersion?.commit && scope.work.worktree) {
      const mainSha = readRef(join(clone, ".git"), "refs/heads/main");
      const current = readWorktreeHead(scope.work.worktree);
      if (mainSha === scope.work.baseSha && current.sha === scope.work.savedVersion.commit) {
        if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
        engine["updates"]["observedHeads"].set(scope.work, current.sha);
        return "current";
      }
    }
    return origUpToDate(scope, signal);
  };

  writeFileSync(script, `import { appendFileSync } from "node:fs";`);
  const define = (command: string) => engine.setProductChecks(productId, [{ name: "Tests", command: commandInputText([process.execPath, script, log, root, command]) }]);
  define("original");
  const add = (name: string, needsFix = false, conflict = false) => owner.prepare(async () => {
    const task = engine.task(engine.addTask({ productId, title: name, delivery: "local", backlog: true }))!;
    task.state = "running"; task.startedAt = 1; task.stageIndex = 1; task.rounds = { review: 1 };
    task.plan = { rationale: "Check review admission", plannerProfileId: "sol-high", stages: [
      { id: "build", title: "Build", kind: "do", roleId: "builder", profileIds: ["sol-high"] },
      { id: "review", title: "Review", kind: "review-chain", roleId: "code-reviewer", profileIds: ["sol-high"], maxRounds: 2 },
    ] };
    const scope = executionFor(task), copy = join(root, name), branch = `task-${name}`;
    const seed = await getAdmissionSeed();
    const tpl = await ensureWorktreeTemplate(seed, name, needsFix, conflict);
    copyLooseObjects(join(seed.repo, ".git", "objects"), join(clone, ".git", "objects"));
    mkdirSync(copy, { recursive: true });
    for (const entry of readdirSync(tpl.copy)) {
      if (entry === ".git") continue;
      cpSync(join(tpl.copy, entry), join(copy, entry), { recursive: true });
    }
    const wtGitDir = join(clone, ".git", "worktrees", name);
    mkdirSync(wtGitDir, { recursive: true });
    writeFileSync(join(wtGitDir, "commondir"), "../..\n");
    writeFileSync(join(wtGitDir, "gitdir"), `${join(copy, ".git")}\n`);
    writeFileSync(join(wtGitDir, "HEAD"), `ref: refs/heads/${branch}\n`);
    cpSync(tpl.index, join(wtGitDir, "index"));
    writeFileSync(join(copy, ".git"), `gitdir: ${wtGitDir}\n`);
    const refFile = join(clone, ".git", "refs", "heads", branch);
    mkdirSync(dirname(refFile), { recursive: true });
    writeFileSync(refFile, `${tpl.sha}\n`);
    Object.assign(scope.work, {
      worktree: copy, branch, base: "main", baseSha: initial,
      savedVersion: { commit: tpl.sha, tree: tpl.tree },
      report: { title: `Improve ${name}`, summary: `Improve ${name}`, changes: [`Improved ${name}`] },
    });
    return { task, scope, copy };
  });
  const controller = new AbortController();
  owner.onStop(() => controller.abort());
  const review = (entry: Awaited<ReturnType<typeof add>>) => owner.run(engine, () => engine["reviews"].runReview(entry.task, entry.task.plan!.stages[1]!, controller.signal));
  const evidence = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as { name: string; sha: string; tree: string; fix: boolean; command: string }) : [];
  const land = async (conflict = false, discovery = false) => {
    const seed = await getAdmissionSeed();
    const tpl = await ensureLandTemplate(seed, conflict, discovery);
    copyLooseObjects(join(seed.repo, ".git", "objects"), join(clone, ".git", "objects"));
    writeFileSync(join(clone, conflict ? "README.md" : "main-fix.txt"), conflict ? "Main rewrites this file differently\n" : "The previously landed fix\n");
    if (discovery) writeFileSync(join(clone, "package.json"), JSON.stringify({ name: "changed-check-inputs", scripts: { test: "the new required command" } }));
    cpSync(tpl.index, join(clone, ".git", "index"));
    writeFileSync(join(clone, ".git", "refs", "heads", "main"), `${tpl.sha}\n`);
    return tpl.sha;
  };
  const head = (dir: string) => readWorktreeHead(dir).sha;
  const mergeBase = async (dir: string, a: string, b: string) => {
    const commonDir = join(clone, ".git");
    if (a === b) return a;
    if (readLooseCommit(commonDir, b).parents.includes(a)) return a;
    if (readLooseCommit(commonDir, a).parents.includes(b)) return b;
    return git(dir, "merge-base", a, b);
  };
  const release = () => writeFileSync(join(root, "release-first"), "continue");
  owner.onStop(release);
  return { root, engine, clone, add, review, evidence, land, head, mergeBase, release, define };
}

export function checkAdmissionFixture<T>(owner: EngineCaseOwner, body: (fixture: Awaited<ReturnType<typeof prepareCheckAdmission>>) => Promise<T>): Promise<T> {
  return owner.prepare(async () => { const fixture = await prepareCheckAdmission(owner); owner.check(); return body(fixture); });
}
