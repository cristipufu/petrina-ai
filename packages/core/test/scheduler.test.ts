import { describe, expect, it } from "vitest";
import { pickStarts } from "../src/scheduler.js";

const pool = (limit: number, toolCaps: Record<string, number> = {}, paused = false) => ({ limit, toolCaps, paused });

describe("pickStarts", () => {
  it("starts candidates in order until the pool is full", () => {
    const starts = pickStarts({
      candidates: [
        { taskId: "a", toolId: "claude-code" },
        { taskId: "b", toolId: "claude-code" },
        { taskId: "c", toolId: "codex" },
      ],
      inUse: [{ taskId: "x", toolId: "codex" }],
      pool: pool(3),
    });
    expect(starts).toEqual(["a", "b"]);
  });

  it("skips a candidate whose tool is at its cap and lets a lower one on another tool start", () => {
    const starts = pickStarts({
      candidates: [
        { taskId: "a", toolId: "codex" },
        { taskId: "b", toolId: "claude-code" },
      ],
      inUse: [{ taskId: "x", toolId: "codex" }],
      pool: pool(4, { codex: 1 }),
    });
    expect(starts).toEqual(["b"]);
  });

  it("counts starts in this round against the tool cap", () => {
    const starts = pickStarts({
      candidates: [
        { taskId: "a", toolId: "codex" },
        { taskId: "b", toolId: "codex" },
      ],
      inUse: [],
      pool: pool(4, { codex: 1 }),
    });
    expect(starts).toEqual(["a"]);
  });

  it("starts nothing when the pool is paused or full", () => {
    const candidates = [{ taskId: "a", toolId: "codex" }];
    expect(pickStarts({ candidates, inUse: [], pool: pool(2, {}, true) })).toEqual([]);
    expect(pickStarts({ candidates, inUse: [{ taskId: "x", toolId: "codex" }], pool: pool(1) })).toEqual([]);
  });

  it("never kills anyone when the limit drops below what is running", () => {
    const inUse = [
      { taskId: "x", toolId: "codex" },
      { taskId: "y", toolId: "codex" },
    ];
    expect(pickStarts({ candidates: [{ taskId: "a", toolId: "codex" }], inUse, pool: pool(1) })).toEqual([]);
  });
});
