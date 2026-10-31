import { installPreparedProduct } from "../../fixtures/prepared-product.js";
import * as gitOps from "@petrina/repositories/git";
import { installSharedWorkflowFastPaths, materializePreparedWorktree, readWorktreeCommit } from "../../fixtures/shared-preparation.js";
import { scriptedToolProbe } from "../../scripted-probes.js";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { expect, it } from "bun:test";
import { directDrivers } from "../../fixtures/direct-drivers.js";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { inflateSync } from "node:zlib";
import { Engine } from "../../engine.js";
import { commandInputText } from "../../../src/checks.js";
import { executionFor, scopesFor } from "@petrina/orchestrator";
import { destination } from "../../../src/shipping.js";
import { Aborted } from "../../../src/kernel.js";
import { WaitingForUsage } from "../../../src/usage.js";
import type { CheckVerification } from "../../../src/product-checks.js";
import { CONFIRM_ADDRESS } from "../../../src/connection.js";
import { makeProduct, tempDir, waitFor } from "../../fixtures.js";

type Observation = { product: string; title: string; sha: string; tree: string; files: string[] };

const READY_TOOLS = scriptedToolProbe({
  "claude-code": { status: "ready" }, codex: { status: "ready" }, grok: { status: "ready" },
  antigravity: { status: "not-installed" }, opencode: { status: "not-installed" }, pi: { status: "not-installed" }, gh: { status: "ready" }, git: { status: "ready" },
});

function readLooseObject(gitDir: string, sha: string): Buffer {
  return inflateSync(readFileSync(join(gitDir, "objects", sha.slice(0, 2), sha.slice(2))));
}

function readBranchSha(repoPath: string, branch = "main"): string {
  return readFileSync(join(repoPath, ".git", "refs", "heads", branch), "utf8").trim();
}

function readCommitTree(gitDir: string, commitSha: string): string {
  const raw = readLooseObject(gitDir, commitSha).toString("utf8");
  return raw.slice(raw.indexOf("\0") + 1).match(/^tree ([0-9a-f]{40})/m)![1]!;
}

/** Start at the approved delivery boundary; each fixture owns its repositories, check barriers and saved state. */
async function fixture(products = ["a"], checkRuns = 2) {
  const root = tempDir("petrina-turn-recovery-"), lifetime = directDrivers(root);
  const data = join(root, "data"), log = join(root, "checks.jsonl"), check = join(root, "check.ts");
  const program = `import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { inflateSync } from "node:zlib";
const [log, root, product] = process.argv.slice(2);
const dotGit = statSync(".git").isDirectory() ? resolve(".git") : resolve(readFileSync(".git", "utf8").replace(/^gitdir:\\s*/, "").trim());
const commonDir = existsSync(join(dotGit, "commondir")) ? resolve(dotGit, readFileSync(join(dotGit, "commondir"), "utf8").trim()) : dotGit;
const headText = readFileSync(join(dotGit, "HEAD"), "utf8").trim();
const sha = headText.startsWith("ref: ") ? readFileSync(join(commonDir, headText.slice(5)), "utf8").trim() : headText;
const raw = inflateSync(readFileSync(join(commonDir, "objects", sha.slice(0, 2), sha.slice(2)))).toString("utf8");
const body = raw.slice(raw.indexOf("\\0") + 1);
const tree = body.match(/^tree ([0-9a-f]{40})/m)[1];
const title = body.slice(body.indexOf("\\n\\n") + 2).trim().split("\\n")[0];
const files = readdirSync(".").filter(file => file.startsWith("feature-")).sort();
appendFileSync(log, JSON.stringify({ product, title, sha, tree, files }) + "\\n");
if (existsSync(root + "/hold-" + title)) while (!existsSync(root + "/release-" + title)) await Bun.sleep(10);
process.exit(existsSync("reject-shared") && existsSync("feature-shared") ? 1 : 0);`;
  const open = () => {
    const engine = lifetime.open(data, {
      agentCommand: () => { throw new Error("Approved local delivery needs no agent"); },
      terminals: () => [],
      toolProbe: READY_TOOLS,
      checkRuns,
      runCheckCommand: async (req) => {
        if (req.argv[0] !== process.execPath || req.argv[1] !== check) return undefined;
        const [targetLog, targetRoot, product] = req.argv.slice(2);
        const ver = readWorktreeCommit(req.cwd)!;
        const title = ver.body.trim().split("\n")[0]!;
        const files = readdirSync(req.cwd).filter(file => file.startsWith("feature-")).sort();
        appendFileSync(targetLog!, `${JSON.stringify({ product, title, sha: ver.commit, tree: ver.tree, files })}\n`);
        if (existsSync(join(targetRoot!, `hold-${title}`))) {
          while (!existsSync(join(targetRoot!, `release-${title}`)) && !req.signal?.aborted) await Bun.sleep(5);
        }
        if (req.signal?.aborted) return { code: 130 };
        return { code: existsSync(join(req.cwd, "reject-shared")) && existsSync(join(req.cwd, "feature-shared")) ? 1 : 0 };
      },
    });
    installSharedWorkflowFastPaths(engine, { skipDriverPrepare: false, skipUpToDate: true, fastCheckCapture: true, fastCleanup: true, fastCheckpoints: true });
    engine.schedule = () => {};
    return engine;
  };
  let engine!: Engine;
  const held = new Set<string>();
  let closing: Promise<void> | undefined;
  const dispose = () => closing ??= Promise.resolve().then(async () => {
    const errors: unknown[] = [];
    for (const name of held) try { writeFileSync(join(root, `release-${name}`), "Continue"); } catch (error) { errors.push(error); }
    try { await lifetime.close(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Destination fixture cleanup could not be confirmed");
  });
  return setupWithCleanup(() => lifetime.prepare(async () => {
    writeFileSync(check, program);
    engine = open();
    await engine.waitUntilReady(); engine.setPoolPaused(false);
    const owners: { id: string; path: string; name: string; baseSha: string; baseTree: string }[] = [];
    for (const name of products) {
      const path = await makeProduct(join(root, name), { origin: "none" });
      const baseSha = readBranchSha(path, "main");
      const baseTree = readCommitTree(join(path, ".git"), baseSha);
      const id = installPreparedProduct(engine, { id: ["clone", "clone-2", "clone-3"][owners.length]!, name: name.toUpperCase(), repo: "local/clone", tone: (["blue", "green", "orange"] as const)[owners.length]!, path, defaultBranch: "main", delivery: "local", approveDelivery: true });
      engine.setProductChecks(id, [{ name: "Tests", command: commandInputText([process.execPath, check, log, root, name]) }]);
      owners.push({ id, path, name, baseSha, baseTree });
    }
    const add = (name: string, indices = [0], branch = "main") => {
      const current = engine;
      return lifetime.run(current, async () => {
      const selected = indices.map(index => owners[index]!);
      const task = current.task(current.addTask({ productId: selected[0]!.id, title: name, delivery: "local", backlog: true }))!;
      task.state = "waiting"; task.startedAt = current.s.tasks.length; task.stageIndex = 1;
      task.plan = { rationale: "Only approved local delivery is under test", plannerProfileId: "sol-high", stages: [
        { id: "approval", title: "Approve delivery", kind: "gate", gate: "delivery", roleId: "coordinator", profileIds: [] },
        { id: "ship", title: "Ship", kind: "do", roleId: "release-manager", profileIds: ["sol-high"] },
      ] };
      if (selected.length > 1) {
        task.repositories = selected.map(owner => ({ productId: owner.id, delivery: "local", completedStages: [], preparation: "ready" }));
        delete task.repository; task.leadProductId = selected[0]!.id; task.activeProductId = selected[0]!.id;
      }
      for (const scope of scopesFor(task)) {
        const work = scope.work;
        const owner = owners.find(entry => entry.id === work.productId)!;
        if (branch !== "main") {
          const branchRef = join(owner.path, ".git", "refs", "heads", ...branch.split("/"));
          mkdirSync(dirname(branchRef), { recursive: true });
          writeFileSync(branchRef, `${owner.baseSha}\n`);
        }
        const taskBranch = `petrina/${name}-${task.id}`;
        const worktree = join(data, "worktrees", owner.id, task.id);
        work.source = {
          product: { id: owner.id, name: owner.name.toUpperCase(), path: owner.path, repo: "local/clone", defaultBranch: "main" },
          start: { kind: "default", branch },
          destination: { kind: "branch", repo: "local/clone", mode: "local", branch },
          initialSha: owner.baseSha,
          confirmed: true,
        };
        work.branch = taskBranch;
        work.worktree = worktree;
        work.hooking = false;
        work.base = branch;
        work.baseSha = owner.baseSha;
        const seed = await materializePreparedWorktree(current, scope, owner.path, branch, owner.baseSha, `feature-${name}`, `${name}\n`, name);
        current.log(scope, "milestone", "Set up a fresh working copy");
        if ("completedStages" in work) work.completedStages = ["build"];
        work.report = { title: name, summary: `Deliver ${name}`, changes: [`Added ${name}`] };
        work.approvedSha = seed.head; work.approvedPatch = seed.patch;
        work.approvedFor = { by: "coordinator", mode: "local", destination: destination(work, current.repositoryOf(scope)) };
        current.commit();
      }
      return task;
      });
    };
    const evidence = (): Observation[] => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
    return {
      root, owners, add, evidence, engine: () => engine, dispose,
      run: <T>(work: () => Promise<T>) => lifetime.prepare(work),
      hold: (name: string) => { held.add(name); writeFileSync(join(root, `hold-${name}`), "Hold this check"); },
      release: (name: string) => writeFileSync(join(root, `release-${name}`), "Continue"),
      schedule: () => engine["driver"].schedule(),
      restart: () => lifetime.prepare(async () => { await lifetime.stop(engine); engine = open(); await engine.waitUntilReady(); }),
    };
  }), dispose);
}








it("looks up an interrupted local publication after restart before checking and landing the next delivery", async () => {
  let fixtureOwner: Awaited<ReturnType<typeof fixture>> | undefined;
  await setupWithCleanup(async () => {
  const f = (fixtureOwner = await fixture());
  await setupWithCleanup(() => f.run(async () => {
    const first = await f.add("first"), second = await f.add("second");
    const firstScope = executionFor(first), signal = new AbortController().signal;
    try {
      expect(f.engine()["shipping"].waitingForTurn(first)).toBeUndefined();
      expect(f.engine()["shipping"].waitingForTurn(second)).toContain("first");
      expect((await f.engine()["checks"].failing(firstScope, signal)).kind).toBe("passed");
      const tested = readWorktreeCommit(firstScope.work.worktree!)!.commit;
      // Save exactly the window after an admitted local update reached Git, before its result reached state.
      first.state = "running";
      firstScope.work.shipping = { start: tested, base: firstScope.work.baseSha, prepared: { tested, summary: "Ready" }, step: "update", boot: f.engine().boot, moves: 0, failures: 0 };
      await gitOps.moveTo(f.owners[0]!.path, tested);
      f.engine().commitNow();
      await f.restart();
      const recovered = f.engine().task(first.id)!;
      expect(f.engine()["shipping"]["admission"].entries()).toEqual([]);
      expect(recovered.state).toBe("waiting");
      f.schedule();
      await waitFor(() => recovered.state === "done" && !f.engine().settling.has(first.id), "the interrupted publication lookup");
      expect(recovered.timeline.some(line => line.text.startsWith("Found after a restart that it had already gone out"))).toBe(true);
      expect(f.evidence().map(run => run.title)).toEqual(["first"]);
      f.schedule();
      const next = f.engine().task(second.id)!;
      await waitFor(() => next.state === "done" && !f.engine().settling.has(second.id), "the waiting task to finish after restart");
      const runs = f.evidence(); expect(runs.map(run => run.title)).toEqual(["first", "second"]);
      expect(runs[1]!.files).toEqual(["feature-first", "feature-second"]);
      expect(readBranchSha(f.owners[0]!.path, "main")).toBe(runs[1]!.sha);
    } finally {  }

  }), () => f.dispose());
  await f.dispose();

  }, async () => { await fixtureOwner?.dispose(); });
});



it("reacquires the destination outside check capacity when discovery resumes after a coordinator decision", async () => {
  let fixtureOwner: Awaited<ReturnType<typeof fixture>> | undefined;
  await setupWithCleanup(async () => {
  const f = (fixtureOwner = await fixture());
  await setupWithCleanup(() => f.run(async () => {
    const first = await f.add("first"), second = await f.add("second");
    const checks = f.engine()["checks"], cached = checks["cachedChecks"].bind(checks), ensure = checks.ensureChecks.bind(checks);
    const occupied = [f.engine().checkQueue.hold(), f.engine().checkQueue.hold()];
    let discovered = false;
    checks["cachedChecks"] = scope => scope.task.id === first.id && !discovered ? undefined : cached(scope);
    checks.ensureChecks = async (scope, signal) => {
      if (scope.task.id !== first.id || discovered) return ensure(scope, signal);
      // Use the real question boundary: no manual state change or scheduling wake can hide a delay.
      await f.engine()["turns"]["wait"]({
        scope,
        kind: "question",
        title: "Which checks should run?",
        blocking: true,
        extra: {},
        signal,
        status: "Waiting for your answer",
        by: { roleId: "check-finder", profileId: "sol-high" },
        main: false,
      });
      discovered = true;
      return cached(scope)!;
    };
    f.hold("second");
    try {
      f.engine().startDriver(first.id);
      await waitFor(() => f.engine().checkQueue.waiting === 1, "the first final checks to queue");
      expect(f.engine()["shipping"].waitingForTurn(second)).toContain("first");
      f.engine().schedule = Engine.prototype.schedule.bind(f.engine());
      occupied[0]!();
      await waitFor(() => f.engine().waiting.size === 1, "the finder question");
      occupied[1]!();
      await waitFor(() => f.evidence().some(run => run.title === "second"), "the second delivery to wake from the actual question");
      f.engine().answer(f.engine().s.inbox.find(item => item.taskId === first.id && item.kind === "question")!.id, "Continue");
      await waitFor(() => !f.engine().settling.has(first.id), "the resumed finder to yield before final commands");
      expect(first.state).toBe("waiting"); expect(first.statusLine).toContain("second");
      expect(f.evidence().map(run => run.title)).toEqual(["second"]);
      expect(f.engine().checkQueue.running).toBe(1); expect(f.engine().checkQueue.waiting).toBe(0);
      expect(f.engine()["checks"]["preparations"].has(first.id)).toBe(false);
      f.release("second");
      await waitFor(() => second.state === "done" && !f.engine().settling.has(second.id), "the second delivery to land");
      f.schedule(); await waitFor(() => first.state === "done" && !f.engine().settling.has(first.id), "the first delivery's only final command and landing");
      expect(f.evidence().map(run => [run.title, run.files])).toEqual([["second", ["feature-second"]], ["first", ["feature-first", "feature-second"]]]);
    } finally {
      for (const finish of occupied) finish(); f.release("second");
      checks["cachedChecks"] = cached; checks.ensureChecks = ensure;

    }

  }), () => f.dispose());
  await f.dispose();

  }, async () => { await fixtureOwner?.dispose(); });
});

for (const confirmation of ["own", "peer"] as const) it(`returns admitted check capacity while its ${confirmation} repository address confirmation waits`, async () => {
  let fixtureOwner: Awaited<ReturnType<typeof fixture>> | undefined;
  await setupWithCleanup(async () => {
  const f = (fixtureOwner = await fixture(["a"], 1)), task = await f.add("address"), scope = executionFor(task);
  await setupWithCleanup(() => f.run(async () => {
    const controller = new AbortController(), occupied = f.engine().checkQueue.hold();
    const product = f.engine().s.products.find(product => product.id === scope.work.productId)!;
    const address = "https://github.com/acme/address.git";
    product.repo = "acme/address"; delete product.remote;
    scope.work.source!.product.repo = product.repo; delete scope.work.source!.product.remote;
    appendFileSync(join(product.path!, ".git", "config"), `\n[remote "origin"]\n\turl = ${address}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
    const owner = confirmation === "peer" ? f.engine().task(f.engine().addTask({ productId: product.id, title: "Address owner", backlog: true }))! : task;
    let attempt: Promise<CheckVerification> | undefined, follower: Promise<() => void> | undefined, confirming: Promise<unknown> | undefined;
    try {
      if (confirmation === "peer") {
        confirming = f.engine()["connections"].connection(executionFor(owner), controller.signal);
        await waitFor(() => f.engine().waiting.size === 1, "the peer address confirmation");
      }
      task.state = "running"; f.engine().drivers.set(task.id, controller);
      expect(f.engine()["shipping"].waitingForTurn(task)).toBeUndefined();
      attempt = f.engine()["checks"].failing(scope, controller.signal, undefined, "review", async () => {
        const connection = await f.engine()["connections"].connection(scope, controller.signal);
        expect(connection.ok).toBe(true);
        return true;
      });
      await waitFor(() => f.engine().checkQueue.waiting === 1, "the address check to queue");
      let followerStarted = false;
      follower = f.engine().checkQueue.acquire(new AbortController().signal, true).then(place => { followerStarted = true; return place; });
      occupied();
      await waitFor(() => f.engine().waiting.size === 1, "the actual address confirmation");
      await waitFor(() => followerStarted, "the follower to start before any confirmation answer");
      expect(followerStarted).toBe(true);
      expect(f.engine()["checks"].preparingCount).toBe(0);
      expect(f.engine()["shipping"]["admission"].entries()).toEqual([]);
      expect(f.evidence()).toEqual([]);
      expect(f.engine().s.inbox.filter(item => item.kind === "question")).toHaveLength(1);
      f.engine().answer(f.engine().s.inbox.find(item => item.taskId === owner.id && item.kind === "question")!.id, CONFIRM_ADDRESS);
      await confirming;
      (await follower)();
      expect((await attempt).kind).toBe("passed");
      expect(f.evidence()).toHaveLength(1);
      expect(f.engine().checkQueue.running).toBe(0);
    } finally {
      occupied(); controller.abort(); if (follower) (await follower)(); await attempt?.catch(() => {}); await confirming?.catch(() => {});
      f.engine().drivers.delete(task.id);
    }

  }), () => f.dispose());
  await f.dispose();

  }, async () => { await fixtureOwner?.dispose(); });
});



for (const changed of [true]) it(`refreshes all shared products before publishing after ${changed ? "a changed" : "an unchanged"} product confirms its address`, async () => {
  let fixtureOwner: Awaited<ReturnType<typeof fixture>> | undefined;
  await setupWithCleanup(async () => {
  const f = (fixtureOwner = await fixture(["a", "b", "c"])), shared = await f.add("shared", [0, 2, 1]), second = await f.add("second");
  await setupWithCleanup(() => f.run(async () => {
    const engine = f.engine(), shipping = engine["shipping"], signal = new AbortController().signal;
    const [a, c, b] = scopesFor(shared), productB = engine.s.products.find(product => product.id === b!.work.productId)!;
    const fetch = engine["connections"].fetchDefault.bind(engine["connections"]);
    // The real connection asks the real coordinator question; fetching stays inside this fixture.
    engine["connections"].fetchDefault = async (scope, currentSignal) => {
      if (scope.work.productId !== productB.id) return fetch(scope, currentSignal);
      await engine["connections"].connection(scope, currentSignal);
      return { ok: false, error: "This fixture uses the local branch", missing: true };
    };
    productB.repo = "acme/address"; delete productB.remote; delete productB.remoteRefused;
    b!.work.source!.product.repo = productB.repo;
    delete b!.work.source!.product.remote;
    appendFileSync(join(productB.path!, ".git", "config"), `\n[remote "origin"]\n\turl = https://github.com/acme/address.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
    if (!changed) {
      await gitOps.moveTo(b!.work.worktree!, b!.work.baseSha!);
      b!.work.approvedSha = b!.work.baseSha;
      delete b!.work.approvedPatch;
    }
    let delivery: Promise<"continue" | "stop"> | undefined;
    const stage = shared.plan!.stages[shared.stageIndex]!;
    try {
      expect(shipping.waitingForTurn(shared)).toBeUndefined();
      for (const scope of [a!, c!]) {
        expect(await shipping["readyToShip"](scope, signal)).toBe("ready");
        expect(await shipping["prepare"](scope, stage, signal)).toBe("ready");
      }
      delivery = shipping.deliver(shared, stage, signal);
      await waitFor(() => engine.s.inbox.some(item => item.taskId === shared.id && item.kind === "question"), "the last product's address question");
      expect(shipping["admission"].entries()).toEqual([]);
      expect(a!.work.shipping?.prepared).toBeUndefined();
      expect(c!.work.shipping?.prepared).toBeUndefined();
      // A competing approved local task lands while the shared task has yielded its turn.
      expect(await shipping.deliver(second, second.plan!.stages[second.stageIndex]!, signal)).toBe("stop");
      shipping.finishDeliveryTurn(second.id);
      const secondTip = readBranchSha(f.owners[0]!.path, "main");
      writeFileSync(join(f.owners[2]!.path, "reject-shared"), "The combined shared change must fail\n");
      await gitOps.commitChanges(f.owners[2]!.path, "Reject the combined shared change");
      const outsideTip = readBranchSha(f.owners[2]!.path, "main");
      engine.answer(engine.s.inbox.find(item => item.taskId === shared.id && item.kind === "question")!.id, CONFIRM_ADDRESS);
      expect(await delivery).toBe("continue");
      expect(shared.repositories!.every(work => !work.landed)).toBe(true);
      expect(readBranchSha(f.owners[0]!.path, "main")).toBe(secondTip);
      expect(await shipping.deliver(shared, stage, signal)).toBe("continue");
      expect(shared.stageIndex).toBe(0);
      expect(shared.repositories!.every(work => !work.landed)).toBe(true);
      expect(readBranchSha(f.owners[0]!.path, "main")).toBe(secondTip);
      expect(readBranchSha(f.owners[2]!.path, "main")).toBe(outsideTip);
      expect(f.evidence().filter(run => run.product === "a").map(run => [run.title, run.files])).toEqual([
        ["shared", ["feature-shared"]], ["second", ["feature-second"]], ["shared", ["feature-second", "feature-shared"]],
      ]);
      const cRuns = f.evidence().filter(run => run.product === "c");
      expect(cRuns).toHaveLength(2);
      expect(cRuns[1]!.tree).not.toBe(cRuns[0]!.tree);
      expect(c!.work.checks?.tree).toBe(cRuns[1]!.tree);
      expect(c!.work.checks?.results.every(result => result.ok)).toBe(false);
    } finally {
      engine["connections"].fetchDefault = fetch;
      // A failed assertion must still let the address helper settle before shutting down its owner.
      const question = engine.s.inbox.find(item => item.taskId === shared.id && item.kind === "question");
      if (question) engine.answer(question.id, "No, it is not");
      await delivery?.catch(() => {}); shipping.finishDeliveryTurn(shared.id); await engine.shutdown();
    }

  }), () => f.dispose());
  await f.dispose();

  }, async () => { await fixtureOwner?.dispose(); });
});



it("refreshes saved shared local candidates after shutdown before publishing any product", async () => {
  let fixtureOwner: Awaited<ReturnType<typeof fixture>> | undefined;
  await setupWithCleanup(async () => {
  const f = (fixtureOwner = await fixture(["a", "c"])), task = await f.add("shared", [0, 1]);
  await setupWithCleanup(() => f.run(async () => {
    const engine = f.engine(), shipping = engine["shipping"], prepare = shipping["prepare"].bind(shipping);
    let stopped: Promise<void> | undefined;
    shipping["prepare"] = async (...args) => {
      const result = await prepare(...args);
      if (args[0].work.productId === f.owners[1]!.id) {
        // The real stop saves before this direct admitted preparation unwinds.
        stopped = engine.shutdown(); await stopped;
      }
      return result;
    };
    try {
      expect(await shipping.deliver(task, task.plan!.stages[task.stageIndex]!, new AbortController().signal).catch(error => error)).toBeInstanceOf(WaitingForUsage);
      await stopped; await f.restart();
      const recovered = f.engine().task(task.id)!;
      expect(scopesFor(recovered).every(({ work }) => !!work.shipping?.prepared)).toBe(true);
      for (const owner of f.owners) {
        writeFileSync(join(owner.path, owner.name === "c" ? "reject-shared" : "outside-fix"), "New main after restart\n");
        await gitOps.commitChanges(owner.path, "Advance main before the task resumes");
      }
      const latest = f.owners.map(owner => readBranchSha(owner.path, "main"));
      f.schedule();
      await waitFor(() => recovered.stageIndex === 0 && !f.engine().settling.has(recovered.id), "the restarted task to stop at its failed combined checks");
      expect(recovered.repositories!.every(work => !work.landed)).toBe(true);
      expect(f.owners.map(owner => readBranchSha(owner.path, "main"))).toEqual(latest);
      for (const owner of f.owners) {
        const runs = f.evidence().filter(run => run.product === owner.name);
        expect(runs).toHaveLength(2);
        expect(runs[1]!.tree).not.toBe(runs[0]!.tree);
        expect(scopesFor(recovered).find(({ work }) => work.productId === owner.id)!.work.checks?.tree).toBe(runs[1]!.tree);
      }
    } finally { shipping["prepare"] = prepare; await stopped;  }

  }), () => f.dispose());
  await f.dispose();

  }, async () => { await fixtureOwner?.dispose(); });
});

for (const outcome of ["cancelled", "unavailable"] as const) it(`returns check capacity when admitted source preparation is ${outcome}`, async () => {
  let fixtureOwner: Awaited<ReturnType<typeof fixture>> | undefined;
  await setupWithCleanup(async () => {
  const f = (fixtureOwner = await fixture(["a"], 1));
  await setupWithCleanup(() => f.run(async () => {
    const task = await f.add("preparing"), scope = executionFor(task);
    const controller = new AbortController();
    const occupied = f.engine().checkQueue.hold();
    let entered!: () => void, release!: () => void;
    const preparing = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const failure = new Error("The approved source is unavailable");
    let attempt: Promise<unknown> | undefined, follower: Promise<() => void> | undefined;
    try {
      task.state = "running"; f.engine().drivers.set(task.id, controller);
      attempt = f.engine()["checks"].failing(scope, controller.signal, undefined, "review", async () => {
        entered(); await gate;
        if (outcome === "unavailable") throw failure;
        return true;
      }).catch(error => error);
      await waitFor(() => f.engine().checkQueue.waiting === 1, "the ordinary check to enter the line");
      let followerStarted = false;
      follower = f.engine().checkQueue.acquire(new AbortController().signal, true).then(place => { followerStarted = true; return place; });
      occupied(); await preparing;
      expect(f.engine().checkQueue.running).toBe(1); expect(followerStarted).toBe(false);
      if (outcome === "cancelled") f.engine().cancel(task.id);
      release();
      const result = await attempt;
      if (outcome === "cancelled") expect(result).toBeInstanceOf(Aborted);
      else expect(result).toBe(failure);
      (await follower)();
      expect(f.evidence()).toEqual([]);
      expect(f.engine().checkQueue.running).toBe(0); expect(f.engine().checkQueue.waiting).toBe(0);
      expect(f.engine()["checks"].preparingCount).toBe(0);
      expect(scope.work.checkReturns).toBeUndefined();
      expect(task.journey!.flatMap(step => step.productChecks ?? []).every(check => check.result === "stopped")).toBe(true);
    } finally {
      occupied(); release(); await attempt; if (follower) (await follower)();
      f.engine().drivers.delete(task.id);
    }

  }), () => f.dispose());
  await f.dispose();

  }, async () => { await fixtureOwner?.dispose(); });
});
