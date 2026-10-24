import { afterAll, describe, expect, it, spyOn } from "bun:test";
import * as processes from "node:child_process";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { childState, lostExit, readProcessList, waitForProcessesToEnd } from "@petrina/platform/process-tree";
import { removeDir, tempDir, waitFor } from "@petrina/test-support/fixtures";

const snapshot = "11 10\n12 11\n40 1\n";

type Report = (error: Error | null, stdout: string, stderr: string) => void;

/**
 * What one read's helper showed. Its output, the output's end, its exit report and the stops it was sent are
 * separate facts; `events` keeps when each happened, counted from the helper's start.
 */
type Helper = { child?: processes.ChildProcess; output: string; ended: boolean; reported: boolean; failure?: Error | null; stops: unknown[]; events: string[] };

/** Start reads' helpers through `execute`, recording what each one showed without changing it. */
function watchHelpers(execute: typeof processes.execFile) {
  const helpers: Helper[] = [];
  const spawn = spyOn(processes, "execFile").mockImplementation(((...args: unknown[]) => {
    const helper: Helper = { output: "", ended: false, reported: false, stops: [], events: [] };
    helpers.push(helper);
    const started = Date.now();
    const note = (event: string) => helper.events.push(`${event}@${Date.now() - started}ms`);
    const done = args.at(-1) as Report;
    const report: Report = (error, stdout, stderr) => { helper.reported = true; helper.failure = error; note("report"); done(error, stdout, stderr); };
    args[args.length - 1] = report;
    const child = helper.child = Reflect.apply(execute, processes, args) as processes.ChildProcess;
    child.stdout?.once("data", () => note("output"));
    child.stdout?.on("data", (chunk: Buffer) => { helper.output += chunk.toString(); });
    child.stdout?.on("end", () => { helper.ended = true; note("end"); });
    child.stdout?.once("close", () => note("closed"));
    child.once("exit", () => note("exit"));
    const kill = child.kill.bind(child);
    child.kill = (signal) => { helper.stops.push(signal); note(`stop ${signal}`); return kill(signal); };
    return child;
  }) as typeof processes.execFile);
  return { helpers, spawn };
}

/**
 * What a settled read may show. A list is a complete snapshot: the helper's exit was reported without error
 * after its output ended, and the list is that output. Unknown proves nothing about the output or the exit,
 * and comes only at the deadline: the runtime stopped the helper at its own timeout and reported it killed,
 * or finished with its output cut off, or nothing was reported and the fallback sent SIGKILL. Either answer
 * arrives within the allowance.
 */
function expectSettled(list: string | undefined, helper: Helper, elapsed: number, timeout: number, allowance: number): void {
  expect(elapsed).toBeLessThan(allowance);
  if (list !== undefined) {
    expect(helper.reported).toBe(true);
    expect(helper.failure).toBeNull();
    expect(helper.ended).toBe(true);
    expect(list).toBe(helper.output);
  } else if (helper.reported) {
    expect(elapsed).toBeGreaterThanOrEqual(timeout);
    if (helper.failure === null) expect(helper.ended).toBe(false);
    else expect(helper.failure).toMatchObject({ killed: true });
    expect(helper.stops).not.toEqual([]);
  } else {
    expect(elapsed).toBeGreaterThanOrEqual(timeout + 100);
    expect(helper.stops).toContain("SIGKILL");
  }
}

/** One log line of what a read's helper showed, so an unknown or failed native read can be understood later. */
function describeRead(list: string | undefined, helper: Helper, elapsed: number, timeout: number): string {
  const failure = helper.failure as processes.ExecFileException | null | undefined;
  return JSON.stringify({
    result: list === undefined ? "unknown" : "listed", elapsed, timeout,
    output: { length: helper.output.length, ended: helper.ended, destroyed: helper.child?.stdout?.destroyed ?? null },
    exit: !helper.reported ? "not reported" : failure ? { killed: failure.killed, signal: failure.signal, code: failure.code, message: failure.message } : "success",
    helper: { pid: helper.child?.pid ?? null, exitCode: helper.child?.exitCode ?? null, signalCode: helper.child?.signalCode ?? null },
    events: helper.events,
  });
}

import { SLOW } from "@petrina/test-support/slow";
import { defunctProcess } from "@petrina/test-support/defunct-process";

describe("a process-list read's deadline", () => {
  const controlled = () => {
    const reports: Report[] = [];
    const deadlines: { ms: number; fire: () => void; handle: ReturnType<typeof setTimeout> }[] = [];
    const { helpers, spawn } = watchHelpers(((...args: unknown[]) => {
      reports.push(args.at(-1) as Report);
      const child = new processes.ChildProcess();
      Object.defineProperty(child, "stdout", { value: new PassThrough() });
      child.kill = () => true;
      return child;
    }) as typeof processes.execFile);
    const schedule = spyOn(globalThis, "setTimeout").mockImplementation(((fire: () => void, ms: number) => {
      const handle = { deadline: deadlines.length } as unknown as ReturnType<typeof setTimeout>;
      deadlines.push({ ms, fire, handle });
      return handle;
    }) as typeof setTimeout);
    const cancel = spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
    return { helpers, reports, deadlines, spawn, cancel, restore: () => { helpers.forEach((helper) => helper.child?.stdout?.destroy()); cancel.mockRestore(); schedule.mockRestore(); spawn.mockRestore(); } };
  };

  type Controlled = ReturnType<typeof controlled>;

  /** End a stand-in helper's output, as its pipe ends once the helper is done writing. */
  const endOutput = async (helper: Helper) => {
    const stdout = helper.child!.stdout as PassThrough;
    stdout.end();
    await once(stdout, "end");
  };

  /** A healthy read: the helper's whole output, its end, then a successful exit report make a list. */
  const completeRead = async (read: Controlled) => {
    const result = readProcessList(4_000);
    const helper = read.helpers.at(-1)!;
    helper.child!.stdout!.emit("data", Buffer.from(snapshot.slice(0, 6)));
    helper.child!.stdout!.emit("data", Buffer.from(snapshot.slice(6)));
    await endOutput(helper);
    read.reports.at(-1)!(null, snapshot, "");
    const list = await result;
    expect(list).toBe(snapshot);
    expectSettled(list, helper, 0, 4_000, 5_000);
    expect(read.cancel).toHaveBeenCalledWith(read.deadlines.at(-1)!.handle);
    expect(helper.stops).toEqual([]);
  };

  for (const error of [null, new Error("Process list unavailable")]) it(`cancels the fallback timer when the helper reports ${error ? "failure" : "success"}`, async () => {
    const read = controlled();
    try {
      const result = readProcessList(4_000);
      expect(read.spawn.mock.calls[0]).toEqual(["ps", ["-A", "-o", "pid=,ppid=,stat="], { timeout: 4_000 }, expect.any(Function)]);
      read.helpers[0]!.child!.stdout!.emit("data", Buffer.from(snapshot));
      await endOutput(read.helpers[0]!);
      read.reports[0]!(error, snapshot, "");
      expect(await result).toBe(error ? undefined : snapshot);
      expect(read.cancel).toHaveBeenCalledWith(read.deadlines[0]!.handle);
      expect(read.helpers[0]!.stops).toEqual([]);
    } finally { read.restore(); }
  });

  it("lists a complete snapshot once the helper's exit is reported after its output ended", async () => {
    const read = controlled();
    try { await completeRead(read); } finally { read.restore(); }
  });

  it("waits for the fallback deadline, kills an unreported helper and leaves the next read usable", async () => {
    const read = controlled();
    try {
      let settled = false;
      const result = readProcessList(4_000);
      void result.then(() => { settled = true; });
      const helper = read.helpers[0]!;
      // A complete successful-looking snapshot is not a successful read without the exit report.
      helper.child!.stdout!.emit("data", Buffer.from(snapshot));
      await endOutput(helper);
      expect(helper).toMatchObject({ output: snapshot, ended: true, reported: false });
      expect(read.deadlines).toHaveLength(1);
      expect(read.deadlines[0]!.ms).toBe(4_100);
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(helper.stops).toEqual([]);
      read.deadlines[0]!.fire();
      expect(await result).toBeUndefined();
      expect(helper.stops).toEqual(["SIGKILL"]);
      expectSettled(undefined, helper, read.deadlines[0]!.ms, 4_000, 5_000);
      // An exit reported after the deadline cannot turn the failed read into a success.
      read.reports[0]!(null, snapshot, "");
      expect(await result).toBeUndefined();
      await completeRead(read);
    } finally { read.restore(); }
  });

  /** As Bun 1.4.2's execFile does at its own timeout: close the helper's output without an end and signal it; then its exit is reported. */
  const runtimeStop = (read: Controlled, error: Error | null) => {
    const helper = read.helpers[0]!;
    helper.child!.stdout!.destroy();
    helper.child!.kill(15);
    read.reports[0]!(error, helper.output, "");
    return 4_000;
  };

  // A list still being written when the read reaches its deadline, by each route. Each returns the moment the read settles.
  const reachDeadline = [
    { name: "nothing is reported by the fallback deadline", stops: ["SIGKILL"], exit: "not reported", reach: (read: Controlled) => { read.deadlines[0]!.fire(); return read.deadlines[0]!.ms; } },
    { name: "the runtime reports stopping the helper at its own deadline", stops: [15], exit: { killed: true, signal: "SIGTERM" }, reach: (read: Controlled) => runtimeStop(read, Object.assign(new Error("Command failed: ps"), { killed: true, signal: "SIGTERM" })) },
    // A helper that exited cleanly just as the runtime's deadline came, or ignored its signal: the report is a success, the list cut short.
    { name: "the runtime reports a clean exit after closing the output at its own deadline", stops: [15], exit: "success", reach: (read: Controlled) => runtimeStop(read, null) },
  ];
  for (const deadline of reachDeadline) it(`settles unknown when its output has not ended and ${deadline.name}`, async () => {
    const read = controlled();
    try {
      const result = readProcessList(4_000);
      const helper = read.helpers[0]!;
      helper.child!.stdout!.emit("data", Buffer.from(`${process.pid} 1 S\n`));
      const settledAt = deadline.reach(read);
      expect(await result).toBeUndefined();
      // The output named this process, yet neither its end nor a successful exit was seen: no list, and no proof of one.
      expect(helper).toMatchObject({ output: `${process.pid} 1 S\n`, ended: false });
      expect(helper.stops).toEqual(deadline.stops);
      expectSettled(undefined, helper, settledAt, 4_000, 5_000);
      // The log line keeps the exit and the output's end apart, so a clean exit is never read as a complete list.
      expect(JSON.parse(describeRead(undefined, helper, settledAt, 4_000))).toMatchObject({ result: "unknown", output: { ended: false }, exit: deadline.exit });
      await completeRead(read);
    } finally { read.restore(); }
  });
});

describe("a live process-list read", () => {
  const folders: string[] = [];
  afterAll(() => folders.forEach(removeDir));
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  it.skipIf(process.platform === "win32")("lists this process within the native probe's allowance", async () => {
    // Only a returned list shows what the system lists, and it must list this process. Unknown at the deadline
    // is the read's own answer for a slow helper or one whose exit goes unreported: it proves nothing about the
    // output, its helper must still end, and the log keeps what the helper showed, as for a failure.
    const watch = watchHelpers(processes.execFile);
    let ended = false;
    try {
      const timeout = 4_000 * SLOW;
      const started = Date.now();
      const list = await readProcessList(timeout);
      const elapsed = Date.now() - started;
      const helper = watch.helpers[0]!;
      const record = () => console.error(`Native process-list read: ${describeRead(list, helper, elapsed, timeout)}`);
      if (list === undefined) record();
      try {
        expectSettled(list, helper, elapsed, timeout, 5_000 * SLOW);
        if (list !== undefined) expect(list.split("\n").some((line) => Number(line.trim().split(/\s+/)[0]) === process.pid)).toBe(true);
        // The read's own exit or stop ends its helper: nothing here stops it first.
        const pid = helper.child?.pid;
        if (pid) await waitFor(async () => (await childState(pid, 4_000)) === "ended", "the native process-list helper to end", 10_000);
      } catch (error) {
        if (list !== undefined) record();
        throw error;
      }
      ended = true;
    } finally {
      watch.spawn.mockRestore();
      const pid = watch.helpers[0]?.child?.pid;
      if (!ended && pid) {
        try { watch.helpers[0]!.child!.kill("SIGKILL"); } catch { /* Already gone. */ }
        await waitFor(async () => (await childState(pid, 4_000)) === "ended", "the native process-list helper to be stopped", 10_000);
      }
    }
  });

  it.skipIf(process.platform === "win32")("reads whether a child is running, defunct or already collected", async () => {
    expect(await childState(process.pid, 4_000)).toBe("running");
    const defunct = await defunctProcess();
    try {
      await waitFor(async () => (await childState(defunct.pid, 4_000)) === "ended", "the defunct process to show as ended", 10_000);
      // Existence alone says nothing: the defunct process still has its number.
      expect(alive(defunct.pid)).toBe(true);
    } finally { await defunct.release(); }
    const collected = Bun.spawn(["sh", "-c", "exit 0"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    await collected.exited;
    expect(await childState(collected.pid, 4_000)).toBe("ended");
    // Without a readable list, the state is unknown rather than guessed.
    expect(await childState(process.pid, 4_000, async () => undefined)).toBe("unknown");
  });

  it.skipIf(process.platform === "win32")("settles as failed at its deadline and kills the helper when the system never reports the helper's exit", async () => {
    // A helper that ignores the runtime's stop signal and lingers is what a finished child whose exit the
    // system lost looks like to the read: the runtime's own timeout never settles its callback.
    const bin = tempDir("petrina-ps-stand-in-"); folders.push(bin);
    const pidFile = join(bin, "pid");
    writeFileSync(join(bin, "ps"), `#!/bin/sh
trap '' TERM
echo $$ > "${pidFile}"
exec sleep 30
`, { mode: 0o755 });
    const recorded = () => existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) || undefined : undefined;
    // A Mac can hold a new program's first start for a while: start the stand-in once outside the measured read.
    const warm = Bun.spawn([join(bin, "ps")], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    let warmPid: number;
    try {
      warmPid = await waitFor(recorded, "the stand-in helper to start once", 60_000);
      warm.kill("SIGKILL");
      await waitFor(() => !alive(warmPid), "the warm-up helper to be gone", 10_000);
    } finally { try { warm.kill("SIGKILL"); } catch { /* Already gone. */ } }
    rmSync(pidFile);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path ?? ""}`;
    const watch = watchHelpers(processes.execFile);
    try {
      const started = Date.now();
      const list = await readProcessList(300);
      const elapsed = Date.now() - started;
      expect(list).toBeUndefined();
      // The real unreported state: no exit report and no ended output when the fallback settles the read.
      const helper = watch.helpers[0]!;
      expect(helper).toMatchObject({ reported: false, ended: false });
      expectSettled(list, helper, elapsed, 300, 5_000);
      const pid = await waitFor(recorded, "the lingering helper's pid", 10_000);
      expect(pid).not.toBe(warmPid);
      await waitFor(() => !alive(pid), "the lingering helper to be killed", 10_000);
    } finally {
      watch.spawn.mockRestore();
      process.env.PATH = path;
      for (const helper of watch.helpers) {
        try { helper.child?.kill("SIGKILL"); } catch { /* Already gone. */ }
        if (helper.child?.pid) await waitFor(async () => (await childState(helper.child!.pid!, 4_000)) === "ended", "the owned process-list helper to be stopped", 10_000);
      }
    }
  });
});

describe("native exit watches", () => {
  it.skipIf(process.platform === "win32")("gives the watches of many children one helper at a time", async () => {
    // Two dozen children close their output together and their exits go unreported for a while: their watches
    // read the process list once, together, instead of starting two dozen helpers at the same moment.
    let reads = 0, inFlight = 0, most = 0;
    const read = async (_timeout: number) => {
      reads += 1; inFlight += 1; most = Math.max(most, inFlight);
      await Bun.sleep(30);
      inFlight -= 1;
      return `${process.pid} 1 S\n`;
    };
    const stop = new AbortController();
    const watches = Array.from({ length: 24 }, () => lostExit(process.pid, stop.signal, read));
    await waitFor(() => reads > 0, "the first shared read");
    await Bun.sleep(200);
    expect(reads).toBe(1);
    expect(most).toBe(1);
    stop.abort();
    expect(await Promise.all(watches)).toEqual(Array.from({ length: 24 }, () => "stopped"));
  });
});

it.skipIf(process.platform === "win32")("keeps a lost-exit watch cancellable after its reader throws", async () => {
  let reads = 0;
  const stop = new AbortController();
  const watch = lostExit(process.pid, stop.signal, () => { reads++; throw new Error("Controlled native observation failure"); });
  try {
    await waitFor(() => reads > 0, "the failing process observation");
  } finally { stop.abort(); }
  expect(await watch).toBe("stopped");
});

for (const rejected of [false, true]) it.skipIf(process.platform === "win32")(`does not mistake a ${rejected ? "rejected" : "throwing"} native observation for confirmed termination`, async () => {
  let reads = 0;
  const read = () => {
    reads++;
    if (rejected) return Promise.reject(new Error("Unavailable process list"));
    throw new Error("Unavailable process list");
  };
  expect(await childState(process.pid, 300, read)).toBe("unknown");
  expect(await waitForProcessesToEnd([process.pid], 100, read)).toEqual({
    ended: false, processes: [{ pid: process.pid, state: "unknown", sources: ["target"] }],
  });
  expect(reads).toBe(2);
});
