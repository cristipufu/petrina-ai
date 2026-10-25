import { describe as originalDescribe } from "bun:test";
import { expect, it } from "bun:test";
import { readMachineRecords, machineInterruption } from "../../../src/machine-records.js";
import { records, at } from "../../fixtures/power-records.js";

originalDescribe("recorded machine interruption", () => {
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
});

originalDescribe("recorded machine interruption", () => {
it("matches a check's own interval against its source's records, and reads nothing without one", async () => {
    let reads = 0;
    const source = async () => { reads += 1; return records; };
    expect((await machineInterruption(at("17:54:07"), at("17:57:46"), undefined, source))?.at).toBe(at("17:55:44"));
    expect(await machineInterruption(at("17:01:00"), at("17:05:00"), undefined, source)).toBeUndefined();
    expect(await machineInterruption(undefined, at("17:57:46"), undefined, source)).toBeUndefined();
    expect(await machineInterruption(at("17:54:07"), at("17:57:46"), undefined, async () => { throw new Error("Log unavailable"); })).toBeUndefined();
    expect(reads).toBe(2);
  });
});
