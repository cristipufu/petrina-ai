import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { executionFor } from "@petrina/orchestrator";
import { commandInputText, deliveryLabel } from "@petrina/core";
import * as gitOps from "@petrina/repositories/git";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import type { Engine, EngineOptions } from "../engine.js";
import { Fakes, coordinator, git, gitWith, itemOf, makeWorld, REPO, taskOf, tempDir, until, type World } from "../support.js";
import { closeDirectDrivers, directDrivers } from "./direct-drivers.js";
import { fakeAgentSessions } from "./fake-agent-sessions.js";
import { installSharedWorkflowFastPaths, materializePreparedWorktree, readLooseCommit, readRef } from "./shared-preparation.js";
import { scriptedGitHub } from "../scripted-github.js";
import type { Scenario } from "../fake-agent.js";

type SourceWorld = Omit<World, "start"> & {
  /** The known private clone identity, installed inside this generation owner. */
  preparedProduct(engine: Engine): Promise<string>;
};
interface SourceFixture {
  w: SourceWorld;
  fakes: Fakes;
  /** Explicit options preserve the existing native-only callers without adding scripted defaults. */
  engine<T>(body: (engine: Engine) => Promise<T>, options?: EngineOptions): Promise<T>;
  /** Explicit already-written input; real source resolution/copy/checks/approval/publication still run. */
  candidate(engine: Engine, input: Parameters<Engine["addTask"]>[0], options?: { checks: "none" }): Promise<string>;
  /** Real proposal/normalization and admission from a canonical supplied plan. */
  planned(engine: Engine, input: Parameters<Engine["addTask"]>[0], start?: "plan" | "builder"): Promise<string>;
}
type Entry = { lifetime: ReturnType<typeof directDrivers>; closed: boolean };
const closed = () => new Error("Source fixture ownership is closing; no world, Engine or callback may start");

export function sourceWorlds(worldOptions: { skipReviewInputDiffs?: boolean } = {}) {
  const active = new Set<Entry>();
  let accepting = true, closing: Promise<void> | undefined;
  const available = (entry: Entry) => { if (!accepting || entry.closed) throw closed(); };
  const observeClose = (entry: Entry, work: Promise<void>) => {
    void work.then(() => { active.delete(entry); }, () => undefined);
    return work;
  };
  const closeEntry = (entry: Entry) => { entry.closed = true; return observeClose(entry, entry.lifetime.close()); };
  const close = (): Promise<void> => {
    if (closing) return closing;
    let done!: () => void, failed!: (error: unknown) => void;
    closing = new Promise<void>((resolve, reject) => { done = resolve; failed = reject; });
    accepting = false;
    const entries = [...active];
    for (const entry of entries) entry.closed = true;
    const joined = closeDirectDrivers(entries.map(entry => entry.lifetime));
    for (const entry of entries) observeClose(entry, entry.lifetime.close());
    void joined.then(() => { clearBranchSeeds(); done(); }, failed);
    return closing;
  };
  const world = async <T>(name: string, body: (fixture: SourceFixture) => Promise<T>, scenario: Scenario = {}, forks: Record<string, string> = {}): Promise<T> => {
    if (!accepting) throw closed();
    if (typeof body !== "function") throw new TypeError("Source fixtures require an owned whole-body callback");
    const root = tempDir(`petrina-source-${name}-`), lifetime = directDrivers(root);
    const entry: Entry = { lifetime, closed: false };
    active.add(entry);
    const result = await setupWithCleanup(() => lifetime.prepare(async () => {
      const w = await makeWorld(`source-${name}`, { owner: { root, open: (data, options) => lifetime.open(data, options) } });
      available(entry);
      const fakes = new Fakes(join(w.dir, "fake"));
      fakes.scenario({ planner: "short", builder: "plain", reopen: "resume", ...scenario });
      const github = scriptedGitHub({ [REPO]: { state: join(w.dir, "github.json"), remote: w.remote } });
      const services = scenario.builder === "work" ? { startAgentSession: fakeAgentSessions(fakes, { scriptPath: join(w.dir, "agents.json") }), toolProbe: privateWorldToolProbe(w), github } : { ...sourceAgents(w, fakes), github };
      const engine: SourceFixture["engine"] = async <Value>(callback: (engine: Engine) => Promise<Value>, options?: EngineOptions): Promise<Value> => {
        available(entry);
        const current = lifetime.open(w.data, options ?? {
          ...services,
          usageCommands: { codex: null, grok: null, antigravity: null },
          agentCommand: () => [process.execPath, join(import.meta.dir, "../fake-agent.ts"), fakes.dir, `--script=${join(w.dir, "agents.json")}`],
          gh: [process.execPath, join(import.meta.dir, "../fake-gh.ts"), join(w.dir, "github.json"), w.remote],
          remote: w.remote,
          sourceRemotes: forks,
          runCheckCommand: (req) => req.argv.length === 2 && req.argv[0] === "git" && req.argv[1] === "--version"
            ? { code: 0, stdout: "git version 2.45.0\n" }
            : undefined,
        });
        installSharedWorkflowFastPaths(current, {
          skipDriverPrepare: true,
          skipUpToDate: true,
          skipPrepareChecks: true,
          skipReviewCopies: true,
          skipReviewInputDiffs: worldOptions.skipReviewInputDiffs ?? true,
          fastCheckCapture: true,
          fastCleanup: true,
          fastCheckpoints: true,
        });
        const value = await setupWithCleanup(() => lifetime.run(current, () => callback(current)), () => lifetime.stop(current));
        await lifetime.stop(current);
        return value;
      };
      const { start: _start, ...visible } = w;
      available(entry);
      const candidate: SourceFixture["candidate"] = (current, input, options) => lifetime.run(current, async () => {
        const active = () => { available(entry); current.stopRequested.signal.throwIfAborted(); };
        active();
        const product = current.s.products.find(product => product.id === input.productId);
        if (!product) throw new Error("A source candidate requires its private product");
        if (options?.checks === "none") {
          if (product.checks?.length) throw new Error("A no-command source input cannot replace configured checks");
          product.checks = []; product.checksBy = "coordinator";
        } else if (product.checks === undefined)
          current.setProductChecks(input.productId, [{ name: "Version", command: "git --version" }]);
        const id = current.addTask({ ...input, backlog: true });
        const task = current.task(id)!, scope = executionFor(task);
        await current["sources"].propose(task, [task.workChoice!], true);
        active(); current["sources"].confirm(task);
        const title = deliveryLabel({ source: scope.work.source, delivery: scope.work.delivery });
        // Only the native source/delivery boundary is claimed, not a Planner/Builder/review execution.
        task.plan = { rationale: "An explicitly prepared change for the source boundary", plannerProfileId: "sol-high", stages: [
          { id: "source-delivery-check", kind: "gate", gate: "delivery", title: "Your delivery check", roleId: "coordinator", profileIds: [] },
          { id: "source-delivery", kind: "do", title, roleId: "release-manager", profileIds: ["sol-high"] },
        ] };
        task.stageIndex = 0; task.sub = 0; task.startedAt = Date.now();
        scope.work.report = { summary: "Added a greeting.", changes: ["People see a greeting"],
          description: "Adds a greeting file.\n\nPrepared source and delivery fixture input." };
        if (product.path && !scope.work.worktree && scope.work.source) {
          const start = scope.work.source.start;
          const gitDir = join(product.path, ".git");
          let prepared = false;
          if (start.kind === "pull-request") {
            const remoteSha = readRef(w.remote, `refs/pull/${start.number}/head`);
            if (remoteSha && readLooseCommit(gitDir, remoteSha)) {
              await current["sources"].refresh(scope, true);
              active();
              const sourceRefFile = join(gitDir, "refs", "petrina", "sources", task.id);
              mkdirSync(dirname(sourceRefFile), { recursive: true });
              writeFileSync(sourceRefFile, `${remoteSha}\n`);
              await materializePreparedWorktree(current, scope, product.path, remoteSha, remoteSha, "greeting.txt", "Hello (with left-pad)\n");
              active();
              prepared = true;
            }
          } else if (start.kind === "branch") {
            const remoteSha = readRef(w.remote, `refs/heads/${start.branch}`);
            if (remoteSha && readLooseCommit(gitDir, remoteSha)) {
              const originRefFile = join(gitDir, "refs", "remotes", "origin", ...start.branch.split("/"));
              mkdirSync(dirname(originRefFile), { recursive: true });
              writeFileSync(originRefFile, `${remoteSha}\n`);
              await materializePreparedWorktree(current, scope, product.path, remoteSha, remoteSha, "greeting.txt", "Hello (with left-pad)\n");
              active();
              prepared = true;
            }
          } else {
            const defaultBranch = product.defaultBranch ?? "main";
            const remoteSha = readRef(w.remote, `refs/heads/${defaultBranch}`);
            const localSha = readRef(gitDir, `refs/heads/${defaultBranch}`);
            if (remoteSha && remoteSha === localSha && readLooseCommit(gitDir, remoteSha)) {
              const originRefFile = join(gitDir, "refs", "remotes", "origin", ...defaultBranch.split("/"));
              mkdirSync(dirname(originRefFile), { recursive: true });
              writeFileSync(originRefFile, `${remoteSha}\n`);
              const baseName = scope.work.delivery === "local" ? defaultBranch : `origin/${defaultBranch}`;
              await materializePreparedWorktree(current, scope, product.path, baseName, remoteSha, "greeting.txt", "Hello (with left-pad)\n");
              active();
              prepared = true;
            }
          }
          if (!prepared) {
            if (start.kind !== "default") {
              const fetched = await current["sources"].fetch(scope, current.stopRequested.signal);
              active();
              await materializePreparedWorktree(current, scope, product.path, fetched.sha, fetched.sha, "greeting.txt", "Hello (with left-pad)\n");
              active();
            } else {
              await current["driver"]["prepare"](scope, current.stopRequested.signal);
              active();
              writeFileSync(join(scope.work.worktree!, "greeting.txt"), "Hello (with left-pad)\n");
              await gitOps.commitChanges(scope.work.worktree!, current["updates"].message(scope));
              active();
            }
          }
        } else {
          await current["driver"]["prepare"](scope, current.stopRequested.signal);
          active();
          writeFileSync(join(scope.work.worktree!, "greeting.txt"), "Hello (with left-pad)\n");
          await gitOps.commitChanges(scope.work.worktree!, current["updates"].message(scope));
          active();
        }
        task.state = "waiting";
        current.commitNow(task);
        current.schedule();
        return id;
      });
      const planned: SourceFixture["planned"] = (current, input, start = "plan") => lifetime.run(current, () => {
        const scenario = JSON.parse(readFileSync(join(fakes.dir, "scenario.json"), "utf8")) as Scenario;
        available(entry); current.stopRequested.signal.throwIfAborted();
        // Source subjects supply the same command recipe as discovery, never a passing result.
        if (current.s.products.find(product => product.id === input.productId)?.checks === undefined)
          current.setProductChecks(input.productId, sourceChecks(scenario).checks.map(check => ({ name: check.name, command: commandInputText(check.argv) })));
        return sourcePrepared(current, input, sourcePlan(scenario, [input.title, input.description ?? ""].join("\n")),
          start === "plan" ? { kind: "plan" } : { kind: "builder", brief: sourceBrief() }, () => available(entry));
      });
      const preparedProduct = (current: Engine) => lifetime.run(current, async () => {
        available(entry); current.stopRequested.signal.throwIfAborted();
        await current.waitUntilReady();
        available(entry); current.stopRequested.signal.throwIfAborted();
        return installPreparedProduct(current, acmeDemoProduct(w.clone));
      });
      return body({ w: { ...visible, preparedProduct }, fakes, engine, candidate, planned });
    }), () => closeEntry(entry));
    await closeEntry(entry);
    return result;
  };
  return { world, close };
}

let branchSeedCounter = 0;
const branchSeeds = new Map<string, Promise<{ origin: string; clone: string; sha: string }>>();

function clearBranchSeeds(): void {
  // Seeds live in the test runner's owned TMPDIR and are reclaimed after worker settlement.
}

function writeLooseGitObject(gitDir: string, type: "blob" | "tree" | "commit", body: Buffer): string {
  const header = Buffer.from(`${type} ${body.length}\0`, "utf8");
  const full = Buffer.concat([header, body]);
  const sha = createHash("sha1").update(full).digest("hex");
  const file = join(gitDir, "objects", sha.slice(0, 2), sha.slice(2));
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, deflateSync(full));
  }
  return sha;
}

export async function commitOnCloneBranch(
  clone: string,
  branchName: string,
  file: string,
  content: string,
  message: string,
): Promise<string> {
  const gitDir = join(clone, ".git");
  const parentSha = readRef(gitDir, `refs/heads/${branchName}`) ?? readRef(gitDir, "refs/heads/main");
  const parentCommit = parentSha ? readLooseCommit(gitDir, parentSha) : undefined;
  const parentTreeFile = parentCommit ? join(gitDir, "objects", parentCommit.tree.slice(0, 2), parentCommit.tree.slice(2)) : undefined;
  if (!file.includes("/") && parentSha && parentCommit && parentTreeFile && existsSync(parentTreeFile)) {
    const raw = inflateSync(readFileSync(parentTreeFile));
    const nul = raw.indexOf(0);
    if (nul > 0 && raw.subarray(0, nul).toString("utf8").startsWith("tree ")) {
      const buf = raw.subarray(nul + 1);
      const entries = new Map<string, { mode: string; name: string; oid: Buffer }>();
      let offset = 0;
      while (offset < buf.length) {
        const space = buf.indexOf(0x20, offset);
        const entryNul = buf.indexOf(0x00, space + 1);
        if (space < 0 || entryNul < 0 || entryNul + 21 > buf.length) break;
        const mode = buf.subarray(offset, space).toString("utf8");
        const entryName = buf.subarray(space + 1, entryNul).toString("utf8");
        const oid = Buffer.from(buf.subarray(entryNul + 1, entryNul + 21));
        entries.set(entryName, { mode, name: entryName, oid });
        offset = entryNul + 21;
      }
      const blobSha = writeLooseGitObject(gitDir, "blob", Buffer.from(content, "utf8"));
      entries.set(file, { mode: "100644", name: file, oid: Buffer.from(blobSha, "hex") });
      const sorted = [...entries.values()].sort((a, b) =>
        Buffer.compare(
          Buffer.from(a.mode === "40000" ? `${a.name}/` : a.name, "utf8"),
          Buffer.from(b.mode === "40000" ? `${b.name}/` : b.name, "utf8"),
        ),
      );
      const treeBody = Buffer.concat(
        sorted.map((entry) => Buffer.concat([Buffer.from(`${entry.mode} ${entry.name}\0`, "utf8"), entry.oid])),
      );
      const treeSha = writeLooseGitObject(gitDir, "tree", treeBody);
      const msg = message.endsWith("\n") ? message : `${message}\n`;
      const commitText = `tree ${treeSha}\nparent ${parentSha}\nauthor Test <test@example.com> 1700000000 +0000\ncommitter Test <test@example.com> 1700000000 +0000\n\n${msg}`;
      const commitSha = writeLooseGitObject(gitDir, "commit", Buffer.from(commitText, "utf8"));
      const refFile = join(gitDir, "refs", "heads", ...branchName.split("/"));
      mkdirSync(dirname(refFile), { recursive: true });
      writeFileSync(refFile, `${commitSha}\n`);
      return commitSha;
    }
  }
  await git(clone, "switch", "-q", ...(readRef(gitDir, `refs/heads/${branchName}`) ? [branchName] : ["-c", branchName]));
  writeFileSync(join(clone, file), content);
  await git(clone, "add", ".");
  await git(clone, "commit", "-qm", message);
  const sha = readFileSync(join(gitDir, "refs", "heads", ...branchName.split("/")), "utf8").trim();
  await git(clone, "switch", "-q", "main");
  return sha;
}

function getBranchSeed(w: SourceWorld, name: string): Promise<{ origin: string; clone: string; sha: string }> {
  const key = `${w.initial}\0${name}`;
  let existing = branchSeeds.get(key);
  if (!existing) {
    const id = ++branchSeedCounter;
    existing = (async () => {
      const dir = tempDir(`petrina-source-branch-seed-${id}-`);
      const origin = join(dir, "github.git");
      const clone = join(dir, "clone");
      cpSync(w.remote, origin, { recursive: true });
      cpSync(w.clone, clone, { recursive: true });
      const sha = await commitOnCloneBranch(clone, name, "source.txt", "Existing source work\n", "Existing source work");
      cpSync(join(clone, ".git", "objects"), join(origin, "objects"), { recursive: true, force: true });
      const originRef = join(origin, "refs", "heads", ...name.split("/"));
      mkdirSync(dirname(originRef), { recursive: true });
      writeFileSync(originRef, `${sha}\n`);
      return { origin, clone, sha };
    })();
    branchSeeds.set(key, existing);
  }
  return existing;
}

export async function branch(w: SourceWorld, name = "release-2.x", remote = w.remote): Promise<string> {
  if (remote === w.remote) {
    const seed = await getBranchSeed(w, name);
    cpSync(seed.origin, w.remote, { recursive: true, force: true });
    cpSync(seed.clone, w.clone, { recursive: true, force: true });
    return seed.sha;
  }
  const sha = await commitOnCloneBranch(w.clone, name, "source.txt", "Existing source work\n", "Existing source work");
  cpSync(join(w.clone, ".git", "objects"), join(remote, "objects"), { recursive: true, force: true });
  const targetRef = join(remote, "refs", "heads", ...name.split("/"));
  mkdirSync(dirname(targetRef), { recursive: true });
  writeFileSync(targetRef, `${sha}\n`);
  return sha;
}
export async function pull(w: SourceWorld, fork = false): Promise<{ sha: string; remote: string }> {
  const seed = await getBranchSeed(w, "review-work");
  const remote = fork ? join(w.dir, "fork.git") : w.remote;
  cpSync(seed.origin, remote, { recursive: true, force: true });
  cpSync(seed.clone, w.clone, { recursive: true, force: true });
  if (fork) cpSync(join(seed.origin, "objects"), join(w.remote, "objects"), { recursive: true, force: true });
  const prRef = join(w.remote, "refs", "pull", "7", "head");
  mkdirSync(dirname(prRef), { recursive: true });
  writeFileSync(prRef, `${seed.sha}\n`);
  w.setGitHub((state) => {
    state.forks = fork ? { "contributor/demo": remote } : {};
    state.prs.push({ number: 7, url: `https://github.com/${REPO}/pull/7`, state: "OPEN", title: "Original PR title", body: "Original description", headRefName: "review-work", baseRefName: "main", headRefOid: seed.sha, headRepository: { nameWithOwner: fork ? "contributor/demo" : REPO }, isCrossRepository: fork });
  });
  return { sha: seed.sha, remote };
}
export async function planGate(engine: Engine, id: string) {
  return until(engine, (state) => !!itemOf(state, id, "plan") || taskOf(state, id).state === "failed", coordinator([]));
}
export async function deliveryGate(engine: Engine, id: string) {
  return until(engine, (state) => !!itemOf(state, id, "delivery") || taskOf(state, id).state === "failed", coordinator(["plan", "design"]));
}
/** The task's commit on the product copy. A finished local delivery may already have removed the working copy. */
export function taskCommit(w: SourceWorld, task: { branch?: string }): Promise<string> {
  const ref = join(w.clone, ".git", "refs", "heads", ...task.branch!.split("/"));
  if (existsSync(ref)) return Promise.resolve(readFileSync(ref, "utf8").trim());
  return git(w.clone, "rev-parse", task.branch!);
}
export async function advance(_w: SourceWorld, remote: string, name: string, file = "NEWS.md", content = "New source work\n"): Promise<string> {
  const message = "New source work\n";
  const parentSha = readRef(remote, `refs/heads/${name}`);
  const parentCommit = parentSha ? readLooseCommit(remote, parentSha) : undefined;
  const parentTreeFile = parentCommit ? join(remote, "objects", parentCommit.tree.slice(0, 2), parentCommit.tree.slice(2)) : undefined;
  if (!file.includes("/") && parentSha && parentCommit && parentTreeFile && existsSync(parentTreeFile)) {
    const raw = inflateSync(readFileSync(parentTreeFile));
    const nul = raw.indexOf(0);
    if (nul > 0 && raw.subarray(0, nul).toString("utf8").startsWith("tree ")) {
      const buf = raw.subarray(nul + 1);
      const entries = new Map<string, { mode: string; name: string; oid: Buffer }>();
      let offset = 0;
      let ok = true;
      while (offset < buf.length) {
        const space = buf.indexOf(0x20, offset);
        const entryNul = buf.indexOf(0x00, space + 1);
        if (space < 0 || entryNul < 0 || entryNul + 21 > buf.length) {
          ok = false;
          break;
        }
        const mode = buf.subarray(offset, space).toString("utf8");
        const entryName = buf.subarray(space + 1, entryNul).toString("utf8");
        const oid = Buffer.from(buf.subarray(entryNul + 1, entryNul + 21));
        entries.set(entryName, { mode, name: entryName, oid });
        offset = entryNul + 21;
      }
      if (ok) {
        const blobSha = writeLooseGitObject(remote, "blob", Buffer.from(content, "utf8"));
        entries.set(file, { mode: "100644", name: file, oid: Buffer.from(blobSha, "hex") });
        const sorted = [...entries.values()].sort((a, b) =>
          Buffer.compare(
            Buffer.from(a.mode === "40000" ? `${a.name}/` : a.name, "utf8"),
            Buffer.from(b.mode === "40000" ? `${b.name}/` : b.name, "utf8"),
          ),
        );
        const treeBody = Buffer.concat(
          sorted.map((entry) => Buffer.concat([Buffer.from(`${entry.mode} ${entry.name}\0`, "utf8"), entry.oid])),
        );
        const treeSha = writeLooseGitObject(remote, "tree", treeBody);
        const commitText = `tree ${treeSha}\nparent ${parentSha}\nauthor Someone else <other@example.com> 1700000000 +0000\ncommitter Someone else <other@example.com> 1700000000 +0000\n\n${message}`;
        const commitSha = writeLooseGitObject(remote, "commit", Buffer.from(commitText, "utf8"));
        const refFile = join(remote, "refs", "heads", ...name.split("/"));
        mkdirSync(dirname(refFile), { recursive: true });
        writeFileSync(refFile, `${commitSha}\n`);
        return commitSha;
      }
    }
  }
  const stream = [
    `commit refs/heads/${name}`,
    "committer Someone else <other@example.com> 1700000000 +0000",
    `data ${Buffer.byteLength(message)}`,
    message,
    `from refs/heads/${name}^0`,
    `M 100644 inline ${file}`,
    `data ${Buffer.byteLength(content)}`,
    content,
    "",
  ].join("\n");
  await gitWith({ input: stream }, "--git-dir", remote, "fast-import", "--quiet");
  return readFileSync(join(remote, "refs", "heads", ...name.split("/")), "utf8").trim();
}

import { sourcePrepared } from "./source-prepared.js";
import { sourceAgents, sourcePlan, sourceBrief, sourceChecks } from "./source-agents.js";
import { privateWorldToolProbe } from "./world-tool-probe.js";
import { acmeDemoProduct, installPreparedProduct } from "./prepared-product.js";
