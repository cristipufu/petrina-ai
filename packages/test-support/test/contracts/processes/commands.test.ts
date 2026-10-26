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
import { rejectionOf } from "../../../src/rejections.js";
import { failureOf } from "../../fixtures/command-failure.js";
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
/** Programs whose stop is watched run this long by themselves, far past the longest watch. */
const WATCHED_S = 300;

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
  const started = Date.now();
  if (started + ms * MOST_SLOW + STATE_READ_MS + 1_000 >= endsBy) throw new Error(`Cannot watch for ${what}: it could end by itself while watched`);
  while ((await childState(pid, STATE_READ_MS, read)) !== "ended") {
    if (Date.now() - started > ms * Math.min(MOST_SLOW, factor())) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(50);
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
  });

  it("fails without starting when it is already cancelled", async () => {
    const stop = new AbortController();
    stop.abort();
    const marker = join(root, "never-started");
    const failure = await failureOf(runCommand(bun(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "")`), { signal: stop.signal }));
    expect(failure.reason).toBe("cancelled");
    expect(existsSync(marker)).toBe(false);
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
  });

  it.skipIf(!unix)("stops at its deadline with the output so far, and stops what it started", async () => {
    const started = Date.now();
    const failure = await failureOf(runCommand(["sh", "-c", "sleep 30 & echo $!; echo working >&2; wait"], { timeoutMs: 300 }));
    expect(Date.now() - started).toBeLessThan(300 + CLEANUP_MS * SLOW + 1_000);
    expect(failure.reason).toBe("timeout");
    expect(failure.message).toContain("did not finish within 0.3 seconds");
    expect(failure.message).toContain("Its exit was never reported.");
    expect(failure.stderr).toBe("working\n");
    const background = Number(failure.stdout.trim());
    expect(background).toBeGreaterThan(0);
    expect(failure.cleanup).toBe("confirmed");
    expect(failure.message).toContain("Everything found that it started has stopped.");
    expect(await childState(background)).toBe("ended");
  });

  it.skipIf(!unix)("stops when cancelled while it runs, and stops what it started", async () => {
    const stop = new AbortController();
    const command = runCommand(["sh", "-c", "sleep 30 & echo $!; wait"], { signal: stop.signal, timeoutMs: 60_000 });
    setTimeout(() => stop.abort(), 200);
    const failure = await failureOf(command);
    expect(failure.reason).toBe("cancelled");
    expect(failure.cleanup).toBe("confirmed");
    expect(await childState(Number(failure.stdout.trim()))).toBe("ended");
  });

  it.skipIf(!unix)("does not succeed when it exited but a program it started keeps its output open", async () => {
    const born = Date.now();
    const failure = await failureOf(runCommand(["sh", "-c", `sleep ${WATCHED_S} & echo $!; exit 0`], { timeoutMs: 500 }));
    const background = Number(failure.stdout.trim());
    try {
      expect(failure.reason).toBe("timeout");
      expect(failure.code).toBe(0);
      expect(failure.message).toContain("It exited with 0, but its output and error output stayed open.");
      // Its parent has exited, so only the command's own process group still finds it, and stops it. The parent was
      // never seen running, so whatever else it may have started stays unconfirmed.
      expect(failure.cleanup).toBe("unconfirmed");
      await stopped(background, born + WATCHED_S * 1_000, "the program holding the output to stop");
    } finally {
      if (background && await alive(background)) process.kill(background, "SIGKILL");
    }
  });

  // The watch after an unconfirmed cleanup, at the busyness factor's ceiling, with real state reads. A program due to
  // end by itself within the longest watch is refused at once, so its own end can never pass for a stop.
  it.skipIf(!unix)("never lets a program's own end pass for a stop, at the highest busyness factor", async () => {
    const born = Date.now();
    const early = Bun.spawn(["sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    try {
      const refused = await rejectionOf(stopped(early.pid, born + 30_000, "a program due to end by itself", { factor: () => MOST_SLOW }));
      expect(String(refused)).toContain("Cannot watch for a program due to end by itself: it could end by itself while watched");
      expect(await alive(early.pid)).toBe(true);
    } finally {
      early.kill("SIGKILL");
      await early.exited;
    }
  });

  // A state that cannot be read is no evidence of an end: a watch whose every read fails runs out instead of passing.
  it.skipIf(!unix)("never takes an unreadable state for a program's end", async () => {
    const born = Date.now();
    const running = Bun.spawn(["sleep", String(WATCHED_S)], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    try {
      const watch = stopped(running.pid, born + WATCHED_S * 1_000, "a program whose state cannot be read", { ms: 250, factor: () => 1, read: async () => undefined });
      expect(String(await rejectionOf(watch))).toContain("Timed out waiting for a program whose state cannot be read");
      expect(await alive(running.pid)).toBe(true);
    } finally {
      running.kill("SIGKILL");
      await running.exited;
    }
  });

  // The output-holding case again, at the factor's ceiling, with cleanup's stop signals sent or withheld. Withheld, the
  // program keeps running through a shortened watch, which fails; sent, the full watch sees it end.
  for (const stopping of [true, false]) {
    it.skipIf(!unix)(`${stopping ? "sees" : "fails without"} the end of an unconfirmed stop at the highest busyness factor, its stop signals ${stopping ? "sent" : "withheld"}`, async () => {
      const send = process.kill.bind(process);
      const signals = spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => stopping || (signal !== "SIGKILL" && signal !== "SIGSTOP") ? send(pid, signal) : true) as typeof process.kill);
      let background = 0;
      try {
        const born = Date.now();
        const failure = await failureOf(runCommand(["sh", "-c", `sleep ${WATCHED_S} & echo $!; exit 0`], { timeoutMs: 500 }));
        background = Number(failure.stdout.trim());
        expect(background).toBeGreaterThan(0);
        expect(failure.cleanup).toBe("unconfirmed");
        const watch = stopped(background, born + WATCHED_S * 1_000, "the program holding the output to stop", { ms: stopping ? 5_000 : 250, factor: () => MOST_SLOW });
        if (stopping) await watch;
        else {
          expect(String(await rejectionOf(watch))).toContain("Timed out waiting for the program holding the output to stop");
          expect(await alive(background)).toBe(true);
        }
      } finally {
        signals.mockRestore();
        if (background && await alive(background)) process.kill(background, "SIGKILL");
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
      // It ended before cleanup could see what it started.
      expect(failure.cleanup).toBe("unconfirmed");
      expect(signals).toEqual(["SIGKILL"]);
      expect(sent.mock.calls.filter(([target, signal]) => Math.abs(Number(target)) === defunct.pid && signal !== 0)).toEqual([]);
    } finally { sent?.mockRestore(); await defunct.release(); }
  }));

  // Windows confirms cleanup through taskkill, not a process list. Unconfirmed is not unattempted: the program itself
  // is still stopped. At the busyness factor's ceiling, with cleanup's stop signals and the program's own handle sent
  // or withheld: withheld, the program keeps running through a shortened watch, which fails; sent, the full watch sees
  // it end.
  for (const stopping of [true, false]) {
    it.skipIf(!unix)(`leaves cleanup unconfirmed when the process list cannot be read, and ${stopping ? "sees" : "fails without"} the program's end at the highest busyness factor, its stop ${stopping ? "sent" : "withheld"}`, async () => {
      let program: Started | undefined;
      const stop = new AbortController();
      const send = process.kill.bind(process);
      const signals = spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => stopping || Math.abs(pid) !== program?.pid || (signal !== "SIGKILL" && signal !== "SIGSTOP") ? send(pid, signal) : true) as typeof process.kill);
      try {
        const born = Date.now();
        const failure = await failureOf(runCommand(bun(`console.log(process.pid); await Bun.sleep(${WATCHED_S * 1_000})`), {
          timeoutMs: 1_000 * SLOW,
          signal: stop.signal,
          onOutput: cancelOnReady(stop),
          processList: async () => undefined,
          // The runtime's own program, its record of the exit kept, so cleanup pauses its group first as usual.
          start: (argv, options) => {
            const real = program = Bun.spawn(argv, { ...options, stdout: "pipe", stderr: "pipe" }) as unknown as Started;
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
        const watch = stopped(pid, born + WATCHED_S * 1_000, "the unconfirmed program to stop", { ms: stopping ? 5_000 : 250, factor: () => MOST_SLOW });
        if (stopping) await watch;
        else {
          expect(String(await rejectionOf(watch))).toContain("Timed out waiting for the unconfirmed program to stop");
          expect(await alive(pid)).toBe(true);
        }
      } finally {
        signals.mockRestore();
        program?.kill("SIGKILL");
        if (program?.pid) expect((await waitForProcessesToEnd([program.pid], 5_000 * SLOW)).ended).toBe(true);
      }
    });
  }

  // The group paused before the first look is stopped whatever that look answers, so nothing is left paused.
  for (const answer of ["fails", "shows only this worker"] as const) {
    it.skipIf(!unix)(`stops the group it paused first when the first look ${answer}`, async () => {
      const stop = new AbortController();
      const failure = await failureOf(runCommand(["sh", "-c", "sleep 300 & echo $!; wait"], {
        timeoutMs: 1_000 * SLOW,
        signal: stop.signal,
        onOutput: cancelOnReady(stop),
        processList: answer === "fails" ? async () => { throw new Error("the list broke"); } : async () => `${process.pid} 1 ${process.pid} S`,
      }));
      const background = Number(failure.stdout.trim());
      try {
        expect(failure.reason).toBe("cancelled");
        expect(background).toBeGreaterThan(0);
        expect(failure.cleanup).toBe("unconfirmed");
        await waitFor(async () => (await childState(background)) === "ended", "the paused group to be stopped", 5_000);
      } finally {
        if (background && await alive(background)) process.kill(background, "SIGKILL");
        if (background) expect((await waitForProcessesToEnd([background], 5_000 * SLOW)).ended).toBe(true);
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
      // The command starts a program outside its own process group, then waits to be released.
      const script = `const { existsSync, renameSync, writeFileSync } = require("node:fs");
const background = Bun.spawn(["sleep", "${WATCHED_S}"], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
background.unref();
writeFileSync(${JSON.stringify(`${record}.tmp`)}, String(background.pid)); renameSync(${JSON.stringify(`${record}.tmp`)}, ${JSON.stringify(record)});
while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(10);`;
      let program: Started | undefined;
      let looks = 0;
      let background = 0;
      const stop = new AbortController();
      const born = Date.now();
      const command = runCommand(bun(script), {
        signal: stop.signal,
        timeoutMs: 60_000 * SLOW,
        start: (argv, options) => withoutRecord(program = Bun.spawn(argv, { ...options, stdout: "pipe", stderr: "pipe" }) as unknown as Started),
        // The first look is a real list taken while the command runs; it ends, and its exit is reported, before the answer.
        processList: async (timeout) => {
          const list = await processList(["-A", "-o", "pid=,ppid=,pgid=,stat="], timeout);
          if (!listsThis(list)) return list;
          const look = looks++;
          if (look === 0) { writeFileSync(release, ""); await program!.exited; }
          return look === 1 && pending ? withState(list!, background, "R") : list;
        },
      });
      try {
        await waitFor(() => existsSync(record), "the background program to start");
        background = Number(readFileSync(record, "utf8"));
        expect(background).toBeGreaterThan(0);
        stop.abort();
        const failure = await failureOf(command);
        expect(failure.reason).toBe("cancelled");
        // The exit arrived while cleanup was looking: what that look found is still stopped, but the program was never
        // seen paused, so it may have started more meanwhile.
        expect(failure.code).toBe(0);
        expect(failure.cleanup).toBe("unconfirmed");
        await stopped(background, born + WATCHED_S * 1_000, "the program in a session of its own to stop");
      } finally {
        if (background && await alive(background)) process.kill(background, "SIGKILL");
      }
    });
  }

  it.skipIf(!unix)("sends no signal between a failed look and the next, and still confirms what it stopped", async () => {
    // Signals sent by number before each read starts; the read after the first complete list fails.
    const counts: number[] = [];
    let lists = 0, failed = -1, background = 0;
    let sent: ReturnType<typeof spyOn<typeof process, "kill">> | undefined;
    try {
      sent = spyOn(process, "kill");
      const stop = new AbortController();
      const command = runCommand(["sh", "-c", "sleep 300 & echo $!; wait"], {
        signal: stop.signal,
        timeoutMs: 60_000 * SLOW,
        processList: async (timeout) => {
          counts.push(sent!.mock.calls.filter(([, signal]) => signal !== 0).length);
          if (lists === 1 && failed < 0) { failed = counts.length - 1; return undefined; }
          const list = await processList(["-A", "-o", "pid=,ppid=,pgid=,stat="], timeout);
          if (listsThis(list)) lists += 1;
          return list;
        },
      });
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
      if (background && await alive(background)) process.kill(background, "SIGKILL");
    }
  });

  it.skipIf(!unix)("never signals a program of this worker that may hold the number after the command's exit was reported", async () => {
    // Another program this worker started, leading its own group, named as the command's program after its exit was
    // reported: the command's number was free from then on, so being this worker's child proves nothing.
    const other = Bun.spawn(["sleep", "300"], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    let sent: ReturnType<typeof spyOn<typeof process, "kill">> | undefined;
    try {
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
      other.kill("SIGKILL");
      await other.exited;
    }
  });

  it.skipIf(!unix)("signals nothing listed under a program number this worker did not start", async () => {
    // Someone else's program, with a child of its own, named as the command's program after its exit was reported.
    const holder = Bun.spawn(["sh", "-c", 'sh -c "sleep 30 & echo sleep \\$!; wait" & echo inner $!; wait'], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const pids: Record<string, number> = {};
    try {
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
      for (const pid of [pids.sleep, pids.inner]) if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ }
      holder.kill("SIGKILL");
      await holder.exited;
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
      const owner = await createProcessLease();
      const workerProgram = owner.program(`await Bun.sleep(${WATCHED_S * 1_000});`);
      const launcher = owner.program(`const worker = Bun.spawn([process.execPath, "-e", ${JSON.stringify(workerProgram)}], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
worker.unref();
const { renameSync, writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(`${launched}.tmp`)}, worker.pid + " " + process.pid); renameSync(${JSON.stringify(`${launched}.tmp`)}, ${JSON.stringify(launched)});`);
      const starts = owner.program(`const { existsSync, writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(ready)}, "");
while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(10);
await Bun.spawn([process.execPath, "-e", ${JSON.stringify(launcher)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited;
await Bun.sleep(60_000);`);
      const script = starter === "command" ? starts : owner.program(`Bun.spawn([process.execPath, "-e", ${JSON.stringify(starts)}], { stdin: "ignore", stdout: "ignore", stderr: "inherit" }); await Bun.sleep(60_000);`);
      const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };
      let looks = 0, worker = 0;
      const stop = new AbortController();
      const command = runCommand(bun(script), {
        signal: stop.signal,
        timeoutMs: 60_000 * SLOW,
        ...(record ? {} : { start: (argv, options) => withoutRecord(Bun.spawn(argv, { ...options, stdout: "pipe", stderr: "pipe" }) as unknown as Started) }),
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
      const completed = command.catch(() => undefined);
      try {
        await waitFor(() => existsSync(ready), "the starter to wait for its release");
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
        await owner.close();
        await completed;
      }
    });
  }

  it.skipIf(!unix)("stops a program in a session of its own but never confirms it: it ran while cleanup looked", async () => {
    const dir = join(root, "own-session");
    mkdirSync(dir);
    const record = join(dir, "background");
    const stop = new AbortController();
    const born = Date.now();
    const command = runCommand(bun(`const { renameSync, writeFileSync } = require("node:fs");
const background = Bun.spawn(["sleep", "${WATCHED_S}"], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
background.unref();
writeFileSync(${JSON.stringify(`${record}.tmp`)}, String(background.pid)); renameSync(${JSON.stringify(`${record}.tmp`)}, ${JSON.stringify(record)});
await Bun.sleep(60_000);`), { signal: stop.signal, timeoutMs: 60_000 * SLOW });
    let background = 0;
    try {
      await waitFor(() => existsSync(record), "the background program to start");
      background = Number(readFileSync(record, "utf8"));
      stop.abort();
      const failure = await failureOf(command);
      expect(failure.cleanup).toBe("unconfirmed");
      await stopped(background, born + WATCHED_S * 1_000, "the program in a session of its own to stop");
    } finally {
      stop.abort();
      if (background && await alive(background)) process.kill(background, "SIGKILL");
    }
  });

  // A program started where no look can see it, by a parent already gone when cleanup first looks. Nothing can show
  // it ended, so cleanup never says everything stopped.
  for (const holds of [false, true]) {
    const output = holds ? `stdout: "inherit", stderr: "inherit"` : `stdout: "ignore", stderr: "ignore"`;
    const background = (dir: string, wait: string) => `const { existsSync, renameSync, writeFileSync } = require("node:fs");
${wait}
const background = Bun.spawn(["sleep", "30"], { detached: true, stdin: "ignore", ${output} });
background.unref();
writeFileSync(${JSON.stringify(join(dir, "background.tmp"))}, String(background.pid)); renameSync(${JSON.stringify(join(dir, "background.tmp"))}, ${JSON.stringify(join(dir, "background"))});`;

    it.skipIf(!unix)(`never confirms a program ${holds ? "holding its output " : ""}started by a parent whose exit was never reported`, async () => {
      const dir = join(root, `lost-parent-${holds}`);
      mkdirSync(dir);
      let real: ReturnType<typeof Bun.spawn> | undefined;
      const stop = new AbortController();
      const command = runCommand(bun(background(dir, "")), {
        signal: stop.signal,
        timeoutMs: 60_000 * SLOW,
        // The runtime collects the command, but its exit report never reaches the runner.
        start: (argv, options) => {
          real = Bun.spawn(argv, { ...options, stdout: "pipe", stderr: "pipe" });
          return { pid: real.pid, stdout: real.stdout as ReadableStream<Uint8Array>, stderr: real.stderr as ReadableStream<Uint8Array>, signalCode: null, exited: new Promise<number>(() => {}), kill: (signal) => real!.kill(signal) };
        },
      });
      let started = 0;
      try {
        await waitFor(() => existsSync(join(dir, "background")), "the background program to start");
        started = Number(readFileSync(join(dir, "background"), "utf8"));
        await real!.exited;
        stop.abort();
        const failure = await failureOf(command);
        expect(failure.reason).toBe("cancelled");
        expect(failure.message).toContain(holds ? "Its exit was never reported." : "Its output closed, but its exit was never reported.");
        expect(failure.cleanup).toBe("unconfirmed");
      } finally {
        if (started && await alive(started)) process.kill(started, "SIGKILL");
      }
    });
  }

  // Someone else's program leading its own group, named as the command's program. Whether its exit was reported
  // or withheld, and whether a list shows its real parent or none can be read, nothing establishes it is the
  // command's: no signal goes to it or its group by number. A withheld exit leaves only the runtime's own handle.
  for (const [exit, list] of [["reported", "readable"], ["withheld", "readable"], ["withheld", "unavailable"]] as const) {
    it.skipIf(!unix)(`never signals a group led by a program number this worker did not start, its exit ${exit} and the process list ${list}`, async () => {
      const holder = Bun.spawn(bun(`const other = Bun.spawn(["sleep", "30"], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" }); console.log(other.pid); await other.exited;`), { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
      let other = 0;
      let sent: ReturnType<typeof spyOn<typeof process, "kill">> | undefined;
      try {
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
        if (other) try { process.kill(other, "SIGKILL"); } catch { /* Already gone. */ }
        holder.kill("SIGKILL");
        await holder.exited;
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
      // It outlives cleanup's whole allowance, so only cleanup can end it.
      const spawnBackground = `const background = Bun.spawn(["sleep", "${WATCHED_S}"], { detached: ${leaves}, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
background.unref();
require("node:fs").writeFileSync(${JSON.stringify(`${record}.tmp`)}, String(background.pid));`;
      const script = `const { renameSync } = require("node:fs");
${parent === "command" ? spawnBackground : `await Bun.spawn([process.execPath, "-e", ${JSON.stringify(spawnBackground)}], { stdin: "ignore", stdout: "ignore", stderr: "inherit" }).exited;`}
renameSync(${JSON.stringify(`${record}.tmp`)}, ${JSON.stringify(record)});
await Bun.sleep(60_000);`;
      let program: Started | undefined;
      let looks = 0;
      let background = 0;
      const stop = new AbortController();
      const born = Date.now();
      const command = runCommand(bun(script), {
        signal: stop.signal,
        timeoutMs: 60_000 * SLOW,
        start: (argv, options) => (program = Bun.spawn(argv, { ...options, stdout: "pipe", stderr: "pipe" }) as unknown as Started),
        processList: async (timeout) => {
          const list = await processList(["-A", "-o", "pid=,ppid=,pgid=,stat="], timeout);
          if (!listsThis(list) || looks++ > 0 || !leaves) return list;
          return list!.split("\n").map((line) => {
            const [id, ppid, , state] = line.trim().split(/\s+/);
            return Number(id) === background ? `${id} ${ppid} ${program!.pid} ${state}` : line;
          }).join("\n");
        },
      });
      try {
        await waitFor(() => existsSync(record), "the background program to start");
        background = Number(readFileSync(record, "utf8"));
        expect(background).toBeGreaterThan(0);
        expect(await alive(background)).toBe(true);
        stop.abort();
        const failure = await failureOf(command);
        expect(failure.reason).toBe("cancelled");
        expect(failure.cleanup).toBe(leaves ? "unconfirmed" : "confirmed");
        if (leaves) await stopped(background, born + WATCHED_S * 1_000, "the program that left the group to stop");
        else expect(await childState(background)).toBe("ended");
        expect(failure.message).toContain(leaves ? "Some of what it started may still be running." : "Everything found that it started has stopped.");
      } finally {
        stop.abort();
        if (background && await alive(background)) process.kill(background, "SIGKILL");
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
