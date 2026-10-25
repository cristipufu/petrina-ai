import { expect, it } from "bun:test";
import { resourceUsageRecord } from "../../../src/resources/usage.js";

it("copies non-enumerable driver getters before writing JSON instead of losing the readings", () => {
  const reading = Object.create({ get cpuTime() { return { user: 120n, system: 30n, total: 150n }; }, get maxRSS() { return 4096; } });
  expect(JSON.stringify(reading)).toBe("{}");
  expect(JSON.parse(JSON.stringify(resourceUsageRecord(reading)))).toEqual({ userUs: 120, systemUs: 30, totalUs: 150, maxRssBytes: 4096 });
});

it("keeps partial known readings without inventing missing counters or coercing null values", () => {
  expect(resourceUsageRecord(undefined)).toBeUndefined();
  expect(resourceUsageRecord({})).toBeUndefined();
  expect(resourceUsageRecord({ cpuTime: { user: null, system: 0, total: Infinity }, maxRSS: "123" })).toEqual({ systemUs: 0 });
  expect(resourceUsageRecord({ cpuTime: { user: -1, system: NaN } })).toBeUndefined();
  expect(resourceUsageRecord({ cpuTime: { user: BigInt(Number.MAX_SAFE_INTEGER) + 1n, system: -1n } })).toBeUndefined();
  expect(resourceUsageRecord({ cpuTime: { user: Number.MAX_SAFE_INTEGER + 1, system: 0.5 }, maxRSS: -1 })).toBeUndefined();
});
