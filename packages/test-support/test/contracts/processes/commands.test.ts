// The tests' own program runner: every outcome either a reported exit with complete output or an explicit
// failure, under the worker's own deadline. Stand-ins are passed straight to the runner; the system-wide
// process starter is never replaced.
import { afterEach, afterAll, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { childState, processList, waitForProcessesToEnd, type ProcessListRead } from "@petrina/platform/process-tree";
import { CLEANUP_MS, runCommand, type Started } from "@petrina/test-support/commands";
import { removeDir, tempDir, waitFor } from "../../../src/fixtures.js";
import { currentSlow, SLOW, MOST_SLOW } from "@petrina/test-support/slow";
import { failureOf } from "../../fixtures/command-failure.js";
import { watchStopped } from "../../fixtures/process-stop-watch.js";
import { defunctProcesses } from "../../../src/defunct-process.js";

const defuncts = defunctProcesses();
afterEach(() => defuncts.close());
afterAll(() => defuncts.close());
import { createProcessLease } from "@petrina/test-support/process-lease";

const root = tempDir("petrina-commands-");
afterAll(() => removeDir(root));
const bun = (script: string) => [process.execPath, "-e", script];
const unix = process.platform !== "win32";

/** A running process's state from the system's list; "unknown" where it cannot be read. */
const alive = async (pid: number) => (await childState(pid)) === "running";

/** How long one state read in a watch may take: the last read of a watch can end this long after the watch. */
const STATE_READ_MS = 3_000;

/** The fixture prints a complete PID line only after it is ready for cleanup. */
const cancelOnReady = (controller: AbortController) => (text: string, stream: "stdout" | "stderr"): undefined => {
  if (stream === "stdout" && text.includes("\n")) controller.abort();
};

/**
 * Wait for the end of a program an unconfirmed cleanup signalled. That cleanup returns once its signals are sent,
 * without watching them take effect, so what it stopped may still be listed for a moment, longer on a busy machine;
 * a confirmed one already saw everything end. The watch lasts `ms`, stretched by the busyness factor, and only a read
 * showing the program ended ends it: one that cannot be read is no evidence of its end. It is refused unless the
 * program, due to end by itself at `endsBy`, outlives the longest watch at the factor's ceiling, so its own end can
 * never pass for a stop.
 */
async function stopped(pid: number, endsBy: number, what: string, { ms = 5_000, factor = currentSlow, read }: { ms?: number; factor?: () => number; read?: ProcessListRead } = {}): Promise<void> {
  return watchStopped(what, { ms, endsBy, maximumSlow: MOST_SLOW, readAllowanceMs: STATE_READ_MS }, {
    now: () => Date.now(), slow: factor, sleep: ms => Bun.sleep(ms), state: () => childState(pid, STATE_READ_MS, read),
  });
}

/** The actual shell topology is supplied explicitly; its child has an independent, non-expiring owner. */
async function ownedShell(name: string, body: string) {
  const owner = await createProcessLease({ guardian: "node" });
  try {
    const actor = join(root, `${name}.ts`);
    const record = join(root, `${name}.pid`);
    writeFileSync(actor, owner.program(`const { writeFileSync, renameSync } = require("node:fs");
writeFileSync(${JSON.stringify(`${record}.tmp`)}, String(process.pid)); renameSync(${JSON.stringify(`${record}.tmp`)}, ${JSON.stringify(record)});
await new Promise(() => {});`));
    return { owner, record, argv: ["sh", "-c", body, "owned-shell", process.execPath, actor] };
  } catch (error) { await owner.close(); throw error; }
}

const outputHolder = (name: string) => ownedShell(name, '"$1" "$2" & echo $!; exit 0');

/** Settle the subject even when readiness fails, then confirm every published actor has physically ended. */
async function closeCommandActors(owner: Awaited<ReturnType<typeof createProcessLease>>, command: Promise<unknown>,
  program: Started | undefined, records: readonly string[]): Promise<void> {
  try { await owner.close(); }
  finally {
    // Shell parents cannot run the lease protocol. Their actual handle remains independently owned
    // even if the subject's cleanup failed while leaving that shell paused.
    if (program?.exitCode === null && program.signalCode === null) program.kill("SIGKILL");
    await command.catch(() => undefined);
    await program?.exited;
    const pids = new Set<number>(program?.pid ? [program.pid] : []);
    for (const record of records) if (existsSync(record)) {
      for (const text of readFileSync(record, "utf8").trim().split(/\s+/)) {
        const pid = Number(text);
        if (Number.isSafeInteger(pid) && pid > 0) pids.add(pid);
      }
    }
    if (pids.size) expect((await waitForProcessesToEnd([...pids], 5_000 * SLOW)).ended).toBe(true);
  }
}

/** Whether a read is a complete list: one always shows this process. */
const listsThis = (list: string | undefined) => list?.split("\n").some((line) => Number(line.trim().split(/\s+/)[0]) === process.pid) ?? false;

/**
 * A started program without the runtime's record of its exit, as a stand-in gives it: cleanup cannot pause its group
 * before looking, so it still runs while cleanup looks.
 */
const withoutRecord = (program: Started): Started => ({
  pid: program.pid, stdout: program.stdout, stderr: program.stderr, exited: program.exited,
  get signalCode() { return program.signalCode; },
  kill: (signal) => program.kill(signal),
});

function wrapSpawned(child: Bun.Subprocess): Started {
  return {
    pid: child.pid,
    ...(typeof child.stdout === "object" && child.stdout ? { stdout: child.stdout } : {}),
    ...(typeof child.stderr === "object" && child.stderr ? { stderr: child.stderr } : {}),
    exited: child.exited,
    get exitCode() {
      return child.exitCode;
    },
    get signalCode() {
      return child.signalCode;
    },
    kill: (signal) => child.kill(signal),
  };
}

const spawnStarted = (
  argv: string[],
  options: Parameters<NonNullable<NonNullable<Parameters<typeof runCommand>[1]>["start"]>>[1],
): Started => wrapSpawned(Bun.spawn(argv, { ...options, stdout: "pipe", stderr: "pipe" }));

/** The list with one process's state replaced. */
const withState = (list: string, pid: number, state: string) => list.split("\n").map((line) => {
  const [id, ppid, pgid] = line.trim().split(/\s+/);
  return Number(id) === pid ? `${id} ${ppid} ${pgid} ${state}` : line;
}).join("\n");

describe("a command that ends normally", () => {
  it("keeps output streams apart and exactly as written, and passes input larger than a pipe holds", async () => {
    const input = `${"x".repeat(200_000)}\nlast line\n`;
    const result = await runCommand(bun("const text = await Bun.stdin.text(); process.stdout.write(text); process.stderr.write(`read ${text.length}\\n`);"), { input, cwd: root });
    expect(result.code).toBe(0);
    expect(result.signal).toBeUndefined();
    expect(result.stdout).toBe(input);
    expect(result.stderr).toBe(`read ${input.length}\n`);
  });

  it("writes output larger than a pipe holds while reading it, without a deadlock", async () => {
    const result = await runCommand(bun("process.stdout.write('y'.repeat(1_000_000)); process.stderr.write('z'.repeat(300_000));"));
    expect([result.code, result.stdout.length, result.stderr.length]).toEqual([0, 1_000_000, 300_000]);
  });

  it("reports a non-zero exit with its output instead of failing the run", async () => {
    const result = await runCommand(bun("console.log('partial'); console.error('complaint'); process.exit(3);"));
    expect(result).toEqual({ code: 3, stdout: "partial\n", stderr: "complaint\n" });
  });

  it.skipIf(!unix)("reports a program that a signal ended", async () => {
    const result = await runCommand(["sh", "-c", "echo before; kill -TERM $$"]);
    expect(result).toEqual({ code: 143, signal: "SIGTERM", stdout: "before\n", stderr: "" });
  });

  it.skipIf(!unix)("waits for the exit of a program that closed its output and keeps working", async () => {
    const marker = join(root, "closed-output-finished");
    const started = Date.now();
    const result = await runCommand(["sh", "-c", `exec >&- 2>&-; sleep 0.6; : > '${marker}'; exit 4`]);
    expect(result).toEqual({ code: 4, stdout: "", stderr: "" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
    expect(existsSync(marker)).toBe(true);
  });

  it("lets another timer in the worker run while a command waits", async () => {
    const release = join(root, "release-waiting-command");
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      if (ticks === 3) writeFileSync(release, "");
    }, 20);
    try {
      const result = await runCommand(bun(`const { existsSync } = require("node:fs"); while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(10); console.log("released");`));
      expect(result.stdout).toBe("released\n");
      expect(ticks).toBeGreaterThanOrEqual(3);
    } finally { clearInterval(timer); }
  });
});

describe("a command that does not end normally", () => {
  it("fails at once, naming the program and folder, when it cannot start", async () => {
    const failure = await failureOf(runCommand(["petrina-no-such-program"], { cwd: root }));
    expect(failure.reason).toBe("start");
    expect(failure.message).toContain("petrina-no-such-program could not start in");
    expect(failure.message).toContain(root);
    expect(failure.execution).toBeUndefined();
  });

  it("fails without starting when it is already cancelled", async () => {
    const stop = new AbortController();
    stop.abort();
    const marker = join(root, "never-started");
    const failure = await failureOf(runCommand(bun(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "")`), { signal: stop.signal }));
    expect(failure.reason).toBe("cancelled");
    expect(existsSync(marker)).toBe(false);
    expect(failure.execution).toBeUndefined();
  });

  it("observes cancellation inside the starter before accepting an already completed program", async () => {
    const stop = new AbortController();
    const error = await failureOf(runCommand(["fixture-program"], {
      signal: stop.signal,
      start: () => {
        stop.abort();
        // No native process: the controlled starter finished before returning its handle.
        return {
          stdout: new ReadableStream({ start(controller) { controller.close(); } }),
          stderr: new ReadableStream({ start(controller) { controller.close(); } }),
          exited: Promise.resolve(0), exitCode: 0, signalCode: null, kill() {},
        };
      },
    }));
    expect(error.reason).toBe("cancelled");
    expect(error.message).toContain("was cancelled");
    expect(error.execution?.pid).toBeUndefined();
    expect(Number.isFinite(error.execution?.startedObservedAt)).toBe(true);
    expect(error.execution?.atFailure).toMatchObject({ exitPromiseReported: false, untracked: false, nativeExitCode: 0, nativeSignalCode: null, stdoutEOF: false, stderrEOF: false });
    expect(error.execution?.atFailure.exitPromiseCode).toBeUndefined();
    expect(error.execution?.afterCleanup).toMatchObject({ exitPromiseReported: true, exitPromiseCode: 0, untracked: false, nativeExitCode: 0, stdoutEOF: true, stderrEOF: true });
  });

  it.skipIf(!unix)("stops at its deadline with the output so far, and stops what it started", async () => {
    const fixture = await ownedShell("deadline-child", '"$1" "$2" & echo $!; echo working >&2; wait');
    let program: Started | undefined;
    const started = Date.now();
    const command = runCommand(fixture.argv, { timeoutMs: 300,
      start: (argv, options) => (program = spawnStarted(argv, options)),
    });
    try {
    const failure = await failureOf(command);
    expect(Date.now() - started).toBeLessThan(300 + CLEANUP_MS * SLOW + 1_000);
    expect(failure.reason).toBe("timeout");
    expect(failure.message).toContain("did not finish within 0.3 seconds");
    expect(failure.execution?.pid).toBe(program!.pid);
    expect(failure.execution?.atFailure.exitPromiseReported).toBe(false);
    expect(failure.message).toContain("Its exit was never reported.");
    expect(failure.stderr).toBe("working\n");
    const background = Number(failure.stdout.trim());
    expect(background).toBeGreaterThan(0);
    expect(failure.cleanup).toBe("confirmed");
    expect(failure.message).toContain("Everything found that it started has stopped.");
    expect(await childState(background)).toBe("ended");
    } finally { await closeCommandActors(fixture.owner, command, program, [fixture.record, `${fixture.record}.tmp`]); }
  });

  it.skipIf(!unix)("stops when cancelled while it runs, and stops what it started", async () => {
    const fixture = await ownedShell("cancelled-child", '"$1" "$2" & echo $!; wait');
    const stop = new AbortController();
    let program: Started | undefined;
    const command = runCommand(fixture.argv, { signal: stop.signal, timeoutMs: 60_000,
      start: (argv, options) => (program = spawnStarted(argv, options)),
    });
    const timer = setTimeout(() => stop.abort(), 200);
    try {
    const failure = await failureOf(command);
    expect(failure.reason).toBe("cancelled");
    expect(failure.cleanup).toBe("confirmed");
    expect(await childState(Number(failure.stdout.trim()))).toBe("ended");
    } finally {
      clearTimeout(timer); stop.abort();
      await closeCommandActors(fixture.owner, command, program, [fixture.record, `${fixture.record}.tmp`]);
    }
  });

  it.skipIf(!unix)("does not succeed when it exited but a program it started keeps its output open", async () => {
    const fixture = await outputHolder("exited-output-holder");
    let background = 0, output = "";
    let program: Started | undefined;
    const command = runCommand(fixture.argv, { timeoutMs: 500,
      onOutput(text, stream) { if (stream === "stdout") background = Number((output += text).trim()); },
      start: (argv, options) => (program = spawnStarted(argv, options)),
    });
    try {
      const failure = await failureOf(command);
      background = Number(failure.stdout.trim());
      expect(failure.reason).toBe("timeout");
      expect(failure.code).toBe(0);
      expect(failure.message).toContain("It exited with 0, but its output and error output stayed open.");
      expect(failure.execution?.pid).toBe(program!.pid);
      expect(failure.execution?.atFailure).toMatchObject({ exitPromiseReported: true, exitPromiseCode: 0, stdoutEOF: false, stderrEOF: false });
      // Its parent has exited, so only the command's own process group still finds it, and stops it. The parent was
      // never seen running, so whatever else it may have started stays unconfirmed.
      expect(failure.cleanup).toBe("unconfirmed");
      await stopped(background, Infinity, "the program holding the output to stop");
    } finally {
      await closeCommandActors(fixture.owner, command, program, [fixture.record, `${fixture.record}.tmp`]);
    }
  });

  // Actual sent/withheld signals remain native; the watch's timeout and load decisions have controlled-clock cases.
  for (const stopping of [true, false]) {
    it.skipIf(!unix)(`${stopping ? "sees the end" : "observes the still-running program"} after an unconfirmed stop, its stop signals ${stopping ? "sent" : "withheld"}`, async () => {
      const fixture = await outputHolder(`unconfirmed-output-holder-${stopping}`);
      const send = process.kill.bind(process);
      const signals = spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => stopping || (signal !== "SIGKILL" && signal !== "SIGSTOP") ? send(pid, signal) : true) as typeof process.kill);
      let background = 0, output = "";
      let program: Started | undefined;
      const command = runCommand(fixture.argv, { timeoutMs: 500,
        onOutput(text, stream) { if (stream === "stdout") background = Number((output += text).trim()); },
        start: (argv, options) => (program = spawnStarted(argv, options)),
      });
      try {
        const failure = await failureOf(command);
        background = Number(failure.stdout.trim());
        expect(background).toBeGreaterThan(0);
        expect(failure.cleanup).toBe("unconfirmed");
        if (stopping) await stopped(background, Infinity, "the program holding the output to stop", { factor: () => MOST_SLOW });
        else expect(await alive(background)).toBe(true);
      } finally {
        signals.mockRestore();
        await closeCommandActors(fixture.owner, command, program, [fixture.record, `${fixture.record}.tmp`]);
      }
    });
  }

  it("does not succeed when its output closed but its exit is never reported", async () => {
    const failure = await failureOf(runCommand(["petrina-stand-in"], {
      timeoutMs: 300,
      // EOF is already available; starting a real program would not establish that it arrives before the deadline.
      start: () => ({ stdout: new Response("finished\n").body!, stderr: new Response("").body!, signalCode: null, exited: new Promise<number>(() => {}), kill() {} }),
    }));
    expect(failure.reason).toBe("timeout");
    expect(failure.message).toContain("Its output closed, but its exit was never reported.");
    expect(failure.stdout).toBe("finished\n");
    expect(failure.execution?.atFailure).toMatchObject({ exitPromiseReported: false, untracked: false, nativeSignalCode: null, stdoutEOF: true, stderrEOF: true });
    expect(failure.execution?.atFailure.exitPromiseCode).toBeUndefined();
    expect(failure.execution?.atFailure.nativeExitCode).toBeUndefined();
    expect(failure.execution?.afterCleanup).toMatchObject({ exitPromiseReported: false, stdoutEOF: true, stderrEOF: true });
  });

  it("keeps the failure's original state when output arrives during cleanup", async () => {
    const stop = new AbortController();
    let output!: ReadableStreamDefaultController<Uint8Array>;
    let errorOutput!: ReadableStreamDefaultController<Uint8Array>;
    const command = runCommand(["petrina-stand-in"], {
      timeoutMs: 300,
      signal: stop.signal,
      start: () => ({
        stdout: new ReadableStream({ start(controller) { output = controller; } }),
        stderr: new ReadableStream({ start(controller) { errorOutput = controller; } }),
        signalCode: null, exited: new Promise<number>(() => {}), kill() {},
      }),
    });
    // Cancelling captures the failure before cleanup; output may still finish while cleanup settles.
    stop.abort();
    output.enqueue(new TextEncoder().encode("late output\n"));
    output.close();
    errorOutput.close();
    const failure = await failureOf(command);
    expect(failure.reason).toBe("cancelled");
    expect(failure.message).toContain("Its exit was never reported.");
    expect(failure.message).not.toContain("Its output closed, but its exit was never reported.");
    expect(failure.stdout).toBe("late output\n");
    expect(failure.stderr).toBe("");
    expect(failure.cleanup).toBe("unconfirmed");
    expect(failure.execution?.atFailure).toMatchObject({ exitPromiseReported: false, stdoutEOF: false, stderrEOF: false });
    expect(failure.execution?.afterCleanup).toMatchObject({ exitPromiseReported: false, stdoutEOF: true, stderrEOF: true });
    expect(Number.isFinite(failure.execution?.atFailure.observedAt)).toBe(true);
    expect(Number.isFinite(failure.execution?.afterCleanup.observedAt)).toBe(true);
  });

  it("does not succeed when neither its exit nor the end of its output is ever reported", async () => {
    let cancelled = 0;
    const open = () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("partial\n")); }, cancel() { cancelled += 1; } });
    const failure = await failureOf(runCommand(["petrina-stand-in"], {
      timeoutMs: 200,
      start: () => ({ stdout: open(), stderr: open(), signalCode: null, exited: new Promise<number>(() => {}), kill() {} }),
    }));
    expect(failure.reason).toBe("timeout");
    expect(failure.message).toContain("Its exit was never reported.");
    expect(failure.stdout).toBe("partial\n");
    // A stand-in without a process number can never be confirmed stopped.
    expect(failure.cleanup).toBe("unconfirmed");
    expect(failure.message).toContain("Some of what it started may still be running.");
    expect(cancelled).toBe(2);
    // Cancelling the readers after cleanup must not manufacture EOF evidence.
    expect(failure.execution?.atFailure).toMatchObject({ exitPromiseReported: false, stdoutEOF: false, stderrEOF: false });
    expect(failure.execution?.afterCleanup).toMatchObject({ exitPromiseReported: false, stdoutEOF: false, stderrEOF: false });
  });

  it.skipIf(!unix)("never confirms a defunct program whose exit was lost, signalling only its own handle", async () => defuncts.use(async defunct => {
    const signals: string[] = [];
    let sent: ReturnType<typeof spyOn<typeof process, "kill">> | undefined;
    try {
      await waitFor(async () => (await childState(defunct.pid)) === "ended", "the stand-in to be defunct", 10_000);
      // Watch, without replacing, every signal sent by number: none may reach a process the command does not own.
      sent = spyOn(process, "kill");
      const failure = await failureOf(runCommand(["petrina-stand-in"], {
        timeoutMs: 200,
        start: () => ({ pid: defunct.pid, stdout: new Response("finished\n").body!, stderr: new Response("").body!, signalCode: null, exited: new Promise<number>(() => {}), kill: (signal) => { signals.push(signal ?? "SIGTERM"); } }),
      }));
      expect(failure.message).toContain("Its output closed, but its exit was never reported.");
      expect(failure.execution?.pid).toBe(defunct.pid);
      expect(failure.execution?.atFailure).toMatchObject({ exitPromiseReported: false, stdoutEOF: true, stderrEOF: true });
      // It ended before cleanup could see what it started.
      expect(failure.cleanup).toBe("unconfirmed");
      expect(signals).toEqual(["SIGKILL"]);
      expect(sent.mock.calls.filter(([target, signal]) => Math.abs(Number(target)) === defunct.pid && signal !== 0)).toEqual([]);
    } finally { sent?.mockRestore(); await defunct.release(); }
  }));

  // Windows confirms cleanup through taskkill, not a process list. Unconfirmed is not unattempted: the program itself
  // is still stopped. Keep both actual sent and withheld handle/numbered signals; the watch's deadline is controlled
  // separately, while these cases assert the real running/ended state before independent cleanup.
  for (const stopping of [true, false]) {
    it.skipIf(!unix)(`leaves cleanup unconfirmed when the process list cannot be read, and ${stopping ? "sees the program's end" : "observes the still-running program"}, its stop ${stopping ? "sent" : "withheld"}`, async () => {
      const owner = await createProcessLease({ guardian: "node" });
      let program: Started | undefined;
      const stop = new AbortController();
      const send = process.kill.bind(process);
      const signals = spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => stopping || Math.abs(pid) !== program?.pid || (signal !== "SIGKILL" && signal !== "SIGSTOP") ? send(pid, signal) : true) as typeof process.kill);
      try {
        const failure = await failureOf(runCommand(bun(owner.program("console.log(process.pid); await new Promise(() => {});")), {
          timeoutMs: 1_000 * SLOW,
          signal: stop.signal,
          onOutput: cancelOnReady(stop),
          processList: async () => undefined,
          // The runtime's own program, its record of the exit kept, so cleanup pauses its group first as usual.
          start: (argv, options) => {
            const real = (program = spawnStarted(argv, options));
            return {
              pid: real.pid, stdout: real.stdout, stderr: real.stderr, exited: real.exited,
              get exitCode() { return real.exitCode; }, get signalCode() { return real.signalCode; },
              kill: (signal) => { if (stopping) real.kill(signal); },
            };
          },
        }));
        expect(failure.reason).toBe("cancelled");
        expect(failure.cleanup).toBe("unconfirmed");
        const pid = Number(failure.stdout.trim());
        expect(pid).toBe(program!.pid!);
        if (stopping) await stopped(pid, Infinity, "the unconfirmed program to stop", { factor: () => MOST_SLOW });
        else expect(await alive(pid)).toBe(true);
      } finally {
        signals.mockRestore();
        await closeCommandActors(owner, program?.exited ?? Promise.resolve(), program, []);
      }
    });
  }

  // The group paused before the first look is stopped whatever that look answers, so nothing is left paused.
  for (const answer of ["fails", "shows only this worker"] as const) {
    it.skipIf(!unix)(`stops the group it paused first when the first look ${answer}`, async () => {
      const fixture = await ownedShell(`first-look-${answer === "fails" ? "fails" : "worker"}`, '"$1" "$2" & echo $!; wait');
      const stop = new AbortController();
      let program: Started | undefined;
      const command = runCommand(fixture.argv, {
        timeoutMs: 1_000 * SLOW,
        signal: stop.signal,
        onOutput: cancelOnReady(stop),
        processList: answer === "fails" ? async () => { throw new Error("the list broke"); } : async () => `${process.pid} 1 ${process.pid} S`,
        start: (argv, options) => (program = spawnStarted(argv, options)),
      });
      try {
        const failure = await failureOf(command);
        const background = Number(failure.stdout.trim());
        expect(failure.reason).toBe("cancelled");
        expect(background).toBeGreaterThan(0);
        expect(failure.cleanup).toBe("unconfirmed");
        await waitFor(async () => (await childState(background)) === "ended", "the paused group to be stopped", 5_000);
      } finally {
        stop.abort();
        await closeCommandActors(fixture.owner, command, program, [fixture.record, `${fixture.record}.tmp`]);
      }
    });
  }

  // Without the runtime's record the command still runs while cleanup looks, and can exit meanwhile. On Linux a pause
  // takes effect only once the paused program runs again, so a busy machine can still list it as running; one paused
  // that way is still the command's, and still stopped.
  for (const pending of [false, true]) {
    it.skipIf(!unix)(`stops what it started in a session of its own even when its exit is reported during the first look${pending ? ", its pause listed as not yet taken effect" : ""}`, async () => {
      const dir = join(root, `exit-during-look-${pending}`);
      mkdirSync(dir);
      const record = join(dir, "background"), release = join(dir, "release");
      const owner = await createProcessLease({ guardian: "node" });
      const actor = owner.program("await new Promise(() => {});");
      // The command starts a program outside its own process group, then waits to be released.
      const script = owner.program(`const { existsSync, renameSync, writeFileSync } = require("node:fs");
const background = Bun.spawn([process.execPath, "-e", ${JSON.stringify(actor)}], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
background.unref();
writeFileSync(${JSON.stringify(`${record}.tmp`)}, String(background.pid)); renameSync(${JSON.stringify(`${record}.tmp`)}, ${JSON.stringify(record)});
while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(10);`);
      let program: Started | undefined;
      let looks = 0;
      let background = 0;
      const stop = new AbortController();
      const command = runCommand(bun(script), {
        signal: stop.signal,
        timeoutMs: 60_000 * SLOW,
        start: (argv, options) => withoutRecord((program = spawnStarted(argv, options))),
        // The first look is a real list taken while the command runs; it ends, and its exit is reported, before the answer.
        processList: async (timeout) => {
          const list = await processList(["-A", "-o", "pid=,ppid=,pgid=,stat="], timeout);
          if (!listsThis(list)) return list;
          const look = looks++;
          if (look === 0) { writeFileSync(release, ""); await program!.exited; }
          return look === 1 && pending ? withState(list!, background, "R") : list;
        },
      });
      void command.catch(() => undefined);
      try {
        await waitFor(() => existsSync(record), "the background program to start", undefined, { during: command });
        background = Number(readFileSync(record, "utf8"));
        expect(background).toBeGreaterThan(0);
        stop.abort();
        const failure = await failureOf(command);
        expect(failure.reason).toBe("cancelled");
        // The exit arrived while cleanup was looking: what that look found is still stopped, but the program was never
        // seen paused, so it may have started more meanwhile.
        expect(failure.code).toBe(0);
        expect(failure.cleanup).toBe("unconfirmed");
        await stopped(background, Infinity, "the program in a session of its own to stop");
      } finally {
        stop.abort();
        await closeCommandActors(owner, command, program, [record, `${record}.tmp`]);
      }
    });
  }

  it.skipIf(!unix)("sends no signal between a failed look and the next, and still confirms what it stopped", async () => {
    const fixture = await ownedShell("failed-look-child", '"$1" "$2" & echo $!; wait');
    // Signals sent by number before each read starts; the read after the first complete list fails.
    const counts: number[] = [];
    let lists = 0, failed = -1, background = 0;
    let sent: ReturnType<typeof spyOn<typeof process, "kill">> | undefined;
    let program: Started | undefined, command: ReturnType<typeof runCommand> | undefined;
    const stop = new AbortController();
    try {
      sent = spyOn(process, "kill");
      command = runCommand(fixture.argv, {
        signal: stop.signal,
        timeoutMs: 60_000 * SLOW,
        start: (argv, options) => (program = spawnStarted(argv, options)),
        processList: async (timeout) => {
          counts.push(sent!.mock.calls.filter(([, signal]) => signal !== 0).length);
          if (lists === 1 && failed < 0) { failed = counts.length - 1; return undefined; }
          const list = await processList(["-A", "-o", "pid=,ppid=,pgid=,stat="], timeout);
          if (listsThis(list)) lists += 1;
          return list;
        },
      });
      void command.catch(() => undefined);
      await Bun.sleep(200);
      stop.abort();
      const failure = await failureOf(command);
      background = Number(failure.stdout.trim());
      expect(failure.cleanup).toBe("confirmed");
      expect(await childState(background)).toBe("ended");
      // Paused after the first look; nothing more until a later look shows something new.
      expect(failed).toBeGreaterThan(0);
      expect(counts.length).toBeGreaterThan(failed + 1);
      expect(counts[failed]!).toBeGreaterThan(counts[failed - 1]!);
      expect(counts[failed + 1]).toBe(counts[failed]!);
    } finally {
      sent?.mockRestore();
      stop.abort();
      if (command) await closeCommandActors(fixture.owner, command, program, [fixture.record, `${fixture.record}.tmp`]);
      else await fixture.owner.close();
    }
  });

  it.skipIf(!unix)("never signals a program of this worker that may hold the number after the command's exit was reported", async () => {
    // Another program this worker started, leading its own group, named as the command's program after its exit was
    // reported: the command's number was free from then on, so being this worker's child proves nothing.
    const owner = await createProcessLease({ guardian: "node" });
    let program: Started | undefined;
    let sent: ReturnType<typeof spyOn<typeof process, "kill">> | undefined;
    try {
      const other = Bun.spawn(bun(owner.program("await new Promise(() => {});")), { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      program = wrapSpawned(other);
      const signals: string[] = [];
      sent = spyOn(process, "kill");
      const failure = await failureOf(runCommand(["petrina-stand-in"], {
        timeoutMs: 200,
        start: () => ({ pid: other.pid, stdout: new ReadableStream<Uint8Array>(), stderr: new Response("").body!, signalCode: null, exited: Promise.resolve(0), kill: (signal) => { signals.push(signal ?? "SIGTERM"); } }),
      }));
      const numbered = sent.mock.calls.filter(([target, signal]) => Math.abs(Number(target)) === other.pid && signal !== 0);
      sent.mockRestore();
      sent = undefined;
      expect(failure.reason).toBe("timeout");
      expect(failure.cleanup).toBe("unconfirmed");
      expect(signals).toEqual([]);
      expect(numbered).toEqual([]);
      expect(await alive(other.pid)).toBe(true);
    } finally {
      sent?.mockRestore();
      await closeCommandActors(owner, program?.exited ?? Promise.resolve(), program, []);
    }
  });

  it.skipIf(!unix)("signals nothing listed under a program number this worker did not start", async () => {
    // Someone else's program, with a child of its own, named as the command's program after its exit was reported.
    const owner = await createProcessLease({ guardian: "node" });
    const innerRecord = join(root, "foreign-inner"), childRecord = join(root, "foreign-child");
    const child = owner.program("await new Promise(() => {});");
    const inner = owner.program(`const { writeFileSync, renameSync } = require("node:fs");
const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(child)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
writeFileSync(${JSON.stringify(`${childRecord}.tmp`)}, String(child.pid)); renameSync(${JSON.stringify(`${childRecord}.tmp`)}, ${JSON.stringify(childRecord)});
console.log("sleep " + child.pid); await child.exited;`);
    const holding = owner.program(`const { writeFileSync, renameSync } = require("node:fs");
const inner = Bun.spawn([process.execPath, "-e", ${JSON.stringify(inner)}], { stdin: "ignore", stdout: "inherit", stderr: "ignore" });
writeFileSync(${JSON.stringify(`${innerRecord}.tmp`)}, String(inner.pid)); renameSync(${JSON.stringify(`${innerRecord}.tmp`)}, ${JSON.stringify(innerRecord)});
console.log("inner " + inner.pid); await inner.exited;`);
    let program: Started | undefined;
    const pids: Record<string, number> = {};
    try {
      const holder = Bun.spawn(bun(holding), { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
      program = wrapSpawned(holder);
      const reader = holder.stdout.getReader();
      for (let text = ""; !(pids.sleep && pids.inner);) {
        const next = await reader.read();
        if (next.done) break;
        text += new TextDecoder().decode(next.value);
        for (const [, label, pid] of text.matchAll(/(sleep|inner) (\d+)/g)) pids[label!] = Number(pid);
      }
      reader.releaseLock();
      const signals: string[] = [];
      const failure = await failureOf(runCommand(["petrina-stand-in"], {
        timeoutMs: 200,
        start: () => ({ pid: pids.inner, stdout: new ReadableStream<Uint8Array>(), stderr: new Response("").body!, signalCode: null, exited: Promise.resolve(0), kill: (signal) => { signals.push(signal ?? "SIGTERM"); } }),
      }));
      expect(failure.reason).toBe("timeout");
      // Output still held open, and nothing of its own left to stop: that is never confirmed.
      expect(failure.cleanup).toBe("unconfirmed");
      expect(signals).toEqual([]);
      expect([await alive(pids.inner!), await alive(pids.sleep!)]).toEqual([true, true]);
    } finally {
      await closeCommandActors(owner, program?.exited ?? Promise.resolve(), program,
        [innerRecord, `${innerRecord}.tmp`, childRecord, `${childRecord}.tmp`]);
    }
  });

  // While cleanup's first look is held, the command or its own child is released to start a short launcher, which
  // starts a program in a session of its own and exits, leaving that program under the system where no look can find
  // it. With the runtime's record the group was paused before the look, so nothing starts; without it, the command
  // ran while cleanup looked, and cleanup never says everything stopped.
  for (const starter of ["command", "child"] as const) for (const record of [true, false]) {
    it.skipIf(!unix)(`${record ? "lets nothing start" : "never confirms a program started"} while cleanup looks, by the ${starter === "command" ? "command" : "command's child"}${record ? "" : ", without the runtime's record"}`, async () => {
      const dir = join(root, `started-while-looking-${starter}-${record}`);
      mkdirSync(dir);
      const ready = join(dir, "ready"), release = join(dir, "release"), launched = join(dir, "launched");
      const child = join(dir, "child"), launching = join(dir, "launcher");
      const owner = await createProcessLease({ guardian: "node" });
      const workerProgram = owner.program("await new Promise(() => {});");
      const launcher = owner.program(`const worker = Bun.spawn([process.execPath, "-e", ${JSON.stringify(workerProgram)}], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
worker.unref();
const { renameSync, writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(`${launched}.tmp`)}, worker.pid + " " + process.pid); renameSync(${JSON.stringify(`${launched}.tmp`)}, ${JSON.stringify(launched)});`);
      const starts = owner.program(`const { existsSync, renameSync, writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(`${ready}.tmp`)}, String(process.pid)); renameSync(${JSON.stringify(`${ready}.tmp`)}, ${JSON.stringify(ready)});
while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(10);
const launcher = Bun.spawn([process.execPath, "-e", ${JSON.stringify(launcher)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
writeFileSync(${JSON.stringify(`${launching}.tmp`)}, String(launcher.pid)); renameSync(${JSON.stringify(`${launching}.tmp`)}, ${JSON.stringify(launching)});
await launcher.exited;
await new Promise(() => {});`);
      const script = starter === "command" ? starts : owner.program(`const { renameSync, writeFileSync } = require("node:fs");
const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(starts)}], { stdin: "ignore", stdout: "ignore", stderr: "inherit" });
writeFileSync(${JSON.stringify(`${child}.tmp`)}, String(child.pid)); renameSync(${JSON.stringify(`${child}.tmp`)}, ${JSON.stringify(child)});
await new Promise(() => {});`);
      const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };
      let looks = 0, worker = 0;
      let program: Started | undefined;
      const stop = new AbortController();
      const command = runCommand(bun(script), {
        signal: stop.signal,
        timeoutMs: 60_000 * SLOW,
        start: (argv, options) => {
          program = spawnStarted(argv, options);
          return record ? program : withoutRecord(program);
        },
        // The first look is real; before it is answered, the starter is released, and the look waits for the launcher
        // to have gone, within the first look's share of cleanup's allowance. A paused starter never starts it, so
        // that wait is short.
        processList: async (timeout) => {
          const list = await processList(["-A", "-o", "pid=,ppid=,pgid=,stat="], timeout);
          if (!listsThis(list) || looks++ > 0) return list;
          writeFileSync(release, "");
          const until = Date.now() + (record ? 500 : CLEANUP_MS * SLOW * 0.4);
          while (Date.now() < until && !(existsSync(launched) && gone(Number(readFileSync(launched, "utf8").split(" ")[1])))) await Bun.sleep(20);
          return list;
        },
      });
      // Observe failure even if readiness throws before this case reaches failureOf(command).
      void command.catch(() => undefined);
      try {
        await waitFor(() => existsSync(ready), "the starter to wait for its release", undefined, { during: command });
        stop.abort();
        const failure = await failureOf(command);
        if (existsSync(launched)) worker = Number(readFileSync(launched, "utf8").split(" ")[0]);
        expect(failure.reason).toBe("cancelled");
        if (record) {
          expect(existsSync(launched)).toBe(false);
          expect(failure.cleanup).toBe("confirmed");
        } else {
          expect(worker).toBeGreaterThan(0);
          expect(failure.cleanup).toBe("unconfirmed");
          expect(failure.message).toContain("Some of what it started may still be running.");
        }
      } finally {
        stop.abort();
        await closeCommandActors(owner, command, program,
          [ready, `${ready}.tmp`, child, `${child}.tmp`, launching, `${launching}.tmp`, launched, `${launched}.tmp`]);
      }
    });
  }

  it.skipIf(!unix)("stops a program in a session of its own but never confirms it: it ran while cleanup looked", async () => {
    const dir = join(root, "own-session");
    mkdirSync(dir);
    const record = join(dir, "background");
    const owner = await createProcessLease({ guardian: "node" });
    const actor = owner.program("await new Promise(() => {});");
    const stop = new AbortController();
    let program: Started | undefined;
    const command = runCommand(bun(owner.program(`const { renameSync, writeFileSync } = require("node:fs");
const background = Bun.spawn([process.execPath, "-e", ${JSON.stringify(actor)}], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
background.unref();
writeFileSync(${JSON.stringify(`${record}.tmp`)}, String(background.pid)); renameSync(${JSON.stringify(`${record}.tmp`)}, ${JSON.stringify(record)});
await new Promise(() => {});`)), { signal: stop.signal, timeoutMs: 60_000 * SLOW,
      start: (argv, options) => (program = spawnStarted(argv, options)),
    });
    void command.catch(() => undefined);
    let background = 0;
    try {
      await waitFor(() => existsSync(record), "the background program to start", undefined, { during: command });
      background = Number(readFileSync(record, "utf8"));
      stop.abort();
      const failure = await failureOf(command);
      expect(failure.cleanup).toBe("unconfirmed");
      await stopped(background, Infinity, "the program in a session of its own to stop");
    } finally {
      stop.abort();
      await closeCommandActors(owner, command, program, [record, `${record}.tmp`]);
    }
  });

  // A program started where no look can see it, by a parent already gone when cleanup first looks. Nothing can show
  // it ended, so cleanup never says everything stopped.
  for (const holds of [false, true]) {
    const output = holds ? `stdout: "inherit", stderr: "inherit"` : `stdout: "ignore", stderr: "ignore"`;
    const background = (dir: string, actor: string) => `const { renameSync, writeFileSync } = require("node:fs");
const background = Bun.spawn([process.execPath, "-e", ${JSON.stringify(actor)}], { detached: true, stdin: "ignore", ${output} });
background.unref();
writeFileSync(${JSON.stringify(join(dir, "background.tmp"))}, String(background.pid)); renameSync(${JSON.stringify(join(dir, "background.tmp"))}, ${JSON.stringify(join(dir, "background"))});`;

    it.skipIf(!unix)(`never confirms a program ${holds ? "holding its output " : ""}started by a parent whose exit was never reported`, async () => {
      const dir = join(root, `lost-parent-${holds}`);
      mkdirSync(dir);
      const owner = await createProcessLease({ guardian: "node" });
      const actor = owner.program("await new Promise(() => {});");
      let real: ReturnType<typeof Bun.spawn> | undefined;
      const stop = new AbortController();
      const command = runCommand(bun(owner.program(background(dir, actor))), {
        signal: stop.signal,
        timeoutMs: 60_000 * SLOW,
        // The runtime collects the command, but its exit report never reaches the runner.
        start: (argv, options) => {
          real = Bun.spawn(argv, { ...options, stdout: "pipe", stderr: "pipe" });
          return { pid: real.pid, stdout: real.stdout as ReadableStream<Uint8Array>, stderr: real.stderr as ReadableStream<Uint8Array>, signalCode: null, exited: new Promise<number>(() => {}), kill: (signal) => real!.kill(signal) };
        },
      });
      void command.catch(() => undefined);
      try {
        await waitFor(() => existsSync(join(dir, "background")), "the background program to start", undefined, { during: command });
        await real!.exited;
        stop.abort();
        const failure = await failureOf(command);
        expect(failure.reason).toBe("cancelled");
        expect(failure.message).toContain(holds ? "Its exit was never reported." : "Its output closed, but its exit was never reported.");
        expect(failure.cleanup).toBe("unconfirmed");
      } finally {
        stop.abort();
        await closeCommandActors(owner, command, real ? wrapSpawned(real) : undefined,
          [join(dir, "background"), join(dir, "background.tmp")]);
      }
    });
  }

  // Someone else's program leading its own group, named as the command's program. Whether its exit was reported
  // or withheld, and whether a list shows its real parent or none can be read, nothing establishes it is the
  // command's: no signal goes to it or its group by number. A withheld exit leaves only the runtime's own handle.
  for (const [exit, list] of [["reported", "readable"], ["withheld", "readable"], ["withheld", "unavailable"]] as const) {
    it.skipIf(!unix)(`never signals a group led by a program number this worker did not start, its exit ${exit} and the process list ${list}`, async () => {
      const owner = await createProcessLease({ guardian: "node" });
      const record = join(root, `foreign-group-${exit}-${list}`);
      const actor = owner.program("await new Promise(() => {});");
      const holding = owner.program(`const { writeFileSync, renameSync } = require("node:fs");
const other = Bun.spawn([process.execPath, "-e", ${JSON.stringify(actor)}], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
writeFileSync(${JSON.stringify(`${record}.tmp`)}, String(other.pid)); renameSync(${JSON.stringify(`${record}.tmp`)}, ${JSON.stringify(record)});
console.log(other.pid); await other.exited;`);
      let program: Started | undefined;
      let other = 0;
      let sent: ReturnType<typeof spyOn<typeof process, "kill">> | undefined;
      try {
        const holder = Bun.spawn(bun(holding), { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
        program = wrapSpawned(holder);
        const reader = holder.stdout.getReader();
        for (let text = ""; !other;) {
          const next = await reader.read();
          if (next.done) break;
          text += new TextDecoder().decode(next.value);
          other = Number(/(\d+)\n/.exec(text)?.[1] ?? 0);
        }
        reader.releaseLock();
        const signals: string[] = [];
        sent = spyOn(process, "kill");
        const failure = await failureOf(runCommand(["petrina-stand-in"], {
          timeoutMs: 200,
          ...(list === "unavailable" ? { processList: async () => undefined } : {}),
          start: () => ({ pid: other, stdout: new ReadableStream<Uint8Array>(), stderr: new Response("").body!, signalCode: null, exited: exit === "reported" ? Promise.resolve(0) : new Promise<number>(() => {}), kill: (signal) => { signals.push(signal ?? "SIGTERM"); } }),
        }));
        const numbered = sent.mock.calls.filter(([target, signal]) => Math.abs(Number(target)) === other && signal !== 0);
        sent.mockRestore();
        sent = undefined;
        expect(failure.reason).toBe("timeout");
        expect(failure.cleanup).toBe("unconfirmed");
        expect(signals).toEqual(exit === "reported" ? [] : ["SIGKILL"]);
        expect(numbered).toEqual([]);
        expect(await alive(other)).toBe(true);
      } finally {
        sent?.mockRestore();
        await closeCommandActors(owner, program?.exited ?? Promise.resolve(), program, [record, `${record}.tmp`]);
      }
    });
  }

  // A program the command started, listed in its group by the first look, that may leave the group before cleanup
  // stops it: its parent is the command or, once its own parent exited, the system. Leaving is shown by a first
  // look that names it in the command's group while it really leads a session of its own, so the group's pause never
  // reached it. Wherever it went, it was the command's when listed, so it is paused, stopped and watched until it is
  // gone; only one that stayed in the group, paused with it, lets cleanup confirm.
  for (const parent of ["command", "system"] as const) for (const leaves of [false, true]) {
    it.skipIf(!unix)(`stops a program whose parent is the ${parent} that ${leaves ? "leaves" : "stays in"} the command's group after the first look`, async () => {
      const dir = join(root, `group-${parent}-${leaves}`);
      mkdirSync(dir);
      const record = join(dir, "background");
      const launcher = join(dir, "launcher");
      const owner = await createProcessLease({ guardian: "node" });
      const actor = owner.program("await new Promise(() => {});");
      // This actor cannot end by itself; its independent owner closes only after the cleanup assertions.
      const spawnBackground = `const background = Bun.spawn([process.execPath, "-e", ${JSON.stringify(actor)}], { detached: ${leaves}, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
background.unref();
require("node:fs").writeFileSync(${JSON.stringify(`${record}.tmp`)}, String(background.pid));`;
      const script = owner.program(`const { renameSync } = require("node:fs");
${parent === "command" ? spawnBackground : `const launcher = Bun.spawn([process.execPath, "-e", ${JSON.stringify(owner.program(spawnBackground))}], { stdin: "ignore", stdout: "ignore", stderr: "inherit" });
require("node:fs").writeFileSync(${JSON.stringify(`${launcher}.tmp`)}, String(launcher.pid)); renameSync(${JSON.stringify(`${launcher}.tmp`)}, ${JSON.stringify(launcher)});
await launcher.exited;`}
renameSync(${JSON.stringify(`${record}.tmp`)}, ${JSON.stringify(record)});
await new Promise(() => {});`);
      let program: Started | undefined;
      let looks = 0;
      let background = 0;
      const stop = new AbortController();
      const command = runCommand(bun(script), {
        signal: stop.signal,
        timeoutMs: 60_000 * SLOW,
        start: (argv, options) => (program = spawnStarted(argv, options)),
        processList: async (timeout) => {
          const list = await processList(["-A", "-o", "pid=,ppid=,pgid=,stat="], timeout);
          if (!listsThis(list) || looks++ > 0 || !leaves) return list;
          return list!.split("\n").map((line) => {
            const [id, ppid, , state] = line.trim().split(/\s+/);
            return Number(id) === background ? `${id} ${ppid} ${program!.pid} ${state}` : line;
          }).join("\n");
        },
      });
      void command.catch(() => undefined);
      try {
        await waitFor(() => existsSync(record), "the background program to start", undefined, { during: command });
        background = Number(readFileSync(record, "utf8"));
        expect(background).toBeGreaterThan(0);
        expect(await alive(background)).toBe(true);
        stop.abort();
        const failure = await failureOf(command);
        expect(failure.reason).toBe("cancelled");
        expect(failure.cleanup).toBe(leaves ? "unconfirmed" : "confirmed");
        if (leaves) await stopped(background, Infinity, "the program that left the group to stop");
        else expect(await childState(background)).toBe("ended");
        expect(failure.message).toContain(leaves ? "Some of what it started may still be running." : "Everything found that it started has stopped.");
      } finally {
        stop.abort();
        await closeCommandActors(owner, command, program, [record, `${record}.tmp`, launcher, `${launcher}.tmp`]);
      }
    });
  }

  it("fails when its output cannot be read", async () => {
    const broken = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error("pipe broke")); } });
    const failure = await failureOf(runCommand(["petrina-stand-in"], {
      timeoutMs: 5_000,
      processList: async () => "",
      start: () => ({ pid: 999_999, stdout: broken, stderr: new Response("").body!, signalCode: null, exited: Promise.resolve(0), kill() {} }),
    }));
    expect(failure.reason).toBe("unreadable");
    expect(failure.message).toContain("could not have its output read (pipe broke)");
  });
});
