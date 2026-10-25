import { describe, expect, it } from "vitest";
import { nextOccurrence, latestOccurrence, routinePreview } from "../../../src/index.js";

const at = (date: string) => Date.parse(date);

const now = at("2026-01-01T00:00:00Z");

describe("maintenance calendars", () => {
  it.each([
    ["0 0 */2 * *", ["2026-01-03", "2026-01-05", "2026-01-07"]],
    ["0 0 */2 * 1", ["2026-01-03", "2026-01-05", "2026-01-07"]],
    ["0 0 1 * */2", ["2026-01-03", "2026-01-04", "2026-01-06"]],
    ["0 0 */2 * */2", ["2026-01-03", "2026-01-04", "2026-01-05"]],
    ["0 0 1-31/2 * *", ["2026-01-03", "2026-01-05", "2026-01-07"]],
    ["0 0 * * */2", ["2026-01-03", "2026-01-04", "2026-01-06"]],
    ["0 0 * * *", ["2026-01-02", "2026-01-03", "2026-01-04"]],
    ["*/15 * * * *", ["2026-01-01T00:15", "2026-01-01T00:30", "2026-01-01T00:45"]],
    ["0 */2 * * *", ["2026-01-01T02:00", "2026-01-01T04:00", "2026-01-01T06:00"]],
    ["0 0 1 */2 *", ["2026-03-01", "2026-05-01", "2026-07-01"]],
  ] as const)("preserves field steps and either-day matching in %s", (expression, dates) => {
    const schedule = { kind: "cron", expression } as const;
    const expected = dates.map(date => at(date.includes("T") ? `${date}Z` : `${date}T00:00Z`));
    expect(routinePreview(schedule, "UTC", now)).toEqual(expected);
    for (const occurrence of expected) expect(latestOccurrence(schedule, "UTC", occurrence + 60_000)).toBe(occurrence);
  });

  it("calculates daily, several weekdays, numeric cron ranges, lists and steps", () => {
    expect(nextOccurrence({ kind: "daily", time: "09:15" }, "UTC", now)).toBe(at("2026-01-01T09:15Z"));
    expect(routinePreview({ kind: "weekly", weekdays: [1, 4], time: "10:00" }, "UTC", now)).toEqual([at("2026-01-01T10:00Z"), at("2026-01-05T10:00Z"), at("2026-01-08T10:00Z")]);
    expect(nextOccurrence({ kind: "cron", expression: "5,20-40/10 8-10 * 1,2 1-5" }, "UTC", now)).toBe(at("2026-01-01T08:05Z"));
    expect(latestOccurrence({ kind: "cron", expression: "*/15 * * * *" }, "UTC", at("2026-01-01T09:43Z"))).toBe(at("2026-01-01T09:30Z"));
  });

  it("uses either restricted day and accepts infrequent leap-century dates", () => {
    expect(nextOccurrence({ kind: "cron", expression: "0 0 31 2 1" }, "UTC", now)).toBe(at("2026-02-02T00:00Z"));
    expect(nextOccurrence({ kind: "cron", expression: "0 0 29 2 *" }, "UTC", at("2096-03-01T00:00Z"))).toBe(at("2104-02-29T00:00Z"));
  });

  it("rejects impossible dates, malformed fields, empty weekdays, bad times and unknown zones", () => {
    for (const expression of ["0 0 31 2 *", "60 0 * * *", "0 24 * * *", "0 0 * 13 *", "0 0 * * 8", "*/0 * * * *", "1-0 * * * *", "0 9 * *", "a 0 * * *"]) expect(() => nextOccurrence({ kind: "cron", expression }, "UTC", now)).toThrow();
    expect(() => nextOccurrence({ kind: "daily", time: "24:00" }, "UTC", now)).toThrow("Choose a time");
    expect(() => nextOccurrence({ kind: "weekly", time: "09:00", weekdays: [] }, "UTC", now)).toThrow("weekday");
    expect(() => nextOccurrence({ kind: "daily", time: "09:00" }, "Missing/Zone", now)).toThrow("time zone");
  });

  it("skips spring gaps and only uses the first instant of a repeated local time", () => {
    const daily = { kind: "daily", time: "02:30" } as const;
    expect(nextOccurrence(daily, "America/New_York", at("2026-03-08T00:00Z"))).toBe(at("2026-03-09T06:30Z"));
    const repeated = { kind: "daily", time: "01:30" } as const;
    expect(nextOccurrence(repeated, "America/New_York", at("2026-11-01T00:00Z"))).toBe(at("2026-11-01T05:30Z"));
    expect(nextOccurrence(repeated, "America/New_York", at("2026-11-01T05:31Z"))).toBe(at("2026-11-02T06:30Z"));
    expect(latestOccurrence(repeated, "America/New_York", at("2026-11-01T06:45Z"))).toBe(at("2026-11-01T05:30Z"));
  });
});
