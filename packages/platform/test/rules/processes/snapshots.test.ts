import { describe, expect, it } from "bun:test";
import { parseChildState, parseDescendants } from "../../../src/process-snapshots.js";

const snapshot = "11 10\n12 11\n40 1\n";

describe("process-tree snapshots", () => {
  it("finds a child and a grandchild, and leaves an unrelated process out", () => {
    expect(parseDescendants(snapshot, [10])).toEqual([11, 12]);
  });

});

describe("a child's state from the process list", () => {
  it("tells a running child from a defunct or missing one, and admits when a snapshot cannot say", () => {
    const listed = "11 10 Ss\n12 11 Z+\n40 1 SN\n";
    expect(parseChildState(listed, 11)).toBe("running");
    expect(parseChildState(listed, 12)).toBe("ended");
    expect(parseChildState(listed, 40)).toBe("running");
    expect(parseChildState(listed, 99)).toBe("ended");
    // A snapshot without a state column (an older helper) cannot tell a defunct child from a running one.
    expect(parseChildState("11 10\n", 11)).toBe("unknown");
    // Descendants still read from the same snapshot.
    expect(parseDescendants(listed, [10])).toEqual([11, 12]);
  });
});
