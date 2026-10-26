import { expectRejection } from "@petrina/test-support/rejections";
import { afterAll, afterEach, expect, it, spyOn } from "bun:test";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { stoppingActors } from "../../fixtures/stopping-actors.js";
import { getEventListeners } from "node:events";
import * as processes from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_CLEANUP_NOTE, AgentRun, stopAll } from "@petrina/agent-runtime/acp-run";
import { ENGINE_PROFILES } from "@petrina/agent-runtime/tools";
import { childState, parseChildState, presentStates, processList, readProcessList } from "@petrina/platform/process-tree";
import { defunctProcesses } from "@petrina/test-support/defunct-process";

const defuncts = defunctProcesses();
afterEach(() => defuncts.close());
afterAll(() => defuncts.close());
import { finishedHelper } from "@petrina/test-support/process-helper";
import { removeDir, tempDir, waitFor } from "@petrina/test-support/fixtures";
import { SLOW } from "@petrina/test-support/slow";

const nativeFixtures = stoppingActors();
afterEach(() => nativeFixtures.close());
const profile = ENGINE_PROFILES.find(profile => profile.id === "sol-high")!;
const callbacks = { onActivity() {}, onPlanStep() {}, onPermission: async () => "deny" as const };
type Signals = ReturnType<typeof spyOn<typeof process, "kill">>;


const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** One process's state column in a process list, if it is listed. */
const stateIn = (listed: string, pid: number) => listed.split("\n").find(line => Number(line.trim().split(/\s+/)[0]) === pid)?.trim().split(/\s+/)[2];
/** Whether this fixture's last successful pause or resume of a process, or of its group, left it paused. */
const pausedBy = (signals: Signals, pid: number) => {
  let paused = false;
  for (const [index, [target, signal]] of signals.mock.calls.entries()) {
    if (Math.abs(target) !== pid || signals.mock.results[index]?.type !== "return") continue;
    if (signal === "SIGSTOP") paused = true;
    else if (signal === "SIGCONT") paused = false;
  }
  return paused;
};
/** Whether this fixture successfully forced a process, or the group it leads, to stop: it can only await collection. */
const killedBy = (signals: Signals, pid: number) => signals.mock.calls.some(([target, signal], index) => Math.abs(target) === pid && signal === "SIGKILL" && signals.mock.results[index]?.type === "return");

const expectPausesReclaimed = (signals: Signals) => {
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
await import(${JSON.stringify(join(import.meta.dir, "../../fixtures/session-agent.ts"))});`);
  const original = processes.execFile;
  let forks = 0;
  const workerPids = () => Array.from({ length: forks }, (_, i) => workerFile(i + 1, "pid")).flatMap(path => existsSync(path) ? Number(readFileSync(path, "utf8")) || [] : []);
  const controller = new AbortController();
  // Read natively before the stop: the stop's final look names process groups, and lists this test's.
  const ownGroup = Number((await waitFor(() => processList(["-o", "pgid=", "-p", String(process.pid)], 4_000 * SLOW), "this test's process group")).trim());
  const unrelated = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
  const signals = spyOn(process, "kill");
  let child: ChildProcess | undefined, run: AgentRun | undefined, incomplete = 0, verifying = false;
  const snapshots: string[] = [];
  // The stop's lists show this test's and this fixture's live processes with the parent links, or
  // for its final look the process groups, and the state its own successful signals left them in:
  // forced to stop, paused or running. A native ps here could answer after the stop's read
  // allowance, which rightly reports cleanup incomplete (the failure controls below); the stop
  // with no work keeps native list coverage. Verification after the stop reads natively.
  const listing = (groups: boolean) => {
    const linked = child!.exitCode === null && child!.signalCode === null;
    // The agent and its detached workers lead their own groups; the unrelated program shares this test's.
    const owned = [
      { pid: process.pid, parent: process.ppid, group: ownGroup },
      { pid: child!.pid!, parent: process.pid, group: child!.pid! },
      ...workerPids().map(pid => ({ pid, parent: linked ? child!.pid! : 1, group: pid })),
      { pid: unrelated.pid, parent: process.pid, group: ownGroup },
    ];
    return owned.filter(({ pid }) => alive(pid)).map(({ pid, parent, group }) => `${pid} ${groups ? group : parent} ${killedBy(signals, pid) ? "Z" : pausedBy(signals, pid) ? "T" : "S"}`).join("\n");
  };
  const scan = spyOn(processes, "execFile").mockImplementation(((...args: unknown[]) => {
    if (args[0] !== "ps" || verifying) return Reflect.apply(original, processes, args);
    const done = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    // Listed when the stop asks. Each ownership list showing the agent able to run releases another
    // fork. Deliver that exact old list only after its new detached, TERM-ignoring worker is ready.
    // The final look after the forced stop asks for groups, and is no ownership snapshot.
    const groups = (args[1] as string[]).some(arg => arg.includes("pgid="));
    const listed = listing(groups);
    if (!groups) snapshots.push(listed);
    void (async () => {
      // Like a real read, answer only once execFile has returned the helper the reader inspects.
      await Promise.resolve();
      if (!groups && stateIn(listed, child!.pid!) === "S") {
        const n = ++forks;
        writeFileSync(workerFile(n, "release"), "ready");
        await waitFor(() => existsSync(workerFile(n, "ready")) && existsSync(workerFile(n, "pid")), "the late worker to cross the captured-snapshot barrier");
      }
      done(null, listed, "");
    })().catch(error => done(error, "", ""));
    return finishedHelper();
  }) as typeof processes.execFile);
  try {
    run = await AgentRun.start({ profile, cwd: dir, command: [process.execPath, agent], callbacks: { ...callbacks, onCleanupIncomplete: () => { incomplete++; } }, signal: controller.signal, browser: false, onProcess: process => { child = process; } });
    const from = Date.now();
    if (entry === "abort") controller.abort();
    if (entry === "close") run.close();
    if (entry !== "stop") await waitFor(() => snapshots.length > 0, "the stop to begin before joining its result");
    const complete = await run.stop();
    expect(Date.now() - from).toBeLessThan(7_000);
    verifying = true;
    expect(complete).toBe(true);
    expect(incomplete).toBe(0);
    // Native evidence, outside the stop's allowance: the agent and every worker it forked have
    // stopped, and the unrelated program still runs unpaused.
    const after = await waitFor(() => readProcessList(4_000 * SLOW), "a native process list after the stop");
    expect(parseChildState(after, child!.pid!)).toBe("ended");
    expect(workerPids().filter(pid => parseChildState(after, pid) !== "ended")).toEqual([]);
    expect(snapshots).toHaveLength(2);
    expect(existsSync(stopping)).toBe(true);
    expect(snapshots.map(listed => stateIn(listed, child!.pid!))).toEqual(["T", "T"]);
    expect(parseChildState(after, unrelated.pid)).toBe("running");
    expect(stateIn(after, unrelated.pid)).not.toContain("T");
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
      for (const pid of [child?.pid, ...workerPids()]) if (pid && await childState(pid, 4_000 * SLOW) !== "ended") return false;
      return true;
    }, "the fixture's programs to stop");
    removeDir(dir);
  }
});

it.skipIf(process.platform === "win32")("stops an agent with no work after one list and no forced stop", async () => nativeFixtures.use(async fixture => {
  let child: ChildProcess | undefined, run: AgentRun | undefined, incomplete = 0, scans = 0;
  const original = processes.execFile, controller = new AbortController();
  let scan: ReturnType<typeof spyOn<typeof processes, "execFile">> | undefined, signals: Signals | undefined;
  const cleanup = async () => {
    const settled = await Promise.allSettled([run?.stop()]);
    const errors = settled.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    for (const restore of [() => signals?.mockRestore(), () => scan?.mockRestore()]) try { restore(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "No-work stop fixture cleanup failed");
  };
  await setupWithCleanup(async () => {
    scan = spyOn(processes, "execFile");
    scan.mockImplementation(((...args: unknown[]) => {
      if (args[0] === "ps") scans++;
      return Reflect.apply(original, processes, args);
    }) as typeof processes.execFile);
    signals = spyOn(process, "kill");
    run = await fixture.agent(controller, { profile, callbacks: { ...callbacks, onCleanupIncomplete: () => { incomplete++; } }, onProcess: process => { child = process; } });
    expect(await run.stop()).toBe(true);
    expect(scans).toBe(1);
    expect(incomplete).toBe(0);
    expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
    expect(signals.mock.calls.some(([, signal]) => signal === "SIGKILL")).toBe(false);
    expectPausesReclaimed(signals);
  }, cleanup);
  await cleanup();
}));


const stopCases = [true, false].flatMap(firstTimesOut => [false, true].map(listedLate => ({ firstTimesOut, listedLate, stubborn: true, delay: 0, workerStubborn: true, cancel: false, firstRunning: false, overrun: 0 })));
stopCases.push(
  { firstTimesOut: true, listedLate: false, stubborn: false, delay: 0, workerStubborn: true, cancel: true, firstRunning: false, overrun: 0 },
  { firstTimesOut: false, listedLate: false, stubborn: true, delay: 2_500, workerStubborn: true, cancel: false, firstRunning: false, overrun: 0 },
  { firstTimesOut: false, listedLate: true, stubborn: true, delay: 2_500, workerStubborn: true, cancel: false, firstRunning: false, overrun: 0 },
  { firstTimesOut: false, listedLate: false, stubborn: false, delay: 3_800, workerStubborn: false, cancel: false, firstRunning: false, overrun: 0 },
  { firstTimesOut: false, listedLate: false, stubborn: true, delay: 0, workerStubborn: true, cancel: false, firstRunning: true, overrun: 0 },
  { firstTimesOut: false, listedLate: true, stubborn: true, delay: 2_500, workerStubborn: true, cancel: false, firstRunning: false, overrun: 700 },
);
for (const { firstTimesOut, listedLate, stubborn, delay, workerStubborn, cancel, firstRunning, overrun } of stopCases) it.skipIf(process.platform === "win32")(`${overrun ? "warns about undiscovered work after a delayed scan exhausts the rescan allowance" : `finds detached work ${listedLate ? "first listed during stopping" : "already listed"}`} within the quit limit when the first process scan ${firstTimesOut ? "times out" : firstRunning ? "still shows the owner running" : "succeeds"}${delay ? ` with consistently slow ${delay}ms listings` : ""}${stubborn ? "" : " and the agent exits gracefully"}${cancel ? " on cancellation" : ""}`, async () => {
  const dir = tempDir("petrina-stop-scan-");
  const record = join(dir, "worker-pid");
  const workerReady = join(dir, "worker-ready");
  const publishRecord = join(dir, "publish-worker-record");
  const agent = join(dir, "agent.ts");
  // Exercise a delayed record without letting publication race the scripted process lists.
  const delayedRecord = listedLate && delay === 2_500;
  const worker = `const { existsSync, writeFileSync } = require("node:fs");
${workerStubborn ? 'process.on("SIGTERM", () => {});' : ""}
setInterval(() => {}, 1000);
writeFileSync(${JSON.stringify(workerReady)}, "ready");
${delayedRecord ? `const publish = setInterval(() => {
  if (!existsSync(${JSON.stringify(publishRecord)})) return;
  writeFileSync(${JSON.stringify(record)}, String(process.pid)); clearInterval(publish);
}, 5);` : ""}`;
  writeFileSync(agent, `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const startWorker = () => { const child = spawn(process.execPath, ["-e", ${JSON.stringify(worker)}], { detached: true, stdio: "ignore" }); ${delayedRecord ? "" : `writeFileSync(${JSON.stringify(record)}, String(child.pid));`} child.unref(); };
startWorker();
${stubborn ? 'process.argv.push("--stubborn");' : ""}
await import(${JSON.stringify(join(import.meta.dir, "../../fixtures/session-agent.ts"))});`);
  const workerPid = () => existsSync(record) ? Number(readFileSync(record, "utf8")) || undefined : undefined;
  const original = processes.execFile;
  const scanned: boolean[] = [];
  const allowances: number[] = [];
  const scansRunning = new Set<number>();
  const scanTimers = new Set<ReturnType<typeof setTimeout>>();
  let scans = 0, incomplete = 0;
  let child: ChildProcess | undefined, run: AgentRun | undefined;
  const realNow = Date.now, realSleep = Bun.sleep;
  let now = 0;
  let clock: ReturnType<typeof spyOn<typeof Date, "now">> | undefined;
  let sleep: ReturnType<typeof spyOn<typeof Bun, "sleep">> | undefined;
  const unrelated = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
  const signals = spyOn(process, "kill");
  const snapshot = (first: boolean) => {
    const stopping = signals.mock.calls.some(([pid, signal], index) => Math.abs(pid) === child!.pid && signal === "SIGTERM" && signals.mock.results[index]?.type === "return");
    const worker = !listedLate || stopping ? workerPid() : undefined;
    const owned = [{ pid: child!.pid!, parent: process.pid }, ...(worker ? [{ pid: worker, parent: child!.pid! }] : []), { pid: unrelated.pid, parent: process.pid }];
    return owned.filter(({ pid }) => alive(pid)).map(({ pid, parent }) => `${pid} ${parent} ${first && firstRunning && pid === child!.pid ? "S" : pausedBy(signals, pid) ? "T" : "S"}`).join("\n");
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
    // Script discovery independently of native startup: a paused parent can have forked a
    // worker whose pid file it has not finished writing. The late-fork barriers above cover a
    // real fork after a captured list; these cases keep real stopping and read deadlines.
    // Read outcomes use this fixture's ready process identities and successful signals: a
    // native ps within the remaining allowance can itself time out under suite load.
    const listed = hang ? "" : snapshot(first);
    const finishRead = () => {
      if (hang) return finish(new Error("Process list timed out"), "", "");
      // A response deliberately slower than the caller's allowance is a timeout, even if
      // the snapshot is ready; this keeps the broken split-budget control failing.
      if (delay >= options.timeout) return finish(new Error("Process list timed out"), "", "");
      finish(null, listed, "");
    };
    if (delay) {
      // These reads test allowance arithmetic, not timer delivery under host load. Advance
      // exactly the scripted duration; real SIGTERM/SIGKILL and their exit waits stay real.
      now += Math.min(delay, options.timeout) + (first ? overrun : 0);
      queueMicrotask(finishRead);
    } else {
      const timer = setTimeout(() => { scanTimers.delete(timer); finishRead(); }, hang ? options.timeout : 0);
      scanTimers.add(timer);
    }
    return finishedHelper();
  }) as typeof processes.execFile);
  const controller = new AbortController();
  try {
    run = await AgentRun.start({ profile, cwd: dir, command: [process.execPath, agent], callbacks: { ...callbacks, onCleanupIncomplete: () => { incomplete++; } }, signal: controller.signal, browser: false, onProcess: process => { child = process; } });
    await waitFor(() => existsSync(workerReady), "the detached worker to be ready before stopping");
    if (delayedRecord) {
      expect(workerPid()).toBeUndefined();
      writeFileSync(publishRecord, "ready");
    }
    const pid = await waitFor(workerPid, "the detached worker's complete record before stopping");
    if (delay) {
      clock = spyOn(Date, "now").mockImplementation(() => now);
      sleep = spyOn(Bun, "sleep").mockImplementation(async ms => {
        const duration = ms instanceof Date ? ms.getTime() - now : ms;
        await realSleep(duration);
        now += duration;
      });
    }
    const wallFrom = realNow();
    const from = Date.now();
    if (cancel) controller.abort();
    const stopping = run.stop();
    const complete = await stopping;
    expect(realNow() - wallFrom).toBeLessThan(7_000);
    expect(Date.now() - from).toBeLessThan(7_000);
    expect([child!.pid!, pid].filter(alive)).toEqual(overrun ? [pid] : []);
    expect(scanned).toEqual(overrun ? [true, false] : firstTimesOut ? [false, true, true] : firstRunning ? [true, true, true] : workerStubborn ? [true, true] : [true]);
    expect(allowances[0]).toBe(4_000);
    if (overrun) expect(allowances[1]).toBe(2_300);
    expect(scansRunning.size).toBe(0);
    expect(scanTimers.size).toBe(0);
    expect(complete).toBe(!overrun);
    expect(incomplete).toBe(overrun ? 1 : 0);
    expect(alive(unrelated.pid)).toBe(true);
    expect(signals.mock.calls.filter(([pid, signal]) => Math.abs(pid) === unrelated.pid && signal !== 0)).toEqual([]);
    if (listedLate && !overrun) {
      const term = signals.mock.calls.findIndex(([pid, signal]) => Math.abs(pid) === child!.pid && signal === "SIGTERM");
      const discovered = signals.mock.calls.findIndex(([target, signal]) => Math.abs(target) === pid && signal !== 0);
      expect(discovered).toBeGreaterThan(term);
      expect(signals.mock.calls[discovered]![1]).toBe("SIGSTOP");
    }
    if (overrun) expect(signals.mock.calls.filter(([target, signal]) => Math.abs(target) === pid && signal !== 0)).toEqual([]);
    expectPausesReclaimed(signals);
    if (!workerStubborn) expect(signals.mock.calls.some(([, signal]) => signal === "SIGKILL")).toBe(false);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  } finally {
    sleep?.mockRestore(); clock?.mockRestore();
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

for (const failure of ["unavailable", "timeout", "unpaused"] as const) it.skipIf(process.platform === "win32")(`keeps an incomplete-cleanup warning within the quit limit when process snapshots ${failure === "timeout" ? "all time out" : failure === "unpaused" ? "still show an owner running" : "are unavailable"}`, async () => nativeFixtures.use(async fixture => {
  let child: ChildProcess | undefined, incomplete = 0, run: AgentRun | undefined;
  const original = processes.execFile, controller = new AbortController();
  let scan: ReturnType<typeof spyOn<typeof processes, "execFile">> | undefined, signals: Signals | undefined;
  const cleanup = async () => {
    const settled = await Promise.allSettled([run?.stop()]);
    const errors = settled.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    for (const restore of [() => signals?.mockRestore(), () => scan?.mockRestore()]) try { restore(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Incomplete-stop fixture cleanup failed");
  };
  await setupWithCleanup(async () => {
    scan = spyOn(processes, "execFile");
    scan.mockImplementation(((...args: unknown[]) => {
      if (args[0] !== "ps") return Reflect.apply(original, processes, args);
      const done = args.at(-1) as (error: Error, stdout: string, stderr: string) => void;
      if (failure === "unpaused") return Reflect.apply(original, processes, [...args.slice(0, -1), (error: Error | null, stdout: string, stderr: string) => {
        const stale = stdout.split("\n").map(line => Number(line.trim().split(/\s+/)[0]) === child?.pid ? line.replace(/T\S*\s*$/, "S") : line).join("\n");
        (done as (error: Error | null, stdout: string, stderr: string) => void)(error, stale, stderr);
      }]);
      const fail = () => done(new Error("Process list unavailable"), "", "");
      if (failure === "timeout") setTimeout(fail, (args[2] as { timeout: number }).timeout);
      else queueMicrotask(fail);
      return undefined;
    }) as typeof processes.execFile);
    signals = spyOn(process, "kill");
    const logged: string[] = [];
    run = await fixture.agent(controller, { profile, stubborn: true, callbacks: { ...callbacks, onCleanupIncomplete: () => { incomplete++; }, onLog: text => { logged.push(text); } }, onProcess: process => { child = process; } });
    const from = Date.now();
    expect(await run.stop()).toBe(false);
    expect(Date.now() - from).toBeLessThan(7_000);
    expect(await run.stop()).toBe(false);
    expect(incomplete).toBe(1);
    const notes = logged.join("").split("\n").filter(line => line.startsWith(AGENT_CLEANUP_NOTE));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(new RegExp(`^${AGENT_CLEANUP_NOTE} stage=forced elapsed=\\d+ms lists=unreadable,unreadable processes=0 shown=0 omitted=0$`));
    expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
    expectPausesReclaimed(signals);
  }, cleanup);
  await cleanup();
}));

const groups = (timeout: number) => processList(["-A", "-o", "pid=,pgid=,stat="], timeout);

it.skipIf(process.platform === "win32")("reclaims an uncollected fixture interrupted before its process number is read", async () => {
  let holderPid: number | undefined;
  await expectRejection(defuncts.use(async () => { throw new Error("The interrupted setup unexpectedly completed"); }, { beforeRead(pid) { holderPid = pid; throw new Error("Fixture setup interrupted"); } }), "Fixture setup interrupted");
  expect(holderPid).toBeDefined(); expect(alive(holderPid!)).toBe(false);
});

// The stop's final second reads the process list for what is still present after the forced stop. Only a complete
// list showing it defunct confirms the stop; an unreadable list, or one that shows it running, never does.
for (const list of ["defunct", "unreadable", "late", "throws", "running", "silent"] as const) it.skipIf(process.platform === "win32")(`${list === "defunct" ? "confirms" : "never confirms"} a stop whose agent exited without being collected when the final list ${{ defunct: "shows it defunct", unreadable: "cannot be read", late: "does not arrive by its deadline", throws: "throws an error", running: "shows it running", silent: "never names it or its group" }[list]}`, async () => defuncts.use(async agent => {
  const self = agent.self;
  const complete = `${self}\n${agent.pid} ${agent.pid} Z`;
  const ownership = `${process.pid} ${process.ppid} S\n${agent.pid} ${agent.holderPid} Z`;
  const original = processes.execFile;
  let ownershipReads = 0;
  let scan: ReturnType<typeof spyOn<typeof processes, "execFile">> | undefined;
  let clock: ReturnType<typeof spyOn<typeof Date, "now">> | undefined;
  let sleep: ReturnType<typeof spyOn<typeof Bun, "sleep">> | undefined;
  const cleanup = async () => {
    const errors: unknown[] = [];
    for (const restore of [() => sleep?.mockRestore(), () => clock?.mockRestore(), () => scan?.mockRestore()]) try { restore(); } catch (error) { errors.push(error); }
    try { await agent.release(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Final stop observation cleanup failed");
  };
  await setupWithCleanup(async () => {
  scan = spyOn(processes, "execFile");
  scan.mockImplementation(((...args: unknown[]) => {
    if (args[0] !== "ps") return Reflect.apply(original, processes, args);
    ownershipReads++;
    const done = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    queueMicrotask(() => done(null, ownership, ""));
    return finishedHelper();
  }) as typeof processes.execFile);
  const wallNow = Date.now;
  let now = 0;
  clock = spyOn(Date, "now");
  clock.mockImplementation(() => now);
  // This process already ended. Control only the observation window; real stop/deadline
  // coverage below retains native clocks and reads, as do the live-agent cases above.
  sleep = spyOn(Bun, "sleep");
  sleep.mockImplementation(async ms => { now += ms instanceof Date ? ms.getTime() - now : ms; });
  const reads: number[] = [], notes: string[] = [];
    const read = async (timeout: number) => {
      reads.push(timeout);
      if (list === "late") { await Bun.sleep(timeout); return undefined; }
      if (list === "throws") throw new Error("Final process observation unavailable");
      return list === "unreadable" ? undefined : list === "running" ? `${self}\n${agent.pid} ${agent.pid} S` : list === "silent" ? self : complete;
    };
    const wallFrom = wallNow();
    const from = Date.now();
    const stopped = await stopAll({ pid: agent.pid, exitCode: null, signalCode: null } as unknown as ChildProcess, 2_000, true, (line) => { notes.push(line); }, read);
    if (stopped !== (list === "defunct")) console.error("Uncollected-agent stop evidence:", JSON.stringify({ list, pid: agent.pid, stopped, elapsed: Date.now() - from, ownershipReads, reads, notes }));
    expect(wallNow() - wallFrom).toBeLessThan(7_000);
    expect(Date.now() - from).toBeLessThan(7_000);
    expect(ownershipReads).toBe(2); expect(reads).toEqual([750]);
    expect(alive(agent.pid)).toBe(true);
    expect(alive(agent.holderPid)).toBe(true);
    expect(stopped).toBe(list === "defunct");
    if (list === "defunct") expect(notes).toEqual([]);
    else {
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatch(new RegExp(`^${AGENT_CLEANUP_NOTE} stage=forced elapsed=\\d+ms lists=read,read processes=\\d+ shown=\\d+ omitted=0 owned=.*${agent.pid}:${{ unreadable: "unknown", late: "unknown", throws: "unknown", running: "running", silent: "absent" }[list]}:target`));
    }
  }, cleanup);
  await cleanup();
}));

it.skipIf(process.platform === "win32")("reports only what native observations prove when stopping an uncollected agent within the quit deadline", async () => defuncts.use(async agent => {
  const notes: string[] = [], reads: { timeout: number; ms: number; listing: string | undefined }[] = [];
  try {
    const read = async (timeout: number) => {
      const from = Date.now(), listing = await groups(timeout);
      reads.push({ timeout, ms: Date.now() - from, listing }); return listing;
    };
    const from = Date.now();
    const stopped = await stopAll({ pid: agent.pid, exitCode: null, signalCode: null } as unknown as ChildProcess, 2_000, true, line => notes.push(line), read);
    const elapsed = Date.now() - from;
    console.log("Native uncollected-agent stop evidence:", JSON.stringify({ pid: agent.pid, stopped, elapsed, notes, reads: reads.map(({ timeout, ms, listing }) => ({ timeout, ms, state: listing === undefined ? "unreadable" : presentStates(listing, [-agent.pid, agent.pid]) })) }));
    expect(elapsed).toBeLessThan(7_000);
    const unreadableOwnership = notes.some(note => /lists=\S*unreadable/.test(note));
    expect(stopped).toBe(!unreadableOwnership && presentStates(reads.at(-1)?.listing, [-agent.pid, agent.pid]).ended);
    expect(notes).toHaveLength(stopped ? 0 : 1);
    expect(alive(agent.holderPid)).toBe(true);
    // Setup proved the real target defunct; it cannot resume. release() confirms native
    // disappearance after its still-live holder ends, without another timed ps assumption.
  } finally { await agent.release(); }
}));

// Actual entry/termination/pipe obligations paired with the portable captured-list policy.
// Detached-fork/native-ancestry conjunctions remain separate; this fixed ACP peer does not fork.
for (const entry of ["stop", "abort", "close"] as const) for (const exitsOnTerm of [false, true]) it.skipIf(process.platform === "win32")(`native AgentRun ${entry} retains termination and pipe ownership when its peer ${exitsOnTerm ? "exits" : "ignores TERM"}`, async () => nativeFixtures.use(async fixture => {
  const controller = new AbortController();
  let child: ChildProcess | undefined, run: AgentRun | undefined, incomplete = 0, streamsClosed = false;
  let closed!: () => void, failed!: (error: unknown) => void;
  const nativeClosed = new Promise<void>((resolve, reject) => { closed = resolve; failed = reject; });
  void nativeClosed.catch(() => undefined);
  let signals: Signals | undefined;
  const cleanup = async () => {
    const result = await Promise.allSettled([run?.stop()]);
    const errors = result.flatMap(outcome => outcome.status === "rejected" ? [outcome.reason] : []);
    try { signals?.mockRestore(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Native public-entry fixture cleanup failed");
  };
  await setupWithCleanup(async () => {
    signals = spyOn(process, "kill");
    run = await fixture.agent(controller, { profile, stubborn: !exitsOnTerm,
      callbacks: { ...callbacks, onCleanupIncomplete() { incomplete++; } },
      onProcess(actual) {
        child = actual;
        actual.once("close", () => { streamsClosed = true; closed(); });
        actual.once("error", failed);
      },
    });
    const from = Date.now();
    if (entry === "abort") controller.abort();
    if (entry === "close") run.close();
    const stopped = await run.stop();
    expect(Date.now() - from).toBeLessThan(7_000);
    expect(stopped).toBe(true);
    expect(incomplete).toBe(0);
    expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
    expect(signals.mock.calls.some(([target, signal]) => Math.abs(target) === child!.pid && signal === "SIGTERM")).toBe(true);
    expect(signals.mock.calls.some(([target, signal]) => Math.abs(target) === child!.pid && signal === "SIGKILL")).toBe(!exitsOnTerm);
    expectPausesReclaimed(signals);
    expect(await run.stop()).toBe(true);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    await waitFor(() => streamsClosed, "the native ACP peer to report closed stdout and stderr", 5_000, { during: nativeClosed });
    expect(streamsClosed).toBe(true);
  }, cleanup);
  await cleanup();
}));
