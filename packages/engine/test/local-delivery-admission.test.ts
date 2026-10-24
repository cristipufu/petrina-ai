import { afterAll, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "./engine.js";
import { commandText } from "../src/checks.js";
import { executionFor } from "../src/repository-context.js";
import { destination } from "../src/shipping.js";
import { Coordination } from "../src/coordination.js";
import { git, makeProduct, removeDir, tempDir, waitFor } from "./fixtures.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

/** Planning, building, review and approval have settled; exercise real scheduling, checks and local placement. */
async function approvedDeliveries(firstFails = false) {
  const root = tempDir("petrina-local-admission-"); roots.push(root);
  const service = join(root, "service"); mkdirSync(service);
  const repo = await makeProduct(root);
  await git(repo, "remote", "remove", "origin");
  const engine = new Engine(join(root, "data"), { agentCommand: () => undefined, terminals: () => [], checkRuns: 2,
    containerTool: [process.execPath, join(import.meta.dir, "fake-extra-container.ts"), service], extraCleanupEveryMs: 60_000 });
  engine.schedule = () => {};
  engine.setPoolPaused(false);
  const productId = await engine.addProduct(repo);
  const signal = new AbortController().signal;
  const tasks = [];
  for (const name of ["first", "second"]) {
    const task = engine.task(engine.addTask({ productId, title: `Deliver ${name}`, delivery: "local", backlog: true }))!;
    task.state = "waiting"; task.startedAt = name === "first" ? 1 : 2; task.stageIndex = 1;
    task.plan = { rationale: "Approved local deliveries", plannerProfileId: "sol-high", stages: [
      { id: "approval", title: "Delivery check", kind: "gate", gate: "delivery", roleId: "coordinator", profileIds: [] },
      { id: "ship", title: "Ship", kind: "do", roleId: "release-manager", profileIds: ["sol-high"] },
    ] };
    const scope = executionFor(task);
    scope.work.source = { ...await engine["sources"].resolve(task, { productId, delivery: "local", startFrom: { kind: "default" } }), confirmed: true };
    await engine["driver"]["prepare"](scope, signal);
    writeFileSync(join(scope.work.worktree!, `feature-${name}`), `${name}\n`);
    if (firstFails && name === "first") writeFileSync(join(scope.work.worktree!, "fail-check"), "A genuine check failure\n");
    await git(scope.work.worktree!, "add", ".");
    await git(scope.work.worktree!, "commit", "-qm", task.title);
    scope.work.approvedSha = await git(scope.work.worktree!, "rev-parse", "HEAD");
    scope.work.approvedPatch = await engine["updates"].patch(scope);
    scope.work.approvedFor = { by: "coordinator", mode: "local", destination: destination(scope.work, engine.repositoryOf(scope)) };
    tasks.push(task);
  }
  const log = join(root, "checks.jsonl"), release = join(root, "release-first"), script = join(root, "check.ts");
  writeFileSync(script, `import { appendFileSync, existsSync } from "node:fs";
const sha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe" }).stdout.toString().trim();
const tree = Bun.spawnSync(["git", "rev-parse", "HEAD^{tree}"], { stdout: "pipe" }).stdout.toString().trim();
const files = ["feature-first", "feature-second"].filter(file => existsSync(file));
const ok = !existsSync("fail-check");
appendFileSync(process.argv[2], JSON.stringify({ sha, tree, files, outside: existsSync("outside-change"), ok }) + "\\n");
if (!existsSync("feature-second")) while (!existsSync(process.argv[3])) await Bun.sleep(10);
process.exit(ok ? 0 : 1);`);
  engine.setProductChecks(productId, [{ name: "Tests", command: commandText([process.execPath, script, log, release]) }]);
  const evidence = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { sha: string; tree: string; files: string[]; outside: boolean; ok: boolean }) : [];
  return { root, service, productId, engine, repo, tasks, evidence, release: () => writeFileSync(release, "Continue"), schedule: () => engine["driver"].schedule() };
}

it("checks two approved local deliveries once each on their exact successive integrated trees", async () => {
  const f = await approvedDeliveries();
  const [first, second] = f.tasks;
  try {
    f.schedule();
    await waitFor(() => f.evidence().length === 1, "the first final check to start");
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
    await waitFor(() => first!.state === "done" && !f.engine.settling.has(first!.id), "the first delivery to finish");
    const firstTip = await git(f.repo, "rev-parse", "main");
    expect(firstTip).toBe(f.evidence()[0]!.sha);
    f.schedule();
    await waitFor(() => second!.state === "done" && !f.engine.settling.has(second!.id), "the second delivery to finish");
    const runs = f.evidence();
    expect(runs).toHaveLength(2);
    expect(runs.map(run => run.files)).toEqual([["feature-first"], ["feature-first", "feature-second"]]);
    const finalTip = await git(f.repo, "rev-parse", "main");
    expect(finalTip).toBe(runs[1]!.sha);
    expect(await git(f.repo, "rev-parse", `${finalTip}^`)).toBe(firstTip);
    for (const [index, task] of f.tasks.entries()) {
      expect(task.error).toBeUndefined();
      expect(executionFor(task).work.checks).toMatchObject({ sha: runs[index]!.sha, tree: runs[index]!.tree, current: true });
      expect(runs[index]!.ok).toBe(true);
    }
  } finally { f.release(); await f.engine.shutdown(); }
});

it.skipIf(process.platform === "win32")("runs another review and its saved extra validation while a local delivery waits for its branch", async () => {
  const f = await approvedDeliveries();
  const [first, second] = f.tasks;
  const started = join(f.root, "review-started"), released = join(f.root, "release-review");
  let reviewing: Promise<"continue" | "stop"> | undefined;
  try {
    const other = join(f.root, "other"); mkdirSync(other);
    const clone = await makeProduct(other); await git(clone, "remote", "remove", "origin");
    const productId = await f.engine.addProduct(clone, "Independent product");
    const task = f.engine.task(f.engine.addTask({ productId, title: "Review independent work", delivery: "local", backlog: true }))!;
    task.state = "running"; task.startedAt = 3; task.stageIndex = 1;
    task.plan = { rationale: "Independent review", plannerProfileId: "sol-high", stages: [
      { id: "build", title: "Build", kind: "do", roleId: "builder", profileIds: ["sol-high"] },
      { id: "review", title: "Review", kind: "review-chain", roleId: "code-reviewer", profileIds: ["sol-high"], maxRounds: 2 },
    ] };
    const scope = executionFor(task), signal = new AbortController().signal;
    scope.work.source = { ...await f.engine["sources"].resolve(task, { productId, delivery: "local", startFrom: { kind: "default" } }), confirmed: true };
    await f.engine["driver"]["prepare"](scope, signal);
    writeFileSync(join(scope.work.worktree!, "independent-feature"), "Ready for review\n");
    await git(scope.work.worktree!, "add", "."); await git(scope.work.worktree!, "commit", "-qm", task.title);
    await f.engine.rememberVersion(scope);
    const check = join(f.root, "independent-check.ts");
    writeFileSync(check, `import { existsSync, writeFileSync } from "node:fs";
writeFileSync(process.argv[2], "Started");
while (!existsSync(process.argv[3])) await Bun.sleep(10);`);
    f.engine.setProductChecks(productId, [{ name: "Review checks", command: commandText([process.execPath, check, started, released]) }]);
    // Keep the independent review outside the scheduler until its explicit check request below.
    task.state = "needs-you";
    f.schedule();
    await waitFor(() => f.evidence().length === 1, "the first local delivery's final run");
    task.state = "running";
    reviewing = f.engine["reviews"].runReview(task, task.plan.stages[1]!, signal);
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
    try { if (reviewing) await reviewing; }
    finally { await f.engine.shutdown(); }
  }
});

for (const outcome of ["failed", "cancelled"] as const) it(`releases a ${outcome} delivery's turn so the next task checks and lands`, async () => {
  const f = await approvedDeliveries(outcome === "failed");
  const [first, second] = f.tasks;
  try {
    f.schedule();
    await waitFor(() => f.evidence().length === 1, "the held final check");
    if (outcome === "cancelled") f.engine.cancel(first!.id);
    f.release();
    await waitFor(() => !f.engine.settling.has(first!.id), "the stopped holder to release its turn");
    expect(first!.state).toBe(outcome === "cancelled" ? "cancelled" : "needs-you");
    f.schedule();
    await waitFor(() => second!.state === "done" && !f.engine.settling.has(second!.id), "the next local delivery");
    const runs = f.evidence();
    expect(runs).toHaveLength(2);
    expect(runs[1]!.files).toEqual(["feature-second"]);
    expect(await git(f.repo, "rev-parse", "main")).toBe(runs[1]!.sha);
    if (outcome === "failed") expect(runs[0]!.ok).toBe(false);
    expect(f.engine.checkQueue.running).toBe(0);
  } finally { f.release(); await f.engine.shutdown(); }
});

for (const when of ["queued", "running"] as const) it(`keeps an outside main advance while final checks are ${when} and verifies the resulting exact tree`, async () => {
  const f = await approvedDeliveries();
  const [first, second] = f.tasks;
  const occupied = when === "queued" ? [f.engine.checkQueue.hold(), f.engine.checkQueue.hold()] : [];
  try {
    f.schedule();
    if (when === "queued") await waitFor(() => f.engine.waitingChecks.has(first!.id), "the first final run to join the check line");
    else await waitFor(() => f.evidence().length === 1, "the first final command to start");
    writeFileSync(join(f.repo, "outside-change"), "An outside writer's change\n");
    await git(f.repo, "add", "."); await git(f.repo, "commit", "-qm", "Outside change");
    const outside = await git(f.repo, "rev-parse", "HEAD");
    occupied.forEach(release => release());
    f.release();
    await waitFor(() => first!.state === "done" && !f.engine.settling.has(first!.id), "the first delivery to revalidate and land");
    const firstRuns = f.evidence();
    expect(firstRuns).toHaveLength(when === "queued" ? 1 : 2);
    expect(firstRuns.map(run => run.outside)).toEqual(when === "queued" ? [true] : [false, true]);
    const firstTip = await git(f.repo, "rev-parse", "main");
    expect(firstTip).toBe(firstRuns.at(-1)!.sha);
    expect(await git(f.repo, "rev-parse", `${firstTip}^`)).toBe(outside);
    f.schedule();
    await waitFor(() => second!.state === "done" && !f.engine.settling.has(second!.id), "the next delivery after the outside change");
    const runs = f.evidence();
    expect(runs).toHaveLength(when === "queued" ? 2 : 3);
    expect(runs.at(-1)!.files).toEqual(["feature-first", "feature-second"]);
    expect(runs.at(-1)!.outside).toBe(true);
    expect(await git(f.repo, "rev-parse", "main")).toBe(runs.at(-1)!.sha);
    expect(executionFor(first!).work.checks?.tree).toBe(firstRuns.at(-1)!.tree);
    expect(executionFor(second!).work.checks?.tree).toBe(runs.at(-1)!.tree);
  } finally { occupied.forEach(release => release()); f.release(); await f.engine.shutdown(); }
});

it("returns changed final approval before any final command starts after a check-line wait", async () => {
  const f = await approvedDeliveries();
  const [first] = f.tasks;
  const signal = new AbortController().signal;
  const occupied = [f.engine.checkQueue.hold(), f.engine.checkQueue.hold()];
  try {
    const delivery = f.engine["shipping"].deliver(first!, first!.plan!.stages[1]!, signal);
    await waitFor(() => f.engine.waitingChecks.has(first!.id), "the approved final run to wait");
    // The task's whole addition is now already present on main; applying it no longer reads as the approved change.
    writeFileSync(join(f.repo, "feature-first"), "first\n");
    await git(f.repo, "add", "."); await git(f.repo, "commit", "-qm", "Outside writer adds the same change");
    occupied.forEach(release => release());
    expect(await delivery).toBe("continue");
    expect(first!.stageIndex).toBe(0);
    expect(executionFor(first!).work.approvedSha).toBeUndefined();
    expect(f.evidence()).toEqual([]);
    expect(f.engine.checkQueue.running).toBe(0);
    const pending = first!.journey?.flatMap(step => step.productChecks ?? []);
    expect(pending?.some(check => check.result === "skipped" && check.detail?.includes("approval"))).toBe(true);
  } finally { occupied.forEach(release => release()); f.release(); await f.engine.shutdown(); }
});

it("returns a queued final conflict to the Builder and releases its destination without spending a failed-check return", async () => {
  const f = await approvedDeliveries();
  const [first, second] = f.tasks;
  const signal = new AbortController().signal;
  const occupied = [f.engine.checkQueue.hold(), f.engine.checkQueue.hold()];
  first!.plan!.stages.unshift({ id: "build", title: "Build", kind: "do", roleId: "builder", profileIds: ["sol-high"] });
  first!.stageIndex = 2;
  const work = executionFor(first!).work;
  try {
    const delivery = f.engine["shipping"].deliver(first!, first!.plan!.stages[2]!, signal);
    await waitFor(() => f.engine.waitingChecks.has(first!.id), "the final check to wait on its old source");
    expect(f.engine["shipping"].waitingForTurn(second!)).toContain("Deliver first");
    writeFileSync(join(f.repo, "feature-first"), "An incompatible outside version\n");
    await git(f.repo, "add", "."); await git(f.repo, "commit", "-qm", "Outside conflicting change");
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
  } finally { occupied.forEach(release => release()); f.release(); await f.engine.shutdown(); }
});

it("keeps the holder's queued check over a pool pause while a cancelled turn waiter leaves without a command", async () => {
  const f = await approvedDeliveries();
  const [first, second] = f.tasks;
  const occupied = [f.engine.checkQueue.hold(), f.engine.checkQueue.hold()];
  try {
    f.schedule();
    await waitFor(() => f.engine.waitingChecks.has(first!.id), "the holder to queue its checks");
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
    await waitFor(() => first!.state === "done" && !f.engine.settling.has(first!.id), "the queued holder to deliver after resume");
    expect(f.evidence()).toHaveLength(1);
    expect(second!.state).toBe("cancelled");
    expect(f.engine.drivers.has(second!.id)).toBe(false);
    expect(f.engine.checkQueue.running).toBe(0);
  } finally { occupied.forEach(release => release()); f.release(); await f.engine.shutdown(); }
});

it("rejoins the same final-check place when the pool pauses during the admitted source update", async () => {
  const f = await approvedDeliveries();
  const [first, second] = f.tasks;
  const occupied = [f.engine.checkQueue.hold(), f.engine.checkQueue.hold()];
  const admitted = Promise.withResolvers<void>(), continueUpdate = Promise.withResolvers<void>();
  const updates = f.engine["updates"].upToDate.bind(f.engine["updates"]);
  let firstUpdates = 0;
  const update = spyOn(f.engine["updates"], "upToDate").mockImplementation(async (...args) => {
    if (args[0].task.id === first!.id && ++firstUpdates === 2) {
      admitted.resolve(); await continueUpdate.promise;
    }
    return updates(...args);
  });
  try {
    f.schedule();
    await waitFor(() => f.engine.waitingChecks.has(first!.id), "the final check to queue");
    const order = f.engine["checks"].deliveryOrders.get(first!.id);
    occupied.forEach(release => release());
    await admitted.promise;
    f.engine.setPoolPaused(true); f.schedule();
    continueUpdate.resolve();
    await waitFor(() => f.engine.waitingChecks.has(first!.id) && f.engine.checkQueue.waiting === 1, "the same final attempt to rejoin while paused");
    expect(f.engine["checks"].deliveryOrders.get(first!.id)).toBe(order);
    expect(f.engine.drivers.has(first!.id)).toBe(true);
    expect(f.engine.checkQueue.running).toBe(0);
    expect(f.evidence()).toEqual([]);
    f.engine.setPoolPaused(false); f.engine.checkQueue.pump(); f.schedule(); f.release();
    await waitFor(() => first!.state === "done" && !f.engine.settling.has(first!.id), "the resumed final attempt to deliver");
    f.schedule();
    await waitFor(() => second!.state === "done" && !f.engine.settling.has(second!.id), "the next delivery after the resumed attempt");
    expect(f.evidence()).toHaveLength(2);
    expect(firstUpdates).toBe(3);
  } finally { continueUpdate.resolve(); update.mockRestore(); occupied.forEach(release => release()); f.release(); await f.engine.shutdown(); }
});

it("yields a held delivery after its admitted check settles and checks it afresh when the prerequisite is cleared", async () => {
  const f = await approvedDeliveries();
  const [first, second] = f.tasks;
  try {
    const prerequisite = f.engine.addTask({ productId: f.productId, title: "Required prerequisite", backlog: true });
    f.schedule();
    await waitFor(() => f.evidence().length === 1, "the holder's final check");
    f.engine.setRuntimeWait(first!.id, [prerequisite], "Wait for the prerequisite", "hold-final-delivery");
    f.schedule(); f.release();
    await waitFor(() => !f.engine.settling.has(first!.id), "the held delivery to leave its turn");
    f.schedule();
    await waitFor(() => second!.state === "done" && !f.engine.settling.has(second!.id), "the next delivery to land");
    expect(f.evidence()).toHaveLength(2);
    expect(f.evidence()[1]!.files).toEqual(["feature-second"]);
    f.engine.setRuntimeWait(first!.id, [], "The prerequisite is available", "clear-final-delivery");
    f.schedule();
    await waitFor(() => first!.state === "done" && !f.engine.settling.has(first!.id), "the released delivery to check the integrated tree");
    expect(f.evidence()).toHaveLength(3);
    expect(f.evidence()[2]!.files).toEqual(["feature-first", "feature-second"]);
    expect(await git(f.repo, "rev-parse", "main")).toBe(f.evidence()[2]!.sha);
  } finally { f.release(); await f.engine.shutdown(); }
});

it("preserves a failed push and releases the destination for the next verified local delivery", async () => {
  const f = await approvedDeliveries();
  const [first, second] = f.tasks;
  const work = executionFor(first!).work;
  // Exercise the delivery state machine's saved push boundary without contacting any account.
  work.localUpdate = { branch: "main", sha: work.approvedSha!, pushed: false };
  const push = spyOn(f.engine["shipping"] as unknown as { pushMain: () => Promise<boolean> }, "pushMain").mockResolvedValue(false);
  try {
    f.schedule();
    await waitFor(() => f.evidence().length === 1, "the first final check");
    f.release();
    await waitFor(() => first!.state === "failed" && !f.engine.settling.has(first!.id), "the push failure to settle");
    expect(push).toHaveBeenCalledTimes(1);
    expect(work.localUpdate).toMatchObject({ branch: "main", sha: f.evidence()[0]!.sha, pushed: false });
    expect(work.shipping?.prepared?.tested).toBe(f.evidence()[0]!.sha);
    expect(existsSync(work.worktree!)).toBe(true);
    expect(f.engine["checks"].deliveryOrders.has(first!.id)).toBe(false);
    push.mockRestore();
    f.schedule();
    await waitFor(() => second!.state === "done" && !f.engine.settling.has(second!.id), "the next local delivery after the failed push");
    expect(f.evidence()).toHaveLength(2);
    expect(f.evidence()[1]!.files).toEqual(["feature-first", "feature-second"]);
    expect(await git(f.repo, "rev-parse", "main")).toBe(f.evidence()[1]!.sha);
    expect(work.localUpdate?.pushed).toBe(false);
  } finally { push.mockRestore(); f.release(); await f.engine.shutdown(); }
});
