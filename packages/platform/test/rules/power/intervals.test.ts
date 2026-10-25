import { describe as originalDescribe } from "bun:test";
import { expect, it } from "bun:test";
import { powerInterruption } from "../../../src/power-interval.js";
import { records, at } from "../../fixtures/power-records.js";

originalDescribe("recorded machine interruption", () => {
it.each([["17:54:07", "17:57:46"], ["17:52:18", "18:48:10"], ["18:10:00", "18:12:00"]])("matches actual sleep during %s–%s", (start, end) => {
    expect(powerInterruption(at(start), at(end), records)).toEqual(expect.objectContaining({ source: "macOS power log", at: expect.any(Number), event: expect.stringContaining("Entering Sleep state") }));
  });
});

originalDescribe("recorded machine interruption", () => {
it("leaves the earlier startup failure's cause unresolved and never infers sleep from a timeout or gap", () => {
    expect(powerInterruption(at("17:01:00"), at("17:05:00"), records)).toBeUndefined();
    expect(powerInterruption(at("17:54:07"), at("18:48:10"), "Timed out after a long wait")).toBeUndefined();
    expect(powerInterruption(undefined, at("18:48:10"), records)).toBeUndefined();
    expect(powerInterruption(at("18:57:00"), at("19:10:00"), records)).toBeUndefined();
  });
});
