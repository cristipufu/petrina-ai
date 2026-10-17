import { describe, expect, it } from "vitest";
import type { Pool, State, UsageReport } from "../src/model.js";
import { balanced, extraSlot, FEWER_START, pickStarts, slotWait } from "../src/scheduler.js";

const pool = (limit: number, toolCaps: Record<string, number> = {}, paused = false): Pool => ({ limit, toolCaps, paused });
const now = new Date(2026, 9, 16, 12, 0, 0).getTime();
const HOUR = 3_600_000;
const report = (toolId: string, utilization: number, resetsAt = now + HOUR): UsageReport => ({ toolId, kind: "seven_day", status: "allowed", utilization, resetsAt, at: now });

/** A state with these agents in slots, for the checks a task makes before one more agent. */
function withSlots(poolValue: Pool, inUse: readonly string[]): State {
  const profiles = [
    { id: "opus-high", toolId: "claude-code", model: "Opus 5.5", effort: "high" },
    { id: "sol-high", toolId: "codex", model: "sol", effort: "high" },
  ];
  const tasks = inUse.map((toolId, index) => ({ id: `t${index}`, holdsSlot: true, agent: { roleId: "builder", profileId: toolId === "codex" ? "sol-high" : "opus-high", since: now, step: 0 } })) as unknown as State["tasks"];
  const tools = [
    { id: "claude-code", name: "Claude Code", command: [], status: "ready", models: [] },
    { id: "codex", name: "Codex", command: [], status: "ready", models: [] },
  ] as unknown as State["tools"];
  return { now, seq: 0, products: [], roles: [], tools, profiles, tasks, inbox: [], pool: poolValue } as unknown as State;
}

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

  it("starts at most half a tool's cap once it is past 80% of a window, and lets another tool have the rest", () => {
    const candidates = ["a", "b", "c", "d"].map((taskId) => ({ taskId, toolId: "codex" }));
    const busy = { ...pool(4, { codex: 4, "claude-code": 4 }), usage: [report("codex", 0.85)] };
    expect(pickStarts({ candidates, inUse: [], pool: busy, now })).toEqual(["a", "b"]);
    expect(pickStarts({ candidates: [...candidates, { taskId: "e", toolId: "claude-code" }], inUse: [], pool: busy, now })).toEqual(["a", "b", "e"]);
    // One already on it leaves one seat; at the mark, nothing changes; a cap of one stays one.
    expect(pickStarts({ candidates, inUse: [{ taskId: "x", toolId: "codex" }], pool: busy, now })).toEqual(["a"]);
    expect(pickStarts({ candidates, inUse: [], pool: { ...busy, usage: [report("codex", 0.79)] }, now })).toEqual(["a", "b", "c", "d"]);
    expect(pickStarts({ candidates, inUse: [], pool: { ...pool(4, { codex: 1 }), usage: [report("codex", 0.85)] }, now })).toEqual(["a"]);
    // With no cap of its own, half the pool.
    expect(pickStarts({ candidates, inUse: [], pool: { ...pool(4), usage: [report("codex", 0.85)] }, now })).toEqual(["a", "b"]);
  });
});

describe("the checks before one more agent", () => {
  it("count a slowed tool's smaller cap, and say so", () => {
    const busy = { ...pool(4, { codex: 4 }), usage: [report("codex", 0.85)] };
    expect(slotWait(withSlots(busy, ["codex", "codex"]), { taskId: "new", toolId: "codex" })).toBe(`Waiting for a free Codex slot (${FEWER_START})`);
    expect(slotWait(withSlots(busy, ["codex"]), { taskId: "new", toolId: "codex" })).toBeUndefined();
    expect(slotWait(withSlots({ ...pool(4, { codex: 2 }) }, ["codex", "codex"]), { taskId: "new", toolId: "codex" })).toBe("Waiting for a free Codex slot");
    expect(extraSlot(withSlots(busy, ["codex", "codex"]), "codex")).toBe(false);
    expect(extraSlot(withSlots(busy, ["codex", "codex"]), "claude-code")).toBe(true);
    expect(extraSlot(withSlots(busy, ["codex"]), "codex")).toBe(true);
  });
});

describe("balanced", () => {
  it("puts work on the tool with more of its limit left first, keeping the order within a tool", () => {
    const candidates = [
      { taskId: "a", toolId: "claude-code" },
      { taskId: "b", toolId: "codex" },
      { taskId: "c", toolId: "claude-code" },
      { taskId: "d", toolId: "grok" },
    ];
    const usage = [report("claude-code", 0.8), report("codex", 0.3)];
    expect(balanced(candidates, { ...pool(4), usage }, now).map((candidate) => candidate.taskId)).toEqual(["b", "d", "a", "c"]);
    // The pool cannot take them all: the roomier tool gets the slots.
    expect(pickStarts({ candidates: balanced(candidates, { ...pool(4), usage }, now), inUse: [], pool: { ...pool(2), usage }, now })).toEqual(["b", "d"]);
    // Nothing reported: the order stands.
    expect(balanced(candidates, pool(4), now)).toEqual(candidates);
  });
});
