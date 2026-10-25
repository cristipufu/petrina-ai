import { expect, it, spyOn } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beginAgentStep, endAgentStep, type ProductCheck } from "@petrina/core";
import { CheckPreparationChanged } from "../../../src/product-checks.js";
import { checksFingerprint, commandText } from "../../../src/checks.js";
import { executionFor } from "@petrina/orchestrator";
import { Engine } from "../../engine.js";
import { git, makeProduct, removeDir, tempDir, waitFor } from "../../fixtures.js";

/** Exercise only check admission and its discovery side step, with no unrelated workflow agents. */
async function fixture(conflictingTask = false) {
  const root = tempDir("petrina-discovery-admission-");
  const engine = new Engine(join(root, "data"), { agentCommand: () => { throw new Error("Only the discovery stand-in should run"); }, terminals: () => [] });
  engine.schedule = () => engine.checkQueue.pump();
  await engine.waitUntilReady();
  const clone = await makeProduct(root), productId = await engine.addProduct(clone);
  const initial = await git(clone, "rev-parse", "HEAD"), copy = join(root, "work");
  const task = engine.task(engine.addTask({ productId, title: "Recheck discovered commands", delivery: "local", backlog: true }))!;
  task.state = "running"; task.startedAt = 1; task.stageIndex = 1;
  task.plan = { rationale: "Check admission only", plannerProfileId: "sol-high", stages: [
    { id: "build", title: "Build", kind: "do", roleId: "builder", profileIds: ["sol-high"] },
    { id: "review", title: "Review", kind: "review-chain", roleId: "code-reviewer", profileIds: ["sol-high"], maxRounds: 2 },
  ] };
  const scope = executionFor(task);
  await git(clone, "worktree", "add", "-b", "task-discovery", copy, initial);
  Object.assign(scope.work, { worktree: copy, branch: "task-discovery", base: "main", baseSha: initial });
  writeFileSync(join(copy, conflictingTask ? "README.md" : "task-change.txt"), "The task change\n");
  await git(copy, "add", "."); await git(copy, "commit", "-qm", "Make the task change");
  const log = join(root, "invocations"), script = join(root, "check.ts");
  writeFileSync(script, `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(log)}, "ran\\n");`);
  const command: ProductCheck = { name: "Tests", argv: [process.execPath, script] };
  engine.setProductChecks(productId, [{ name: command.name, command: commandText(command.argv) }]);
  const product = engine.productOf(scope)!;
  product.checksBy = "finder"; product.checksFingerprint = checksFingerprint(copy);
  const checks = engine["checks"], entered = Promise.withResolvers<void>(), releaseDiscovery = Promise.withResolvers<void>();
  let oldStep: NonNullable<typeof task.journey>[number] | undefined, oldRecord: string | undefined;
  const discovery = spyOn(checks, "ensureChecks").mockImplementation(async () => {
    // Use the real journey transitions: discovery closes the pending checks entry before awaiting.
    beginAgentStep(task, "check-finder", "sol-high", Date.now(), engine.s.roles, undefined, scope.work);
    oldStep = task.journey!.find(step => step.work === "checks")!;
    oldRecord = JSON.stringify(oldStep);
    entered.resolve(); await releaseDiscovery.promise;
    const discovered = [{ ...command, argv: [...command.argv], name: "Rediscovered tests" }];
    product.checks = discovered;
    product.checksFingerprint = checksFingerprint(copy);
    endAgentStep(task, { outcome: "Found checks", reason: "Use the current commands" }, Date.now());
    return discovered;
  });
  const land = async (conflict = false) => {
    writeFileSync(join(clone, conflict ? "README.md" : "package.json"), conflict ? "Main's different change\n" : JSON.stringify({ name: "changed-check-inputs" }));
    await git(clone, "add", "."); await git(clone, "commit", "-qm", conflict ? "Conflict with the task" : "Change check discovery inputs");
    return git(clone, "rev-parse", "HEAD");
  };
  const invocations = () => existsSync(log) ? readFileSync(log, "utf8").match(/ran/g)?.length ?? 0 : 0;
  const unchangedHistory = () => {
    if (oldRecord === undefined || !oldStep) throw new Error("Discovery must first close and capture the original checks step");
    expect(JSON.stringify(oldStep)).toBe(oldRecord);
  };
  const cleanup = async () => { releaseDiscovery.resolve(); discovery.mockRestore(); await engine.shutdown(); removeDir(root); };
  return { root, engine, clone, copy, task, scope, checks, command, discovery, entered, releaseDiscovery, land, invocations, unchangedHistory, cleanup };
}

for (const waitsAgain of [false, true]) it(`recaptures discovered check inputs ${waitsAgain ? "with one more source update after another queue wait" : "without another source update when the line is free"}`, async () => {
  const f = await fixture();
  const controller = new AbortController(), block = f.engine.checkQueue.hold();
  let place: (() => void) | undefined, follower: Promise<() => void> | undefined;
  let updates = 0;
  const prepare = async () => { updates++; return await f.engine["updates"].upToDate(f.scope, controller.signal) !== "conflict"; };
  const checking = f.checks.runProductChecks(f.scope, [f.command], controller.signal, undefined, undefined, prepare);
  try {
    await waitFor(() => f.engine.checkQueue.waiting === 1, "check run to join the line");
    const latest = await f.land();
    block(); await f.entered.promise;
    expect(f.engine.checkQueue.running).toBe(0); expect(f.invocations()).toBe(0); expect(updates).toBe(1);
    if (waitsAgain) { follower = f.engine.checkQueue.acquire(controller.signal); place = await follower; }
    f.releaseDiscovery.resolve();
    if (waitsAgain) { await waitFor(() => f.engine.checkQueue.waiting === 1, "discovered run to rejoin the occupied line"); place!(); }
    expect(await checking).toBe(0);
    expect(updates).toBe(waitsAgain ? 2 : 1); expect(f.discovery).toHaveBeenCalledTimes(1); expect(f.invocations()).toBe(1);
    const sha = await git(f.copy, "rev-parse", "HEAD"), tree = await git(f.copy, "rev-parse", "HEAD^{tree}");
    expect(await git(f.copy, "merge-base", latest, sha)).toBe(latest);
    expect(f.scope.work.checks).toMatchObject({ sha, tree, current: true });
    expect(f.scope.work.checks!.results[0]!.name).toBe("Rediscovered tests");
    f.unchangedHistory();
    expect(f.engine.checkQueue.running).toBe(0); expect(f.engine.checkQueue.waiting).toBe(0);
  } finally {
    controller.abort(); block(); place?.(); f.releaseDiscovery.resolve();
    if (follower) await follower.then(release => release(), () => {});
    await checking.catch(() => {}); await f.cleanup();
  }
});

for (const reason of ["conflict", "approval"] as const) it(`keeps the closed pre-discovery record unchanged when later preparation stops for ${reason}`, async () => {
  const f = await fixture(reason === "conflict");
  const controller = new AbortController(), block = f.engine.checkQueue.hold();
  let place: (() => void) | undefined, follower: Promise<() => void> | undefined;
  let updates = 0;
  const prepare = async () => {
    updates++;
    if (await f.engine["updates"].upToDate(f.scope, controller.signal) === "conflict") return false;
    return !(reason === "approval" && updates === 2);
  };
  const checking = f.checks.runProductChecks(f.scope, [f.command], controller.signal, undefined, undefined, prepare).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
  try {
    await waitFor(() => f.engine.checkQueue.waiting === 1, "check run to join the line");
    await f.land(); block(); await f.entered.promise;
    follower = f.engine.checkQueue.acquire(controller.signal); place = await follower;
    if (reason === "conflict") await f.land(true);
    f.releaseDiscovery.resolve();
    await waitFor(() => f.engine.checkQueue.waiting === 1, "discovered run to wait for its next admission");
    place();
    const result = await checking;
    expect(result.error).toBeInstanceOf(CheckPreparationChanged); expect(updates).toBe(2); expect(f.invocations()).toBe(0);
    f.unchangedHistory();
    const steps = f.task.journey!.filter(step => step.work === "checks");
    expect(steps).toHaveLength(2); expect(steps[1]!.outcome).toBe("Not run");
    expect(steps[1]!.productChecks![0]!.detail).toContain(reason === "conflict" ? "conflict" : "approval");
    expect(f.scope.work.checkReturns).toBeUndefined();
    expect(f.engine.checkQueue.running).toBe(0); expect(f.engine.checkQueue.waiting).toBe(0);
  } finally {
    controller.abort(); block(); place?.(); f.releaseDiscovery.resolve();
    if (follower) await follower.then(release => release(), () => {});
    await checking; await f.cleanup();
  }
});
