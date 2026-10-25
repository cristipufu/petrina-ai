import { describe, expect, it, vi } from "vitest";
import { limitBuckets } from "../../../src/limit-history-view.js";

const hour = 3_600_000;

describe("bounded usage history", () => {
  it("uses full local days and real hours across Bucharest clock changes without changing UTC times", () => {
    vi.stubEnv("TZ", "Europe/Bucharest");
    try {
      const autumn = limitBuckets("today", Date.parse("2026-10-25T12:00:00Z"));
      expect(autumn).toHaveLength(25);
      expect(autumn.filter(bucket => bucket.label.startsWith("03:" )).map(bucket => bucket.label)).toEqual(["03:00 UTC+03:00", "03:00 UTC+02:00"]);
      const spring = limitBuckets("today", Date.parse("2026-03-29T12:00:00Z"));
      expect(spring).toHaveLength(23);
      expect(spring.some(bucket => bucket.label.startsWith("03:"))).toBe(false);
      expect(limitBuckets("7d", Date.parse("2026-10-25T12:00:00Z")).at(-1)!.end - autumn[0]!.start).toBe(25 * hour);
    } finally { vi.unstubAllEnvs(); }
  });
});
