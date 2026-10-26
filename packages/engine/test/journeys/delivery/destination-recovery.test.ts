import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { expect, it } from "bun:test";
import { directDrivers } from "../../fixtures/direct-drivers.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "../../engine.js";
import { commandText } from "../../../src/checks.js";
import { executionFor, scopesFor } from "@petrina/orchestrator";
import { destination } from "../../../src/shipping.js";
import { Aborted } from "../../../src/kernel.js";
import { WaitingForUsage } from "../../../src/usage.js";
import type { CheckVerification } from "../../../src/product-checks.js";
import { CONFIRM_ADDRESS } from "../../../src/connection.js";
import { git, makeProduct, tempDir, waitFor } from "../../fixtures.js";

type Observation = { product: string; title: string; sha: string; tree: string; files: string[] };

/** Start at the approved delivery boundary; each fixture owns its repositories, check barriers and saved state. */
async function fixture(products = ["a"], checkRuns = 2) {
  const root = tempDir("petrina-turn-recovery-"), lifetime = directDrivers(root);
  const data = join(root, "data"), log = join(root, "checks.jsonl"), check = join(root, "check.ts");
  const program = `import { appendFileSync, existsSync, readdirSync } from "node:fs";
const [log, root, product] = process.argv.slice(2);
const read = (...args) => Bun.spawnSync(["git", ...args], { stdout: "pipe" }).stdout.toString().trim();
const title = read("log", "-1", "--format=%s");
const sha = read("rev-parse", "HEAD"), tree = read("rev-parse", "HEAD^{tree}");
const files = readdirSync(".").filter(file => file.startsWith("feature-")).sort();
appendFileSync(log, JSON.stringify({ product, title, sha, tree, files }) + "\\n");
if (existsSync(root + "/hold-" + title)) while (!existsSync(root + "/release-" + title)) await Bun.sleep(10);
process.exit(existsSync("reject-shared") && existsSync("feature-shared") ? 1 : 0);`;
  const open = () => {
    const engine = lifetime.open(data, { agentCommand: () => { throw new Error("Approved local delivery needs no agent"); }, terminals: () => [], checkRuns });
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
    const owners: { id: string; path: string; name: string }[] = [];
    for (const name of products) {
      const path = await makeProduct(join(root, name)); await git(path, "remote", "remove", "origin");
      const id = await engine.addProduct(path, name.toUpperCase());
      engine.setProductChecks(id, [{ name: "Tests", command: commandText([process.execPath, check, log, root, name]) }]);
      owners.push({ id, path, name });
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
        work.source = { ...await current["sources"].resolve(task, { productId: work.productId, delivery: "local", startFrom: { kind: "default" } }), confirmed: true };
        if (branch !== "main") {
          // Source approval is already settled; the scheduler sees the resolved branch, as it does after a plan check.
          const owner = owners.find(owner => owner.id === work.productId)!;
          await git(owner.path, "branch", branch, "main");
          work.source.start.branch = branch; work.source.destination.branch = branch;
        }
        await current["driver"]["prepare"](scope, new AbortController().signal);
        if ("completedStages" in work) work.completedStages = ["build"];
        work.report = { title: name, summary: `Deliver ${name}`, changes: [`Added ${name}`] };
        writeFileSync(join(work.worktree!, `feature-${name}`), `${name}\n`);
        await git(work.worktree!, "add", "."); await git(work.worktree!, "commit", "-qm", name);
        work.approvedSha = await git(work.worktree!, "rev-parse", "HEAD"); work.approvedPatch = await current["updates"].patch(scope);
        work.approvedFor = { by: "coordinator", mode: "local", destination: destination(work, current.repositoryOf(scope)) };
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

it("finishes a shared delivery before later single-product requests on either destination", async () => {
  let fixtureOwner: Awaited<ReturnType<typeof fixture>> | undefined;
  await setupWithCleanup(async () => {
  const f = (fixtureOwner = await fixture(["a", "b"]));
  await setupWithCleanup(() => f.run(async () => {
    const first = await f.add("first-a"), shared = await f.add("shared", [0, 1]);
    const lastA = await f.add("last-a"), lastB = await f.add("last-b", [1]);
    f.hold("first-a");
    try {
      f.schedule(); await waitFor(() => f.evidence().length === 1, "the first destination check");
      expect(f.evidence()[0]!.title).toBe("first-a");
      for (const task of [shared, lastA, lastB]) {
        expect(task.state).toBe("waiting"); expect(task.agent).toBeUndefined(); expect(task.holdsSlot).toBe(false);
        expect(f.engine().drivers.has(task.id)).toBe(false);
      }
      expect(lastB.statusLine).toContain("shared");
      expect(f.engine().checkQueue.running).toBe(1); expect(f.engine().checkQueue.waiting).toBe(0);
      f.release("first-a");
      await waitFor(() => first.state === "done" && !f.engine().settling.has(first.id), "the first destination delivery");
      f.schedule(); await waitFor(() => shared.state === "done" && !f.engine().settling.has(shared.id), "both shared destinations to land");
      expect(f.evidence().map(run => [run.product, run.title])).toEqual([["a", "first-a"], ["a", "shared"], ["b", "shared"]]);
      f.schedule(); await waitFor(() => [lastA, lastB].every(task => task.state === "done" && !f.engine().settling.has(task.id)), "both later single deliveries");
      const runs = f.evidence(); expect(runs).toHaveLength(5);
      expect(runs.filter(run => run.product === "a").map(run => run.title)).toEqual(["first-a", "shared", "last-a"]);
      expect(runs.filter(run => run.product === "b").map(run => run.title)).toEqual(["shared", "last-b"]);
      for (const owner of f.owners) {
        const latest = runs.filter(run => run.product === owner.name).at(-1)!;
        expect(await git(owner.path, "rev-parse", "main")).toBe(latest.sha);
        expect(latest.files).toEqual(owner.name === "a" ? ["feature-first-a", "feature-last-a", "feature-shared"] : ["feature-last-b", "feature-shared"]);
      }
      expect(f.engine()["checks"].preparingCount).toBe(0);
    } finally { f.release("first-a");  }

  }), () => f.dispose());
  await f.dispose();

  }, async () => { await fixtureOwner?.dispose(); });
});



it("checks and lands another branch while a delivery to main still owns its turn", async () => {
  let fixtureOwner: Awaited<ReturnType<typeof fixture>> | undefined;
  await setupWithCleanup(async () => {
  const f = (fixtureOwner = await fixture());
  await setupWithCleanup(() => f.run(async () => {
    const first = await f.add("first"), other = await f.add("other", [0], "next");
    const base = executionFor(first).work.baseSha!;
    f.hold("first");
    try {
      f.schedule();
      await waitFor(() => other.state === "done" && !f.engine().settling.has(other.id), "the independent branch to finish");
      expect(first.state).toBe("running");
      const runs = f.evidence(); expect(runs).toHaveLength(2);
      expect(runs.find(run => run.title === "other")!.files).toEqual(["feature-other"]);
      expect(await git(f.owners[0]!.path, "rev-parse", "main")).toBe(base);
      expect(await git(f.owners[0]!.path, "rev-parse", "next")).toBe(runs.find(run => run.title === "other")!.sha);
      f.release("first"); await waitFor(() => first.state === "done" && !f.engine().settling.has(first.id), "the original branch delivery to finish");
      expect(f.evidence()).toHaveLength(2);
      expect(await git(f.owners[0]!.path, "rev-parse", "main")).toBe(runs.find(run => run.title === "first")!.sha);
    } finally { f.release("first");  }

  }), () => f.dispose());
  await f.dispose();

  }, async () => { await fixtureOwner?.dispose(); });
});


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
      const tested = await git(firstScope.work.worktree!, "rev-parse", "HEAD");
      // Save exactly the window after an admitted local update reached Git, before its result reached state.
      first.state = "running";
      firstScope.work.shipping = { start: tested, base: firstScope.work.baseSha, prepared: { tested, summary: "Ready" }, step: "update", boot: f.engine().boot, moves: 0, failures: 0 };
      await git(f.owners[0]!.path, "reset", "--hard", tested);
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
      expect(await git(f.owners[0]!.path, "rev-parse", "main")).toBe(runs[1]!.sha);
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
      await f.engine()["turns"]["wait"](scope, "question", "Which checks should run?", true, {}, signal, "Waiting for your answer", { roleId: "check-finder", profileId: "sol-high" }, false);
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
    await git(product.path!, "remote", "add", "origin", address);
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

for (const interruption of ["question"] as readonly ("hold" | "question")[]) it(`refreshes every unpublished shared preparation after yielding its turn for a ${interruption}`, async () => {
  let fixtureOwner: Awaited<ReturnType<typeof fixture>> | undefined;
  await setupWithCleanup(async () => {
  const f = (fixtureOwner = await fixture(["a", "b"])), shared = await f.add("shared", [0, 1]), second = await f.add("second");
  await setupWithCleanup(() => f.run(async () => {
    const shipping = f.engine()["shipping"], prepare = shipping["prepare"].bind(shipping), publish = shipping["publishLocal"].bind(shipping);
    const preparedA = scopesFor(shared)[0]!.work;
    let interrupted = false;
    const published: { title: string; files: string[] }[] = [];
    shipping["prepare"] = async (scope, stage, signal) => {
      if (scope.task.id === shared.id && scope.work.productId === f.owners[1]!.id && !interrupted) {
        interrupted = true;
        expect(preparedA.shipping?.prepared).toBeDefined();
        if (interruption === "hold") {
          f.engine().setHeld(shared.id, true);
          throw new WaitingForUsage("This task is on hold");
        }
        await f.engine()["turns"]["wait"](scope, "question", "Finish the shared delivery?", true, {}, signal, "Waiting for your answer", { roleId: "release-manager", profileId: "sol-high" }, false);
      }
      return prepare(scope, stage, signal);
    };
    shipping["publishLocal"] = async (scope, signal) => {
      const files = (await git(scope.work.worktree!, "ls-tree", "--name-only", scope.work.shipping!.prepared!.tested)).split("\n").filter(file => file.startsWith("feature-")).sort();
      published.push({ title: scope.task.title, files });
      return publish(scope, signal);
    };
    f.hold("second");
    try {
      f.engine().schedule = Engine.prototype.schedule.bind(f.engine());
      f.schedule();
      await waitFor(() => f.evidence().some(run => run.title === "second"), "the follower to check while shared delivery yields");
      expect(preparedA.shipping?.prepared).toBeUndefined();
      expect(published).toEqual([]);
      if (interruption === "question") {
        f.engine().answer(f.engine().s.inbox.find(item => item.taskId === shared.id && item.kind === "question")!.id, "Continue");
        await waitFor(() => shared.state === "waiting" && !f.engine().settling.has(shared.id), "the shared delivery to yield to the current holder");
      }
      f.release("second");
      await waitFor(() => second.state === "done" && !f.engine().settling.has(second.id), "the follower to land its checked change");
      if (interruption === "hold") f.engine().setHeld(shared.id, false);
      await waitFor(() => shared.state === "done" && !f.engine().settling.has(shared.id), "the refreshed shared delivery to finish");
      const aRuns = f.evidence().filter(run => run.product === "a");
      expect(aRuns.map(run => [run.title, run.files])).toEqual([
        ["shared", ["feature-shared"]], ["second", ["feature-second"]], ["shared", ["feature-second", "feature-shared"]],
      ]);
      expect(published).toEqual([
        { title: "second", files: ["feature-second"] }, { title: "shared", files: ["feature-second", "feature-shared"] }, { title: "shared", files: ["feature-shared"] },
      ]);
      expect(await git(f.owners[0]!.path, "rev-parse", "main")).toBe(aRuns.at(-1)!.sha);
      expect(f.engine()["shipping"]["admission"].entries()).toEqual([]);
    } finally {
      f.release("second"); shipping["prepare"] = prepare; shipping["publishLocal"] = publish;

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
    await git(productB.path!, "remote", "add", "origin", "https://github.com/acme/address.git");
    if (!changed) {
      await git(b!.work.worktree!, "reset", "--hard", b!.work.baseSha!);
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
      const secondTip = await git(f.owners[0]!.path, "rev-parse", "main");
      writeFileSync(join(f.owners[2]!.path, "reject-shared"), "The combined shared change must fail\n");
      await git(f.owners[2]!.path, "add", "."); await git(f.owners[2]!.path, "commit", "-qm", "Reject the combined shared change");
      const outsideTip = await git(f.owners[2]!.path, "rev-parse", "main");
      engine.answer(engine.s.inbox.find(item => item.taskId === shared.id && item.kind === "question")!.id, CONFIRM_ADDRESS);
      expect(await delivery).toBe("continue");
      expect(shared.repositories!.every(work => !work.landed)).toBe(true);
      expect(await git(f.owners[0]!.path, "rev-parse", "main")).toBe(secondTip);
      expect(await shipping.deliver(shared, stage, signal)).toBe("continue");
      expect(shared.stageIndex).toBe(0);
      expect(shared.repositories!.every(work => !work.landed)).toBe(true);
      expect(await git(f.owners[0]!.path, "rev-parse", "main")).toBe(secondTip);
      expect(await git(f.owners[2]!.path, "rev-parse", "main")).toBe(outsideTip);
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

for (const [mode, stop] of [["pull-request", "single pool pause"], ["release", "shared engine drain"]] as const) it(`keeps prepared ${mode} candidates through a ${stop} without local destination turns`, async () => {
  let fixtureOwner: Awaited<ReturnType<typeof fixture>> | undefined;
  await setupWithCleanup(async () => {
  const shared = stop.startsWith("shared"), f = (fixtureOwner = await fixture(shared ? ["a", "b"] : ["a"]));
  await setupWithCleanup(() => f.run(async () => {
    const task = await f.add("prepared", shared ? [0, 1] : [0]);
    const engine = f.engine(), shipping = engine["shipping"], signal = new AbortController().signal, stage = task.plan!.stages[task.stageIndex]!;
    const prepare = shipping["prepare"].bind(shipping), publish = shipping["publish"].bind(shipping), checkDelivery = shipping["checkDelivery"].bind(shipping);
    const notes = shipping.releases.chooseVersion.bind(shipping.releases), companions = shipping["companions"].finish.bind(shipping["companions"]);
    const github = engine["tools"].needGitHub.bind(engine["tools"]);
    engine["tools"].needGitHub = async () => {};
    shipping.releases.chooseVersion = async scope => {
      scope.work.shipping!.version = "1.0.1"; scope.work.shipping!.tag = "v1.0.1"; scope.work.shipping!.after = "";
      return [{ file: "package.json", version: "1.0.0", text: '{"name":"demo","version":"1.0.0"}\n' }];
    };
    for (const scope of scopesFor(task)) {
      const work = scope.work;
      work.delivery = mode; work.source!.destination.mode = mode; work.source!.destination.kind = mode === "release" ? "release" : "new-pr";
      work.approvedFor = { by: "coordinator", mode, destination: destination(work, engine.repositoryOf(scope)) };
      if (mode === "release") {
        writeFileSync(join(work.worktree!, "package.json"), '{"name":"demo","version":"1.0.0"}\n');
        await git(work.worktree!, "add", "."); await git(work.worktree!, "commit", "-qm", "Declare the release version");
        await engine["updates"].fold(scope);
        work.approvedSha = await git(work.worktree!, "rev-parse", "HEAD"); work.approvedPatch = await engine["updates"].patch(scope);
        work.releasePreview = { start: work.approvedSha, base: work.baseSha, version: "1.0.1", tag: "v1.0.1", after: "", summary: "Prepared release", notes: "The approved release notes" };
      }
    }
    const candidates: string[] = [], published: string[] = [];
    let paused = false;
    shipping["prepare"] = async (scope, currentStage, currentSignal) => {
      const result = await prepare(scope, currentStage, currentSignal);
      if (!paused) {
        candidates.push(scope.work.shipping!.prepared!.tested);
        if (candidates.length === scopesFor(task).length) {
          paused = true;
          if (stop.endsWith("drain")) engine.draining = true;
          else engine.setPoolPaused(true);
        }
      }
      return result;
    };
    // Observe publication at its normal admission boundary without a shared GitHub service.
    shipping["checkDelivery"] = async () => "continue";
    shipping["publish"] = async (scope, currentSignal) => {
      published.push(scope.work.shipping!.prepared!.tested);
      await shipping["recordDelivery"](scope, mode === "release"
        ? { kind: "release", release: { tag: "v1.0.1", url: "https://github.com/acme/demo/releases/tag/v1.0.1" } }
        : { kind: "pr", pr: { number: 1, url: "https://github.com/acme/demo/pull/1", state: "open" } }, currentSignal);
      return "done";
    };
    shipping["companions"].finish = async () => true;
    try {
      expect(await shipping.deliver(task, stage, signal).catch(error => error)).toBeInstanceOf(WaitingForUsage);
      expect(candidates).toHaveLength(scopesFor(task).length);
      expect(scopesFor(task).map(({ work }) => work.shipping?.prepared?.tested)).toEqual(candidates);
      expect(shipping["admission"].entries()).toEqual([]);
      expect(published).toEqual([]);
      const originalRuns = f.evidence();
      expect(originalRuns).toHaveLength(scopesFor(task).length * (mode === "release" ? 2 : 1));
      writeFileSync(join(f.owners[0]!.path, "later-main"), "A later outside commit\n");
      await git(f.owners[0]!.path, "add", "."); await git(f.owners[0]!.path, "commit", "-qm", "Advance main while publication waits");
      engine.draining = false; engine.setPoolPaused(false);
      expect(await shipping.deliver(task, stage, signal)).toBe("stop");
      expect(published).toEqual(candidates);
      expect(f.evidence()).toEqual(originalRuns);
      expect(shipping["admission"].entries()).toEqual([]);
    } finally {
      engine.draining = false; engine.setPoolPaused(false);
      shipping["prepare"] = prepare; shipping["publish"] = publish; shipping["checkDelivery"] = checkDelivery;
      shipping.releases.chooseVersion = notes; shipping["companions"].finish = companions; engine["tools"].needGitHub = github;
      await engine.shutdown();
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
        await git(owner.path, "add", "."); await git(owner.path, "commit", "-qm", "Advance main before the task resumes");
      }
      const latest = await Promise.all(f.owners.map(owner => git(owner.path, "rev-parse", "main")));
      f.schedule();
      await waitFor(() => recovered.stageIndex === 0 && !f.engine().settling.has(recovered.id), "the restarted task to stop at its failed combined checks");
      expect(recovered.repositories!.every(work => !work.landed)).toBe(true);
      expect(await Promise.all(f.owners.map(owner => git(owner.path, "rev-parse", "main")))).toEqual(latest);
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
