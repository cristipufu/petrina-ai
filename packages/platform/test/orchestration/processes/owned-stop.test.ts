import { describe, expect, it } from "bun:test";
import { stopOwnedProcess, type OwnedProcess } from "../../../src/owned-process.js";
import type { ProcessDeadline } from "../../../src/process-capabilities.js";

const budgets = { graceMs: 100, forceMs: 400 };
const flush = async () => { for (let index = 0; index < 6; index++) await Promise.resolve(); };
function fixture() {
  const completion = Promise.withResolvers<number>(), signals: string[] = [];
  let exitCode: number | null | undefined = null, signalCode: string | null | undefined = null;
  const timers = new Map<number, { after: number; expire: () => void }>();
  let next = 0;
  const arm: ProcessDeadline = (expire, after) => { const id = ++next; timers.set(id, { after, expire }); return () => { timers.delete(id); }; };
  const child: OwnedProcess = { exited: completion.promise, get exitCode() { return exitCode; }, get signalCode() { return signalCode; }, kill: signal => { signals.push(signal); } };
  return { child, completion, arm, signals, timers,
    record(code: number | null | undefined, signal?: string | null) { exitCode = code; signalCode = signal; },
    async expire() { const entry = timers.entries().next().value; if (!entry) throw new Error("No owned-process deadline is armed"); timers.delete(entry[0]); entry[1].expire(); await flush(); },
  };
}

describe("stopping an owned process handle", () => {
  for (const code of [0, 9]) it(`accepts a native exit ${code} without signalling or waiting`, async () => {
    const f = fixture(); f.record(code);
    expect(await stopOwnedProcess(f.child, budgets, f.arm)).toBe("confirmed");
    expect(f.signals).toEqual([]);
    expect(f.timers.size).toBe(0);
  });

  it("accepts a native signal record even when the completion promise is unavailable", async () => {
    const f = fixture(); f.record(null, "SIGTERM"); f.completion.reject(new Error("exit notification unavailable"));
    expect(await stopOwnedProcess(f.child, budgets, f.arm)).toBe("confirmed");
    expect(f.signals).toEqual([]);
    expect(f.timers.size).toBe(0);
  });

  it("confirms a graceful reported exit and cancels its deadline", async () => {
    const f = fixture(), stopped = stopOwnedProcess(f.child, budgets, f.arm);
    expect(f.signals).toEqual(["SIGTERM"]);
    f.completion.resolve(0);
    expect(await stopped).toBe("confirmed");
    expect(f.signals).toEqual(["SIGTERM"]);
    expect(f.timers.size).toBe(0);
  });

  it("uses a late native end record when its exit notification never arrives", async () => {
    const f = fixture(), stopped = stopOwnedProcess(f.child, budgets, f.arm);
    f.record(0); await f.expire();
    expect(await stopped).toBe("confirmed");
    expect(f.signals).toEqual(["SIGTERM"]);
    expect(f.timers.size).toBe(0);
  });

  it("escalates only after the grace period and confirms the forced exit", async () => {
    const f = fixture(), stopped = stopOwnedProcess(f.child, budgets, f.arm);
    expect([...f.timers.values()].map(timer => timer.after)).toEqual([100]);
    await f.expire();
    expect(f.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect([...f.timers.values()].map(timer => timer.after)).toEqual([400]);
    f.record(null, "SIGKILL"); f.completion.resolve(137);
    expect(await stopped).toBe("confirmed");
    expect(f.timers.size).toBe(0);
  });

  for (const rejected of [false, true]) it(`keeps missing native records unconfirmed when completion ${rejected ? "rejects" : "never arrives"}`, async () => {
    const f = fixture(); f.record(undefined);
    if (rejected) f.completion.reject(new Error("no exit observation"));
    const stopped = stopOwnedProcess(f.child, budgets, f.arm);
    await f.expire(); await f.expire();
    expect(await stopped).toBe("unconfirmed");
    expect(f.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(f.timers.size).toBe(0);
  });

  it("does not accept an invalid native record as a completed process", async () => {
    const f = fixture(); f.record(Number.NaN, "");
    const stopped = stopOwnedProcess(f.child, budgets, f.arm);
    await f.expire(); await f.expire();
    expect(await stopped).toBe("unconfirmed");
    expect(f.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("does not mistake a failed signal for completion", async () => {
    const f = fixture();
    const child = { ...f.child, kill: (signal: "SIGTERM" | "SIGKILL") => { f.signals.push(signal); throw new Error("signal unavailable"); } };
    const stopped = stopOwnedProcess(child, budgets, f.arm);
    await f.expire(); await f.expire();
    expect(await stopped).toBe("unconfirmed");
    expect(f.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(f.timers.size).toBe(0);
  });
});
