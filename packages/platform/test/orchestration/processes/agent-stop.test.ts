import { expect, it } from "bun:test";
import { stopAgentPrograms, type AgentStopTarget } from "../../../src/agent-stop.js";
import { AgentStopFixture } from "../../fixtures/agent-stop.js";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";

function expectPausesReclaimed(fixture: AgentStopFixture) {
  for (const [index, call] of fixture.signals.entries()) if (call.signal === "SIGSTOP" && call.delivered)
    expect(fixture.signals.slice(index + 1).some(next => next.target === call.target && (next.signal === "SIGCONT" || next.signal === "SIGKILL"))).toBe(true);
}
const stateIn = (listed: string, pid: number) => listed.split("\n").find(line => Number(line.trim().split(/\s+/)[0]) === pid)?.trim().split(/\s+/)[2];

// The public stop/abort/close entry dimension belongs to the paired native AgentRun controls.
// Their common captured-list policy runs here for both original agent behaviors, without fake ACP.
for (const exitsOnTerm of [false, true]) it(`does not trust a captured list that would release a late fork (agent ${exitsOnTerm ? "exits" : "ignores TERM"})`, async () => {
  const fixture = new AgentStopFixture();
  let forks = 0;
  const snapshots: string[] = [];
  fixture.parents = async () => {
    const listed = fixture.parentSnapshot(); snapshots.push(listed);
    if (stateIn(listed, fixture.rootPid) === "S") {
      const pid = fixture.workerPid + forks++;
      fixture.add({ pid, parent: fixture.rootPid, group: pid, state: "S", term: "ignore" });
    }
    return listed;
  };
  fixture.onSignal = (_target, signal) => {
    // The original parent waits for both late-fork barriers before its graceful exit.
    if (signal === "SIGCONT" && exitsOnTerm && forks >= 2) fixture.rows.delete(fixture.rootPid);
  };
  const complete = await stopAgentPrograms(fixture.target(), 2_000, true, fixture);
  expect(fixture.now()).toBeLessThan(7_000);
  expect(complete).toBe(true);
  expect(fixture.notes).toHaveLength(0);
  expect(fixture.alive(fixture.rootPid)).toBe(false);
  expect([...fixture.rows.values()].filter(row => row.parent === fixture.rootPid)).toEqual([]);
  expect(snapshots).toHaveLength(2);
  expect(snapshots.map(listed => stateIn(listed, fixture.rootPid))).toEqual(["T", "T"]);
  expect(fixture.rows.get(fixture.unrelatedPid)?.state).toBe("S");
  expect(fixture.signals.filter(call => Math.abs(call.target) === fixture.unrelatedPid)).toEqual([]);
  expectPausesReclaimed(fixture);
});

const stopCases = [true, false].flatMap(firstTimesOut => [false, true].map(listedLate => ({ firstTimesOut, listedLate, stubborn: true, delay: 0, workerStubborn: true, cancel: false, firstRunning: false, overrun: 0 })));
stopCases.push(
  { firstTimesOut: true, listedLate: false, stubborn: false, delay: 0, workerStubborn: true, cancel: true, firstRunning: false, overrun: 0 },
  { firstTimesOut: false, listedLate: false, stubborn: true, delay: 2_500, workerStubborn: true, cancel: false, firstRunning: false, overrun: 0 },
  { firstTimesOut: false, listedLate: true, stubborn: true, delay: 2_500, workerStubborn: true, cancel: false, firstRunning: false, overrun: 0 },
  { firstTimesOut: false, listedLate: false, stubborn: false, delay: 3_800, workerStubborn: false, cancel: false, firstRunning: false, overrun: 0 },
  { firstTimesOut: false, listedLate: false, stubborn: true, delay: 0, workerStubborn: true, cancel: false, firstRunning: true, overrun: 0 },
  { firstTimesOut: false, listedLate: true, stubborn: true, delay: 2_500, workerStubborn: true, cancel: false, firstRunning: false, overrun: 700 },
);
for (const { firstTimesOut, listedLate, stubborn, delay, workerStubborn, cancel, firstRunning, overrun } of stopCases) it(`${overrun ? "warns about undiscovered work after a delayed scan exhausts the rescan allowance" : `finds detached work ${listedLate ? "first listed during stopping" : "already listed"}`} within the quit limit when the first process scan ${firstTimesOut ? "times out" : firstRunning ? "still shows the owner running" : "succeeds"}${delay ? ` with consistently slow ${delay}ms listings` : ""}${stubborn ? "" : " and the agent exits gracefully"}${cancel ? " on cancellation" : ""}`, async () => {
  const fixture = new AgentStopFixture(stubborn ? "ignore" : "exit");
  fixture.add({ pid: fixture.workerPid, parent: fixture.rootPid, group: fixture.workerPid, state: "S", term: workerStubborn ? "ignore" : "exit" });
  const scanned: boolean[] = [];
  let stopping = false;
  fixture.onSignal = (target, signal) => { if (Math.abs(target) === fixture.rootPid && signal === "SIGTERM") stopping = true; };
  fixture.parents = async (timeout, index) => {
    const first = index === 1, hang = first && firstTimesOut;
    const listed = [...fixture.rows.values()].filter(row => row.pid !== fixture.workerPid || !listedLate || stopping)
      .map(row => `${row.pid} ${row.parent} ${first && firstRunning && row.pid === fixture.rootPid ? "S" : row.state}`).join("\n");
    fixture.time += (delay ? Math.min(delay, timeout) + (first ? overrun : 0) : hang ? timeout : 0);
    const failed = hang || (delay > 0 && delay >= timeout);
    scanned.push(!failed);
    return failed ? undefined : listed;
  };
  const complete = await stopAgentPrograms(fixture.target(), 2_000, true, fixture);
  expect(fixture.now()).toBeLessThan(7_000);
  expect([fixture.rootPid, fixture.workerPid].filter(pid => fixture.alive(pid))).toEqual(overrun ? [fixture.workerPid] : []);
  expect(scanned).toEqual(overrun ? [true, false] : firstTimesOut ? [false, true, true] : firstRunning ? [true, true, true] : workerStubborn ? [true, true] : [true]);
  expect(fixture.parentAllowances[0]).toBe(4_000);
  if (overrun) expect(fixture.parentAllowances[1]).toBe(2_300);
  expect(complete).toBe(!overrun);
  expect(fixture.notes).toHaveLength(overrun ? 1 : 0);
  expect(fixture.pendingReads.size).toBe(0);
  expect(fixture.alive(fixture.unrelatedPid)).toBe(true);
  expect(fixture.signals.filter(call => Math.abs(call.target) === fixture.unrelatedPid)).toEqual([]);
  if (listedLate && !overrun) {
    const term = fixture.signals.findIndex(call => Math.abs(call.target) === fixture.rootPid && call.signal === "SIGTERM");
    const discovered = fixture.signals.findIndex(call => Math.abs(call.target) === fixture.workerPid);
    expect(discovered).toBeGreaterThan(term);
    expect(fixture.signals[discovered]!.signal).toBe("SIGSTOP");
  }
  if (overrun) expect(fixture.signals.filter(call => Math.abs(call.target) === fixture.workerPid)).toEqual([]);
  expectPausesReclaimed(fixture);
  if (!workerStubborn) expect(fixture.signals.some(call => call.signal === "SIGKILL")).toBe(false);
});

it("joins an actually held process observation before reporting the stop", async () => {
  const fixture = new AgentStopFixture();
  let observed!: () => void, release!: (value: string) => void, finished = false;
  const reading = new Promise<void>(resolve => { observed = resolve; });
  const held = new Promise<string>(resolve => { release = resolve; });
  fixture.parents = async (_timeout, index) => {
    if (index !== 1) return fixture.parentSnapshot();
    observed(); return held;
  };
  const stopping = stopAgentPrograms(fixture.target(), 2_000, true, fixture);
  void stopping.then(() => { finished = true; }, () => { finished = true; });
  await setupWithCleanup(async () => {
    await Promise.race([reading, stopping.then(() => { throw new Error("The stop ended before its observation was admitted"); })]);
    expect(fixture.pendingReads.size).toBe(1);
    expect(finished).toBe(false);
    release(fixture.parentSnapshot());
    expect(await stopping).toBe(true);
    expect(fixture.pendingReads.size).toBe(0);
    expect(finished).toBe(true);
  }, async () => { release(fixture.parentSnapshot()); await stopping; });
});

for (const list of ["defunct", "unreadable", "late", "throws", "running", "silent"] as const) it(`${list === "defunct" ? "confirms" : "never confirms"} a stop with an uncollected recorded exit when the final list is ${list}`, async () => {
  const fixture = new AgentStopFixture();
  fixture.rows.get(fixture.rootPid)!.state = "Z";
  const target: AgentStopTarget = { pid: fixture.rootPid, running: () => true };
  const self = `${fixture.selfPid} ${fixture.selfPid} S`;
  fixture.groups = async timeout => {
    if (list === "late") { await fixture.sleep(timeout); return undefined; }
    if (list === "throws") throw new Error("Final process observation unavailable");
    return list === "unreadable" ? undefined : list === "running" ? `${self}\n${fixture.rootPid} ${fixture.rootPid} S` : list === "silent" ? self : `${self}\n${fixture.rootPid} ${fixture.rootPid} Z`;
  };
  const stopped = await stopAgentPrograms(target, 2_000, true, fixture);
  expect(fixture.now()).toBeLessThan(7_000);
  expect(fixture.parentAllowances).toHaveLength(2);
  expect(fixture.groupAllowances).toEqual([750]);
  expect(fixture.alive(fixture.rootPid)).toBe(true);
  expect(stopped).toBe(list === "defunct");
  if (list === "defunct") expect(fixture.notes).toEqual([]);
  else {
    expect(fixture.notes).toHaveLength(1);
    expect(fixture.notes[0]).toMatchObject({ stage: "forced", lists: ["read", "read"] });
    expect(fixture.notes[0]!.processes).toContainEqual({ pid: fixture.rootPid, state: ({ unreadable: "unknown", late: "unknown", throws: "unknown", running: "running", silent: "absent" } as const)[list], sources: ["target"] });
  }
});
