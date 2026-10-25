import { describe, expect, it } from "vitest";
import { WaitClock } from "../../../src/wait-clock.js";

describe("An agent session", () => {
it("counts overlapping waits for the coordinator once", () => {
    const clock = new WaitClock();
    clock.start("task", 0);
    clock.start("task", 100);
    expect(clock.of("task", 200)).toBe(200);
    clock.stop("task", 300);
    clock.stop("task", 500);
    // Two permission questions open at once, from 0 to 500: 500ms of waiting, not 700.
    expect(clock.of("task", 900)).toBe(500);
    clock.start("task", 1000);
    clock.stop("task", 1100);
    expect(clock.of("task", 2000)).toBe(600);
    expect(clock.of("other", 2000)).toBe(0);
  });
});
