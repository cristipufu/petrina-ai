import { expectRejection } from "./rejections.js";
import { afterAll, expect, it, spyOn } from "bun:test";
import { getEventListeners } from "node:events";
import * as processes from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentRun } from "../src/acp-run.js";
import { AgentBrowser } from "../src/browser.js";
import { ENGINE_PROFILES } from "../src/tools.js";
import { parseChildState } from "../src/process-tree.js";
import { removeDir, tempDir, waitFor } from "./fixtures.js";

const root = tempDir("petrina-agent-lifetime-");
afterAll(() => removeDir(root));
const profile = ENGINE_PROFILES.find(profile => profile.id === "sol-high")!;
const command = [process.execPath, join(import.meta.dir, "fake-agent.ts")];
const callbacks = { onActivity() {}, onPlanStep() {}, onPermission: async () => "deny" as const };

const expectPausesReclaimed = (signals: ReturnType<typeof spyOn<typeof process, "kill">>) => {
  const { calls, results } = signals.mock;
  for (const [index, [pid, signal]] of calls.entries()) if (signal === "SIGSTOP") {
    // A known owner can already be gone when the final pause is attempted.
    if (results[index]?.type === "throw") continue;
    expect(calls.slice(index + 1).some(([target, next]) => target === pid && (next === "SIGCONT" || next === "SIGKILL"))).toBe(true);
  }
};

// Each public entry point reaches the same idempotent stop. No Engine or native provider is needed.
for (const entry of ["stop", "abort", "close"] as const) for (const exitsOnTerm of [false, true]) it.skipIf(process.platform === "win32")(`does not trust a snapshot delivered before a late fork barrier (${entry}, agent ${exitsOnTerm ? "exits" : "ignores TERM"})`, async () => {
  const dir = tempDir("petrina-stop-barrier-");
  const stopping = join(dir, "stopping");
  const workerFile = (n: number, part: string) => join(dir, `worker-${n}-${part}`);
  const agent = join(dir, "agent.ts");
  const worker = `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); require("node:fs").writeFileSync(process.argv.at(-1), "ready");`;
  writeFileSync(agent, `import { spawn } from "node:child_process";
import { existsSync, renameSync, writeFileSync } from "node:fs";
const workerFile = (n, part) => ${JSON.stringify(dir)} + "/worker-" + n + "-" + part;
let forks = 0;
setInterval(() => {
  if (!existsSync(workerFile(forks + 1, "release"))) return;
  const n = ++forks;
  const worker = spawn(process.execPath, ["-e", ${JSON.stringify(worker)}, workerFile(n, "ready")], { detached: true, stdio: "ignore" });
  writeFileSync(workerFile(n, "pid.tmp"), String(worker.pid));
  renameSync(workerFile(n, "pid.tmp"), workerFile(n, "pid")); worker.unref();
}, 5);
process.once("SIGTERM", () => { void (async () => {
  writeFileSync(${JSON.stringify(stopping)}, "ready");
  // Keep the parent link until the final snapshot's worker is ready, including the graceful case.
  while (!existsSync(workerFile(2, "ready"))) await Bun.sleep(5);
  ${exitsOnTerm ? "process.exit(0);" : ""}
})(); });
process.argv.push("--stubborn");
await import(${JSON.stringify(join(import.meta.dir, "fake-agent.ts"))});`);
  const original = processes.execFile;
  const actualList = () => new Promise<string>((resolve, reject) => {
    original("/bin/ps", ["-A", "-o", "pid=,ppid=,stat="], { timeout: 4_000 }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
  let forks = 0;
  const workerPids = () => Array.from({ length: forks }, (_, i) => workerFile(i + 1, "pid")).flatMap(path => existsSync(path) ? Number(readFileSync(path, "utf8")) || [] : []);
  const controller = new AbortController();
  const unrelated = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
  const signals = spyOn(process, "kill");
  let child: ChildProcess | undefined, run: AgentRun | undefined, incomplete = 0;
  const snapshots: string[] = [];
  const scan = spyOn(processes, "execFile").mockImplementation(((...args: unknown[]) => {
    if (args[0] !== "ps") return Reflect.apply(original, processes, args);
    const done = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    void (async () => {
      // Each snapshot showing the agent able to run releases another fork. Deliver that
      // exact old list only after its new detached, TERM-ignoring worker is ready.
      const listed = await actualList();
      snapshots.push(listed);
      const row = listed.split("\n").find(line => Number(line.trim().split(/\s+/)[0]) === child?.pid);
      if (row && !/^[TZ]/.test(row.trim().split(/\s+/)[2] ?? "")) {
        const n = ++forks;
        writeFileSync(workerFile(n, "release"), "ready");
        await waitFor(() => existsSync(workerFile(n, "ready")) && existsSync(workerFile(n, "pid")), "the late worker to cross the captured-snapshot barrier");
      }
      done(null, listed, "");
    })().catch(error => done(error, "", ""));
    return undefined;
  }) as typeof processes.execFile);
  try {
    run = await AgentRun.start({ profile, cwd: dir, command: [process.execPath, agent], callbacks: { ...callbacks, onCleanupIncomplete: () => { incomplete++; } }, signal: controller.signal, browser: false, onProcess: process => { child = process; } });
    const from = Date.now();
    if (entry === "abort") controller.abort();
    if (entry === "close") run.close();
    if (entry !== "stop") await waitFor(() => snapshots.length > 0, "the stop to begin before joining its result");
    const complete = await run.stop();
    expect(Date.now() - from).toBeLessThan(7_000);
    expect(complete).toBe(true);
    expect(incomplete).toBe(0);
    const after = await actualList();
    expect(parseChildState(after, child!.pid!)).toBe("ended");
    expect(workerPids().filter(pid => parseChildState(after, pid) !== "ended")).toEqual([]);
    expect(snapshots).toHaveLength(2);
    expect(existsSync(stopping)).toBe(true);
    expect(snapshots.map(listed => listed.split("\n").find(line => Number(line.trim().split(/\s+/)[0]) === child!.pid)?.trim().split(/\s+/)[2]?.startsWith("T"))).toEqual([true, true]);
    expect(parseChildState(after, unrelated.pid)).toBe("running");
    expect(after.split("\n").find(line => Number(line.trim().split(/\s+/)[0]) === unrelated.pid)?.trim().split(/\s+/)[2]).not.toContain("T");
    expect(signals.mock.calls.filter(([pid, signal]) => Math.abs(pid) === unrelated.pid && signal !== 0)).toEqual([]);
    expectPausesReclaimed(signals);
    expect(await run.stop()).toBe(true);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  } finally {
    signals.mockRestore(); scan.mockRestore();
    for (const pid of [child?.pid, ...workerPids()].filter((pid): pid is number => !!pid)) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* Already gone. */ }
      try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ }
    }
    await run?.stop();
    unrelated.kill("SIGKILL"); await unrelated.exited;
    await waitFor(async () => {
      const listed = await actualList();
      return [child?.pid, ...workerPids()].every(pid => !pid || parseChildState(listed, pid) === "ended");
    }, "the fixture's programs to stop");
    removeDir(dir);
  }
});

it.skipIf(process.platform === "win32")("stops an agent with no work after one list and no forced stop", async () => {
  let child: ChildProcess | undefined, run: AgentRun | undefined, incomplete = 0, scans = 0;
  const original = processes.execFile;
  const scan = spyOn(processes, "execFile").mockImplementation(((...args: unknown[]) => {
    if (args[0] === "ps") scans++;
    return Reflect.apply(original, processes, args);
  }) as typeof processes.execFile);
  const signals = spyOn(process, "kill");
  try {
    run = await AgentRun.start({ profile, cwd: root, command, callbacks: { ...callbacks, onCleanupIncomplete: () => { incomplete++; } }, signal: new AbortController().signal, browser: false, onProcess: process => { child = process; } });
    expect(await run.stop()).toBe(true);
    expect(scans).toBe(1);
    expect(incomplete).toBe(0);
    expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
    expect(signals.mock.calls.some(([, signal]) => signal === "SIGKILL")).toBe(false);
    expectPausesReclaimed(signals);
  } finally { await run?.stop(); signals.mockRestore(); scan.mockRestore(); }
});

it("stops a process aborted synchronously by its ownership callback without opening a browser", async () => {
  const browser = spyOn(AgentBrowser, "start");
  try {
    for (const probe of [false, true]) {
      const controller = new AbortController();
      let child: ChildProcess | undefined;
      const error = await AgentRun.start({ profile, cwd: root, command: [...command, "--hang"], callbacks, probe, signal: controller.signal, onProcess: process => { child = process; controller.abort(); } }).then(async run => { await run.stop(); return undefined; }, error => error);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("Stopped before the agent started");
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      if (child) await new Promise<void>(done => { if (child!.exitCode !== null || child!.signalCode !== null) done(); else child!.once("exit", () => done()); });
      expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
    }
    expect(browser).not.toHaveBeenCalled();
  } finally { browser.mockRestore(); }
});

it("releases stopped and failed runs from a shared task cancellation signal", async () => {
  const controller = new AbortController();
  const before = getEventListeners(controller.signal, "abort").length;
  for (let n = 0; n < 3; n++) {
    const run = await AgentRun.start({ profile, cwd: root, command, callbacks, signal: controller.signal, probe: true });
    await run.stop();
    expect(getEventListeners(controller.signal, "abort").length).toBe(before);
  }
  await expectRejection(AgentRun.start({ profile, cwd: root, command: [...command, "--logged-out"], callbacks, signal: controller.signal, probe: true }));
  expect(getEventListeners(controller.signal, "abort").length).toBe(before);
});

it("does not retain completed turns on the live agent's process", async () => {
  let child: ChildProcess | undefined;
  const run = await AgentRun.start({ profile, cwd: root, command, callbacks, signal: new AbortController().signal, browser: false, onProcess: process => { child = process; } });
  try {
    const before = child!.listenerCount("exit");
    for (let n = 0; n < 3; n++) {
      await run.prompt("You are the Researcher in Petrina. Hand back notes.");
      expect(child!.listenerCount("exit")).toBe(before);
    }
  } finally { await run.stop(); }
});

const stopCases = [true, false].flatMap(firstTimesOut => [false, true].map(startsLate => ({ firstTimesOut, startsLate, stubborn: true, delay: 0, workerStubborn: true, cancel: false, firstRunning: false })));
stopCases.push(
  { firstTimesOut: true, startsLate: false, stubborn: false, delay: 0, workerStubborn: true, cancel: true, firstRunning: false },
  { firstTimesOut: false, startsLate: false, stubborn: true, delay: 2_500, workerStubborn: true, cancel: false, firstRunning: false },
  { firstTimesOut: false, startsLate: true, stubborn: true, delay: 2_500, workerStubborn: true, cancel: false, firstRunning: false },
  { firstTimesOut: false, startsLate: false, stubborn: false, delay: 3_800, workerStubborn: false, cancel: false, firstRunning: false },
  { firstTimesOut: false, startsLate: false, stubborn: true, delay: 0, workerStubborn: true, cancel: false, firstRunning: true },
);
for (const { firstTimesOut, startsLate, stubborn, delay, workerStubborn, cancel, firstRunning } of stopCases) it.skipIf(process.platform === "win32")(`finds detached work ${startsLate ? "started during stopping" : "already running"} within the quit limit when the first process scan ${firstTimesOut ? "times out" : firstRunning ? "still shows the owner running" : "succeeds"}${delay ? ` with consistently slow ${delay}ms listings` : ""}${stubborn ? "" : " and the agent exits gracefully"}${cancel ? " on cancellation" : ""}`, async () => {
  const dir = tempDir("petrina-stop-scan-");
  const record = join(dir, "worker-pid");
  const workerReady = join(dir, "worker-ready");
  const agent = join(dir, "agent.ts");
  const worker = `${workerStubborn ? 'process.on("SIGTERM", () => {});' : ""} setInterval(() => {}, 1000); require("node:fs").writeFileSync(${JSON.stringify(workerReady)}, "ready");`;
  writeFileSync(agent, `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const startWorker = () => { const child = spawn(process.execPath, ["-e", ${JSON.stringify(worker)}], { detached: true, stdio: "ignore" }); writeFileSync(${JSON.stringify(record)}, String(child.pid)); child.unref(); };
${startsLate ? 'process.once("SIGTERM", startWorker);' : "startWorker();"}
${stubborn ? 'process.argv.push("--stubborn");' : ""}
await import(${JSON.stringify(join(import.meta.dir, "fake-agent.ts"))});`);
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const workerPid = () => existsSync(record) ? Number(readFileSync(record, "utf8")) || undefined : undefined;
  const original = processes.execFile;
  const scanned: boolean[] = [];
  const allowances: number[] = [];
  const scansRunning = new Set<number>();
  const scanTimers = new Set<ReturnType<typeof setTimeout>>();
  let scans = 0, incomplete = 0;
  let child: ChildProcess | undefined, run: AgentRun | undefined;
  const unrelated = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
  const signals = spyOn(process, "kill");
  const snapshot = (first: boolean) => {
    const worker = workerPid();
    const owned = [{ pid: child!.pid!, parent: process.pid }, ...(worker ? [{ pid: worker, parent: child!.pid! }] : []), { pid: unrelated.pid, parent: process.pid }];
    return owned.filter(({ pid }) => alive(pid)).map(({ pid, parent }) => {
      let paused = false;
      for (const [index, [target, signal]] of signals.mock.calls.entries()) {
        if (Math.abs(target) !== pid || signals.mock.results[index]?.type !== "return") continue;
        if (signal === "SIGSTOP") paused = true;
        else if (signal === "SIGCONT") paused = false;
      }
      return `${pid} ${parent} ${first && firstRunning && pid === child!.pid ? "S" : paused ? "T" : "S"}`;
    }).join("\n");
  };
  const scan = spyOn(processes, "execFile").mockImplementation(((...args: unknown[]) => {
    if (args[0] !== "ps") return Reflect.apply(original, processes, args);
    const id = ++scans, first = id === 1;
    scansRunning.add(id);
    const hang = first && firstTimesOut;
    const options = args[2] as { timeout: number };
    allowances.push(options.timeout);
    const done = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    let reported = false;
    const finish = (error: Error | null, stdout: string, stderr: string) => {
      if (reported) return;
      reported = true; scansRunning.delete(id); scanned.push(!error); done(error, stdout, stderr);
    };
    // Script read outcomes from this fixture's real process identities and successful signals.
    // A native ps started inside the remaining quit allowance can itself time out under suite
    // load, turning an intended successful response into an unrelated failure. Native snapshots
    // and late-fork barriers have their own tests; these cases keep real stopping and deadlines.
    const listed = hang ? "" : snapshot(first);
    const timer = setTimeout(() => {
      scanTimers.delete(timer);
      if (hang) return finish(new Error("Process list timed out"), "", "");
      // A response deliberately slower than the caller's allowance is a timeout, even if
      // the snapshot is ready; this keeps the broken split-budget control failing.
      if (delay >= options.timeout) return finish(new Error("Process list timed out"), "", "");
      finish(null, listed, "");
    }, hang ? options.timeout : Math.min(delay, options.timeout));
    scanTimers.add(timer);
    return undefined;
  }) as typeof processes.execFile);
  const controller = new AbortController();
  try {
    run = await AgentRun.start({ profile, cwd: dir, command: [process.execPath, agent], callbacks: { ...callbacks, onCleanupIncomplete: () => { incomplete++; } }, signal: controller.signal, browser: false, onProcess: process => { child = process; } });
    if (!startsLate) await waitFor(() => existsSync(workerReady), "the detached worker to be ready before stopping");
    const from = Date.now();
    if (cancel) controller.abort();
    const stopping = run.stop();
    const pid = await waitFor(workerPid, "the detached worker to start");
    const complete = await stopping;
    expect(Date.now() - from).toBeLessThan(7_000);
    expect([child!.pid!, pid].filter(alive)).toEqual([]);
    expect(scanned).toEqual(firstTimesOut ? [false, true, true] : firstRunning ? [true, true, true] : workerStubborn ? [true, true] : [true]);
    expect(allowances[0]).toBe(4_000);
    expect(scansRunning.size).toBe(0);
    expect(scanTimers.size).toBe(0);
    expect(complete).toBe(true);
    expect(incomplete).toBe(0);
    expect(alive(unrelated.pid)).toBe(true);
    expect(signals.mock.calls.filter(([pid, signal]) => Math.abs(pid) === unrelated.pid && signal !== 0)).toEqual([]);
    expectPausesReclaimed(signals);
    if (!workerStubborn) expect(signals.mock.calls.some(([, signal]) => signal === "SIGKILL")).toBe(false);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  } finally {
    // Reclaim the missed worker even when this regression is run against broken shutdown code.
    for (const pid of [child?.pid, workerPid()].filter((pid): pid is number => !!pid)) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* Not a group leader, or already stopped. */ }
      try { process.kill(pid, "SIGKILL"); } catch { /* Already stopped. */ }
    }
    await run?.stop();
    signals.mockRestore();
    scan.mockRestore();
    scanTimers.forEach(clearTimeout);
    scansRunning.clear();
    unrelated.kill("SIGKILL");
    await unrelated.exited;
    await waitFor(() => ![child?.pid, workerPid()].some(pid => pid && alive(pid)), "the fixture's agent and detached worker to stop");
    removeDir(dir);
  }
});

for (const failure of ["unavailable", "timeout", "unpaused"] as const) it.skipIf(process.platform === "win32")(`keeps an incomplete-cleanup warning within the quit limit when process snapshots ${failure === "timeout" ? "all time out" : failure === "unpaused" ? "still show an owner running" : "are unavailable"}`, async () => {
  let child: ChildProcess | undefined;
  const original = processes.execFile;
  const scan = spyOn(processes, "execFile").mockImplementation(((...args: unknown[]) => {
    if (args[0] !== "ps") return Reflect.apply(original, processes, args);
    const done = args.at(-1) as (error: Error, stdout: string, stderr: string) => void;
    if (failure === "unpaused") return Reflect.apply(original, processes, [...args.slice(0, -1), (error: Error | null, stdout: string, stderr: string) => {
      // A successful old snapshot cannot confirm the pause, even if the live agent is paused.
      const stale = stdout.split("\n").map(line => Number(line.trim().split(/\s+/)[0]) === child?.pid ? line.replace(/T\S*\s*$/, "S") : line).join("\n");
      (done as (error: Error | null, stdout: string, stderr: string) => void)(error, stale, stderr);
    }]);
    const fail = () => done(new Error("Process list unavailable"), "", "");
    if (failure === "timeout") setTimeout(fail, (args[2] as { timeout: number }).timeout);
    else queueMicrotask(fail);
    return undefined;
  }) as typeof processes.execFile);
  let incomplete = 0;
  let run: AgentRun | undefined;
  const signals = spyOn(process, "kill");
  try {
    run = await AgentRun.start({ profile, cwd: root, command: [...command, "--stubborn"], callbacks: { ...callbacks, onCleanupIncomplete: () => { incomplete++; } }, signal: new AbortController().signal, browser: false, onProcess: process => { child = process; } });
    const from = Date.now();
    expect(await run.stop()).toBe(false);
    expect(Date.now() - from).toBeLessThan(7_000);
    expect(await run.stop()).toBe(false);
    expect(incomplete).toBe(1);
    expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
    expectPausesReclaimed(signals);
  } finally { await run?.stop(); signals.mockRestore(); scan.mockRestore(); }
});
