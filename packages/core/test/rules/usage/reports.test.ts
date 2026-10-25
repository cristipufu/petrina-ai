import { describe, expect, it } from "vitest";
import type { AgentProfile, Pool, Tool, UsageLimit, UsageReport } from "../../../src/model.js";

import { HOLDING_BACK, headroom, liveLimits, nextExpiry, untilWords, usageLines, waitingWords, withLimit, withReport } from "../../../src/usage.js";

const opus: AgentProfile = { id: "opus-high", toolId: "claude-code", model: "Opus 5.5", modelId: "opus", effort: "high" };

const tools: Tool[] = [
  { id: "claude-code", name: "Claude Code", command: [], status: "ready", models: [] },
  { id: "codex", name: "Codex", command: [], status: "ready", models: [] },
];

const now = new Date(2026, 9, 16, 12, 0, 0).getTime();

const HOUR = 3_600_000;

const pool = (extra: Partial<Pool> = {}): Pool => ({ limit: 3, paused: false, toolCaps: {}, ...extra });

const out = (toolId: string, until: number, model?: string): UsageLimit => ({ toolId, until, reason: `${toolId}'s limit`, ...(model ? { model } : {}) });

const report = (extra: Partial<UsageReport>): UsageReport => ({ toolId: "claude-code", kind: "seven_day", status: "allowed", at: now, ...extra });

describe("limits and reports", () => {
  it("shows the longest restriction for each scope while retaining independent lifetimes", () => {
    for (const toolId of ["codex", "claude-code"]) for (const refusalLonger of [false, true]) for (const refusalFirst of [false, true]) {
      const refused = { ...out(toolId, now + (refusalLonger ? 72 : 0.5) * HOUR), source: "refusal" as const, ...(refusalLonger ? { retry: true } : {}) };
      const reported = { ...out(toolId, now + (refusalLonger ? 0.5 : 72) * HOUR), source: "report" as const };
      const limits = refusalFirst ? withLimit(withLimit([], refused), reported) : withLimit(withLimit([], reported), refused);
      const state = { tools, pool: pool({ limited: limits, usage: [report({ toolId, status: "rejected", utilization: 1, resetsAt: reported.until })] }) };
      const name = toolId === "codex" ? "Codex" : "Claude Code";
      const words = refusalLonger ? "request refused; retry after" : "out until";
      expect(limits).toHaveLength(2);
      expect(waitingWords(state, now)).toBe(`Waiting for usage: ${name}${refusalLonger ? "" : " is"} ${words} ${untilWords(now + 72 * HOUR, now)}`);
      expect(usageLines(state, now).find(line => line.toolId === toolId)!.text).toBe(`weekly 100%, resets ${untilWords(reported.until, now)} · ${words} ${untilWords(now + 72 * HOUR, now)}`);
      expect(nextExpiry(state.pool, now)).toBe(now + 0.5 * HOUR);
      expect(liveLimits(state.pool, now + HOUR)).toEqual([refusalLonger ? refused : reported]);
    }
    // Distinct models and tools still have distinct waits; the earliest can resume first.
    const state = { tools, pool: pool({ limited: [out("claude-code", now + HOUR, "opus"), out("claude-code", now + 2 * HOUR, "sonnet"), out("codex", now + 3 * HOUR)] }) };
    expect(waitingWords(state, now)).toBe("Waiting for usage: Claude Code (Opus), Claude Code (Sonnet) and Codex are out until 13:00");
    expect(usageLines(state, now)[0]!.text).toBe("Opus out until 13:00 · Sonnet out until 14:00");
  });

  it("shows a refused request's cooldown separately from the account's weekly allowance", () => {
    const toolList = [...tools, { id: "grok", name: "Grok", command: [], status: "ready" as const, models: [] }];
    const refused = { toolId: "grok", until: now + 5 * 60_000, retry: true, reason: "Grok refused the request: Grok Build usage balance exhausted" };
    const allowance = report({ toolId: "grok", utilization: 0.42, resetsAt: now + 24 * HOUR });
    const state = { tools: toolList, pool: pool({ usage: [allowance], limited: [refused] }) };
    expect(waitingWords(state, now)).toBe("Waiting for usage: Grok request refused; retry after 12:05");
    expect(usageLines(state, now).find((line) => line.toolId === "grok")!.text).toBe("weekly 42%, resets Sat 12:00 · request refused; retry after 12:05");
    expect(state.pool.usage).toEqual([allowance]);
    expect(waitingWords({ ...state, pool: pool({ limited: [out("codex", now + HOUR), refused] }) }, now)).toBe("Waiting for usage: Codex out until 13:00 · Grok request refused; retry after 12:05");
    expect(liveLimits(state.pool, refused.until)).toEqual([]);
  });

  it("keep the latest per tool and model, and drop what ended", () => {
    const first = withLimit(undefined, out("claude-code", now + HOUR));
    expect(withLimit(first, out("claude-code", now + 2 * HOUR))).toEqual([out("claude-code", now + 2 * HOUR)]);
    // An earlier end never shortens a limit already known.
    expect(withLimit(first, out("claude-code", now + 1000))).toEqual(first);
    expect(withLimit(first, out("claude-code", now + HOUR, "opus"))).toHaveLength(2);
    const limited = pool({ limited: [out("claude-code", now - 1), out("codex", now + HOUR)] });
    expect(liveLimits(limited, now)).toEqual([out("codex", now + HOUR)]);
    expect(nextExpiry(limited, now)).toBe(now + HOUR);
    expect(nextExpiry(pool(), now)).toBeUndefined();
    expect(withReport([report({ utilization: 0.5 })], report({ utilization: 0.6 }))).toEqual([report({ utilization: 0.6 })]);
    expect(withReport([report({})], report({ kind: "five_hour" }))).toHaveLength(2);
  });

  it("keeps a request refusal independent of a longer report-derived restriction", () => {
    const refused = { ...out("claude-code", now + HOUR), source: "refusal" as const };
    const reported = { ...out("claude-code", now + 2 * HOUR), source: "report" as const };
    const limits = withLimit(withLimit(undefined, refused), reported);
    expect(limits).toEqual([refused, reported]);
    expect(withLimit(limits, { ...reported, until: now + 3 * HOUR })).toEqual([refused, { ...reported, until: now + 3 * HOUR }]);
  });
});

describe("usage in words", () => {
  it("says the day only when the time is not today", () => {
    expect(untilWords(new Date(2026, 9, 16, 17, 5).getTime(), now)).toBe("17:05");
    expect(untilWords(new Date(2026, 9, 23, 17, 0).getTime(), now)).toBe("Fri 17:00");
    const beforeMidnight = new Date(2026, 9, 20, 23, 45).getTime();
    expect(untilWords(beforeMidnight + HOUR, beforeMidnight)).toBe("Wed 00:45");
    expect(untilWords(beforeMidnight + HOUR, beforeMidnight + 30 * 60_000)).toBe("00:45");
  });

  it("lists each tool: how much is used, who is out until when, or not reported", () => {
    const lines = usageLines({ tools, pool: pool({ usage: [report({ utilization: 0.82 }), report({ kind: "five_hour", utilization: 0.3 })], limited: [out("claude-code", new Date(2026, 9, 23, 17, 0).getTime(), "opus")] }) }, now);
    expect(lines).toEqual([
      { toolId: "claude-code", name: "Claude Code", text: "weekly 82% · 5-hour 30% · Opus out until Fri 17:00", tone: "out" },
      { toolId: "codex", name: "Codex", text: "not reported", tone: "fine" },
    ]);
    expect(usageLines({ tools, pool: pool({ usage: [report({ status: "allowed_warning" })] }) }, now)[0]).toMatchObject({ text: "weekly provider warning, percentage not reported", tone: "fine" });
    expect(usageLines({ tools, pool: pool({ usage: [report({ utilization: 0.4, resetsAt: now - 1 })] }) }, now)[0]).toMatchObject({ text: "not reported", tone: "fine" });
  });

  it("says when each window resets, and in one line when Petrina is starting fewer agents on a tool", () => {
    const thursday = new Date(2026, 9, 22, 13, 0).getTime();
    const lines = usageLines({ tools, pool: pool({ usage: [report({ toolId: "codex", utilization: 0.84, resetsAt: thursday }), report({ utilization: 0.5, resetsAt: now + 2 * HOUR }), report({ kind: "five_hour", utilization: 0.1, resetsAt: now + HOUR })] }) }, now);
    expect(lines).toEqual([
      { toolId: "claude-code", name: "Claude Code", text: "weekly 50%, resets 14:00 · 5-hour 10%, resets 13:00", tone: "fine" },
      { toolId: "codex", name: "Codex", text: `weekly 84%, resets Thu 13:00 · ${HOLDING_BACK}`, tone: "near" },
    ]);
    // Out already says it all.
    expect(usageLines({ tools, pool: pool({ usage: [report({ toolId: "codex", utilization: 1, status: "rejected", resetsAt: thursday })], limited: [out("codex", thursday)] }) }, now)[1]).toEqual({ toolId: "codex", name: "Codex", text: "weekly 100%, resets Thu 13:00 · out until Thu 13:00", tone: "out" });
  });
});

describe("a window that is used up", () => {
  it("is said so, with extra usage when the tool goes on with it, and leaves the tool in with no room", () => {
    const spent = pool({ usage: [report({ status: "rejected", overage: true, resetsAt: now + 72 * HOUR })] });
    expect(usageLines({ tools, pool: spent }, now)[0]).toMatchObject({ text: "weekly used up, on extra usage, resets Mon 12:00 · starting fewer agents on it", tone: "near" });
    // Spent is no room, so a tool with room comes first; it is not out.
    expect(headroom(spent, opus, now)).toBe(0);
    expect(liveLimits(spent, now)).toEqual([]);
    // Without extra usage the window still shows, and the tool is out once the engine marks it.
    expect(usageLines({ tools, pool: pool({ usage: [report({ status: "rejected", resetsAt: now + HOUR })] }) }, now)[0]!.text).toBe("weekly used up, resets 13:00 · starting fewer agents on it");
  });
});
