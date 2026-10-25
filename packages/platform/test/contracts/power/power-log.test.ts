import { describe as originalDescribe } from "bun:test";
import { expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { readMachinePowerRecords } from "../../../src/power-log.js";
import { powerInterruption } from "../../../src/power-interval.js";
import { records, at } from "../../fixtures/power-records.js";

originalDescribe("recorded machine interruption", () => {
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
});

originalDescribe("recorded machine interruption", () => {
it("treats unavailable or incomplete reads as unavailable evidence and does not run a Mac command elsewhere", async () => {
    const unavailable = await readMachinePowerRecords((_file, _args, _options, done) => done(new Error("Log read stopped"), records), "darwin");
    expect(unavailable).toBe("");
    expect(powerInterruption(at("17:54:07"), at("17:57:46"), unavailable)).toBeUndefined();
    expect(await readMachinePowerRecords(() => { throw new Error("Must not run"); }, "linux")).toBe("");
  });
});

originalDescribe("recorded machine interruption", () => {
it("does not start an evidence read after cancellation", async () => {
    const stop = new AbortController();
    stop.abort();
    expect(await readMachinePowerRecords(() => { throw new Error("Must not run"); }, "darwin", stop.signal)).toBe("");
  });
});

originalDescribe("recorded machine interruption", () => {
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
});
