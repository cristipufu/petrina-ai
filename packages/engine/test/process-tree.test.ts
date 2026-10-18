import { describe, expect, it } from "bun:test";
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
});
