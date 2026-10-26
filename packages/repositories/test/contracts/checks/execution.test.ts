import { describe as originalDescribe } from "bun:test";
import { afterAll, expect, it, spyOn } from "bun:test";


import { existsSync, lstatSync, writeFileSync } from "node:fs";
import * as files from "node:fs/promises";
import { join } from "node:path";

import { childState } from "@petrina/platform/process-tree";
import { stopOwnedProcess } from "@petrina/platform/owned-process";
import { isCheckExecutorFacts, isCheckOutputIdentity } from "@petrina/core";

import { removeDir, tempDir, waitFor } from "@petrina/test-support/fixtures";
import { FixtureOperations } from "@petrina/test-support/fixture-operations";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { CLEANUP_MS } from "@petrina/test-support/commands";
import { SLOW } from "@petrina/test-support/slow";
import { runChecks, checkCommandOutcome, powerLogSleep, heldMachineRecords } from "../../fixtures/check-runner.js";
import { checkExecutionFixture } from "../../fixtures/check-execution.js";
const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
const root = (prefix: string) => { const dir = tempDir(prefix); roots.push(dir); return dir; };
const arm = (expired: () => void, ms: number) => { const timer = setTimeout(expired, ms); return () => clearTimeout(timer); };
const dispose = (dir: string) => {
  removeDir(dir);
  try { lstatSync(dir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  throw new Error(`The check fixture could not remove ${dir}`);
};
function checkOwner(dir: string, stop: () => void | Promise<void>) {
  let closing = false;
  const operations = new FixtureOperations({
    arm, allowanceMs: CLEANUP_MS * SLOW, label: `Check fixture at ${dir}`,
    stop: () => { closing = true; return stop(); }, dispose: () => dispose(dir),
  });
  return {
    run: <T>(start: () => Promise<T>) => operations.run(start),
    close: () => operations.close(),
    beforeStart: () => !closing,
  };
}

originalDescribe("a product's checks", () => {
it("reports each check's start and result while another check is still running", async () => {
    const dir = tempDir("petrina-check-progress-");
    const release = join(dir, "release");
    const updates: { index: number; kind: string; at: number }[] = [];
    const held = `import { existsSync } from "node:fs"; while (!existsSync(process.argv[1])) await Bun.sleep(20);`;
    const owner = checkOwner(dir, () => { writeFileSync(release, "go"); });
    await setupWithCleanup(async () => {
      const running = owner.run(() => runChecks(dir, [{ name: "Quick", argv: ["git", "--version"] }, { name: "Held", argv: [process.execPath, "-e", held, release] }], process.env, 30_000 * SLOW, undefined, undefined, undefined, (event) => updates.push(event), undefined, undefined, undefined, owner.beforeStart));
      await waitFor(() => updates.some((event) => event.index === 0 && event.kind === "finished") && updates.some((event) => event.index === 1 && event.kind === "started"), "one completed check and another still running", undefined, { during: running });
      expect(updates.some((event) => event.index === 1 && event.kind === "finished")).toBe(false);
      writeFileSync(release, "go");
      const results = await running;
      expect(results.every((run) => run.ok)).toBe(true);
      expect(updates.map((event) => `${event.index}:${event.kind}`)).toEqual(["0:started", "0:finished", "1:started", "1:finished"]);
    }, () => owner.close());
    await owner.close();
  });
});

originalDescribe("a product's checks", () => {
it("runs static checks first and skips heavy commands after a static failure", async () => {
    const dir = root("petrina-check-stages-");
    const heavy = join(dir, "heavy-started");
    const results = await runChecks(dir, [
      { name: "Tests", argv: [process.execPath, "-e", 'require("node:fs").writeFileSync(process.argv[1], "yes")', heavy] },
      { name: "Type check", argv: [process.execPath, "-e", "process.exit(1)"] },
      { name: "Lint", argv: ["git", "--version"] },
    ], process.env, 30_000 * SLOW);
    expect(results.map((run) => [run.name, run.ok])).toEqual([["Type check", false]]);
    expect(existsSync(heavy)).toBe(false);
  });
});

originalDescribe("a product's checks", () => {
it("reports what really happened: passed, failed, or could not start", async () => {
    const dir = root("petrina-checks-run-");
    // These commands test exit results, so allow time for process startup on a busy machine.
    const results = await runChecks(
      dir,
      [
        { name: "Passes", argv: ["git", "--version"] },
        { name: "Fails", argv: ["git", "no-such-subcommand-petrina"] },
        { name: "Missing", argv: ["petrina-no-such-program"] },
      ],
      process.env,
      30_000 * SLOW,
    );
    expect(results.map((run) => [run.name, run.ok]), JSON.stringify(results)).toEqual([
      ["Passes", true],
      ["Fails", false],
      ["Missing", false],
    ]);
    expect(results[0]!.output).toContain("git version");
    expect(results[2]!.output).toStartWith("Could not start");
    expect(results[0]!.execution).toMatchObject({ started: true, exit: { status: "reported", code: 0 }, stdout: "eof", stderr: "eof", cleanup: "not-requested" });
    expect(results[1]!.execution?.exit.status).toBe("reported");
    expect(results[1]!.execution!.exit.code).toBeGreaterThan(0);
    expect(results[2]!.execution).toMatchObject({ started: false, exit: { status: "unreported" }, failure: { kind: "start" }, cleanup: "not-requested" });
    expect(results.every(run => isCheckExecutorFacts(run.executor))).toBe(true);
    expect(results.map(run => isCheckOutputIdentity(run.outputIdentity))).toEqual([true, true, false]);
  });
});

originalDescribe("a product's checks", () => {
for (const mode of ["launch failure", "successful registration", "registration failure"] as const) it.skipIf(process.platform === "win32" && mode === "registration failure")(`distinguishes ${mode} at the launched-process callback`, async () => {
    const dir = tempDir("petrina-check-registration-");
    const ready = join(dir, "ready"), program = join(dir, "check.ts");
    const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
    let pid: number | undefined, returned = false;
    let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined, restore = () => {};
    const owner = checkOwner(dir, async () => {
      released.resolve();
      const errors: unknown[] = [];
      try { restore(); } catch (error) { errors.push(error); }
      try {
        if (pid !== undefined && !child) throw new Error("The registration fixture did not capture its launched child");
        if (child && await stopOwnedProcess(child, { graceMs: CLEANUP_MS * SLOW, forceMs: CLEANUP_MS * SLOW }, arm) !== "confirmed")
          throw new Error("The registration fixture's actual child did not stop");
      } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "Registration fixture cleanup could not be confirmed");
    });
    await setupWithCleanup(async () => {
      writeFileSync(program, `import { writeFileSync, renameSync } from "node:fs";
writeFileSync(${JSON.stringify(ready)} + ".tmp", "ready"); renameSync(${JSON.stringify(ready)} + ".tmp", ${JSON.stringify(ready)});
console.log("Original command output");
${mode === "registration failure" ? "setInterval(() => {}, 1000);" : "process.exit(0);"}`);
      const command = mode === "launch failure" ? ["petrina-no-such-program"] : [process.execPath, program];
      const nativeSpawn = Bun.spawn.bind(Bun);
      const dispatch = ((...args: unknown[]) => {
        const first = args[0];
        const argv = Array.isArray(first) ? first : first && typeof first === "object" && "cmd" in first ? first.cmd : undefined;
        const options = Array.isArray(first) ? args[1] : first;
        const matches = Array.isArray(argv) && argv.length === command.length && argv.every((value, index) => value === command[index]) &&
          options && typeof options === "object" && "cwd" in options && options.cwd === dir;
        const started = Reflect.apply(nativeSpawn, undefined, args);
        if (matches) {
          const owned = started as Bun.Subprocess<"ignore", "pipe", "pipe">;
          child = owned; void owned.exited.catch(() => undefined);
        }
        return started;
      }) as typeof Bun.spawn;
      const spawning = spyOn(Bun, "spawn");
      restore = () => spawning.mockRestore();
      spawning.mockImplementation(dispatch);
      const running = owner.run(() => runChecks(dir, [{ name: "Registered check", argv: command }],
      process.env, 30_000 * SLOW, undefined, join(dir, "logs"), async () => {
        entered.resolve(); await released.promise;
        return `${pid} ${process.pid} S\n`; // The fixture's single owned process cannot fork or finish by itself.
      }, undefined, undefined, launched => {
        pid = launched;
        if (mode === "registration failure") throw new Error("Client registration unavailable");
      }, undefined, owner.beforeStart).then(runs => { returned = true; return runs; }));
      if (mode === "registration failure") {
        await Promise.race([entered.promise, running.then(() => { throw new Error("The runner returned before stopping its launched process"); })]);
        await waitFor(() => existsSync(ready), "the owned command to be running while cleanup is held", undefined, { during: running });
        expect(returned).toBe(false); expect(pid).toBeDefined(); expect(() => process.kill(pid!, 0)).not.toThrow();
        released.resolve();
      }
      const [run] = await running;
      expect(isCheckExecutorFacts(run!.executor)).toBe(true);
      expect(isCheckOutputIdentity(run!.outputIdentity)).toBe(mode === "successful registration");
      expect(run!.endedAt).toBeDefined(); expect(run!.cleanupIncomplete).toBeUndefined();
      expect(run!.logPath).toBeDefined();
      if (mode === "launch failure") {
        expect(pid).toBeUndefined(); expect(run!.ok).toBe(false); expect(run!.interrupted).toBeUndefined();
        expect(run!.output).toStartWith("Could not start:"); expect(checkCommandOutcome(run)).toBe("unavailable");
      } else {
        expect(pid).toBeDefined(); expect(child?.pid).toBe(pid); expect(await childState(pid!)).toBe("ended");
        expect(run!.ok).toBe(mode === "successful registration");
        expect(checkCommandOutcome(run)).toBe(mode === "successful registration" ? "passed" : "unfinished");
        if (mode === "registration failure") {
          expect(run!.interrupted).toBe(true); expect(run!.output).toContain("Client registration unavailable");
          expect(run!.output).not.toContain("Could not start");
        } else { expect(run!.logComplete).toBe(true); expect(run!.output).toContain("Original command output"); }
      }
    }, () => owner.close());
    await owner.close();
  });
});

originalDescribe("a product's checks", () => {
it("closes fixture admission while diagnostic creation is still pending", async () => {
    const dir = tempDir("petrina-check-admission-"), logs = join(dir, "logs"), forbidden = join(dir, "never-launch");
    const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
    let restoreDirectory = () => {}, restoreSpawn = () => {}, forbiddenStarts = 0;
    const owner = checkOwner(dir, () => {
      released.resolve();
      restoreDirectory();
    });
    const close = async () => {
      const errors: unknown[] = [];
      try { await owner.close(); } catch (error) { errors.push(error); }
      try { restoreSpawn(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "The held diagnostic fixture could not close");
    };
    await setupWithCleanup(async () => {
      const nativeDirectory = files.mkdir.bind(files), nativeSpawn = Bun.spawn.bind(Bun);
      const directories = spyOn(files, "mkdir");
      restoreDirectory = () => directories.mockRestore();
      directories.mockImplementation((async (...args: unknown[]) => {
        if (args[0] === logs) { entered.resolve(); await released.promise; }
        return Reflect.apply(nativeDirectory, undefined, args);
      }) as typeof files.mkdir);
      const spawning = spyOn(Bun, "spawn");
      restoreSpawn = () => spawning.mockRestore();
      spawning.mockImplementation(((...args: unknown[]) => {
        const first = args[0];
        const argv = Array.isArray(first) ? first : first && typeof first === "object" && "cmd" in first ? first.cmd : undefined;
        if (Array.isArray(argv) && argv[0] === forbidden) {
          forbiddenStarts++;
          throw new Error("The closed fixture attempted to launch its command");
        }
        return Reflect.apply(nativeSpawn, undefined, args);
      }) as typeof Bun.spawn);
      const running = owner.run(() => runChecks(dir, [{ name: "Not admitted", argv: [forbidden] }], process.env, 30_000 * SLOW,
        undefined, logs, undefined, undefined, async () => "", undefined, undefined, owner.beforeStart));
      await Promise.race([entered.promise, running.then(() => { throw new Error("The run returned before its diagnostic creation was held"); })]);
      const closing = owner.close();
      void closing.catch(() => undefined);
      expect(existsSync(dir)).toBe(true);
      expect(await running).toEqual([]);
      await closing;
      expect(forbiddenStarts).toBe(0);
      expect(existsSync(dir)).toBe(false);
    }, close);
    await close();
  });
});

originalDescribe("a product's checks", () => {
for (const code of [0, 7]) it(`keeps the output and exit code ${code} when the command ended before spawn returned`, async () => {
    // A fast command under bun:test may be reaped before the caller can attach any event listeners.
    const child = {
      exited: Promise.resolve(code),
      stdout: new Response("Check finished\n").body!,
      stderr: new Response("Details kept\n").body!,
    } as Bun.Subprocess<"ignore", "pipe", "pipe">;
    const spawning = spyOn(Bun, "spawn").mockReturnValue(child);
    // This run's own records: sleep that began a minute ago and lasted an hour.
    const sleep = powerLogSleep(Date.now() - 60_000, 3600);
    const reads: (AbortSignal | undefined)[] = [];
    try {
      const runs = await runChecks(root("petrina-checks-ended-"), [{ name: "Already ended", argv: ["petrina-already-ended"] }], process.env, 200 * SLOW, undefined, undefined, undefined, undefined, async (signal) => { reads.push(signal); return sleep; });
      expect(runs, JSON.stringify(runs)).toEqual([expect.objectContaining({
        name: "Already ended", command: "petrina-already-ended", ms: expect.any(Number), ok: code === 0, output: "Check finished\nDetails kept\n",
        startedAt: expect.any(Number), endedAt: expect.any(Number),
      })]);
      expect(runs[0]!.ms).toBe(runs[0]!.endedAt! - runs[0]!.startedAt!);
      expect(runs[0]!.interruption).toEqual(code === 0 ? undefined : { source: "macOS power log", at: Date.parse(sleep.slice(0, 25)), event: expect.stringContaining("Entering Sleep state") });
      expect(reads).toEqual(code === 0 ? [] : [undefined]);
      expect(isCheckExecutorFacts(runs[0]!.executor)).toBe(true);
      expect(isCheckOutputIdentity(runs[0]!.outputIdentity)).toBe(code === 0);
    } finally { spawning.mockRestore(); }
  });
});

originalDescribe("a product's checks", () => {
it("records a cancelled check without starting an environment investigation", async () => {
    const owner = await checkExecutionFixture("cancelled-before-return"), spawning = owner.spawning;
    const reads: (AbortSignal | undefined)[] = [];
    try {
      const runs = await owner.run(async signal => { reads.push(signal); return ""; }, true);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.ok).toBe(false);
      expect(runs[0]!.interrupted).toBe(true);
      expect(runs[0]!.output).toBe("Original diagnostic\n");
      expect(runs[0]!.execution?.cancelled).toBe(true);
      expect(isCheckExecutorFacts(runs[0]!.executor)).toBe(true);
      expect(runs[0]!.outputIdentity).toBeUndefined();
      expect(reads).toEqual([]);
      expect(spawning).toHaveBeenCalledTimes(1);
    } finally { await owner.close(); }
  });
});

originalDescribe("a product's checks", () => {
it("cancels evidence collection after a completed failure without starting pending checks", async () => {
    const stop = new AbortController();
    const child = {
      exited: Promise.resolve(7), stdout: new Response("Original failure\n").body!, stderr: new Response("").body!,
    } as Bun.Subprocess<"ignore", "pipe", "pipe">;
    const spawning = spyOn(Bun, "spawn").mockReturnValue(child);
    // A read racing the stop answers with sleep covering the check: it arrives too late to count.
    const held = heldMachineRecords(powerLogSleep(Date.now() - 60_000, 3600));
    let running: ReturnType<typeof runChecks> | undefined;
    try {
      running = runChecks(root("petrina-checks-evidence-stop-"), [{ name: "Failed", argv: ["failed-check"] }, { name: "Pending", argv: ["pending-check"] }], process.env, 30_000, stop.signal, undefined, undefined, undefined, held.source);
      await held.started();
      expect(held.reads).toEqual([stop.signal]);
      stop.abort();
      const runs = await running;
      expect(runs).toHaveLength(1);
      expect(runs[0]!.ok).toBe(false);
      expect(runs[0]!.interrupted).toBe(true);
      expect(runs[0]!.interruption).toBeUndefined();
      expect(runs[0]!.output).toBe("Original failure\n");
      expect(runs[0]!.ms).toBe(runs[0]!.endedAt! - runs[0]!.startedAt!);
      expect(isCheckExecutorFacts(runs[0]!.executor)).toBe(true);
      expect(runs[0]!.outputIdentity).toBeUndefined();
      expect(spawning).toHaveBeenCalledTimes(1);
    } finally {
      stop.abort(); held.answer(""); await running;
      spawning.mockRestore();
    }
  });
});

originalDescribe("a product's checks", () => {
it("reports a check that exceeds its deadline as timed out", async () => {
    const dir = root("petrina-checks-timeout-");
    const [run] = await runChecks(dir, [{ name: "Too slow", argv: [process.execPath, "-e", "await Bun.sleep(120000)"] }], process.env, 200 * SLOW, undefined, join(dir, "logs"));
    expect(run!.ok).toBe(false);
    expect(run!.timedOut).toBe(true);
    expect(run!.execution?.timedOut).toBe(true);
    expect(isCheckExecutorFacts(run!.executor)).toBe(true);
    expect(run!.outputIdentity).toBeUndefined();
    expect(existsSync(run!.logPath!)).toBe(true);
    expect(run!.logError).toBeUndefined();
  });
});

originalDescribe("a check that misbehaves", () => {
it("reports fast failures when many checks finish together, without waiting for their timeout", async () => {
    // A minute leaves room for 24 programs starting at once while the load climbs after SLOW was measured.
    // A failure Petrina missed would still be cut off at that limit and show as timed out.
    const results = await runChecks(root("petrina-checks-fast-"), Array.from({ length: 24 }, (_, index) => ({ name: `Check ${index}`, argv: [process.execPath, "-e", "console.error('Failed right away'); process.exit(1)"] })), process.env, 60_000 * SLOW);
    for (const result of results) {
      expect(result.ok).toBe(false);
      expect(result.timedOut).toBeUndefined();
      expect(result.output).toContain("Failed right away");
    }
  });
});

originalDescribe("a check that misbehaves", () => {
it("stops the current check and never starts pending commands when the task is stopped", async () => {
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 300);
    const started = Date.now();
    const dir = root("petrina-checks-abort-");
    const results = await runChecks(dir, [{ name: "Slow", argv: [process.execPath, "-e", "await Bun.sleep(30000)"] }, { name: "Slower", argv: [process.execPath, "-e", "await Bun.sleep(40000)"] }], process.env, 60_000, stop.signal, join(dir, "logs"));
    expect(Date.now() - started).toBeLessThan(4000);
    expect(results.map((run) => [run.name, run.ok])).toEqual([["Slow", false]]);
    for (const run of results) {
      expect(existsSync(run.logPath!)).toBe(true);
      expect(run.logError).toBeUndefined();
      expect(isCheckExecutorFacts(run.executor)).toBe(true);
      expect(run.outputIdentity).toBeUndefined();
    }
  });
});

originalDescribe("a check that misbehaves", () => {
it("serializes commands that share a build directory", async () => {
    const dir = root("petrina-checks-shared-output-");
    const command = 'const fs = require("node:fs"); fs.writeFileSync("build.lock", "held", {flag:"wx"}); await Bun.sleep(40); fs.unlinkSync("build.lock");';
    const results = await runChecks(dir, [1, 2, 3].map((n) => ({ name: `Check ${n}`, argv: [process.execPath, "-e", command] })), process.env);
    expect(results.map((run) => [run.name, run.ok])).toEqual([["Check 1", true], ["Check 2", true], ["Check 3", true]]);
    expect(existsSync(join(dir, "build.lock"))).toBe(false);
  });
});
