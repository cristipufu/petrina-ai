import { describe, expect, it } from "bun:test";
import { ProcessObservations } from "../../../src/process-observations.js";
import { parseDescendants } from "../../../src/process-snapshots.js";

const snapshot = "11 10\n12 11\n40 1\n";

describe("bounded process observations", () => {
  const observations = new ProcessObservations(() => 0);
  it("distinguishes an empty tree from failure to read the process list", async () => {
    expect(parseDescendants("", [10])).toEqual([]);
    expect(await observations.descendantsKnown([10], 100, async () => undefined)).toBeUndefined();
  });

  it("retries a failed read within its budget and returns the later snapshot", async () => {
    const timeouts: number[] = [];
    const result = await observations.descendantsKnown([10], 3_200, async (timeout) => {
      timeouts.push(timeout);
      return timeouts.length === 1 ? undefined : snapshot;
    });
    expect(timeouts).toEqual([1_000, 2_000]);
    expect(result).toEqual([11, 12]);
  });

  it("does not reread a list that was read and has no descendants", async () => {
    let calls = 0;
    const listed = await observations.descendantsKnown([10], 3_200, async () => {
      calls += 1;
      return "40 1\n";
    });
    expect(calls).toBe(1);
    expect(listed).toEqual([]);
  });

  it("rejects a successful but unpaused snapshot and uses the next confirmed one", async () => {
    const timeouts: number[] = [];
    const result = await observations.descendantsKnown([10, 11], 4_800, async timeout => {
      timeouts.push(timeout);
      return timeouts.length === 1 ? "10 1 T\n11 10 S\n" : "10 1 T\n11 10 T\n12 11 S\n40 1 S\n";
    }, [4_000, 4_000], true);
    expect(timeouts).toEqual([4_000, expect.any(Number)]);
    expect(result).toEqual([12]);
  });

  for (const listed of [undefined, "10 1 S\n", "10 1\n"]) it(`does not confirm ownership when a list ${listed === undefined ? "fails" : listed.includes("S") ? "shows an owner running" : "lacks the owner's state"}`, async () => {
    let reads = 0;
    expect(await observations.descendantsKnown([10], 4_800, async () => { reads++; return listed; }, [4_000, 4_000], true)).toBeUndefined();
    expect(reads).toBe(2);
  });

  for (const listed of ["", "10 1 Z\n", "10 1 T+\n"]) it(`accepts one confirmed list with an owner ${listed === "" ? "gone" : listed.includes("Z") ? "defunct" : "paused"}`, async () => {
    let reads = 0;
    expect(await observations.descendantsKnown([10], 4_800, async () => { reads++; return listed; }, [4_000, 4_000], true)).toEqual([]);
    expect(reads).toBe(1);
  });

  for (const delay of [2_500, 3_999]) it(`preserves a consistently slow ${delay}ms first snapshot before stopping the parent`, async () => {
    let now = 0;
    const observations = new ProcessObservations(() => now);
    const timeouts: number[] = [];
    const result = await observations.descendantsKnown([10], 4_800, async (timeout) => {
      timeouts.push(timeout);
      now += Math.min(delay, timeout);
      return delay < timeout ? snapshot : undefined;
    }, [4_000, 4_000]);
    expect(timeouts).toEqual([4_000]);
    expect(result).toEqual([11, 12]);
  });

  it("recovers a hung first read while reserving the rest of the quit budget", async () => {
    let now = 0;
    const observations = new ProcessObservations(() => now);
    const timeouts: number[] = [];
    const result = await observations.descendantsKnown([10], 4_800, async (timeout) => {
      timeouts.push(timeout);
      now += timeouts.length === 1 ? timeout : 100;
      return timeouts.length === 1 ? undefined : snapshot;
    }, [4_000, 4_000]);
    expect(timeouts).toEqual([4_000, 800]);
    expect(result).toEqual([11, 12]);
    expect(now).toBe(4_100);
  });

  it("lets a slow rescan use the remaining allowance without splitting it into shorter attempts", async () => {
    let now = 0;
    const observations = new ProcessObservations(() => now);
    const timeouts: number[] = [];
    const result = await observations.descendantsKnown([10], 3_200, async (timeout) => {
      timeouts.push(timeout);
      now += Math.min(2_500, timeout);
      return timeout > 2_500 ? snapshot : undefined;
    }, [4_000, 4_000]);
    expect(timeouts).toEqual([3_200]);
    expect(result).toEqual([11, 12]);
  });
});


describe("process-list reads shared by the watchers asking at once", () => {
  const controlled = () => {
    const pending: ((value: string | undefined) => void)[] = [];
    const read = (_timeout: number) => new Promise<string | undefined>((resolve) => { pending.push(resolve); });
    return { read, pending, settle: (value: string | undefined) => pending.shift()!(value) };
  };

  it("runs one read at a time: askers at the same moment share it, later askers get a snapshot taken after they asked", async () => {
    const list = controlled();
    let now = 10;
    const observations = new ProcessObservations(() => now);
    const since = now;
    const together = [observations.sharedRead(list.read, 300, since), observations.sharedRead(list.read, 300, since), observations.sharedRead(list.read, 300, since)];
    expect(list.pending).toHaveLength(1);
    // A child that may be newer than the read under way could be missing from its snapshot: these wait for the next read.
    const later = [observations.sharedRead(list.read, 300, now + 1), observations.sharedRead(list.read, 300, now + 1)];
    expect(list.pending).toHaveLength(1);
    now++;
    list.settle("1 0 S\n");
    expect(await Promise.all(together)).toEqual(["1 0 S\n", "1 0 S\n", "1 0 S\n"]);
    expect(list.pending).toHaveLength(1);
    list.settle("2 0 S\n");
    expect(await Promise.all(later)).toEqual(["2 0 S\n", "2 0 S\n"]);
    // Nothing under way: a fresh ask starts a fresh read, and a failed read is reported as such without wedging the next.
    const failed = observations.sharedRead(list.read, 300, now);
    expect(list.pending).toHaveLength(1);
    list.settle(undefined);
    expect(await failed).toBeUndefined();
    const fresh = observations.sharedRead(list.read, 300, now);
    expect(list.pending).toHaveLength(1);
    list.settle("3 0 S\n");
    expect(await fresh).toBe("3 0 S\n");
  });

});

for (const rejected of [false, true]) it(`treats a ${rejected ? "rejected" : "throwing"} query as unavailable and leaves the next read usable`, async () => {
  const observations = new ProcessObservations(() => 0);
  let calls = 0;
  const read = () => {
    if (++calls > 1) return Promise.resolve(snapshot);
    if (rejected) return Promise.reject(new Error("Controlled observation failure"));
    throw new Error("Controlled observation failure");
  };
  expect(await observations.sharedRead(read, 300, 0)).toBeUndefined();
  expect(await observations.sharedRead(read, 300, 0)).toBe(snapshot);
  expect(calls).toBe(2);
});

it("publishes the pending observation before invoking a synchronous reader callback", async () => {
  const observations = new ProcessObservations(() => 0);
  let calls = 0, joined: Promise<string | undefined> | undefined;
  const read = () => {
    calls++;
    joined = observations.sharedRead(read, 300, 0);
    return Promise.resolve(snapshot);
  };
  const first = observations.sharedRead(read, 300, 0);
  expect(calls).toBe(1);
  expect(joined).toBe(first);
  expect(await first).toBe(snapshot);
});

it("keeps independent reader identities separate and queues a new observation after failure", async () => {
  let now = 0;
  const observations = new ProcessObservations(() => now);
  let fail!: () => void, finish!: (text: string) => void, calls = 0;
  const read = () => {
    calls++;
    return calls === 1 ? new Promise<string>((_resolve, reject) => { fail = () => reject(new Error("Failed first snapshot")); })
      : new Promise<string>(resolve => { finish = resolve; });
  };
  const first = observations.sharedRead(read, 300, 0);
  now = 1;
  const later = observations.sharedRead(read, 300, 1);
  expect(await observations.sharedRead(async () => "independent", 300, 1)).toBe("independent");
  expect(calls).toBe(1);
  fail();
  expect(await first).toBeUndefined();
  // A fresh caller can arrive as the queued observation starts, and must share that new observation.
  const fresh = observations.sharedRead(read, 300, 1);
  expect(calls).toBe(2);
  finish(snapshot);
  expect(await Promise.all([later, fresh])).toEqual([snapshot, snapshot]);
});

for (const rejected of [false, true]) it(`retries a ${rejected ? "rejected" : "throwing"} descendant query within the original budget`, async () => {
  let now = 0, calls = 0;
  const observations = new ProcessObservations(() => now);
  const timeouts: number[] = [];
  const read = (timeout: number) => {
    timeouts.push(timeout);
    if (++calls > 1) return Promise.resolve(snapshot);
    now = 1_000;
    if (rejected) return Promise.reject(new Error("No snapshot"));
    throw new Error("No snapshot");
  };
  expect(await observations.descendantsKnown([10], 3_200, read)).toEqual([11, 12]);
  expect(timeouts).toEqual([1_000, 2_000]);
});
