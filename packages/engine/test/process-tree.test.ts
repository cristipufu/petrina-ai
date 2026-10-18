import { describe, expect, it } from "bun:test";
import { descendantsKnown, parseDescendants } from "../src/process-tree.js";

describe("process-tree snapshots", () => {
  it("distinguishes an empty tree from failure to read the process list", async () => {
    expect(parseDescendants("", [10])).toEqual([]);
    expect(await descendantsKnown([10], 100, async () => undefined)).toBeUndefined();
  });

  it("retries a failed read within its budget and returns the later snapshot", async () => {
    const timeouts: number[] = [];
    const result = await descendantsKnown([10], 3_200, async (timeout) => {
      timeouts.push(timeout);
      return timeouts.length === 1 ? undefined : "11 10\n12 11\n";
    });
    expect(timeouts).toEqual([1_000, 2_000]);
    expect(result).toEqual([11, 12]);
  });
});
