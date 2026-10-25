import { describe, expect, it } from "vitest";
import { AnalyticsHolds, type AnalyticsHold } from "../../../src/analytics-holds.js";

describe("analytics holds", () => {
  const hold = (id: string, asOf: number, bytes: number): AnalyticsHold => ({ id, scope: { period: "7d" }, asOf, live: [], key: id, total: 10, bytes });

  it("bounds holds by count and total size across every caller, oldest first", () => {
    const holds = new AnalyticsHolds({ entries: 3, bytes: 1000, hold: 600, ms: 1000 });
    expect(holds.keep(hold("a", 1, 400), 1)).toBe(true);
    expect(holds.keep(hold("b", 2, 400), 2)).toBe(true);
    expect(holds.keep(hold("c", 3, 400), 3)).toBe(true);
    expect([holds.get("a", 3), holds.size, holds.retainedBytes]).toEqual([undefined, 2, 800]);
    expect(holds.keep(hold("d", 4, 100), 4)).toBe(true);
    expect(holds.keep(hold("e", 5, 100), 5)).toBe(true);
    expect([holds.get("b", 5), holds.size, holds.retainedBytes]).toEqual([undefined, 3, 600]);
    expect(holds.keep(hold("big", 6, 601), 6)).toBe(false);
    expect([holds.get("big", 6), holds.size]).toEqual([undefined, 3]);
    // Expiry counts from the first page, however often it is read.
    expect(holds.get("c", 1002)?.id).toBe("c");
    expect(holds.get("c", 1003)).toBeUndefined();
    expect(holds.retainedBytes).toBe(200);
  });
});
