import { describe, expect, it, spyOn } from "bun:test";
import { descendantsKnown, parseDescendants } from "../src/process-tree.js";

const snapshot = "11 10\n12 11\n40 1\n";

describe("process-tree snapshots", () => {
  it("finds a child and a grandchild, and leaves an unrelated process out", () => {
    expect(parseDescendants(snapshot, [10])).toEqual([11, 12]);
  });

  it("distinguishes an empty tree from failure to read the process list", async () => {
    expect(parseDescendants("", [10])).toEqual([]);
    expect(await descendantsKnown([10], 100, async () => undefined)).toBeUndefined();
  });

  it("retries a failed read within its budget and returns the later snapshot", async () => {
    const timeouts: number[] = [];
    const result = await descendantsKnown([10], 3_200, async (timeout) => {
      timeouts.push(timeout);
      return timeouts.length === 1 ? undefined : snapshot;
    });
    expect(timeouts).toEqual([1_000, 2_000]);
    expect(result).toEqual([11, 12]);
  });

  it("does not reread a list that was read and has no descendants", async () => {
    let calls = 0;
    const listed = await descendantsKnown([10], 3_200, async () => {
      calls += 1;
      return "40 1\n";
    });
    expect(calls).toBe(1);
    expect(listed).toEqual([]);
  });

  for (const delay of [2_500, 3_999]) it(`preserves a consistently slow ${delay}ms first snapshot before stopping the parent`, async () => {
    let now = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const timeouts: number[] = [];
    try {
      const result = await descendantsKnown([10], 4_800, async (timeout) => {
        timeouts.push(timeout);
        now += Math.min(delay, timeout);
        return delay < timeout ? snapshot : undefined;
      }, [4_000, 4_000]);
      expect(timeouts).toEqual([4_000]);
      expect(result).toEqual([11, 12]);
    } finally { clock.mockRestore(); }
  });

  it("recovers a hung first read while reserving the rest of the quit budget", async () => {
    let now = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const timeouts: number[] = [];
    try {
      const result = await descendantsKnown([10], 4_800, async (timeout) => {
        timeouts.push(timeout);
        now += timeouts.length === 1 ? timeout : 100;
        return timeouts.length === 1 ? undefined : snapshot;
      }, [4_000, 4_000]);
      expect(timeouts).toEqual([4_000, 800]);
      expect(result).toEqual([11, 12]);
      expect(now).toBe(4_100);
    } finally { clock.mockRestore(); }
  });

  it("lets a slow rescan use the remaining allowance without splitting it into shorter attempts", async () => {
    let now = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      const timeouts: number[] = [];
      const result = await descendantsKnown([10], 3_200, async (timeout) => {
        timeouts.push(timeout);
        now += Math.min(2_500, timeout);
        return timeout > 2_500 ? snapshot : undefined;
      }, [4_000, 4_000]);
      expect(timeouts).toEqual([3_200]);
      expect(result).toEqual([11, 12]);
    } finally { clock.mockRestore(); }
  });
});
