import { afterAll, expect, it, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckRun } from "@petrina/core";
import type { MachineRecords } from "../src/check-interruption.js";
import type { CheckProgress } from "../src/checks.js";
import { Aborted } from "../src/kernel.js";
import { executionFor } from "../src/repository-context.js";
import { Engine } from "./engine.js";
import { git, heldMachineRecords, makeProduct, powerLogSleep, removeDir, runChecks, SLOW, tempDir } from "./fixtures.js";
import { rejectionOf } from "./rejections.js";

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
    const repo = makeProduct(dir);
    const base = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-qb", "task");
    writeFileSync(join(repo, "change.txt"), "The task's change\n");
    git(repo, "add", "change.txt");
    git(repo, "commit", "-qm", "Add the change");
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
  const dir = root("petrina-machine-records-direct-");
  const commands = powerLogCommands();
  try {
    // A direct run's default reads nothing.
    const [quiet] = await runChecks(dir, [failing("Quiet failure")], process.env, 30_000 * SLOW);
    expect([quiet!.ok, quiet!.interruption, quiet!.output.trim()]).toEqual([false, undefined, "Quiet failure"]);
    // Each run's records cover both executions: only the run that receives them may use them.
    const sleep = powerLogSleep(Date.now() - 60_000, 3600);
    const first = heldMachineRecords(sleep), second = heldMachineRecords();
    const stopFirst = new AbortController(), stopSecond = new AbortController();
    const firstProgress: CheckProgress[] = [];
    const later = { name: "Build", argv: [process.execPath, "-e", "process.exit(0)"] };
    const runs = [
      runChecks(dir, [failing("First failure"), later], process.env, 30_000 * SLOW, stopFirst.signal, undefined, undefined, (event) => firstProgress.push(event), first.source),
      runChecks(dir, [failing("Second failure")], process.env, 30_000 * SLOW, stopSecond.signal, undefined, undefined, undefined, second.source),
    ];
    await Promise.all([first.started(), second.started()]);
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
  } finally { commands.restore(); }
});

it("keeps two engines' evidence apart through failure reuse, and stopping one leaves the other's collection and result unaffected", async () => {
  const now = Date.now();
  const checks = [{ name: "Tests", argv: ["test"] }];
  const saved = (output: string): CheckRun[] => [{ name: "Tests", command: "test", ok: false, ms: 60_000, output, startedAt: now - 120_000, endedAt: now - 60_000 }];
  const sleep = powerLogSleep(now - 100_000, 30);
  const start = async (name: string, held: ReturnType<typeof heldMachineRecords>) => {
    const dir = root(`petrina-machine-records-${name}-`);
    const engine = new Engine(join(dir, "data"), { agentCommand: () => undefined, terminals: () => [], machineRecords: held.source });
    engine.schedule = () => {};
    const repo = makeProduct(dir);
    engine.s.products.push({ id: "product", name: "Shop", repo: "local/shop", path: repo, tone: "blue", delivery: "local", checksBy: "coordinator", checks });
    const task = engine.task(engine.addTask({ productId: "product", title: `${name} engine's failure` }))!;
    const scope = executionFor(task);
    scope.work.worktree = repo;
    scope.work.checkReturns = 2;
    task.plan = { stages: [{ id: "delivery", title: "Delivery", kind: "gate", gate: "delivery", roleId: "coordinator", profileIds: [] }], rationale: "Saved failure", plannerProfileId: "opus-high" };
    task.stageIndex = 0;
    await engine["checks"]["runPreparedChecks"](scope, checks, new AbortController().signal, saved(`Original ${name} failure`));
    return { engine, task, scope };
  };
  // A stopped read answers with the same sleep: arriving after the stop, it must not count.
  const stoppedRecords = heldMachineRecords(sleep), continuingRecords = heldMachineRecords();
  const stopped = await start("stopped", stoppedRecords), continuing = await start("continuing", continuingRecords);
  const stop = new AbortController(), keepGoing = new AbortController();
  try {
    const reuse = [stopped.engine["checks"].failing(stopped.scope, stop.signal, checks), continuing.engine["checks"].failing(continuing.scope, keepGoing.signal, checks)];
    await Promise.all([stoppedRecords.started(), continuingRecords.started()]);
    expect([stoppedRecords.reads, continuingRecords.reads]).toEqual([[stop.signal], [keepGoing.signal]]);
    stop.abort();
    expect(await rejectionOf(reuse[0]!)).toBeInstanceOf(Aborted);
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
    stop.abort(); keepGoing.abort(); stoppedRecords.answer(""); continuingRecords.answer("");
    await Promise.all([stopped.engine.shutdown(), continuing.engine.shutdown()]);
  }
});
