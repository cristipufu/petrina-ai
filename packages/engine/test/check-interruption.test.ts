import { describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { powerInterruption, readMachinePowerRecords } from "../src/check-interruption.js";

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
    const reading = readMachinePowerRecords((file, args, options, done) => {
      expect(file).toBe("/usr/bin/pmset");
      expect(args).toEqual(["-g", "log"]);
      // Observed busy-machine reads take up to eleven seconds; retain a finite deadline.
      expect(options.timeout).toBeGreaterThan(11_000);
      expect(options.timeout).toBeLessThanOrEqual(60_000);
      finish = done;
    }, "darwin");
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
