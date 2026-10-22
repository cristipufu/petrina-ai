import { describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { machineInterruption, powerInterruption, readMachinePowerRecords, readMachineRecords } from "../src/check-interruption.js";

const records = `2026-10-21 17:55:44 +0300 Sleep               Entering Sleep state due to 'Clamshell Sleep':TCPKeepAlive=active Using Batt (Charge:100%) 74 secs
2026-10-21 17:56:58 +0300 DarkWake            DarkWake from Deep Idle
2026-10-21 17:57:43 +0300 Sleep               Entering Sleep state due to 'Maintenance Sleep':TCPKeepAlive=active Using Batt (Charge:100%) 59 secs
2026-10-21 17:58:42 +0300 DarkWake            DarkWake from Deep Idle
2026-10-21 17:59:27 +0300 Sleep               Entering Sleep state due to 'Maintenance Sleep':TCPKeepAlive=active Using Batt (Charge:100%) 946 secs
2026-10-21 18:15:13 +0300 DarkWake            DarkWake from Deep Idle
2026-10-21 18:15:15 +0300 Sleep               Entering Sleep state due to 'Sleep Service Back to Sleep':TCPKeepAlive=active Using Batt (Charge:100%) 902 secs
2026-10-21 18:30:17 +0300 DarkWake            DarkWake from Deep Idle
2026-10-21 18:30:19 +0300 Sleep               Entering Sleep state due to 'Sleep Service Back to Sleep':TCPKeepAlive=active Using Batt (Charge:100%) 1070 secs
2026-10-21 18:48:09 +0300 DarkWake            DarkWake from Deep Idle
2026-10-21 18:56:59 +0300 Wake                DarkWake to FullWake from Deep Idle`;
const at = (time: string) => Date.parse(`2026-10-21T${time}+03:00`);
describe("recorded machine interruption", () => {
  it("allows a busy Mac's power-log read to finish before matching every affected execution", async () => {
    let finish!: (error: Error | null, stdout: string) => void;
    const stop = new AbortController();
    const reading = readMachinePowerRecords((file, args, options, done) => {
      // Observed busy-machine reads take up to eleven seconds: a bounded 30-second read with a bounded output,
      // stopped by the caller's own signal.
      expect([file, args, options]).toEqual(["/usr/bin/pmset", ["-g", "log"], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, signal: stop.signal }]);
      expect(options.signal).toBe(stop.signal);
      finish = done;
    }, "darwin", stop.signal);
    finish(null, records);
    const complete = await reading;
    expect(powerInterruption(at("17:54:07"), at("17:57:46"), complete)?.at).toBe(at("17:55:44"));
    expect(powerInterruption(at("17:52:18"), at("18:48:10"), complete)?.at).toBe(at("17:55:44"));
    expect(powerInterruption(at("17:01:00"), at("17:05:00"), complete)).toBeUndefined();
  });
  it("treats unavailable or incomplete reads as unavailable evidence and does not run a Mac command elsewhere", async () => {
    const unavailable = await readMachinePowerRecords((_file, _args, _options, done) => done(new Error("Log read stopped"), records), "darwin");
    expect(unavailable).toBe("");
    expect(powerInterruption(at("17:54:07"), at("17:57:46"), unavailable)).toBeUndefined();
    expect(await readMachinePowerRecords(() => { throw new Error("Must not run"); }, "linux")).toBe("");
  });
  it("does not start an evidence read after cancellation", async () => {
    const stop = new AbortController();
    stop.abort();
    expect(await readMachinePowerRecords(() => { throw new Error("Must not run"); }, "darwin", stop.signal)).toBe("");
  });
  it("stops an in-flight evidence read and discards its partial output on cancellation", async () => {
    const stop = new AbortController();
    let child: ReturnType<typeof execFile> | undefined;
    let closed: Promise<unknown> | undefined;
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const reading = readMachinePowerRecords((_file, _args, options, done) => {
      // Use the installed runtime's cancellation, without depending on the live Mac log's speed.
      child = execFile(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(records)}); setInterval(() => {}, 1000);`], options, done);
      closed = new Promise<void>((resolve) => { child!.once("close", () => resolve()); });
      void once(child.stdout!, "data").then(ready);
      return child;
    }, "darwin", stop.signal);
    try {
      await started;
      stop.abort();
      expect(await reading).toBe("");
      await closed;
      expect(child!.signalCode).toBeTruthy();
    } finally {
      stop.abort();
      child?.kill("SIGKILL");
      await closed;
    }
  });
  it("takes one snapshot from the caller's own source, and treats a failed or late read as unavailable", async () => {
    const stop = new AbortController();
    const reads: (AbortSignal | undefined)[] = [];
    expect(await readMachineRecords(async (signal) => { reads.push(signal); return records; }, stop.signal)).toBe(records);
    expect(reads).toEqual([stop.signal]);
    expect(await readMachineRecords(async () => { throw new Error("Log unavailable"); })).toBe("");
    expect(await readMachineRecords(() => { throw new Error("Log unavailable"); })).toBe("");
    // Records that arrive after the stop never count, whatever the source does with the signal.
    expect(await readMachineRecords(async () => { stop.abort(); return records; }, stop.signal)).toBe("");
    expect(await readMachineRecords(() => { throw new Error("Must not read after a stop"); }, stop.signal)).toBe("");
    expect(reads).toHaveLength(1);
  });
  it("matches a check's own interval against its source's records, and reads nothing without one", async () => {
    let reads = 0;
    const source = async () => { reads += 1; return records; };
    expect((await machineInterruption(at("17:54:07"), at("17:57:46"), undefined, source))?.at).toBe(at("17:55:44"));
    expect(await machineInterruption(at("17:01:00"), at("17:05:00"), undefined, source)).toBeUndefined();
    expect(await machineInterruption(undefined, at("17:57:46"), undefined, source)).toBeUndefined();
    expect(await machineInterruption(at("17:54:07"), at("17:57:46"), undefined, async () => { throw new Error("Log unavailable"); })).toBeUndefined();
    expect(reads).toBe(2);
  });
  it.each([["17:54:07", "17:57:46"], ["17:52:18", "18:48:10"], ["18:10:00", "18:12:00"]])("matches actual sleep during %s–%s", (start, end) => {
    expect(powerInterruption(at(start), at(end), records)).toEqual(expect.objectContaining({ source: "macOS power log", at: expect.any(Number), event: expect.stringContaining("Entering Sleep state") }));
  });
  it("leaves the earlier startup failure's cause unresolved and never infers sleep from a timeout or gap", () => {
    expect(powerInterruption(at("17:01:00"), at("17:05:00"), records)).toBeUndefined();
    expect(powerInterruption(at("17:54:07"), at("18:48:10"), "Timed out after a long wait")).toBeUndefined();
    expect(powerInterruption(undefined, at("18:48:10"), records)).toBeUndefined();
    expect(powerInterruption(at("18:57:00"), at("19:10:00"), records)).toBeUndefined();
  });
});
