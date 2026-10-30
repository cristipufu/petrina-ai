import { installPreparedProduct, acmeDemoProduct, privateCloneProduct } from "../../fixtures/prepared-product.js";
import type { Engine } from "../../engine.js";
import { completeAll, CLEANUP_WORDS, displayTask, type Task } from "@petrina/core";
import { gitCommand } from "@petrina/test-support/git-program";
import { fixtureFiles } from "@petrina/test-support/fixture-files";
import { executionFor, resolveSource, type RepositoryContext, type SourceQueries } from "@petrina/orchestrator";
import { checkSetupContract } from "@petrina/repositories/check-environment";

import { Coordination } from "../../../src/coordination.js";
import { afterAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";

import { addCopy, branchName, ensureWorktree, removeWorktree } from "@petrina/repositories/git";
import { finish, git, itemOf, taskOf, tempDir, until, waitFor, waitForFile } from "../../support.js";
import { cleanupBuildOutput } from "../../fixtures/cleanup-agents.js";
import { cleanupFixture, texts, cleaned, listed, expectUnconfirmed, type CleanupWorld } from "../../fixtures/cleanup-world.js";

const EMPTY_CHECKS_DEF = createHash("sha256").update("[]").digest("hex");
const EMPTY_SETUP_CONTRACT = checkSetupContract(undefined);

function branchSha(clone: string, branch: string): string {
  return readFileSync(join(clone, ".git", "refs", "heads", branch), "utf8").trim();
}

function remoteRef(remote: string, ref: string): string | undefined {
  const file = join(remote, ref);
  return existsSync(file) ? readFileSync(file, "utf8").trim() : undefined;
}

async function gone(w: Pick<CleanupWorld, "clone" | "dir">, task: Task): Promise<void> {
  expect(existsSync(task.worktree!), `${task.id}: ${task.worktree} ${JSON.stringify(task.cleanup)}`).toBe(false);
  expect(await listed(w, task.worktree!)).toBe(false);
  expect(branchSha(w.clone, task.branch!)).toMatch(/^[a-f0-9]{40}$/);
  expect(readFileSync(join(w.dir, "shared-cache", "keep"), "utf8")).toBe("shared");
}

function writeGitObject(gitDir: string, type: "blob" | "tree" | "commit", content: Buffer): string {
  const header = Buffer.from(`${type} ${content.length}\0`);
  const full = Buffer.concat([header, content]);
  const sha = createHash("sha1").update(full).digest("hex");
  const dir = join(gitDir, "objects", sha.slice(0, 2));
  const file = join(dir, sha.slice(2));
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, deflateSync(full));
  }
  return sha;
}

function writeGreetingCommit(gitDir: string, branch: string, parentSha: string, message: string): { commit: string; tree: string } {
  const readmeSha = writeGitObject(gitDir, "blob", Buffer.from("# Demo\n"));
  const greetingSha = writeGitObject(gitDir, "blob", Buffer.from("Hello\n"));
  const treeContent = Buffer.concat([
    Buffer.from("100644 README.md\0"), Buffer.from(readmeSha, "hex"),
    Buffer.from("100644 greeting.txt\0"), Buffer.from(greetingSha, "hex"),
  ]);
  const tree = writeGitObject(gitDir, "tree", treeContent);
  const person = "Test <test@example.com> 1700000000 +0000";
  const body = message.endsWith("\n") ? message : `${message}\n`;
  const commit = writeGitObject(gitDir, "commit", Buffer.from(`tree ${tree}\nparent ${parentSha}\nauthor ${person}\ncommitter ${person}\n\n${body}`));
  const refPath = join(gitDir, "refs", "heads", branch);
  mkdirSync(dirname(refPath), { recursive: true });
  writeFileSync(refPath, `${commit}\n`);
  return { commit, tree };
}

let cachedGreetingIndexPromise: Promise<{ root: string; index: string }> | undefined;
process.once("exit", () => {
  if (cachedGreetingIndexPromise) {
    void cachedGreetingIndexPromise.then(({ root }) => rmSync(root, { recursive: true, force: true })).catch(() => {});
  }
});

function getGreetingIndex(clonePath: string): Promise<string> {
  cachedGreetingIndexPromise ??= (async () => {
    const root = tempDir("petrina-cleanup-index-seed-");
    const repo = join(root, "repo");
    cpSync(clonePath, repo, { recursive: true });
    writeFileSync(join(repo, "greeting.txt"), "Hello\n");
    await git(repo, "add", "greeting.txt");
    return { root, index: join(repo, ".git", "index") };
  })();
  return cachedGreetingIndexPromise.then(({ index }) => index);
}

async function materializeCleanupWorktree(clonePath: string, worktree: string, branch: string): Promise<void> {
  const index = await getGreetingIndex(clonePath);
  mkdirSync(worktree, { recursive: true });
  const canonicalRoot = fixtureFiles.canonical(clonePath);
  const canonicalWorktree = fixtureFiles.canonical(worktree);
  writeFileSync(join(canonicalWorktree, "README.md"), "# Demo\n");
  writeFileSync(join(canonicalWorktree, "greeting.txt"), "Hello\n");
  const wtGitDir = join(canonicalRoot, ".git", "worktrees", branch.replace(/\//g, "-"));
  mkdirSync(wtGitDir, { recursive: true });
  writeFileSync(join(wtGitDir, "commondir"), "../..\n");
  writeFileSync(join(wtGitDir, "gitdir"), `${join(canonicalWorktree, ".git")}\n`);
  writeFileSync(join(wtGitDir, "HEAD"), `ref: refs/heads/${branch}\n`);
  cpSync(index, join(wtGitDir, "index"));
  writeFileSync(join(canonicalWorktree, ".git"), `gitdir: ${wtGitDir}\n`);
}

type CleanupInputWorld = Pick<CleanupWorld, "script" | "signal" | "clone" | "data" | "initial">;
const available = (engine: Engine, w: CleanupInputWorld) => {
  w.signal.throwIfAborted();
  engine.stopRequested.signal.throwIfAborted();
};

async function addSavedCleanupInput(engine: Engine, w: CleanupInputWorld, request: Parameters<Engine["addTask"]>[0]): Promise<string> {
  available(engine, w);
  const id = engine.addTask({ ...request, backlog: true });
  const task = engine.task(id)!, scope = executionFor(task), product = engine.s.products.find(product => product.id === scope.work.productId)!;
  const path = fixtureFiles.canonical(w.clone), remote = product.remote, workProduct = scope.work.workProduct;
  const active = () => {
    available(engine, w);
    if (engine.task(id) !== task || task.repositories || task.workRows || scope.work.workProduct !== workProduct
      || executionFor(task).work !== scope.work || engine.productOf(scope) !== product || product.path !== path
      || product.defaultBranch !== "main" || product.remote !== remote
      || workProduct?.id !== product.id || workProduct.path !== path || workProduct.repo !== product.repo
      || workProduct.defaultBranch !== "main" || workProduct.remote !== remote
      || !(product.id === "demo" && product.repo === "acme/demo" && remote === "https://github.com/acme/demo.git"
        || product.id === "clone" && product.repo === "local/clone" && remote === undefined))
      throw new Error("The saved cleanup input requires its captured private main product");
  };
  active();
  task.startedAt = Date.now(); task.state = "paused"; task.stageIndex = 2; task.holdsSlot = false;
  task.plan = { rationale: "Supplied work preceding owned delivery and working-copy cleanup", plannerProfileId: "sol-high", stages: [
    { id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
    { id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high"] },
    { id: "delivery", kind: "gate", title: "Your delivery check", roleId: "coordinator", profileIds: [], gate: "delivery" },
    { id: "publish", kind: "do", title: "Publish", roleId: "release-manager", profileIds: ["opus-high"] },
  ] };
  const choice = { productId: product.id, delivery: scope.work.delivery, startFrom: { kind: "default" as const } };
  let validated = false;
  const queries: SourceQueries = {
    async validBranch(name) {
      active();
      if (validated || name !== "main") throw new Error("Unexpected cleanup fixture branch validation");
      validated = true;
      return true;
    },
    async requireBranch() { active(); throw new Error("Cleanup input must not request a remote branch lookup"); },
    async pullRequest() { active(); throw new Error("Cleanup input must not request pull-request resolution"); },
  };
  const source = await resolveSource(scope, choice, engine.s.products, queries);
  active();
  if (!validated) throw new Error("The saved cleanup source did not consume its main precondition");
  scope.work.report = { summary: "Added the greeting", title: task.title, changes: ["People see a greeting"], description: "The completed fixture change" };
  const branch = branchName(task.title, task.id);
  const worktree = join(w.data, "worktrees", product.id, task.id);
  const base = scope.work.delivery !== "local" ? "origin/main" : "main";
  if (scope.work.delivery !== "local") {
    const originMain = join(w.clone, ".git", "refs", "remotes", "origin", "main");
    mkdirSync(dirname(originMain), { recursive: true });
    writeFileSync(originMain, `${w.initial}\n`);
  }
  const { commit, tree } = writeGreetingCommit(join(w.clone, ".git"), branch, w.initial, engine["updates"].message(scope));
  scope.work.source = { ...source, confirmed: true, initialSha: w.initial };
  scope.work.base = base;
  scope.work.baseSha = w.initial;
  scope.work.savedVersion = { commit, tree };
  await materializeCleanupWorktree(product.path!, worktree, branch);
  active();
  engine.log(scope, "milestone", "Set up a fresh working copy");
  scope.work.branch = branch;
  scope.work.worktree = worktree;
  cleanupBuildOutput(w, worktree);
  engine.commitNow(task);
  return id;
}

async function addPreparedCleanupTask(engine: Engine, w: CleanupInputWorld, request: Parameters<Engine["addTask"]>[0]): Promise<string> {
  const id = await addSavedCleanupInput(engine, w, request);
  available(engine, w);
  const task = engine.task(id)!, scope = executionFor(task), product = engine.s.products.find(product => product.id === scope.work.productId)!;
  scope.work.reviewedTree = scope.work.savedVersion!.tree;
  product.checks = []; product.checksBy = "coordinator";
  task.state = "waiting";
  engine.commitNow(task);
  engine.schedule();
  return id;
}

async function addObservedCleanupPullRequest(engine: Engine, w: CleanupInputWorld & Pick<CleanupWorld, "remote">, request: Parameters<Engine["addTask"]>[0]): Promise<string> {
  const id = await addSavedCleanupInput(engine, w, request);
  available(engine, w);
  const task = engine.task(id)!, scope = executionFor(task), work = scope.work;
  if (work.delivery !== "pull-request" || work.source?.destination.kind !== "new-pr" || !work.branch || !work.worktree)
    throw new Error("Cleanup pull-request observations need a prepared private new-PR copy");
  const head = work.savedVersion!.commit;
  writeGreetingCommit(w.remote, work.branch, w.initial, engine["updates"].message(scope));
  available(engine, w);
  const repo = work.source.product.repo, base = work.source.destination.branch;
  const opened = await engine.github.openPullRequest(repo, { head: work.branch, base, title: task.title, body: "Supplied pull request for native cleanup" });
  available(engine, w);
  if (!opened.ok) throw new Error(`The private cleanup pull request did not open: ${opened.error}`);
  const observed = await engine.github.pullRequests(repo, work.branch);
  available(engine, w);
  if (!observed.ok) throw new Error(`The private cleanup pull request could not be observed: ${observed.error}`);
  const matches = observed.value.filter(pr => pr.head === work.branch && pr.base === base && pr.commit === head && pr.state === "open" && pr.url === opened.url && !pr.fork);
  if (matches.length !== 1) throw new Error("The private cleanup pull request did not match its real branch and commit");
  engine["shipping"]["recordPr"](scope, matches[0]!, "opened");
  return id;
}

function configureCleanupEngine(engine: Engine, w: CleanupWorld): void {
  engine["connections"].fetchDefault = async (scope, signal) => {
    const connection = await engine["connections"].connection(scope, signal);
    if (!connection.ok) return { ok: false, error: connection.reason, ...(connection.missing ? { missing: true } : {}) };
    const product = engine.repositoryOf(scope)!;
    const branch = product.defaultBranch ?? "main";
    const remoteSha = readFileSync(join(w.remote, "refs", "heads", branch), "utf8").trim();
    const refFile = join(product.path!, ".git", "refs", "remotes", "origin", branch);
    mkdirSync(dirname(refFile), { recursive: true });
    writeFileSync(refFile, `${remoteSha}\n`);
    return { ok: true, sha: remoteSha };
  };
  const basePrepare = engine["driver"]["prepare"].bind(engine["driver"]);
  engine["driver"]["prepare"] = async (scope: RepositoryContext, signal: AbortSignal) => {
    if (scope.work.worktree && scope.work.branch && scope.work.base && scope.work.baseSha && scope.work.savedVersion && !scope.work.hooking && existsSync(join(scope.work.worktree, ".git"))) {
      await engine.copyCleanups.get(scope.task.id);
      signal.throwIfAborted();
      engine.commit();
      return;
    }
    return basePrepare(scope, signal);
  };
  engine["checks"].noteHooks = async () => [];
  engine["checks"]["captureState"] = async (scope: RepositoryContext) => ({
    sha: scope.work.savedVersion?.commit,
    tree: scope.work.savedVersion?.tree,
    trackedChanged: false,
    hooks: [],
    definition: EMPTY_CHECKS_DEF,
    contract: EMPTY_SETUP_CONTRACT,
    requiredCommands: "[]",
  });
  engine["updates"].upToDate = async (scope: RepositoryContext, signal: AbortSignal, fresh = false) => {
    if (fresh && scope.work.delivery !== "local") await engine["connections"].fetchDefault(scope, signal);
    return "current" as const;
  };
  engine["updates"].patch = async (scope: RepositoryContext) => scope.work.savedVersion?.tree ?? "patch";
  Object.assign(engine["driver"]["checkpoint"]["effects"], {
    head: async (scope: RepositoryContext) => scope.work.savedVersion?.commit ?? branchSha(w.clone, scope.work.branch!),
    patch: (scope: RepositoryContext) => engine["updates"].patch(scope),
    writeGuide: async () => {},
    writeLearnings: async () => {},
    offerLearnings: async () => {},
  });
  engine["shipping"]["proofApprovalCurrent"] = async () => true;
  engine["shipping"]["backToWork"] = async (scope: RepositoryContext) => { await engine.agentCleanup.wait(scope.task.id); };
  engine["shipping"]["branchTip"] = async (scope: RepositoryContext) =>
    scope.work.savedVersion?.commit ?? branchSha(w.clone, scope.work.branch!);
  engine["shipping"]["rememberDelivery"] = async (scope: RepositoryContext, sha: string, branch: string) => {
    const product = engine.repositoryOf(scope);
    if (product && scope.work.savedVersion?.tree) {
      scope.work.confirmedDelivery = { sha, tree: scope.work.savedVersion.tree, branch, repo: product.repo, at: Date.now() };
    }
  };
}

const { world: baseWorld, close } = cleanupFixture();
const world: typeof baseWorld = (name, body, resources) => baseWorld(name, w => body({
  ...w,
  engine: (run, options) => w.engine(engine => {
    configureCleanupEngine(engine, w);
    return run(engine);
  }, options),
}), resources);
afterAll(close);

describe.concurrent("Finished tasks free their working copies", () => {
it("keeps existing pull-request updates out of the new-pull-request attribution check", async () => {
    await world("existing-pr-attribution", async w => {

      await w.engine(async engine => {
        try {
          engine.setPoolPaused(true);
          const productId = installPreparedProduct(engine, acmeDemoProduct(w.clone));
          const id = engine.addTask({ productId, title: "Update existing pull request", delivery: "pull-request" });
          const task = engine.task(id)!;
          const product = engine.activeState().products.find((entry) => entry.id === productId)!;
          executionFor(task).work.source = {
            product: { id: product.id, name: product.name, repo: product.repo, path: product.path },
            start: { kind: "pull-request", number: 77, url: "https://github.com/acme/demo/pull/77", headRepo: product.repo, branch: "existing-feature" },
            destination: { mode: "pull-request", kind: "update-pr", repo: product.repo, branch: "existing-feature" }, confirmed: true,
          };
          executionFor(task).work.shipping = { moves: 0, failures: 0, prepared: { tested: w.initial, summary: "Update existing work" } };
          executionFor(task).work.cleanup = { checkedDelivery: { tested: w.initial, base: "stale-base" } };
          const item = engine.raise(task, "shipping", "Interrupted update", false);
          engine.markDone(item);
          expect(task.state).toBe("done");
          expect(executionFor(task).work.cleanup!.checkedDelivery).toBeUndefined();
          expect(executionFor(task).work.cleanup!.foreignPullRequest).toBeUndefined();
          expect(executionFor(task).work.cleanup!.pullRequest).toBe("unconfirmed");
          expect(executionFor(task).work.shipping).toBeUndefined();
        } finally { await engine.shutdown(); }

      });
    });
  });

it("recovers orphaned reviewer copies after the main copy was already removed, leaving unfinished tasks alone", async () => {
    await world("reviewer-crash", async w => {


      const { folder, copy, missing, active, id } = await w.engine(async engine => {
        const productId = installPreparedProduct(engine, acmeDemoProduct(w.clone));
        const id = await addPreparedCleanupTask(engine, w, { productId, title: "Finished before cleanup", description: "[quick]", delivery: "local", approveDelivery: false });
        await finish(engine, id);
        const task = structuredClone(await cleaned(engine, id));
        await engine.shutdown();
        const folder = join(w.data, "worktrees", productId, `${id}.copies`);
        const copy = join(folder, "review-0");
        const missing = join(folder, "review-1");
        const sha = branchSha(w.clone, task.branch!);
        await addCopy(w.clone, copy, sha);
        await addCopy(w.clone, missing, sha);
        await git(w.clone, "worktree", "lock", copy);
        await git(w.clone, "worktree", "lock", missing);
        rmSync(missing, { recursive: true, force: true });
        const active = join(w.data, "worktrees", productId, "unfinished.copies", "review-0");
        await addCopy(w.clone, active, sha);
        writeFileSync(join(active, "unsaved.txt"), "Keep this unfinished review");
        w.editSaved((state) => {
          const tasks = state.tasks as unknown as Task[];
          tasks.push({ ...task, id: "unfinished", state: "paused", worktree: join(w.data, "worktrees", productId, "unfinished"), cleanup: undefined });
          const previous = state.tasks.find((entry) => entry.id === id)!;
          delete (previous.cleanup as { reviewCopiesRemovedAt?: number }).reviewCopiesRemovedAt;
        });

        return { folder, copy, missing, active, id };
      });
      await w.engine(async engine => {
        try {
          await waitFor(async () => !existsSync(folder) && !await listed(w, copy) && !await listed(w, missing), "orphaned reviewer folders and locked Git records to be removed", 5_000);
          await gone(w, taskOf(engine.getState(), id));
          expect(existsSync(active)).toBe(true);
          expect(await listed(w, active)).toBe(true);
          expect(readFileSync(join(active, "unsaved.txt"), "utf8")).toBe("Keep this unfinished review");

        } finally { await engine.shutdown(); }
      }, { checkEveryMs: 100 });
    });
  });

// Slot allocation while a prior driver settles belongs to the actual portable AgentWorkflow owner.
// Native pause during worktree setup and immediate Resume controls remain below.

for (const kind of ["uncertain", "older interrupted", "already marked", "no pull request"] as const) it(`checks GitHub before cleaning a ${kind} delivery marked done, including after restart`, async () => {
    await world(`mark-done-${kind.replaceAll(" ", "-")}`, async w => {
      w.setGitHub((github) => (github.fail = { "pr create": 1 }));


      const { id, copy } = await w.engine(async engine => {
        const productId = installPreparedProduct(engine, acmeDemoProduct(w.clone));
        const savedInput = kind === "older interrupted" || kind === "already marked";
        const id = await (savedInput ? addSavedCleanupInput : addPreparedCleanupTask)(engine, w, { productId, title: "Uncertain delivery", description: "[quick]", approveDelivery: false });
        // The current uncertain-delivery variants retain the actual failed publication anchor.
        if (!savedInput) expect(taskOf(await finish(engine, id), id).state).toBe("failed");
        const supplied = taskOf(engine.getState(), id), copy = supplied.worktree!;
        const headRefOid = branchSha(w.clone, supplied.branch!);
        w.setGitHub((github) => {
          github.offline = true;
          if (kind !== "no pull request") github.prs.push({ number: 77, url: "https://github.com/acme/demo/pull/77", state: "OPEN", headRefName: supplied.branch!, baseRefName: "main", headRefOid, isCrossRepository: false, title: "Uncertain delivery", body: "" });
        });
        await engine.shutdown();
        w.editSaved((state) => {
          const task = state.tasks.find((task) => task.id === id) as unknown as Record<string, unknown>;
          Object.assign(task, { state: kind === "already marked" ? "done" : "waiting", statusLine: "Marked as done by you" });
          if (kind === "older interrupted") task.shipping = { startedAt: Date.now(), attempts: 1 };
          if (kind === "already marked") delete task.shipping;
          (state as unknown as { inbox: unknown }).inbox = state.inbox.filter((item) => item.taskId !== id);
        });

        return { id, copy };
      }, { checkEveryMs: 100 });
      await w.engine(async engine => {
        if (kind !== "already marked") {
          await until(engine, (s) => !!itemOf(s, id, "shipping"), () => {});
          engine.markDone(itemOf(engine.getState(), id, "shipping")!.id);
        }
        const held = taskOf(await until(engine, (s) => {
          const cleanup = taskOf(s, id).cleanup;
          return cleanup?.error !== undefined || cleanup?.removedAt !== undefined;
        }, () => {}), id);
        expect(held.cleanup?.error).toBe(CLEANUP_WORDS.unconfirmedPr);
        expect(taskOf(engine.getState(), id).state).toBe("done");
        expect(existsSync(copy)).toBe(true);
        expect(taskOf(engine.getState(), id).cleanup?.removedAt).toBeUndefined();
        await engine.shutdown();

      }, { checkEveryMs: 100 });
      await w.engine(async engine => {
        try {
          expect(existsSync(copy)).toBe(true);
          w.setGitHub((github) => (github.offline = false));
          if (kind === "no pull request") {
            const done = await cleaned(engine, id);
            await gone(w, done);
            expect(done.cleanup?.pullRequest).toBe("none");
            expect(done.state).toBe("done");
            await expectUnconfirmed(engine, id);
            return;
          }
          await until(engine, (s) => taskOf(s, id).pr?.state === "open", () => {});
          expect(taskOf(engine.getState(), id).state).toBe("done");
          const c = new Coordination(engine);
          const updates = async () => (await c.call("watch.events", { taskIds: [id], from: "oldest", kinds: ["publishing.result"], timeoutMs: 0, limit: 100 })).events as { result: unknown; landing: string }[];
          expect((await updates()).at(-1)).toMatchObject({ landing: "marked-done", result: { kind: "unconfirmed", landed: false, lookup: { number: 77, state: "open" } } });
          await expectUnconfirmed(engine, id);
          expect(existsSync(copy)).toBe(true);
          expect(taskOf(engine.getState(), id).cleanup?.removedAt).toBeUndefined();
          w.setGitHub((github) => (github.prs[0]!.state = kind === "older interrupted" ? "MERGED" : "CLOSED"));
          const done = await cleaned(engine, id);
          await gone(w, done);
          expect(done.state).toBe("done");
          expect(texts(done)).toContain(kind === "older interrupted" ? "Merged #77 on GitHub" : "Closed #77 without merging");
          expect((await updates()).at(-1)).toMatchObject({ landing: "marked-done", result: { kind: "unconfirmed", landed: false, lookup: { number: 77, state: kind === "older interrupted" ? "merged" : "closed" } } });
          await expectUnconfirmed(engine, id);

        } finally { await engine.shutdown(); }
      }, { checkEveryMs: 100 });
    });
  });

for (const { github, marked } of [{ github: false, marked: false }, { github: false, marked: true }, { github: true, marked: false }]) it(`handles an older local delivery ${marked ? "already marked done" : "marked done now"} for a ${github ? "GitHub" : "computer-only"} product`, async () => {
    await world(`older-local-${github}-${marked}`, async w => {
      if (!github) await git(w.clone, "remote", "remove", "origin");
      w.setGitHub((state) => (state.offline = true));


      const { id, copy } = await w.engine(async engine => {
        await engine.waitUntilReady(); engine.stopRequested.signal.throwIfAborted();
        const productId = installPreparedProduct(engine, github ? acmeDemoProduct(w.clone) : { ...privateCloneProduct(w.clone), remote: undefined });
        const id = await addSavedCleanupInput(engine, w, { productId, title: "Older local delivery", description: "[quick]", delivery: "local", approveDelivery: true });
        const copy = taskOf(engine.getState(), id).worktree!;
        expect(existsSync(join(copy, "node_modules", "left-pad"))).toBe(true);
        expect(existsSync(join(copy, "target", "debug"))).toBe(true);
        await engine.shutdown();
        w.editSaved((state) => {
          const task = state.tasks.find((entry) => entry.id === id)!;
          Object.assign(task, marked
            ? { state: "done", shipping: undefined, cleanup: { pullRequest: "unconfirmed", error: CLEANUP_WORDS.unconfirmedPr } }
            : { state: "waiting", shipping: { startedAt: Date.now(), attempts: 1 } });
          (state as unknown as { inbox: unknown }).inbox = state.inbox.filter((item) => item.taskId !== id);
        });

        return { id, copy };
      });
      const next = await w.engine(async engine => {
        try {
          if (!marked) {
            await until(engine, (state) => !!itemOf(state, id, "shipping"), () => {});
            engine.markDone(itemOf(engine.getState(), id, "shipping")!.id);
          }
          if (github) {
            const task = taskOf(await until(engine, (state) => taskOf(state, id).cleanup?.error !== undefined, () => {}), id);
            expect(task.state).toBe("done");
            expect(task.cleanup?.error).toBe(CLEANUP_WORDS.unconfirmedPr);
            expect(task.cleanup?.removedAt).toBeUndefined();
            expect(existsSync(copy)).toBe(true);
          } else {
            const task = await cleaned(engine, id);
            expect(task.state).toBe("done");
            expect(task.cleanup?.pullRequest).toBe("none");
            expect(task.cleanup?.error).toBeUndefined();
            expect(w.github().calls).toEqual([]);
            await gone(w, task);
            await engine.shutdown();

            return async (engine: Engine) => {
              expect(taskOf(engine.getState(), id).cleanup).toEqual(task.cleanup);
              expect(w.github().calls).toEqual([]);
              await gone(w, taskOf(engine.getState(), id));
            };
          }
          return undefined;
        } finally { await engine.shutdown(); }
      }, { checkEveryMs: 100 });
      if (next) await w.engine(next, { checkEveryMs: 100 });
    });
  });

for (const resumeImmediately of [false, true]) it(`keeps a copy paused during setup${resumeImmediately ? " and resumed before setup finishes" : " until it is resumed"}`, async () => {
    let releasePeers = () => {};
    await world(resumeImmediately ? "setup-resumed" : "setup-paused", async w => {
      const hold = join(w.dir, "checkout-hold");
      const filter = join(w.dir, "smudge.mjs");
      releasePeers = () => rmSync(hold, { force: true });
      writeFileSync(hold, "");
      await w.leasedProgram(filter, `const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
      const input = readFileSync(0); const hold = ${JSON.stringify(hold)};
      writeFileSync(hold + ".reached", ""); while (existsSync(hold)) Bun.sleepSync(10);
      process.stdout.write(input);`, { monitor: "worker" });
      // Hold the actual checkout in git, after it starts creating the copy and before ensureWorktree returns.
      await git(w.clone, "config", "filter.petrinaSetup.clean", gitCommand([{ path: process.execPath }, "-e", 'process.stdout.write(require("node:fs").readFileSync(0))']));
      await git(w.clone, "config", "filter.petrinaSetup.smudge", gitCommand([{ path: process.execPath }, { path: filter }]));
      await git(w.clone, "config", "filter.petrinaSetup.required", "true");
      writeFileSync(join(w.clone, ".gitattributes"), "README.md filter=petrinaSetup\n");
      await git(w.clone, "add", ".gitattributes");
      await git(w.clone, "commit", "-qm", "Hold checkout for the test");

      await w.engine(async engine => {
        try {
          const productId = installPreparedProduct(engine, acmeDemoProduct(w.clone));
          const id = engine.addTask({ productId, title: "Pause during setup", description: "[quick]", delivery: "local", approvePlan: true });
          // The plan check stays editable, so the copy is not created until the plan is approved.
          const planned = await until(engine, (s) => !!itemOf(s, id, "plan"), () => {});
          expect(taskOf(planned, id).worktree).toBeUndefined();
          expect(existsSync(`${hold}.reached`)).toBe(false);
          engine.approve(itemOf(planned, id, "plan")!.id);
          await waitForFile(`${hold}.reached`, { during: engine.settling.get(id) });
          const settling = engine.settling.get(id)!;
          expect(taskOf(engine.getState(), id).worktree).toBeUndefined();
          engine.pause(id);
          if (resumeImmediately) {
            engine.resume(id);
            expect(engine.settling.get(id)).toBe(settling);
          }
          rmSync(hold);
          await settling;
          const path = join(w.data, "worktrees", productId, id);
          expect(existsSync(join(path, "README.md"))).toBe(true);
          expect(await listed(w, path)).toBe(true);
          if (!resumeImmediately) {
            expect(taskOf(engine.getState(), id).state).toBe("paused");
            expect(taskOf(engine.getState(), id).cleanup).toBeUndefined();
            engine.resume(id);
          }
          await until(engine, (s) => taskOf(s, id).worktree === path && taskOf(s, id).state !== "paused", () => {});
          expect(existsSync(join(path, "README.md"))).toBe(true);
          expect(taskOf(engine.getState(), id).cleanup).toBeUndefined();
          expect(texts(taskOf(engine.getState(), id))).not.toContain(CLEANUP_WORDS.removed);
        } finally {
          rmSync(hold, { force: true });
          await engine.shutdown();
          await Promise.allSettled([...engine.settling.values()]);
        }

      }, { checkEveryMs: 100 });
    }, { stopPeers: () => releasePeers() });
  });

it("finds a cancelled setup's copy after quitting and retries its locked output after restart", async () => {
    let releasePeers = () => {};
    await world("setup-cancel-quit", async w => {
      let allowRemoval = () => {};
      const hold = join(w.dir, "checkout-hold");
      const filter = join(w.dir, "smudge.mjs");
      releasePeers = () => { rmSync(hold, { force: true }); allowRemoval(); };
      writeFileSync(hold, "");
      await w.leasedProgram(filter, `const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
      const input = readFileSync(0); const hold = ${JSON.stringify(hold)};
      writeFileSync(hold + ".reached", ""); while (existsSync(hold)) Bun.sleepSync(10);
      process.stdout.write(input);`, { monitor: "worker" });
      await git(w.clone, "config", "filter.petrinaSetup.clean", gitCommand([{ path: process.execPath }, "-e", 'process.stdout.write(require("node:fs").readFileSync(0))']));
      await git(w.clone, "config", "filter.petrinaSetup.smudge", gitCommand([{ path: process.execPath }, { path: filter }]));
      await git(w.clone, "config", "filter.petrinaSetup.required", "true");
      writeFileSync(join(w.clone, ".gitattributes"), "README.md filter=petrinaSetup\n");
      await git(w.clone, "add", ".gitattributes");
      await git(w.clone, "commit", "-qm", "Hold checkout for the test");


      const { id, copy } = await w.engine(async engine => {
        const productId = installPreparedProduct(engine, acmeDemoProduct(w.clone));
        const id = engine.addTask({ productId, title: "Cancel during checkout", delivery: "local" });
        await waitForFile(`${hold}.reached`, { during: engine.settling.get(id) });
        const copy = join(w.data, "worktrees", productId, id);
        const locked = join(copy, "target", "locked");
        mkdirSync(locked, { recursive: true });
        writeFileSync(join(locked, "output"), "build output");
        allowRemoval = w.faults.blockRemoval(copy);
        engine.cancel(id);
        // Shutdown saves and closes the store while checkout still holds the copy.
        const quitting = engine.shutdown();
        rmSync(hold);
        await quitting;
        expect(existsSync(copy)).toBe(true);

        return { id, copy };
      }, { checkEveryMs: 100 });
      await w.engine(async engine => {
        try {
          // It never became usable before the save. Cleanup recovers only this task's standard folder.
          expect(taskOf(engine.getState(), id).worktree).toBeUndefined();
          await until(engine, (state) => !!taskOf(state, id).cleanup?.error, () => {});
          expect(taskOf(engine.getState(), id).state).toBe("cancelled");
          expect(taskOf(engine.getState(), id).cleanup?.removedAt).toBeUndefined();
          allowRemoval();
          const task = await cleaned(engine, id);
          await gone(w, { ...task, worktree: copy, branch: branchName("Cancel during checkout", id) });
          expect(task.state).toBe("cancelled");
          expect(texts(task).slice(-2)).toEqual([CLEANUP_WORDS.failed(CLEANUP_WORDS.locked), CLEANUP_WORDS.removed]);

        } finally {
          rmSync(hold, { force: true });
          allowRemoval();
          await engine.shutdown();
        }
      }, { checkEveryMs: 100 });
    }, { stopPeers: () => releasePeers() });
  });

for (const source of ["open", "no-pull-request"] as const) it(`checks a cancelled uncertain delivery marked done with ${source}, including retries and restart`, async () => {
    await world(`cancelled-${source}`, async w => {


      const { id, copy } = await w.engine(async engine => {
        const productId = installPreparedProduct(engine, acmeDemoProduct(w.clone));
        const id = await (source === "open" ? addPreparedCleanupTask : addSavedCleanupInput)(engine, w, { productId, title: "Older cancelled delivery", description: "[quick]", approveDelivery: false });
        if (source === "open") expect(taskOf(await finish(engine, id), id).state).toBe("pr-open");
        const copy = taskOf(engine.getState(), id).worktree!;
        await engine.shutdown();
        w.editSaved((state) => {
          Object.assign(state.tasks.find((task) => task.id === id)!, {
            state: "cancelled", column: "done", statusLine: "Cancelled", pr: undefined,
            shipping: undefined, cleanup: { pullRequest: "unconfirmed" },
          });
        });
        w.setGitHub((github) => { github.offline = true; if (source === "no-pull-request") github.prs = []; });

        return { id, copy };
      }, { checkEveryMs: 100 });
      await w.engine(async engine => {
        await until(engine, (state) => taskOf(state, id).cleanup?.error === CLEANUP_WORDS.unconfirmedPr, () => {});
        expect(existsSync(copy)).toBe(true);
        expect(engine.getState().inbox.some((item) => item.taskId === id)).toBe(false);
        const before = taskOf(engine.getState(), id).timeline;
        const lookups = () => w.github().calls.filter((call) => call[0] === "pr" && call[1] === "list").length;
        const count = lookups();
        await until(engine, () => lookups() >= count + 2, () => {});
        expect(taskOf(engine.getState(), id).timeline).toEqual(before);
        await engine.shutdown();

      }, { checkEveryMs: 100 });
      await w.engine(async engine => {
        try {
          expect(existsSync(copy)).toBe(true);
          w.setGitHub((github) => (github.offline = false));
          if (source !== "no-pull-request") {
            await until(engine, (state) => taskOf(state, id).pr?.state === "open", () => {});
            expect(existsSync(copy)).toBe(true);
            expect(taskOf(engine.getState(), id).state).toBe("cancelled");
            expect(taskOf(engine.getState(), id).cleanup?.removedAt).toBeUndefined();
            w.setGitHub((github) => (github.prs[0]!.state = "CLOSED"));
          }
          const task = await cleaned(engine, id);
          await gone(w, task);
          expect(task.state).toBe("cancelled");
          expect(task.statusLine).toBe("Cancelled");
          expect(task.cleanup?.pullRequest).toBe("none");
          expect(texts(task).filter((text) => text === CLEANUP_WORDS.failed(CLEANUP_WORDS.unconfirmedPr))).toHaveLength(1);
          if (source !== "no-pull-request") expect(texts(task)).toContain("Closed #1 without merging");
          expect(w.github().calls.every((call) => !call.includes("merge") && !call.includes("close"))).toBe(true);

        } finally { await engine.shutdown(); }
      }, { checkEveryMs: 100 });
    });
  });

it("cleans a cancelled computer-only delivery marked done without asking GitHub", async () => {
    await world("cancelled-computer-only", async w => {
      await git(w.clone, "remote", "remove", "origin");


      const { id } = await w.engine(async engine => {
        await engine.waitUntilReady(); engine.stopRequested.signal.throwIfAborted();
        const productId = installPreparedProduct(engine, { ...privateCloneProduct(w.clone), remote: undefined });
        const id = await addSavedCleanupInput(engine, w, { productId, title: "Older computer-only delivery", description: "[quick]", delivery: "local", approveDelivery: false });
        await engine.shutdown();
        // The supplied older delivery left this real copy behind before the coordinator cancelled it.
        w.editSaved((state) => Object.assign(state.tasks.find((task) => task.id === id)!, {
          state: "cancelled", column: "done", statusLine: "Cancelled", shipping: undefined,
          cleanup: { pullRequest: "unconfirmed" },
        }));

        return { id };
      }, { checkEveryMs: 100 });
      await w.engine(async engine => {
        try {
          const task = await cleaned(engine, id);
          await gone(w, task);
          expect(task.state).toBe("cancelled");
          expect(task.cleanup?.pullRequest).toBe("none");
          expect(w.github().calls).toEqual([]);

        } finally { await engine.shutdown(); }
      }, { checkEveryMs: 100 });
    });
  });

it("removes a verified release's copy and keeps its branch, tag and link", async () => {
    await world("release", async w => {

      await w.engine(async engine => {
        try {
          const productId = installPreparedProduct(engine, acmeDemoProduct(w.clone));
          const id = await addPreparedCleanupTask(engine, w, { productId, title: "Release a greeting", description: "[quick]", delivery: "release", approveDelivery: false });
          expect(taskOf(await finish(engine, id), id).state).toBe("done");
          const task = await cleaned(engine, id);
          await gone(w, task);
          expect(task.release?.url).toContain("/releases/tag/");
          expect(remoteRef(w.remote, `refs/tags/${task.release!.tag}`)).toBe(branchSha(w.clone, task.branch!));
          expect(texts(task).findIndex((line) => line.startsWith("Petrina published release"))).toBeLessThan(texts(task).indexOf(CLEANUP_WORDS.removed));
        } finally { await engine.shutdown(); }

      });
    });
  });

it("still frees space when the disk cannot save the verified delivery until its copy is gone", async () => {
    let releasePeers = () => {};
    await world("full-disk", async w => {

      await w.engine(async engine => {
        const save = engine.store.save.bind(engine.store);
        releasePeers = () => { engine.store.save = save; };
        let failed = 0;
        try {
          const productId = installPreparedProduct(engine, acmeDemoProduct(w.clone));
          const id = await addPreparedCleanupTask(engine, w, { productId, title: "Free space", description: "[quick]", delivery: "local", approveDelivery: false });
          engine.store.save = (state, ...archive) => {
            // Once its copy is gone, the task may already have moved to History.
            const saved = state.tasks.find((entry) => entry.id === id);
            const task = saved && displayTask(saved);
            if (task?.state === "done" && existsSync(task.worktree!)) { failed += 1; throw new Error("disk full"); }
            save(state, ...archive);
          };
          const task = await cleaned(engine, id);
          expect(failed).toBeGreaterThan(0);
          expect(task.state).toBe("done");
          expect(task.error).toBeUndefined();
          // A later save contains only live tasks: keep the disk-full stand-in installed across retirement.
          await waitFor(() => !engine.activeState().tasks.some((entry) => entry.id === id), "the cleaned task to move to History");
          engine.commitNow();
          await gone(w, task);
          expect(displayTask(engine.store.history.get(id)!).cleanup?.removedAt).toBeDefined();
        } finally { engine.store.save = save; await engine.shutdown(); }

      });
    }, { stopPeers: () => releasePeers() });
  });

it("keeps open pull requests through checks, restart and cancellation, then records merged and closed separately", async () => {
    await world("pull-requests", async w => {


      const { ids } = await w.engine(async engine => {
        const productId = installPreparedProduct(engine, acmeDemoProduct(w.clone));
        const ids: string[] = [];
        for (const title of ["Merge this", "Close this", "Cancel this"]) {
          const id = await addObservedCleanupPullRequest(engine, w, { productId, title, description: "[quick]", approveDelivery: false });
          expect(taskOf(engine.getState(), id).state).toBe("pr-open");
          ids.push(id);
        }
        engine.cancel(ids[2]!);
        w.setGitHub((github) => (github.offline = true));
        await engine.shutdown();

        return { ids };
      }, { checkEveryMs: 100 });
      await w.engine(async engine => {
        try {
          await Bun.sleep(350);
          for (const id of ids) {
            const task = taskOf(engine.getState(), id);
            expect(task.cleanup).toBeUndefined();
            expect(existsSync(join(task.worktree!, "node_modules", "left-pad"))).toBe(true);
            expect(existsSync(join(task.worktree!, "target", "debug"))).toBe(true);
          }
          w.setGitHub((github) => { github.offline = false; github.prs.forEach((pr, index) => (pr.state = index === 0 ? "MERGED" : "CLOSED")); });
          const tasks = await completeAll(ids.map((id) => cleaned(engine, id)));
          for (const task of tasks) await gone(w, task);
          expect(tasks.map((task) => [task.state, task.pr?.state])).toEqual([["done", "merged"], ["done", "closed"], ["cancelled", "closed"]]);
          expect(ids.map((id) => engine.tracking.log.moments({ taskId: id, kinds: ["task-end"] }).map((entry) => entry.outcome))).toEqual([
            ["delivered", "merged"], ["delivered", "closed"], ["delivered", "cancelled", "closed"],
          ]);
          expect(texts(tasks[1]!)).toContain("Closed #2 without merging");
          expect(tasks[2]!.statusLine).toBe("Cancelled");
          expect(w.github().calls.every((call) => !call.includes("merge") && !call.includes("close"))).toBe(true);
          expect(remoteRef(w.remote, "refs/heads/main")).toBe(w.initial);

        } finally { await engine.shutdown(); }
      }, { checkEveryMs: 100 });
    });
  });

it("holds a copy cancelled while GitHub opens its pull request until GitHub can answer", async () => {
    let releasePeers = () => {};
    await world("opening", async w => {
      const hold = join(w.dir, "opening");
      releasePeers = () => rmSync(hold, { force: true });
      writeFileSync(hold, "");
      w.setGitHub((github) => (github.hold = { command: "pr create", file: hold }));


      const { id, calls, before, warning } = await w.engine(async engine => {
        const productId = installPreparedProduct(engine, acmeDemoProduct(w.clone));
        const id = await addPreparedCleanupTask(engine, w, { productId, title: "Open slowly", description: "[quick]", approveDelivery: false });
        await until(engine, () => existsSync(`${hold}.reached`));
        engine.cancel(id);
        w.setGitHub((github) => (github.offline = true));
        rmSync(hold);
        await until(engine, () => !engine.settling.has(id));
        expect(taskOf(engine.getState(), id).shipping?.step).toBe("open");
        expect(existsSync(taskOf(engine.getState(), id).worktree!)).toBe(true);
        const warning = CLEANUP_WORDS.failed(CLEANUP_WORDS.unconfirmed);
        expect(texts(taskOf(engine.getState(), id)).filter((line) => line === warning)).toHaveLength(1);
        expect(taskOf(engine.getState(), id).cleanup?.error).toBe(CLEANUP_WORDS.unconfirmed);
        const calls = () => w.github().calls.filter((call) => call[0] === "pr" && call[1] === "list").length;
        const before = calls();
        await until(engine, () => calls() >= before + 2);
        await engine.shutdown();

        return { id, calls, before, warning };
      }, { checkEveryMs: 100 });
      await w.engine(async engine => {
        try {
          await until(engine, () => calls() >= before + 3);
          expect(texts(taskOf(engine.getState(), id)).filter((line) => line === warning)).toHaveLength(1);
          expect(engine.getState().inbox.some((item) => item.taskId === id)).toBe(false);
          expect(existsSync(taskOf(engine.getState(), id).worktree!)).toBe(true);
          w.setGitHub((github) => { github.offline = false; github.prs[0]!.baseRefName = "another-base"; });
          await until(engine, (s) => taskOf(s, id).pr?.state === "open");
          expect(taskOf(engine.getState(), id).cleanup).toBeUndefined();
          w.setGitHub((github) => (github.prs[0]!.state = "CLOSED"));
          await gone(w, await cleaned(engine, id));
          expect(taskOf(engine.getState(), id).state).toBe("cancelled");

        } finally { rmSync(hold, { force: true }); await engine.shutdown(); }
      }, { checkEveryMs: 100 });
    }, { stopPeers: () => releasePeers() });
  });

it("cleans a cancelled publishing step when GitHub confirms it never opened a pull request", async () => {
    await world("no-pull-request", async w => {
      w.setGitHub((github) => (github.fail = { "pr create": 1 }));

      await w.engine(async engine => {
        try {
          const productId = installPreparedProduct(engine, acmeDemoProduct(w.clone));
          const id = await addPreparedCleanupTask(engine, w, { productId, title: "Never opened", description: "[quick]", approveDelivery: false });
          expect(taskOf(await finish(engine, id), id).state).toBe("failed");
          engine.cancel(id);
          const task = await cleaned(engine, id);
          expect(task.state).toBe("cancelled");
          expect(task.pr).toBeUndefined();
          await gone(w, task);
        } finally { await engine.shutdown(); }

      }, { checkEveryMs: 100 });
    });
  });

it("retries a locked copy once a minute without crowding the timeline, then succeeds", async () => {
    let releasePeers = () => {};
    await world("retry", async w => {

      await w.engine(async engine => {
        let allowRemoval = () => {};
        releasePeers = () => allowRemoval();
        try {
          const productId = installPreparedProduct(engine, acmeDemoProduct(w.clone));
          const id = await addPreparedCleanupTask(engine, w, { productId, title: "Locked build", description: "[quick]", delivery: "local", approveDelivery: false });
          allowRemoval = w.faults.blockRemoval(join(w.data, "worktrees", productId, id));
          await until(engine, (s) => !!taskOf(s, id).cleanup?.error);
          let task = taskOf(engine.getState(), id);
          expect(readFileSync(join(task.worktree!, "target", "debug", "greeting.bin"), "utf8")).toBe("build output\n");
          expect(task.state).toBe("done");
          expect(task.cleanup?.removedAt).toBeUndefined();
          expect(await listed(w, task.worktree!)).toBe(true);
          const timeline = task.timeline;
          await Bun.sleep(350);
          expect(taskOf(engine.getState(), id).timeline).toEqual(timeline);
          expect(texts(task).at(-1)).toBe(CLEANUP_WORDS.failed(CLEANUP_WORDS.locked));
          expect(engine.getState().inbox.some((item) => item.taskId === id)).toBe(false);
          allowRemoval();
          task = await cleaned(engine, id);
          await gone(w, task);
          expect(texts(task).slice(-2)).toEqual([CLEANUP_WORDS.failed(CLEANUP_WORDS.locked), CLEANUP_WORDS.removed]);
        } finally { allowRemoval(); await engine.shutdown(); }

      }, { checkEveryMs: 100 });
    }, { stopPeers: () => releasePeers() });
  });

it("catches up older tasks across products at startup while a stalled pull request leaves others free", async () => {
    let releasePeers = () => {};
    await world("catch-up", async w => {

      const hold = join(w.dir, "stalled");

      releasePeers = () => rmSync(hold, { force: true });

      const { task, cancelled } = await w.engine(async engine => {
        const productId = installPreparedProduct(engine, acmeDemoProduct(w.clone));
        const id = await addPreparedCleanupTask(engine, w, { productId, title: "Old copy", description: "[quick]", approveDelivery: false });
        const task = structuredClone(taskOf(await finish(engine, id), id));
        const cancelled = engine.addTask({ productId, title: "Older cancelled copy", description: "[quick]", approvePlan: true });
        // The plan check is editable before any copy exists. Approve it, then pause once the copy is there.
        const planned = await until(engine, (s) => !!itemOf(s, cancelled, "plan"), () => {});
        expect(taskOf(planned, cancelled).worktree).toBeUndefined();
        engine.approve(itemOf(planned, cancelled, "plan")!.id);
        await until(engine, (s) => !!taskOf(s, cancelled).worktree, () => {});
        engine.pause(cancelled);
        await until(engine, () => !engine.settling.has(cancelled), () => {});
        await engine.shutdown();
        const baseSha = branchSha(w.clone, task.branch!);
        // Stand in for older saved tasks, including a second product and all states that must retain a copy.
        w.editSaved((state) => {
          (state.pool as { paused: boolean }).paused = true;
          (state as unknown as { inbox: unknown }).inbox = state.inbox.filter((item) => item.taskId !== cancelled);
          const rows = state.tasks as unknown as Record<string, unknown>[];
          rows.find((row) => row.id === id)!.pr = { ...task.pr, number: 101 };
          Object.assign(rows.find((row) => row.id === cancelled)!, { state: "cancelled", column: "done" });
          const products = state.products as unknown as Record<string, unknown>[];
          products.push({ ...products[0], id: "second-product" });
          for (const status of ["done", "running", "paused", "failed", "queued", "needs-you"]) rows.push({ ...task, id: `older-${status}`, productId: "second-product", state: status === "running" ? "paused" : status, held: true, agent: undefined, pr: undefined, worktree: join(w.data, "worktrees", "second-product", status), branch: `petrina/older-${status}` });
        });
        for (const status of ["done", "running", "paused", "failed", "queued", "needs-you"]) {
          const refFile = join(w.clone, ".git", "refs", "heads", "petrina", `older-${status}`);
          mkdirSync(dirname(refFile), { recursive: true });
          writeFileSync(refFile, `${baseSha}\n`);
          await materializeCleanupWorktree(w.clone, join(w.data, "worktrees", "second-product", status), `petrina/older-${status}`);
        }
        // As if cleanup stopped after deleting the folder, before dropping its repository record.
        const interrupted = join(w.data, "worktrees", "second-product", "done");
        rmSync(interrupted, { recursive: true, force: true });
        expect(await listed(w, interrupted)).toBe(true);
        w.setGitHub((github) => {
          const first = github.prs[0]!;
          github.prs = [{ ...first, number: 101, state: "OPEN" }, { ...first, number: 102, state: "CLOSED" }];
          github.hold = { command: "pr view", file: hold, match: "101" };
        });
        const closedPath = join(w.data, "worktrees", productId, "closed");
        const closedRefFile = join(w.clone, ".git", "refs", "heads", "petrina", "older-closed");
        mkdirSync(dirname(closedRefFile), { recursive: true });
        writeFileSync(closedRefFile, `${baseSha}\n`);
        await materializeCleanupWorktree(w.clone, closedPath, "petrina/older-closed");
        w.editSaved((state) => (state.tasks as unknown as Record<string, unknown>[]).push({ ...task, id: "older-closed", worktree: closedPath, branch: "petrina/older-closed", pr: { ...task.pr, number: 102 } }));
        writeFileSync(hold, "");

        return { productId, id, task, cancelled };
      });
      await w.engine(async engine => {
        try { // All of this must happen on startup, before the first minute passes.
          await waitForFile(`${hold}.reached`);
          for (const key of [cancelled, "older-done", "older-closed"]) {
            const row = await cleaned(engine, key);
            await gone(w, row);
          }
          expect(existsSync(task.worktree!)).toBe(true);
          for (const status of ["running", "paused", "failed", "queued", "needs-you"]) expect(existsSync(join(w.data, "worktrees", "second-product", status))).toBe(true);

        } finally { rmSync(hold, { force: true }); await engine.shutdown(); }
      });
    }, { stopPeers: () => releasePeers() });
  });

it("says nothing about a copy when cancelled before setup, and safely completes an interrupted removal", async () => {
    await world("setup", async w => {

      await w.engine(async engine => {
        try {
          const productId = installPreparedProduct(engine, acmeDemoProduct(w.clone));
          const id = engine.addTask({ productId, title: "Cancel before setup" });
          engine.cancel(id);
          await until(engine, () => !engine.settling.has(id));
          const task = taskOf(engine.getState(), id);
          expect(task.worktree).toBeUndefined();
          expect(texts(task).some((line) => /working copy|will try again/i.test(line))).toBe(false);
          expect(existsSync(join(w.data, "worktrees", productId, id))).toBe(false);
          const path = join(w.data, "worktrees", productId, "interrupted");
          const branch = branchName("Interrupted", "old");
          await ensureWorktree(w.clone, path, branch, "main");
          rmSync(path, { recursive: true, force: true });
          expect(await listed(w, path)).toBe(true);
          expect(await removeWorktree(w.clone, path)).toBe(true);
          expect(await listed(w, path)).toBe(false);
          expect(await removeWorktree(w.clone, path)).toBe(false);
          expect(branchSha(w.clone, branch)).toBe(w.initial);
        } finally { await engine.shutdown(); }

      }, { checkEveryMs: 100 });
    });
  });
});
