import { describe, expect, it } from "bun:test";
import { readOwnedProcessOutput, ProcessOutputCleanupError, type ProcessOutputOptions } from "../../../src/process-output.js";
import { rejectionOf } from "@petrina/test-support/rejections";
import { outputFixture, flushOutput } from "../../fixtures/process-output.js";

describe("owned helper output", () => {
  it("keeps output-first discovery while stopping a helper whose stdout closed before exit", async () => {
    const f = outputFixture(); f.write("complete"); f.end();
    expect(await f.read({ completion: "output" })).toBe("complete");
    expect(f.signals).toEqual(["SIGTERM"]);
    expect(f.stream.locked).toBe(false);
    expect(f.timers.size).toBe(0);
  });

  for (const first of ["output", "exit"] as const) it(`requires both successful exit and complete output when ${first} arrives first`, async () => {
    const f = outputFixture(); f.write("ready"); let settled = false;
    const output = f.read().then(value => { settled = true; return value; });
    if (first === "output") f.end(); else f.exit(0);
    await flushOutput(); expect(settled).toBe(false); expect(f.signals).toEqual([]);
    if (first === "output") f.exit(0); else f.end();
    expect(await output).toBe("ready");
    expect(f.signals).toEqual([]); expect(f.timers.size).toBe(0); expect(f.stream.locked).toBe(false);
  });

  it("does not trust closed output from a still-running command when its deadline expires", async () => {
    const f = outputFixture(); f.write("manual"); f.end();
    const output = f.read(); await f.expire(10_000);
    expect(await output).toBeUndefined(); expect(f.signals).toEqual(["SIGTERM"]); expect(f.timers.size).toBe(0);
  });

  for (const code of [1, 7, 137]) it(`does not trust text from a completed command with exit ${code}`, async () => {
    const f = outputFixture(); f.write("manual"); f.end(); f.exit(code);
    expect(await f.read()).toBeUndefined(); expect(f.signals).toEqual([]); expect(f.timers.size).toBe(0);
  });

  it("stops and closes output after a read error", async () => {
    const f = outputFixture(), output = f.read(); f.error(new Error("Read failed"));
    expect(await output).toBeUndefined(); expect(f.signals).toEqual(["SIGTERM"]);
    expect(f.stream.locked).toBe(false); expect(f.timers.size).toBe(0);
  });

  for (const completion of ["output", "successful-exit"] as const) it(`observes a rejected exit immediately in ${completion} mode`, async () => {
    const f = outputFixture(), output = f.read({ completion });
    f.loseExit(new Error("Exit observation unavailable")); await flushOutput();
    if (completion === "output") { f.write("read completely"); f.end(); }
    expect(await output).toBe(completion === "output" ? "read completely" : undefined);
    // The native end record from stopping the actual handle confirms this helper independently.
    expect(f.signals).toEqual(["SIGTERM"]); expect(f.timers.size).toBe(0);
  });

  it("does not claim that an already-locked output pipe was closed", async () => {
    const f = outputFixture(), foreign = f.stream.getReader();
    try {
      const error = await rejectionOf(f.read());
      expect(error).toBeInstanceOf(ProcessOutputCleanupError);
      expect(error).toMatchObject({ cleanup: "unconfirmed", processStopped: true, outputClosed: false });
      expect(f.signals).toEqual(["SIGTERM"]); expect(f.timers.size).toBe(0);
    } finally { await foreign.cancel(); foreign.releaseLock(); }
  });

  for (const cancellation of ["pending", "rejected"] as const) it(`reports ${cancellation} output cancellation instead of manufacturing a closed stream`, async () => {
    const f = outputFixture({ cancellation }), output = rejectionOf(f.read());
    await f.expire(10_000); if (cancellation === "pending") await f.expire(500);
    expect(await output).toMatchObject({ cleanup: "unconfirmed", processStopped: true, outputClosed: false });
    expect(f.signals).toEqual(["SIGTERM"]); expect(f.stream.locked).toBe(false); expect(f.timers.size).toBe(0);
  });

  it("retains unavailable process completion after both bounded stop attempts", async () => {
    const f = outputFixture({ stops: false }); f.end();
    const output = rejectionOf(f.read({ completion: "output" }));
    await f.expire(100); await f.expire(400);
    expect(await output).toMatchObject({ cleanup: "unconfirmed", processStopped: false, outputClosed: true });
    expect(f.signals).toEqual(["SIGTERM", "SIGKILL"]); expect(f.timers.size).toBe(0);
  });

  for (const when of ["before start", "inside start", "during read"] as const) it(`owns cancellation ${when}`, async () => {
    const f = outputFixture(), lifetime = new AbortController();
    if (when === "before start") lifetime.abort();
    const output = f.read({ signal: lifetime.signal, ...(when === "inside start" ? { start() { lifetime.abort(); return f.child; } } : {}) });
    if (when === "during read") { await flushOutput(); lifetime.abort(); }
    expect(await output).toBeUndefined(); expect(f.timers.size).toBe(0);
    expect(f.signals).toEqual(when === "before start" ? [] : ["SIGTERM"]);
    expect(f.starts).toBe(when === "during read" ? 1 : 0);
  });

  for (const invalid of [{ timeoutMs: Infinity }, { timeoutMs: -1 }, { graceMs: 0 }, { forceMs: NaN }, { graceMs: 2_147_483_647, forceMs: 1 }])
    it(`rejects invalid budgets before starting a child: ${JSON.stringify(invalid)}`, async () => {
      const f = outputFixture();
      expect(await rejectionOf(f.read(invalid))).toBeInstanceOf(RangeError);
      expect(f.starts).toBe(0); expect(f.signals).toEqual([]); expect(f.timers.size).toBe(0);
    });

  it("keeps a starter failure unavailable without arming timers", async () => {
    const f = outputFixture();
    expect(await f.read({ start() { throw new Error("Could not start"); } })).toBeUndefined();
    expect(f.timers.size).toBe(0); expect(f.signals).toEqual([]);
  });

  it("decodes a split UTF-8 character only after both output and successful completion", async () => {
    const f = outputFixture(), encoded = new TextEncoder().encode("A😀B");
    f.bytes(encoded.subarray(0, 3)); f.bytes(encoded.subarray(3)); f.end(); f.exit(0);
    expect(await f.read()).toBe("A😀B"); expect(f.timers.size).toBe(0);
  });
  it("keeps a method-backed timer port bound during read and cleanup", async () => {
    const f = outputFixture(); let arms = 0;
    class Owner implements ProcessOutputOptions {
      readonly marker = "this owner";
      readonly completion = "successful-exit";
      readonly timeoutMs = 10_000; readonly graceMs = 100; readonly forceMs = 400;
      start() { return f.child; }
      arm(expired: () => void, ms: number) {
        if (this.marker !== "this owner") throw new Error("Timer owner was detached");
        arms++; return f.arm(expired, ms);
      }
    }
    const output = readOwnedProcessOutput(new Owner()); await f.expire(10_000);
    expect(await output).toBeUndefined(); expect(arms).toBeGreaterThanOrEqual(2);
    expect(f.signals).toEqual(["SIGTERM"]); expect(f.timers.size).toBe(0);
  });

});
