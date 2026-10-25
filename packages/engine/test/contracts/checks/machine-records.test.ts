import { completeCheckExecution } from "@petrina/test-support/check-execution-facts";
import { afterAll, expect, it, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import { chmodSync, existsSync, lstatSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckRun, DeepMutable, ProductCheck } from "@petrina/core";
import type { MachineRecords } from "../../../src/check-interruption.js";
import type { CheckProgress } from "../../../src/checks.js";
import { Aborted } from "../../../src/kernel.js";
import { executionFor } from "@petrina/orchestrator";
import { Engine } from "../../engine.js";
import { git, heldMachineRecords, makeProduct, powerLogSleep, removeDir, runChecks, SLOW, tempDir } from "../../fixtures.js";
import { rejectionOf } from "@petrina/test-support/rejections";
import { FixtureOperations } from "@petrina/test-support/fixture-operations";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { CLEANUP_MS } from "@petrina/test-support/commands";
import { waitFor } from "../../fixtures.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
const root = (prefix: string) => {
  const dir = tempDir(prefix);
  roots.push(dir);
  return dir;
};

/**
 * Watch this file's own child processes for the Mac's power-log command. It is refused and recorded, never
 * started; every other command runs as usual. It observes only: no engine or check gets evidence from it.
 */
function powerLogCommands(): { started: string[]; restore(): void } {
  const original = childProcess.execFile as (...args: unknown[]) => unknown;
  const started: string[] = [];
  const watch = spyOn(childProcess, "execFile").mockImplementation(((file: string, ...rest: unknown[]) => {
    if (file !== "/usr/bin/pmset") return original(file, ...rest);
    started.push(file);
    (rest.findLast((arg) => typeof arg === "function") as ((error: Error, stdout: string) => void) | undefined)?.(new Error("A synthetic test must not read the power log"), "");
    return undefined;
  }) as never);
  return { started, restore: () => watch.mockRestore() };
}

const failing = (text: string) => ({ name: "Tests", argv: [process.execPath, "-e", `console.error(${JSON.stringify(text)}); process.exit(1)`] });

for (const source of ["the fixture's default", "an explicit source"] as const) it.skipIf(process.platform === "win32")(`reads sleep evidence only from ${source} after failed checks and hooks, failure reuse and startup recovery`, async () => {
  const dir = root("petrina-machine-records-");
  const home = join(dir, "data");
  const reads: (AbortSignal | undefined)[] = [];
  const own: MachineRecords = async (signal) => { reads.push(signal); return ""; };
  const options = { agentCommand: () => undefined, terminals: () => [], ...(source === "an explicit source" ? { machineRecords: own } : {}) };
  const commands = powerLogCommands();
  let engine = new Engine(home, options);
  engine.schedule = () => {};
  try {
    const repo = await makeProduct(dir);
    const base = await git(repo, "rev-parse", "HEAD");
    await git(repo, "checkout", "-qb", "task");
    writeFileSync(join(repo, "change.txt"), "The task's change\n");
    await git(repo, "add", "change.txt");
    await git(repo, "commit", "-qm", "Add the change");
    for (const hook of ["pre-commit", "commit-msg"]) {
      writeFileSync(join(repo, ".git", "hooks", hook), `#!/bin/sh\necho "Original ${hook} failure"\nexit 1\n`);
      chmodSync(join(repo, ".git", "hooks", hook), 0o755);
    }
    const checks = [failing("Original test failure")];
    engine.s.products.push({ id: "product", name: "Shop", repo: "local/shop", path: repo, tone: "blue", delivery: "local", checksBy: "coordinator", checks });
    const task = engine.task(engine.addTask({ productId: "product", title: "Synthetic failures" }))!;
    const scope = executionFor(task);
    Object.assign(scope.work, { worktree: repo, baseSha: base, branch: "task" });
    // Command completion, including both repository hooks: one read for each failed run.
    expect(await engine["checks"].runProductChecks(scope, checks, new AbortController().signal)).toBe(3);
    const failed = scope.work.checks!.results.map((run) => [run.name, run.ok, run.interruption, run.output.trim()]);
    expect(failed).toEqual([["Tests", false, undefined, "Original test failure"], ["Pre-commit hook", false, undefined, "Original pre-commit failure"], ["Commit message hook", false, undefined, "Original commit-msg failure"]]);
    // Reusing the saved failures takes one snapshot for the batch.
    expect(await engine["checks"].failing(scope, new AbortController().signal, checks)).toBe(true);
    expect(task.journey!.flatMap((step) => step.reuses ?? [])).toHaveLength(1);
    await engine.shutdown();
    // Startup recovery takes one more for the saved failures still waiting.
    engine = new Engine(home, options);
    engine.schedule = () => {};
    await Promise.allSettled([...engine.backgroundWork]);
    expect(executionFor(engine.task(task.id)!).work.checks!.results.map((run) => [run.name, run.ok, run.interruption, run.output.trim()])).toEqual(failed);
    expect(reads).toHaveLength(source === "an explicit source" ? 5 : 0);
    expect(commands.started).toEqual([]);
  } finally {
    commands.restore();
    await engine.shutdown();
  }
});

it("keeps two direct check runs' evidence apart, and cancelling one leaves the other's collection and result unaffected", async () => {
  const dir = tempDir("petrina-machine-records-direct-");
  const stopFirst = new AbortController(), stopSecond = new AbortController();
  let commands: ReturnType<typeof powerLogCommands> | undefined;
  let firstRecords: ReturnType<typeof heldMachineRecords> | undefined, secondRecords: ReturnType<typeof heldMachineRecords> | undefined;
  const operations = new FixtureOperations({
    stop() {
      stopFirst.abort(); stopSecond.abort();
      firstRecords?.answer(""); secondRecords?.answer("");
    },
    dispose() {
      removeDir(dir);
      try { lstatSync(dir); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      throw new Error(`The direct-check fixture could not remove ${dir}`);
    },
    allowanceMs: CLEANUP_MS * SLOW, label: `Direct-check fixture at ${dir}`,
    arm(expired, ms) { const timer = setTimeout(expired, ms); return () => clearTimeout(timer); },
  });
  try {
    commands = powerLogCommands();
    // A direct run's default reads nothing.
    const [quiet] = await operations.run(() => runChecks(dir, [failing("Quiet failure")], process.env, 30_000 * SLOW, stopFirst.signal));
    expect([quiet!.ok, quiet!.interruption, quiet!.output.trim()]).toEqual([false, undefined, "Quiet failure"]);
    // Each run's records cover both executions: only the run that receives them may use them.
    const sleep = powerLogSleep(Date.now() - 60_000, 3600);
    const first = firstRecords = heldMachineRecords(sleep), second = secondRecords = heldMachineRecords();
    const firstProgress: CheckProgress[] = [];
    const later = { name: "Build", argv: [process.execPath, "-e", "process.exit(0)"] };
    const runs = [
      operations.run(() => runChecks(dir, [failing("First failure"), later], process.env, 30_000 * SLOW, stopFirst.signal, undefined, undefined, (event) => firstProgress.push(event), first.source)),
      operations.run(() => runChecks(dir, [failing("Second failure")], process.env, 30_000 * SLOW, stopSecond.signal, undefined, undefined, undefined, second.source)),
    ];
    await Promise.all([
      waitFor(() => first.reads.length === 1, "the first direct check's evidence read", 30_000, { during: runs[0] }),
      waitFor(() => second.reads.length === 1, "the second direct check's evidence read", 30_000, { during: runs[1] }),
    ]);
    expect([first.reads, second.reads]).toEqual([[stopFirst.signal], [stopSecond.signal]]);
    stopFirst.abort();
    const firstRuns = await runs[0]!;
    expect(second.reads[0]!.aborted).toBe(false);
    second.answer(sleep);
    const [interrupted] = await runs[1]!;
    // The cancelled run discards its late records and starts nothing more.
    const [stopped] = firstRuns;
    expect(firstRuns).toHaveLength(1);
    expect([stopped!.ok, stopped!.interrupted, stopped!.interruption, stopped!.output.trim()]).toEqual([false, true, undefined, "First failure"]);
    expect(firstProgress.filter((event) => event.kind === "started").map((event) => event.index)).toEqual([0]);
    // The other keeps its original result, timing and diagnostic, with its own recorded sleep.
    expect([interrupted!.ok, interrupted!.interrupted, interrupted!.output.trim(), interrupted!.ms]).toEqual([false, undefined, "Second failure", interrupted!.endedAt! - interrupted!.startedAt!]);
    expect(interrupted!.interruption).toEqual({ source: "macOS power log", at: Date.parse(sleep.slice(0, 25)), event: expect.stringContaining("Entering Sleep state") });
    expect(commands.started).toEqual([]);
  } finally {
    try { await operations.close(); }
    finally { commands?.restore(); }
  }
});

interface FailureOwner {
  root: string;
  engine: Engine;
  task: NonNullable<ReturnType<Engine["task"]>>;
  scope: ReturnType<typeof executionFor>;
  controller: AbortController;
  operations: FixtureOperations;
  close(): Promise<void>;
}

async function savedFailureWorld(name: string, held: ReturnType<typeof heldMachineRecords>, checks: DeepMutable<ProductCheck>[], saved: CheckRun[], effects: {
  prepareRepository?(root: string, engine: Engine): Promise<string>;
  beforeHandoff?(owner: FailureOwner): Promise<void>;
} = {}): Promise<FailureOwner> {
  const dir = tempDir(`petrina-machine-records-${name}-`);
  const controller = new AbortController();
  let current: Engine | undefined;
  const operations = new FixtureOperations({
    async stop() {
      controller.abort();
      const stopped = current?.shutdown();
      held.answer("");
      await stopped;
    },
    dispose() {
      removeDir(dir);
      try { lstatSync(dir); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      throw new Error(`The failure-reuse fixture could not remove ${dir}`);
    },
    allowanceMs: CLEANUP_MS * SLOW, label: `Failure-reuse fixture at ${dir}`,
    arm(expired, ms) { const timer = setTimeout(expired, ms); return () => clearTimeout(timer); },
  });
  return setupWithCleanup(async () => {
    const engine = current = new Engine(join(dir, "data"), { agentCommand: () => undefined, terminals: () => [], machineRecords: held.source });
    engine.schedule = () => {};
    const repo = await (effects.prepareRepository ? effects.prepareRepository(dir, engine) : makeProduct(dir));
    engine.s.products.push({ id: "product", name: "Shop", repo: "local/shop", path: repo, tone: "blue", delivery: "local", checksBy: "coordinator", checks });
    const task = engine.task(engine.addTask({ productId: "product", title: `${name} engine's failure` }))!;
    const scope = executionFor(task);
    scope.work.worktree = repo;
    scope.work.checkReturns = 2;
    task.plan = { stages: [{ id: "delivery", title: "Delivery", kind: "gate", gate: "delivery", roleId: "coordinator", profileIds: [] }], rationale: "Saved failure", plannerProfileId: "opus-high" };
    task.stageIndex = 0;
    await operations.run(() => engine["checks"]["runPreparedChecks"](scope, checks, controller.signal, saved));
    const owner = { root: dir, engine, task, scope, controller, operations, close: () => operations.close() };
    await effects.beforeHandoff?.(owner);
    return owner;
  }, () => operations.close());
}

it("keeps two engines' evidence apart through failure reuse, and stopping one leaves the other's collection and result unaffected", async () => {
  const now = Date.now();
  const checks = [{ name: "Tests", argv: ["test"] }];
  const saved = (output: string): CheckRun[] => [{ name: "Tests", command: "test", ok: false, execution: completeCheckExecution(7), ms: 60_000, output, startedAt: now - 120_000, endedAt: now - 60_000 }];
  const sleep = powerLogSleep(now - 100_000, 30);
  // A stopped read answers with the same sleep: arriving after the stop, it must not count.
  const stoppedRecords = heldMachineRecords(sleep), continuingRecords = heldMachineRecords();
  let stopped: FailureOwner | undefined, continuing: FailureOwner | undefined;
  try {
    stopped = await savedFailureWorld("stopped", stoppedRecords, checks, saved("Original stopped failure"));
    continuing = await savedFailureWorld("continuing", continuingRecords, checks, saved("Original continuing failure"));
    const stop = stopped.controller, keepGoing = continuing.controller;
    const stoppedOwner = stopped;
    let first!: Promise<boolean>;
    const observedFirst = stopped.operations.run(() => {
      first = stoppedOwner.engine["checks"].failing(stoppedOwner.scope, stop.signal, checks);
      return rejectionOf(first);
    });
    const continuingOwner = continuing;
    const reuse = [first, continuing.operations.run(() => continuingOwner.engine["checks"].failing(continuingOwner.scope, keepGoing.signal, checks))];
    await Promise.all([
      waitFor(() => stoppedRecords.reads.length === 1, "the stopped Engine's evidence read", 30_000, { during: first }),
      waitFor(() => continuingRecords.reads.length === 1, "the continuing Engine's evidence read", 30_000, { during: reuse[1] }),
    ]);
    expect([stoppedRecords.reads, continuingRecords.reads]).toEqual([[stop.signal], [keepGoing.signal]]);
    stop.abort();
    expect(await rejectionOf(reuse[0]!)).toBeInstanceOf(Aborted);
    await observedFirst;
    expect(continuingRecords.reads[0]!.aborted).toBe(false);
    continuingRecords.answer(sleep);
    expect(await reuse[1]).toBe(true);
    expect(stopped.scope.work.checks!.results).toEqual(saved("Original stopped failure"));
    expect(stopped.task.journey!.flatMap((step) => step.reuses ?? [])).toEqual([]);
    // Recorded sleep leaves verification incomplete: the original failure stays, with no repair or extra return.
    const [run] = continuing.scope.work.checks!.results;
    expect(run).toEqual({ ...saved("Original continuing failure")[0]!, interruption: { source: "macOS power log", at: Date.parse(sleep.slice(0, 25)), event: expect.stringContaining("Entering Sleep state") } });
    expect(continuing.task.findings.filter((finding) => finding.status === "open")).toEqual([]);
    expect(continuing.task.repair).toBeUndefined();
    expect([stopped.scope.work.checkReturns, continuing.scope.work.checkReturns]).toEqual([2, 2]);
  } finally {
    const outcomes = await Promise.allSettled([stopped?.close(), continuing?.close()]);
    const errors = outcomes.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Failure-reuse fixtures could not finish cleanup");
  }
});

it("stops the actual Engine when repository setup rejects before fixture handoff", async () => {
  const failure = new Error("Repository setup failed before handoff");
  let observed: { root: string; engine: Engine } | undefined;
  const outcome = await rejectionOf(savedFailureWorld("setup-failure", heldMachineRecords(), [], [], {
    prepareRepository: async (root, engine) => { observed = { root, engine }; throw failure; },
  }));
  expect(outcome).toBe(failure);
  expect(observed!.engine.stopped).toBe(true);
  expect(existsSync(observed!.root)).toBe(false);
});

it("keeps setup cleanup pending until its actual direct check and inspected cancellation settle", async () => {
  const failure = new Error("Fixture setup failed after starting a direct check");
  const held = heldMachineRecords(), release = Promise.withResolvers<void>();
  const checks = [{ name: "Tests", argv: ["test"] }];
  const at = Date.now() - 120_000;
  const saved = [{ name: "Tests", command: "test", ok: false, execution: completeCheckExecution(7), ms: 60_000, output: "Saved failure", startedAt: at, endedAt: at + 60_000 }];
  let observed: FailureOwner | undefined, direct: Promise<void> | undefined, cancelled = false, settled = false;
  const setup = savedFailureWorld("pending-handoff", held, checks, saved, {
    beforeHandoff: async owner => {
      observed = owner;
      let reading!: Promise<boolean>;
      direct = owner.operations.run(async () => {
        reading = owner.engine["checks"].failing(owner.scope, owner.controller.signal, checks);
        const result = await rejectionOf(reading);
        if (!(result instanceof Aborted)) throw result;
        cancelled = true;
        await release.promise;
      });
      await waitFor(() => held.reads.length === 1, "setup to start its direct evidence read", 30_000, { during: reading });
      throw failure;
    },
  });
  const outcome = rejectionOf(setup).then(result => { settled = true; return result; });
  try {
    await waitFor(() => cancelled, "the actual direct check to observe fixture cancellation", 30_000, { during: setup });
    expect(observed!.controller.signal.aborted).toBe(true);
    expect(settled).toBe(false);
    expect(existsSync(observed!.root)).toBe(true);
    release.resolve();
    expect(await outcome).toBe(failure);
    expect(observed!.engine.stopped).toBe(true);
    expect(existsSync(observed!.root)).toBe(false);
  } finally {
    release.resolve(); held.answer("");
    await outcome;
    await direct;
  }
});
