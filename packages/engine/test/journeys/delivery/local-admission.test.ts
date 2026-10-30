import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { afterEach, expect, it, spyOn } from "bun:test";
import { completeAll, type ExtraValidation } from "@petrina/core";
import { readFixtureJsonLines } from "@petrina/test-support/fixture-json";
import { createHash } from "node:crypto";
import * as gitOps from "@petrina/repositories/git";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { directDrivers } from "../../fixtures/direct-drivers.js";
import { installPreparedProduct, privateCloneProduct } from "../../fixtures/prepared-product.js";
import { localFixtureSource } from "../../fixtures/prepared-runtime.js";
import { privateAgentToolProbe } from "../../scripted-probes.js";
import { scriptedExtraCheckRunner } from "../../extra-fixtures.js";
import { scriptedContainerControl, scriptedContainerInspection } from "../../fixtures/container-inspection.js";
import { installSharedWorkflowFastPaths, materializePreparedWorktree, readLooseCommit, readRef, readWorktreeCommit } from "../../fixtures/shared-preparation.js";
import { commandInputText } from "../../../src/checks.js";
import { executionFor } from "@petrina/orchestrator";
import { destination } from "../../../src/shipping.js";
import { Coordination } from "../../../src/coordination.js";
import { createProductRepository, tempDir, waitFor } from "../../fixtures.js";

const owners = new Set<{ close(): Promise<void> }>();
afterEach(() => completeAll([...owners].map(owner => owner.close())));

/** Planning, building, review and approval have settled; exercise real scheduling, checks and local placement. */
async function prepareApprovedDeliveries(root: string, lifetime: ReturnType<typeof directDrivers>, onClose: (stop: () => void) => void, firstFails: boolean, names: string[]) {
  const service = join(root, "service"); mkdirSync(service);
  const productRepo = await createProductRepository(root, { origin: "none" });
  const repo = productRepo.path;
  const dataDir = join(root, "data");
  const containerClient = join(import.meta.dir, "../../fake-extra-container.ts");
  const log = join(root, "checks.jsonl"), release = join(root, "release-first"), script = join(root, "check.ts"), independentCheck = join(root, "independent-check.ts");
  const engine = lifetime.open(dataDir, { agentCommand: () => undefined, toolProbe: privateAgentToolProbe(), terminals: () => [], checkRuns: 2,
    containerTool: [process.execPath, containerClient, service],
    containerInspection: scriptedContainerInspection(service),
    containerControl: scriptedContainerControl(service, () => createHash("sha256").update(realpathSync(dataDir)).digest("hex")),
    extraCleanupEveryMs: 60_000,
    validationSnapshots: {
      async snapshot(record) {
        const commit = readLooseCommit(join(record.source, ".git"), record.commit);
        if (!commit || commit.tree !== record.tree) throw new Error("The validation copy does not match the saved commit");
        mkdirSync(join(record.snapshot, ".git"), { recursive: true, mode: 0o755 });
      },
    },
    runCheckCommand: scriptedExtraCheckRunner(containerClient, service, async (req) => {
      if (req.argv[0] === process.execPath && req.argv[1] === script) {
        const ver = readWorktreeCommit(req.cwd)!;
        const files = ["feature-first", "feature-second"].filter(file => existsSync(join(req.cwd, file)));
        const ok = !existsSync(join(req.cwd, "fail-check"));
        appendFileSync(req.argv[2]!, `${JSON.stringify({ sha: ver.commit, tree: ver.tree, files, outside: existsSync(join(req.cwd, "outside-change")), ok })}\n`);
        if (!existsSync(join(req.cwd, "feature-second"))) {
          while (!existsSync(req.argv[3]!) && !req.signal?.aborted) await Bun.sleep(5);
        }
        return { code: req.signal?.aborted ? 130 : ok ? 0 : 1 };
      }
      if (req.argv[0] === process.execPath && req.argv[1] === independentCheck) {
        writeFileSync(req.argv[2]!, "Started");
        while (!existsSync(req.argv[3]!) && !req.signal?.aborted) await Bun.sleep(5);
        return { code: req.signal?.aborted ? 130 : 0 };
      }
      return undefined;
    }),
  });
  installSharedWorkflowFastPaths(engine, {
    skipDriverPrepare: false,
    skipUpToDate: true,
    skipPrepareChecks: true,
    skipReviewCopies: true,
    skipReviewInputDiffs: true,
    fastCheckCapture: true,
    fastCleanup: true,
    fastCheckpoints: true,
  });
  const container = engine.extraValidations["container"];
  container["stopClient"] = async (record: ExtraValidation) => {
    if (record.clientPid) {
      try { process.kill(-record.clientPid, "SIGKILL"); } catch {}
      try { process.kill(record.clientPid, "SIGKILL"); } catch {}
    }
    return true;
  };
  engine.schedule = () => {};
  await engine.waitUntilReady();
  engine.setPoolPaused(false);
  const productId = installPreparedProduct(engine, { ...privateCloneProduct(repo), remote: undefined });
  const tasks = [];
  for (const name of names) {
    const task = engine.task(engine.addTask({ productId, title: `Deliver ${name}`, delivery: "local", backlog: true }))!;
    await localFixtureSource(engine, task, { initial: productRepo, check: () => {} });
    task.state = "waiting"; task.startedAt = name === "first" ? 1 : 2; task.stageIndex = 1;
    task.plan = { rationale: "Approved local deliveries", plannerProfileId: "sol-high", stages: [
      { id: "approval", title: "Delivery check", kind: "gate", gate: "delivery", roleId: "coordinator", profileIds: [] },
      { id: "ship", title: "Ship", kind: "do", roleId: "release-manager", profileIds: ["sol-high"] },
    ] };
    const scope = executionFor(task);
    const seed = await materializePreparedWorktree(
      engine,
      scope,
      repo,
      "main",
      productRepo.initialSha,
      `feature-${name}`,
      `${name}\n`,
      task.title,
      firstFails && name === "first" ? { "fail-check": "A genuine check failure\n" } : undefined,
    );
    scope.work.approvedSha = seed.head;
    scope.work.approvedPatch = seed.patch;
    scope.work.approvedFor = { by: "coordinator", mode: "local", destination: destination(scope.work, engine.repositoryOf(scope)) };
    tasks.push(task);
  }
  writeFileSync(script, `import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";`);
  engine.setProductChecks(productId, [{ name: "Tests", command: commandInputText([process.execPath, script, log, release]) }]);
  const evidence = () => readFixtureJsonLines<{ sha: string; tree: string; files: string[]; outside: boolean; ok: boolean }>(log);
  return { root, service, productId, engine, repo, tasks, evidence, onClose,
    run: <T>(start: () => Promise<T>) => lifetime.run(engine, start),
    hold: () => { const release = engine.checkQueue.hold(); onClose(release); return release; },
    release: () => writeFileSync(release, "Continue"), schedule: () => engine["driver"].schedule() };

}

async function approvedDeliveries<T>(body: (fixture: Awaited<ReturnType<typeof prepareApprovedDeliveries>>) => Promise<T>, firstFails = false, names = ["first", "second"]): Promise<T> {
  const root = tempDir("petrina-local-admission-"), lifetime = directDrivers(root);
  const releases: (() => void)[] = [() => writeFileSync(join(root, "release-first"), "Continue")];
  let closing: Promise<void> | undefined;
  const close = () => {
    if (closing) return closing;
    const settled = Promise.withResolvers<void>(); closing = settled.promise;
    // Register every release before closing admission; one failed release must not skip another stop.
    const released = lifetime.prepare(() => completeAll(releases.map(release => {
      try { return Promise.resolve(release()); } catch (error) { return Promise.reject(error); }
    })).then(() => undefined));
    const stopped = lifetime.close();
    void completeAll([released, stopped]).then(() => settled.resolve(), settled.reject);
    void closing.then(() => owners.delete(entry), () => owners.delete(entry));
    return closing;
  };
  const entry = { close }; owners.add(entry);
  const onClose = (release: () => void) => { if (closing) throw new Error("Local delivery fixture is closing"); releases.push(release); };
  const result = await setupWithCleanup(() => lifetime.prepare(async () => {
    const fixture = await prepareApprovedDeliveries(root, lifetime, onClose, firstFails, names);
    return lifetime.run(fixture.engine, () => body(fixture));
  }), close);
  await close(); return result;
}

it("checks two approved local deliveries once each on their exact successive integrated trees", async () => {
  return approvedDeliveries(async f => {
    const [first, second] = f.tasks;
    try {
      f.schedule();
      await waitFor(() => f.evidence().length === 1, "the first final check to start", undefined, { during: f.engine.settling.get(first!.id) });
      expect(first!.state).toBe("running");
      expect(second!.state).toBe("waiting");
      expect(second!.statusLine).toBe("Waiting for “Deliver first” to finish delivering to main");
      expect(second!.agent).toBeUndefined();
      expect(second!.holdsSlot).toBe(false);
      expect(f.engine.drivers.has(second!.id)).toBe(false);
      expect(f.engine.checkQueue.running).toBe(1);
      expect(f.engine.checkQueue.waiting).toBe(0);
      expect(f.evidence()[0]!.files).toEqual(["feature-first"]);
      f.release();
      await waitFor(() => first!.state === "done" && !f.engine.settling.has(first!.id), "the first delivery to finish", undefined, { during: f.engine.settling.get(first!.id) });
      const firstTip = readRef(join(f.repo, ".git"), "refs/heads/main")!;
      expect(firstTip).toBe(f.evidence()[0]!.sha);
      f.schedule();
      await waitFor(() => second!.state === "done" && !f.engine.settling.has(second!.id), "the second delivery to finish", undefined, { during: f.engine.settling.get(second!.id) });
      const runs = f.evidence();
      expect(runs).toHaveLength(2);
      expect(runs.map(run => run.files)).toEqual([["feature-first"], ["feature-first", "feature-second"]]);
      const finalTip = readRef(join(f.repo, ".git"), "refs/heads/main")!;
      expect(finalTip).toBe(runs[1]!.sha);
      expect(readLooseCommit(join(f.repo, ".git"), finalTip)?.parents[0]).toBe(firstTip);
      for (const [index, task] of f.tasks.entries()) {
        expect(task.error).toBeUndefined();
        expect(executionFor(task).work.checks).toMatchObject({ sha: runs[index]!.sha, tree: runs[index]!.tree, current: true });
        expect(runs[index]!.ok).toBe(true);
      }
    } finally { f.release(); }


  });
});

it.skipIf(process.platform === "win32")("runs another review and its saved extra validation while a local delivery waits for its branch", async () => {
  return approvedDeliveries(async f => {
    const [first, second] = f.tasks;
    const started = join(f.root, "review-started"), released = join(f.root, "release-review");
    f.onClose(() => writeFileSync(released, "Continue"));
    let reviewing: Promise<"continue" | "stop"> | undefined;
    try {
      const other = join(f.root, "other"); mkdirSync(other);
      const cloneRepo = await createProductRepository(other, { origin: "none" });
      f.engine.stopRequested.signal.throwIfAborted();
      const clone = cloneRepo.path;
      const productId = installPreparedProduct(f.engine, { ...privateCloneProduct(clone), id: "clone-2", name: "Independent product", tone: "green", remote: undefined });
      const task = f.engine.task(f.engine.addTask({ productId, title: "Review independent work", delivery: "local", backlog: true }))!;
      await localFixtureSource(f.engine, task, { initial: cloneRepo, check: () => {} });
      task.state = "running"; task.startedAt = 3; task.stageIndex = 1;
      task.plan = { rationale: "Independent review", plannerProfileId: "sol-high", stages: [
        { id: "build", title: "Build", kind: "do", roleId: "builder", profileIds: ["sol-high"] },
        { id: "review", title: "Review", kind: "review-chain", roleId: "code-reviewer", profileIds: ["sol-high"], maxRounds: 2 },
      ] };
      const scope = executionFor(task), signal = new AbortController().signal;
      await materializePreparedWorktree(f.engine, scope, clone, "main", cloneRepo.initialSha, "independent-feature", "Ready for review\n", task.title);
      await f.engine.rememberVersion(scope);
      const check = join(f.root, "independent-check.ts");
      writeFileSync(check, `import { existsSync, writeFileSync } from "node:fs";
writeFileSync(process.argv[2], "Started");
while (!existsSync(process.argv[3])) await Bun.sleep(10);`);
      f.engine.setProductChecks(productId, [{ name: "Review checks", command: commandInputText([process.execPath, check, started, released]) }]);
      // Keep the independent review outside the scheduler until its explicit check request below.
      task.state = "needs-you";
      f.schedule();
      await waitFor(() => f.evidence().length === 1, "the first local delivery's final run", undefined, { during: f.engine.settling.get(first!.id) });
      task.state = "running";
      reviewing = f.run(() => f.engine["reviews"].runReview(task, task.plan!.stages[1]!, signal));
      await Promise.race([waitFor(() => existsSync(started), "the independent review checks"), reviewing.then(() => {
        throw new Error(`Review ended before its check barrier: ${task.statusLine}; ${JSON.stringify(scope.work.checks)}`);
      })]);
      const requested = scope.work.savedVersion!;
      const coordination = new Coordination(f.engine);
      const reply = await coordination.call("validation.run", { taskId: task.id, name: "Saved platform proof", reason: "Independent required validation", image: "local:ready", argv: ["probe", "pass"], requestId: "independent-during-delivery" });
      f.engine.extraValidations.pump(); // This isolated fixture drives scheduling explicitly.
      expect(reply.outcome).toBe("pending");
      expect(f.engine.checkQueue.running).toBe(2); expect(f.engine.checkQueue.waiting).toBe(1);
      expect(second!.holdsSlot).toBe(false); expect(second!.agent).toBeUndefined();
      expect(f.engine.drivers.has(second!.id)).toBe(false);
      writeFileSync(released, "Continue"); await reviewing;
      await waitFor(() => f.engine.extraValidations.get("independent-during-delivery")?.outcome === "completed", "the saved validation while the first delivery is held");
      const validation = f.engine.extraValidations.get("independent-during-delivery")!.validation!;
      expect(validation).toMatchObject({ commit: requested.commit, tree: requested.tree, result: "passed" });
      expect(first!.state).toBe("running"); expect(second!.state).toBe("waiting");
      expect(f.evidence()).toHaveLength(1);
      expect(f.engine["checks"].preparingCount).toBe(1);
      const invocations = readFileSync(join(f.service, "calls"), "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]).filter(args => args[0] === "run");
      expect(invocations).toHaveLength(1);
    } finally {
      writeFileSync(released, "Continue"); f.release();
      if (reviewing) await reviewing;
    }


  });
});

for (const outcome of ["failed", "cancelled"] as const) it(`releases a ${outcome} delivery's turn so the next task checks and lands`, async () => {
  return approvedDeliveries(async f => {
    const [first, second] = f.tasks;
    try {
      f.schedule();
      await waitFor(() => f.evidence().length === 1, "the held final check", undefined, { during: f.engine.settling.get(first!.id) });
      if (outcome === "cancelled") f.engine.cancel(first!.id);
      f.release();
      await waitFor(() => !f.engine.settling.has(first!.id), "the stopped holder to release its turn", undefined, { during: f.engine.settling.get(first!.id) });
      expect(first!.state).toBe(outcome === "cancelled" ? "cancelled" : "needs-you");
      f.schedule();
      await waitFor(() => second!.state === "done" && !f.engine.settling.has(second!.id), "the next local delivery", undefined, { during: f.engine.settling.get(second!.id) });
      const runs = f.evidence();
      expect(runs).toHaveLength(2);
      expect(runs[1]!.files).toEqual(["feature-second"]);
      expect(readRef(join(f.repo, ".git"), "refs/heads/main")).toBe(runs[1]!.sha);
      if (outcome === "failed") expect(runs[0]!.ok).toBe(false);
      expect(f.engine.checkQueue.running).toBe(0);
    } finally { f.release(); }


  }, outcome === "failed");
});

for (const when of ["queued", "running"] as const) it(`keeps an outside main advance while final checks are ${when} and verifies the resulting exact tree`, async () => {
  return approvedDeliveries(async f => {
    const [first, second] = f.tasks;
    const occupied = when === "queued" ? [f.hold(), f.hold()] : [];
    try {
      f.schedule();
      if (when === "queued") await waitFor(() => f.engine.waitingChecks.has(first!.id), "the first final run to join the check line", undefined, { during: f.engine.settling.get(first!.id) });
      else await waitFor(() => f.evidence().length === 1, "the first final command to start", undefined, { during: f.engine.settling.get(first!.id) });
      writeFileSync(join(f.repo, "outside-change"), "An outside writer's change\n");
      await gitOps.commitChanges(f.repo, "Outside change");
      const outside = readRef(join(f.repo, ".git"), "refs/heads/main")!;
      occupied.forEach(release => release());
      f.release();
      await waitFor(() => first!.state === "done" && !f.engine.settling.has(first!.id), "the first delivery to revalidate and land", undefined, { during: f.engine.settling.get(first!.id) });
      const firstRuns = f.evidence();
      expect(firstRuns).toHaveLength(when === "queued" ? 1 : 2);
      expect(firstRuns.map(run => run.outside)).toEqual(when === "queued" ? [true] : [false, true]);
      const firstTip = readRef(join(f.repo, ".git"), "refs/heads/main")!;
      expect(firstTip).toBe(firstRuns.at(-1)!.sha);
      expect(readLooseCommit(join(f.repo, ".git"), firstTip)?.parents[0]).toBe(outside);
      f.schedule();
      await waitFor(() => second!.state === "done" && !f.engine.settling.has(second!.id), "the next delivery after the outside change", undefined, { during: f.engine.settling.get(second!.id) });
      const runs = f.evidence();
      expect(runs).toHaveLength(when === "queued" ? 2 : 3);
      expect(runs.at(-1)!.files).toEqual(["feature-first", "feature-second"]);
      expect(runs.at(-1)!.outside).toBe(true);
      expect(readRef(join(f.repo, ".git"), "refs/heads/main")).toBe(runs.at(-1)!.sha);
      expect(executionFor(first!).work.checks?.tree).toBe(firstRuns.at(-1)!.tree);
      expect(executionFor(second!).work.checks?.tree).toBe(runs.at(-1)!.tree);
    } finally { occupied.forEach(release => release()); f.release(); }


  });
});

it("returns changed final approval before any final command starts after a check-line wait", async () => {
  return approvedDeliveries(async f => {
    const [first] = f.tasks;
    const signal = new AbortController().signal;
    const occupied = [f.hold(), f.hold()];
    try {
      const delivery = f.run(() => f.engine["shipping"].deliver(first!, first!.plan!.stages[1]!, signal));
      await waitFor(() => f.engine.waitingChecks.has(first!.id), "the approved final run to wait", undefined, { during: delivery });
      // The task's whole addition is now already present on main; applying it no longer reads as the approved change.
      writeFileSync(join(f.repo, "feature-first"), "first\n");
      await gitOps.commitChanges(f.repo, "Outside writer adds the same change");
      occupied.forEach(release => release());
      expect(await delivery).toBe("continue");
      expect(first!.stageIndex).toBe(0);
      expect(executionFor(first!).work.approvedSha).toBeUndefined();
      expect(f.evidence()).toEqual([]);
      expect(f.engine.checkQueue.running).toBe(0);
      const pending = first!.journey?.flatMap(step => step.productChecks ?? []);
      expect(pending?.some(check => check.result === "skipped" && check.detail?.includes("approval"))).toBe(true);
    } finally { occupied.forEach(release => release()); f.release(); }


  }, false, ["first"]);
});

it("returns a queued final conflict to the Builder and releases its destination without spending a failed-check return", async () => {
  return approvedDeliveries(async f => {
    const [first, second] = f.tasks;
    const signal = new AbortController().signal;
    const occupied = [f.hold(), f.hold()];
    first!.plan!.stages.unshift({ id: "build", title: "Build", kind: "do", roleId: "builder", profileIds: ["sol-high"] });
    first!.stageIndex = 2;
    const work = executionFor(first!).work;
    try {
      const delivery = f.run(() => f.engine["shipping"].deliver(first!, first!.plan!.stages[2]!, signal));
      await waitFor(() => f.engine.waitingChecks.has(first!.id), "the final check to wait on its old source", undefined, { during: delivery });
      expect(f.engine["shipping"].waitingForTurn(second!)).toContain("Deliver first");
      writeFileSync(join(f.repo, "feature-first"), "An incompatible outside version\n");
      await gitOps.commitChanges(f.repo, "Outside conflicting change");
      occupied.forEach(release => release());
      expect(await delivery).toBe("continue");
      expect(first!.stageIndex).toBe(0);
      expect(work.updating?.files).toEqual(["feature-first"]);
      expect(work.approvedSha).toBeUndefined();
      expect(work.checkReturns ?? 0).toBe(0);
      expect(f.evidence()).toEqual([]);
      expect(f.engine.checkQueue.running).toBe(0);
      expect(f.engine["checks"].deliveryOrders.has(first!.id)).toBe(false);
      expect(f.engine["shipping"].waitingForTurn(second!)).toBeUndefined();
    } finally { occupied.forEach(release => release()); f.release(); }


  });
});

it("keeps the holder's queued check over a pool pause while a cancelled turn waiter leaves without a command", async () => {
  return approvedDeliveries(async f => {
    const [first, second] = f.tasks;
    const occupied = [f.hold(), f.hold()];
    try {
      f.schedule();
      await waitFor(() => f.engine.waitingChecks.has(first!.id), "the holder to queue its checks", undefined, { during: f.engine.settling.get(first!.id) });
      const order = f.engine["checks"].deliveryOrders.get(first!.id);
      expect(f.engine["checks"].deliveryOrders.has(second!.id)).toBe(true);
      f.engine.setPoolPaused(true); f.schedule();
      expect(f.engine["checks"].deliveryOrders.get(first!.id)).toBe(order);
      expect(f.engine["checks"].deliveryOrders.has(second!.id)).toBe(false);
      expect(f.engine.checkQueue.waiting).toBe(1);
      f.engine.cancel(second!.id);
      occupied.forEach(release => release());
      expect(f.evidence()).toEqual([]);
      f.engine.setPoolPaused(false); f.engine.checkQueue.pump(); f.schedule(); f.release();
      await waitFor(() => first!.state === "done" && !f.engine.settling.has(first!.id), "the queued holder to deliver after resume", undefined, { during: f.engine.settling.get(first!.id) });
      expect(f.evidence()).toHaveLength(1);
      expect(second!.state).toBe("cancelled");
      expect(f.engine.drivers.has(second!.id)).toBe(false);
      expect(f.engine.checkQueue.running).toBe(0);
    } finally { occupied.forEach(release => release()); f.release(); }


  });
});

it("rejoins the same final-check place when the pool pauses during the admitted source update", async () => {
  return approvedDeliveries(async f => {
    const [first, second] = f.tasks;
    const occupied = [f.hold(), f.hold()];
    const admitted = Promise.withResolvers<void>(), continueUpdate = Promise.withResolvers<void>();
    f.onClose(() => continueUpdate.resolve());
    const updates = f.engine["updates"].upToDate.bind(f.engine["updates"]);
    let firstUpdates = 0;
    const update = spyOn(f.engine["updates"], "upToDate");
    f.onClose(() => update.mockRestore());
    update.mockImplementation(async (...args) => {
      if (args[0].task.id === first!.id && ++firstUpdates === 2) {
        admitted.resolve(); await continueUpdate.promise;
      }
      return updates(...args);
    });
    try {
      f.schedule();
      await waitFor(() => f.engine.waitingChecks.has(first!.id), "the final check to queue", undefined, { during: f.engine.settling.get(first!.id) });
      const order = f.engine["checks"].deliveryOrders.get(first!.id);
      occupied.forEach(release => release());
      const driving = f.engine.settling.get(first!.id);
      if (!driving) throw new Error("The actual delivery driver ended before source-update admission");
      await Promise.race([admitted.promise, driving.then(() => { throw new Error("The actual delivery driver ended before source-update admission"); })]);
      f.engine.setPoolPaused(true); f.schedule();
      continueUpdate.resolve();
      await waitFor(() => f.engine.waitingChecks.has(first!.id) && f.engine.checkQueue.waiting === 1, "the same final attempt to rejoin while paused", undefined, { during: f.engine.settling.get(first!.id) });
      expect(f.engine["checks"].deliveryOrders.get(first!.id)).toBe(order);
      expect(f.engine.drivers.has(first!.id)).toBe(true);
      expect(f.engine.checkQueue.running).toBe(0);
      expect(f.evidence()).toEqual([]);
      f.engine.setPoolPaused(false); f.engine.checkQueue.pump(); f.schedule(); f.release();
      await waitFor(() => first!.state === "done" && !f.engine.settling.has(first!.id), "the resumed final attempt to deliver", undefined, { during: f.engine.settling.get(first!.id) });
      f.schedule();
      await waitFor(() => second!.state === "done" && !f.engine.settling.has(second!.id), "the next delivery after the resumed attempt", undefined, { during: f.engine.settling.get(second!.id) });
      expect(f.evidence()).toHaveLength(2);
      expect(firstUpdates).toBe(3);
    } finally { continueUpdate.resolve(); update.mockRestore(); occupied.forEach(release => release()); f.release(); }


  });
});

it("yields a held delivery after its admitted check settles and checks it afresh when the prerequisite is cleared", async () => {
  return approvedDeliveries(async f => {
    const [first, second] = f.tasks;
    try {
      const prerequisite = f.engine.addTask({ productId: f.productId, title: "Required prerequisite", backlog: true });
      f.schedule();
      await waitFor(() => f.evidence().length === 1, "the holder's final check", undefined, { during: f.engine.settling.get(first!.id) });
      f.engine.setRuntimeWait(first!.id, [prerequisite], "Wait for the prerequisite", "hold-final-delivery");
      f.schedule(); f.release();
      await waitFor(() => !f.engine.settling.has(first!.id), "the held delivery to leave its turn", undefined, { during: f.engine.settling.get(first!.id) });
      f.schedule();
      await waitFor(() => second!.state === "done" && !f.engine.settling.has(second!.id), "the next delivery to land", undefined, { during: f.engine.settling.get(second!.id) });
      expect(f.evidence()).toHaveLength(2);
      expect(f.evidence()[1]!.files).toEqual(["feature-second"]);
      f.engine.setRuntimeWait(first!.id, [], "The prerequisite is available", "clear-final-delivery");
      f.schedule();
      await waitFor(() => first!.state === "done" && !f.engine.settling.has(first!.id), "the released delivery to check the integrated tree", undefined, { during: f.engine.settling.get(first!.id) });
      expect(f.evidence()).toHaveLength(3);
      expect(f.evidence()[2]!.files).toEqual(["feature-first", "feature-second"]);
      expect(readRef(join(f.repo, ".git"), "refs/heads/main")).toBe(f.evidence()[2]!.sha);
    } finally { f.release(); }


  });
});

it("preserves a failed push and releases the destination for the next verified local delivery", async () => {
  return approvedDeliveries(async f => {
    const [first, second] = f.tasks;
    const work = executionFor(first!).work;
    // Exercise the delivery state machine's saved push boundary without contacting any account.
    work.localUpdate = { branch: "main", sha: work.approvedSha!, pushed: false };
    const push = spyOn(f.engine["shipping"] as unknown as { pushMain: () => Promise<boolean> }, "pushMain");
    f.onClose(() => push.mockRestore());
    push.mockResolvedValue(false);
    try {
      f.schedule();
      await waitFor(() => f.evidence().length === 1, "the first final check", undefined, { during: f.engine.settling.get(first!.id) });
      f.release();
      await waitFor(() => first!.state === "failed" && !f.engine.settling.has(first!.id), "the push failure to settle", undefined, { during: f.engine.settling.get(first!.id) });
      expect(push).toHaveBeenCalledTimes(1);
      expect(work.localUpdate).toMatchObject({ branch: "main", sha: f.evidence()[0]!.sha, pushed: false });
      expect(work.shipping?.prepared?.tested).toBe(f.evidence()[0]!.sha);
      expect(existsSync(work.worktree!)).toBe(true);
      expect(f.engine["checks"].deliveryOrders.has(first!.id)).toBe(false);
      push.mockRestore();
      f.schedule();
      await waitFor(() => second!.state === "done" && !f.engine.settling.has(second!.id), "the next local delivery after the failed push", undefined, { during: f.engine.settling.get(second!.id) });
      expect(f.evidence()).toHaveLength(2);
      expect(f.evidence()[1]!.files).toEqual(["feature-first", "feature-second"]);
      expect(readRef(join(f.repo, ".git"), "refs/heads/main")).toBe(f.evidence()[1]!.sha);
      expect(work.localUpdate?.pushed).toBe(false);
    } finally { push.mockRestore(); f.release(); }


  });
});
