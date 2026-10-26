import { expectRejection } from "@petrina/test-support/rejections";
import { afterAll, afterEach, expect, it, spyOn } from "bun:test";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { stoppingActors } from "../../fixtures/stopping-actors.js";
import { getEventListeners } from "node:events";
import * as processes from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { AGENT_CLEANUP_NOTE, AgentRun, stopAll } from "@petrina/agent-runtime/acp-run";
import { ENGINE_PROFILES } from "@petrina/agent-runtime/tools";
import { childState, parseChildState, parseProcessState, presentStates, processList, readProcessList } from "@petrina/platform/process-tree";
import { defunctProcesses } from "@petrina/test-support/defunct-process";

const defuncts = defunctProcesses();
afterEach(() => defuncts.close());
afterAll(() => defuncts.close());
import { waitFor } from "@petrina/test-support/fixtures";
import { SLOW } from "@petrina/test-support/slow";

const nativeFixtures = stoppingActors();
afterEach(() => nativeFixtures.close());
const profile = ENGINE_PROFILES.find(profile => profile.id === "sol-high")!;
const callbacks = { onActivity() {}, onPlanStep() {}, onPermission: async () => "deny" as const };
type Signals = ReturnType<typeof spyOn<typeof process, "kill">>;


const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** One process's state column in a process list, if it is listed. */
const stateIn = (listed: string, pid: number) => listed.split("\n").find(line => Number(line.trim().split(/\s+/)[0]) === pid)?.trim().split(/\s+/)[2];
const expectPausesReclaimed = (signals: Signals) => {
  const { calls, results } = signals.mock;
  for (const [index, [pid, signal]] of calls.entries()) if (signal === "SIGSTOP") {
    // A known owner can already be gone when the final pause is attempted.
    if (results[index]?.type === "throw") continue;
    expect(calls.slice(index + 1).some(([target, next]) => target === pid && (next === "SIGCONT" || next === "SIGKILL"))).toBe(true);
  }
};

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

// Native conjunctions: real ACP -> detached child ancestry, real signals and final
// native state. The guardian is fallback ownership only, after all subject assertions.
for (const exitsOnTerm of [true, false]) it.skipIf(process.platform === "win32")(`stops an actual detached ACP fork whose family ${exitsOnTerm ? "exits" : "ignores TERM"} without touching its unrelated peer`, async () => nativeFixtures.use(async fixture => {
  const controller = new AbortController();
  let child: ChildProcess | undefined, run: AgentRun | undefined, incomplete = 0, streamsClosed = false;
  let closed!: () => void, failed!: (error: unknown) => void;
  const nativeClosed = new Promise<void>((resolve, reject) => { closed = resolve; failed = reject; });
  void nativeClosed.catch(() => undefined);
  let signals: Signals | undefined;
  const cleanup = async () => {
    const settled = await Promise.allSettled([run?.stop()]);
    const errors = settled.flatMap(outcome => outcome.status === "rejected" ? [outcome.reason] : []);
    try { signals?.mockRestore(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Native detached-fork subject cleanup failed");
  };
  await setupWithCleanup(async () => {
    signals = spyOn(process, "kill");
    run = await fixture.agent(controller, { profile, stubborn: !exitsOnTerm, fork: { stubborn: !exitsOnTerm },
      callbacks: { ...callbacks, onCleanupIncomplete() { incomplete++; } },
      onProcess(actual) {
        child = actual;
        actual.once("close", () => { streamsClosed = true; closed(); });
        actual.once("error", failed);
      },
    });
    const worker = await fixture.worker(), unrelated = await fixture.unrelated();
    const ancestry = await readProcessList(4_000 * SLOW);
    expect(ancestry).toBeDefined();
    expect(ancestry!.split("\n").some(line => {
      const fields = line.trim().split(/\s+/);
      return Number(fields[0]) === worker.pid && Number(fields[1]) === child!.pid;
    })).toBe(true);
    const group = await processList(["-o", "pgid=", "-p", String(worker.pid)], 4_000 * SLOW);
    expect(Number(group?.trim())).toBe(worker.pid);
    expect(worker.parentPid).toBe(child!.pid!);
    expect(await childState(worker.pid)).toBe("running");
    expect(await childState(unrelated.pid!)).toBe("running");
    const from = Date.now();
    expect(await run.stop()).toBe(true);
    expect(Date.now() - from).toBeLessThan(7_000);
    expect(incomplete).toBe(0);
    expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
    expect(signals.mock.calls.some(([target, signal]) => Math.abs(target) === worker.pid && signal === "SIGTERM")).toBe(true);
    expect(signals.mock.calls.some(([target, signal]) => Math.abs(target) === worker.pid && signal === "SIGKILL")).toBe(!exitsOnTerm);
    expectPausesReclaimed(signals);
    expect(await childState(worker.pid)).toBe("ended");
    expect(await run.stop()).toBe(true);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    await waitFor(() => streamsClosed, "the actual forking ACP peer's output to close", 5_000, { during: nativeClosed });
    expect(streamsClosed).toBe(true);
    const after = await readProcessList(4_000 * SLOW);
    expect(after).toBeDefined();
    expect(after!.split("\n").some(line => Number(line.trim().split(/\s+/)[0]) === process.pid)).toBe(true);
    expect(parseProcessState(after!, worker.pid)).toBe("absent");
    expect(parseChildState(after!, unrelated.pid!)).toBe("running");
    expect(stateIn(after!, unrelated.pid!)).not.toContain("T");
    expect(await childState(unrelated.pid!)).toBe("running");
    expect(signals.mock.calls.some(([target, signal]) => Math.abs(target) === unrelated.pid && signal !== 0)).toBe(false);
  }, cleanup);
  await cleanup();
}));


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
