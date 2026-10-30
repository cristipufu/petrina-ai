import { engineCaseFixtures, type EngineCaseOwner } from "../../fixtures/engine-cases.js";
import { registerFixtureRoot } from "@petrina/test-support/fixture-retention";
import type { CheckVerification } from "../../../src/product-checks.js";
import { nonpassingChecks } from "../../fixtures/check-verification.js";
import { afterAll, expect, it, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckRun } from "@petrina/core";
import * as nativeChecks from "@petrina/repositories/check-runner";
import type { MachineRecords } from "../../../src/check-interruption.js";
import type { CheckProgress } from "../../../src/checks.js";
import { Aborted } from "../../../src/kernel.js";
import { executionFor } from "@petrina/orchestrator";
import { Engine } from "../../engine.js";
import { git, heldMachineRecords, createProductRepository, makeProduct, noMachineRecords, powerLogSleep, removeDir, runChecks, SLOW, tempDir } from "../../fixtures.js";
import { rejectionOf } from "@petrina/test-support/rejections";
import { FixtureOperations } from "@petrina/test-support/fixture-operations";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { CLEANUP_MS } from "@petrina/test-support/commands";
import { waitFor } from "../../fixtures.js";
import { installSharedWorkflowFastPaths } from "../../fixtures/shared-preparation.js";
import { privateAgentToolProbe } from "../../scripted-probes.js";

const engineCases = engineCaseFixtures();
afterAll(() => engineCases.close());

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
  return engineCases.use("petrina-machine-records-", async caseOwner => {
  const dir = caseOwner.root;
  const home = join(dir, "data");
  const reads: (AbortSignal | undefined)[] = [];
  const own: MachineRecords = async (signal) => { reads.push(signal); return ""; };
  const options = { agentCommand: () => undefined, toolProbe: privateAgentToolProbe(), terminals: () => [], ...(source === "an explicit source" ? { machineRecords: own } : {}) };
  const commands = powerLogCommands();
  let engine = caseOwner.open(home, options);
  engine.schedule = () => {};
  try {
    const { path: repo, initialSha: base } = await createProductRepository(dir, { origin: "none" });
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
    expect(nonpassingChecks(await engine["checks"].runProductChecks(scope, checks, new AbortController().signal))).toBe(3);
    const failed = scope.work.checks!.results.map((run) => [run.name, run.ok, run.interruption, run.output.trim()]);
    expect(failed).toEqual([["Tests", false, undefined, "Original test failure"], ["Pre-commit hook", false, undefined, "Original pre-commit failure"], ["Commit message hook", false, undefined, "Original commit-msg failure"]]);
    // Reusing the saved failures takes one snapshot for the batch.
    expect((await engine["checks"].failing(scope, new AbortController().signal, checks)).kind).toBe("product-failed");
    expect(task.journey!.flatMap((step) => step.reuses ?? [])).toHaveLength(1);
    await caseOwner.stop(engine);
    // Startup recovery takes one more for the saved failures still waiting.
    engine = caseOwner.open(home, options);
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
});

it("keeps two direct check runs' evidence apart, and cancelling one leaves the other's collection and result unaffected", async () => {
  const dir = tempDir("petrina-machine-records-direct-");
  registerFixtureRoot(dir);
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
  runs: CheckRun[];
  close(): Promise<void>;
}

async function savedFailureWorld(caseOwner: EngineCaseOwner, name: string, held: ReturnType<typeof heldMachineRecords>, output: string, effects: {
  prepareRepository?(root: string, engine: Engine): Promise<string>;
  beforeHandoff?(owner: FailureOwner): Promise<void>;
} = {}): Promise<FailureOwner> {
  const dir = join(caseOwner.root, `petrina-machine-records-${name}`);
  mkdirSync(dir);
  const controller = new AbortController();
  let current: Engine | undefined;
  let records: MachineRecords = noMachineRecords, restore: (() => void) | undefined;
  const operations = new FixtureOperations({
    async stop() {
      controller.abort();
      const stopped = current ? caseOwner.stop(current) : Promise.resolve();
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
  caseOwner.onStop(() => operations.close());
  return setupWithCleanup(async () => {
    const engine = current = caseOwner.open(join(dir, "data"), { agentCommand: () => undefined, toolProbe: privateAgentToolProbe(), terminals: () => [], machineRecords: signal => records(signal) });
    installSharedWorkflowFastPaths(engine, { fastCheckCapture: true });
    const prepared = await caseOwner.run(engine, async () => {
    try {
    engine.schedule = () => {};
    const repo = await (effects.prepareRepository ? effects.prepareRepository(dir, engine) : operations.run(() => makeProduct(dir, { origin: "none" })));
    const checks = [{ name: "Tests", argv: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(output)});process.exit(7)`] }];
    engine.s.products.push({ id: "product", name: "Shop", repo: "local/shop", path: repo, tone: "blue", delivery: "local", checksBy: "coordinator", checks });
    const task = engine.task(engine.addTask({ productId: "product", title: `${name} engine's failure` }))!;
    const scope = executionFor(task);
    scope.work.worktree = repo;
    scope.work.checkReturns = 2;
    task.plan = { stages: [{ id: "delivery", title: "Delivery", kind: "gate", gate: "delivery", roleId: "coordinator", profileIds: [] }], rationale: "Saved failure", plannerProfileId: "opus-high" };
    task.stageIndex = 0;
    const runs: CheckRun[] = [], original = nativeChecks.runChecks;
    try {
      const capture = spyOn(nativeChecks, "runChecks"); restore = () => capture.mockRestore();
      capture.mockImplementation(async (...args) => {
        const produced = await original(...args);
        if (args[0] === repo && args[1].every(check => checks.some(expected => expected.name === check.name && JSON.stringify(expected.argv) === JSON.stringify(check.argv))))
          runs.push(...structuredClone(produced));
        return produced;
      });
      await operations.run(() => engine["checks"]["runPreparedChecks"](scope, checks, controller.signal));
    } finally { restore?.(); restore = undefined; }
    records = held.source;
    const owner = { root: dir, engine, task, scope, controller, operations, runs, close: () => operations.close() };
    caseOwner.check();
    await effects.beforeHandoff?.(owner);
    caseOwner.check();
    return { value: owner };
    } catch (error) { return { failure: { error } }; }
    });
    if (prepared.failure) throw prepared.failure.error;
    return prepared.value;
  }, () => operations.close());
}

it("keeps two engines' evidence apart through failure reuse, and stopping one leaves the other's collection and result unaffected", async () => {
  return engineCases.use("petrina-machine-records-", async caseOwner => {
  let sleep = "";
  // A stopped read answers with the same actual-run-overlapping sleep: arriving after the stop, it must not count.
  const stoppedRaw = heldMachineRecords(), continuingRecords = heldMachineRecords();
  const stoppedRecords = { ...stoppedRaw, source: async (signal?: AbortSignal) => {
    const records = await stoppedRaw.source(signal);
    return signal?.aborted ? sleep : records;
  } };
  let stopped: FailureOwner | undefined, continuing: FailureOwner | undefined;
  try {
    stopped = await savedFailureWorld(caseOwner, "stopped", stoppedRecords, "Original stopped failure");
    continuing = await savedFailureWorld(caseOwner, "continuing", continuingRecords, "Original continuing failure");
    const starts = [...stopped.runs, ...continuing.runs].map(run => run.startedAt!), ends = [...stopped.runs, ...continuing.runs].map(run => run.endedAt!);
    const start = Math.min(...starts), end = Math.max(...ends);
    sleep = powerLogSleep(start - 1000, Math.ceil((end - start + 2000) / 1000));
    const stop = stopped.controller, keepGoing = continuing.controller;
    const stoppedOwner = stopped;
    let first!: Promise<CheckVerification>;
    const observedFirst = stopped.operations.run(() => {
      first = stoppedOwner.engine["checks"].failing(stoppedOwner.scope, stop.signal);
      return rejectionOf(first).then(error => {
        if (!(error instanceof Aborted)) throw error;
        return error;
      });
    });
    const continuingOwner = continuing;
    const reuse = [first, continuing.operations.run(() => continuingOwner.engine["checks"].failing(continuingOwner.scope, keepGoing.signal))];
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
    expect((await reuse[1]!).kind).toBe("blocked");
    expect(stopped.scope.work.checks!.results).toEqual(stopped.runs);
    expect(stopped.task.journey!.flatMap((step) => step.reuses ?? [])).toEqual([]);
    // Recorded sleep leaves verification incomplete: the original failure stays, with no repair or extra return.
    const [run] = continuing.scope.work.checks!.results;
    expect(run).toEqual({ ...continuing.runs[0]!, interruption: { source: "macOS power log", at: Date.parse(sleep.slice(0, 25)), event: expect.stringContaining("Entering Sleep state") } });
    expect(continuing.task.findings.filter((finding) => finding.status === "open")).toEqual([]);
    expect(continuing.task.repair).toBeUndefined();
    expect([stopped.scope.work.checkReturns, continuing.scope.work.checkReturns]).toEqual([2, 2]);
  } finally {
    const outcomes = await Promise.allSettled([stopped?.close(), continuing?.close()]);
    const errors = outcomes.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Failure-reuse fixtures could not finish cleanup");
  }

  }, { allowOverlap: true });
});

it("stops the actual Engine when repository setup rejects before fixture handoff", async () => {
  return engineCases.use("petrina-machine-records-", async caseOwner => {
  const failure = new Error("Repository setup failed before handoff");
  let observed: { root: string; engine: Engine } | undefined;
  const outcome = await rejectionOf(savedFailureWorld(caseOwner, "setup-failure", heldMachineRecords(), "Unused setup failure", {
    prepareRepository: async (root, engine) => { observed = { root, engine }; throw failure; },
  }));
  expect(outcome).toBe(failure);
  expect(observed!.engine.stopped).toBe(true);
  expect(existsSync(observed!.root)).toBe(false);

  });
});

it("keeps setup cleanup pending until its actual direct check and inspected cancellation settle", async () => {
  return engineCases.use("petrina-machine-records-", async caseOwner => {
  const failure = new Error("Fixture setup failed after starting a direct check");
  const held = heldMachineRecords(), release = Promise.withResolvers<void>();
  caseOwner.onStop(() => release.resolve());
  let observed: FailureOwner | undefined, direct: Promise<void> | undefined, cancelled = false, settled = false;
  const setup = savedFailureWorld(caseOwner, "pending-handoff", held, "Saved failure", {
    beforeHandoff: async owner => {
      observed = owner;
      let reading!: Promise<CheckVerification>;
      direct = owner.operations.run(async () => {
        reading = owner.engine["checks"].failing(owner.scope, owner.controller.signal);
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
});
