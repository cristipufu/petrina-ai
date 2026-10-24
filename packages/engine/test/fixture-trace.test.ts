import { rejectionOf } from "@petrina/test-support/rejections";
import { expect, it } from "bun:test";
import { FixtureTrace } from "./fixture-trace.js";

it("records a stalled nested phase before it finishes, including work still owned during shutdown", async () => {
  const lines: string[] = [];
  let now = 1_000;
  const trace = new FixtureTrace("Peer review", (line) => lines.push(line), () => now);
  const failure = new Error("Evidence could not be read");
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  try {
    trace.snapshot = () => ({ helpers: [{ sessionId: "peer-session", pid: 42 }], settling: ["task"] });
    const work = trace.during("Round 2", () => trace.during("Prepared evidence", () => held));
    now += 15_000;
    trace.report("still waiting");
    expect(lines.at(-1)).toContain('"phase":"Prepared evidence"');
    expect(lines.at(-1)).toContain('"pending":[{"phase":"Round 2","elapsedMs":15000},{"phase":"Prepared evidence","elapsedMs":15000}]');
    expect(lines.at(-1)).toContain('"sessionId":"peer-session","pid":42');
    release();
    await work;
    trace.report("still waiting");
    expect(lines.at(-1)).toContain('"pending":[]');
    expect(await rejectionOf(trace.during("Shutdown", async () => {
      trace.report("still waiting");
      throw failure;
    }))).toBe(failure);
    expect(lines.at(-1)).toContain('"phase":"Shutdown"');
    expect(lines.at(-1)).toContain('"settling":["task"]');
    expect(lines.at(-1)).toContain("Evidence could not be read");
  } finally { release(); trace.close(); }
});

it("keeps passing phases quiet without reading files that may not exist yet", async () => {
  const lines: string[] = [];
  const trace = new FixtureTrace("Peer review", (line) => lines.push(line));
  let snapshots = 0;
  try {
    trace.snapshot = () => { snapshots++; throw new Error("startup file does not exist yet"); };
    trace.mark("Creating fixture files");
    await trace.during("Round 1", async () => {
      await trace.during("Prepared evidence", async () => {});
    });
    await trace.during("Shutdown", async () => {});
    expect(lines).toEqual([]);
    expect(snapshots).toBe(0);
  } finally { trace.close(); }
});

it("keeps a held operation visible when another operation with the same label finishes", async () => {
  const lines: string[] = [];
  let now = 1_000;
  const trace = new FixtureTrace("Peer review", (line) => lines.push(line), () => now);
  const release = Promise.withResolvers<void>();
  const held = trace.during("Reading saved evidence", () => release.promise);
  try {
    now += 10;
    await trace.during("Reading saved evidence", async () => "other reviewer finished");
    now += 20;
    trace.report("still waiting");
    const evidence = JSON.parse(lines.at(-1)!.split("Peer review: ")[1]!);
    expect(evidence.pending).toEqual([{ phase: "Reading saved evidence", elapsedMs: 30 }]);
    expect(evidence.progress.at(-1)).toEqual({ phase: "Reading saved evidence: complete", elapsedMs: 10 });
    release.resolve();
    await held;
    trace.report("still waiting");
    expect(lines.at(-1)).toContain('"pending":[]');
  } finally { release.resolve(); await held; trace.close(); }
});

it("emits periodic evidence while the fixture remains held, without waiting for its rejection", async () => {
  let report!: () => void, release!: () => void;
  const reported = new Promise<void>((resolve) => { report = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const lines: string[] = [];
  // Only the diagnostic cadence changes here; no fixture or production deadline is shortened.
  const trace = new FixtureTrace("Peer review", (line) => {
    lines.push(line);
    if (line.includes('"event":"still waiting"')) report();
  }, Date.now, 1);
  const work = trace.during("Shutdown", () => held);
  try {
    await reported;
    expect(lines.at(-1)).toContain('"phase":"Shutdown"');
    expect(lines.at(-1)).not.toContain(": complete");
  } finally { release(); await work; trace.close(); }
});

it("retains phase evidence when startup diagnostics are unavailable and preserves the original failure", async () => {
  const lines: string[] = [];
  const trace = new FixtureTrace("Peer review", (line) => lines.push(line));
  const failure = new Error("Agent did not start");
  try {
    trace.snapshot = () => { throw new Error("startup.jsonl unavailable"); };
    expect(await rejectionOf(trace.during("Round 1", async () => { throw failure; }))).toBe(failure);
    expect(lines.at(-1)).toContain('"event":"failed"');
    expect(lines.at(-1)).toContain('"phase":"Round 1"');
    expect(lines.at(-1)).toContain("startup.jsonl unavailable");
    trace.snapshot = () => ({ bad: 1n }); // Even an unserializable diagnostic cannot replace failure.
    expect(await rejectionOf(trace.during("Shutdown", async () => { throw failure; }))).toBe(failure);
  } finally { trace.close(); }
});

for (const rejects of [false, true]) it(`distinguishes an unfinished process from ${rejects ? "a rejected exit wait" : "an exited process with its command result still pending"} without reading its pipes`, async () => {
  const lines: string[] = [];
  const trace = new FixtureTrace("Git cleanup", (line) => lines.push(line));
  const exit = Promise.withResolvers<number>(), result = Promise.withResolvers<string>();
  const stdout = new ReadableStream(), stderr = new ReadableStream();
  const child = { pid: 42, exited: exit.promise, exitCode: null as number | null, signalCode: null, killed: false, stdout, stderr };
  const failure = new Error("Command output failed");
  const work = trace.duringProcess("Git pruning", (capture) => { capture(child); return result.promise; });
  const evidence = () => {
    trace.report("still waiting");
    return JSON.parse(lines.at(-1)!.split("Git cleanup: ")[1]!);
  };
  try {
    expect(evidence().processes).toEqual([{
      phase: "Git pruning", pid: 42, exitWait: "pending", exitCode: null, signalCode: null, hasExited: false, stdoutLocked: false, stderrLocked: false,
    }]);
    if (rejects) exit.reject(new Error("Exit wait failed"));
    else { child.exitCode = 0; child.killed = true; exit.resolve(0); }
    await exit.promise.catch(() => undefined);
    const after = evidence();
    expect(after.processes[0].exitWait).toBe(rejects ? "rejected" : "completed");
    expect(after.processes[0].exitCode).toBe(rejects ? null : 0);
    expect(after.processes[0].hasExited).toBe(!rejects);
    if (rejects) expect(after.processes[0].error).toContain("Exit wait failed");
    expect(after.pending.map((entry: { phase: string }) => entry.phase)).toEqual(["Git pruning"]);
    expect(stdout.locked).toBe(false);
    expect(stderr.locked).toBe(false);
    result.reject(failure);
    expect(await rejectionOf(work)).toBe(failure);
    const failed = JSON.parse(lines.at(-1)!.split("Git cleanup: ")[1]!);
    expect(failed.event).toBe("failed");
    expect(failed.error).toContain("Command output failed");
    expect(failed.processes[0].pid).toBe(42);
    expect(failed.processes[0].exitWait).toBe(rejects ? "rejected" : "completed");
    expect(evidence().processes).toEqual([]);
    expect(evidence().pending).toEqual([]);
  } finally {
    exit.resolve(0); result.resolve("done");
    await work.catch(() => undefined);
    trace.close();
  }
});
