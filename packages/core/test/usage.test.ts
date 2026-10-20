import { describe, expect, it } from "vitest";
import type { AgentProfile, Pool, Tool, UsageLimit, UsageReport } from "../src/model.js";
import { DEFAULT_PROFILES } from "../src/profiles.js";
import { HOLDING_BACK, byRoom, chooseProfile, chooseWithRoom, headroom, liveLimits, nearLimit, nextExpiry, slowingDown, toolCapNow, untilWords, usageLines, waitingWords, withLimit, withReport } from "../src/usage.js";

const opus: AgentProfile = { id: "opus-high", toolId: "claude-code", model: "Opus 5.5", modelId: "opus", effort: "high" };
const opusX: AgentProfile = { id: "opus-xhigh", toolId: "claude-code", model: "Opus 5.5", modelId: "opus", effort: "xhigh" };
const sonnet: AgentProfile = { id: "sonnet-high", toolId: "claude-code", model: "Sonnet 5.5", modelId: "sonnet", effort: "high", standby: true };
const solX: AgentProfile = { id: "sol-xhigh", toolId: "codex", model: "sol", modelId: "gpt-6.1-sol", effort: "xhigh" };
const sol: AgentProfile = { id: "sol-high", toolId: "codex", model: "sol", modelId: "gpt-6.1-sol", effort: "high" };
const profiles = [opusX, opus, solX, sol, sonnet];
const tools: Tool[] = [
  { id: "claude-code", name: "Claude Code", command: [], status: "ready", models: [] },
  { id: "codex", name: "Codex", command: [], status: "ready", models: [] },
];
const now = new Date(2026, 9, 16, 12, 0, 0).getTime();
const HOUR = 3_600_000;

const pool = (extra: Partial<Pool> = {}): Pool => ({ limit: 3, paused: false, toolCaps: {}, ...extra });
const out = (toolId: string, until: number, model?: string): UsageLimit => ({ toolId, until, reason: `${toolId}'s limit`, ...(model ? { model } : {}) });
const report = (extra: Partial<UsageReport>): UsageReport => ({ toolId: "claude-code", kind: "seven_day", status: "allowed", at: now, ...extra });
const choose = (planned: AgentProfile, p: Pool, list: AgentProfile[] = profiles, toolList: Tool[] = tools) => chooseProfile({ profiles: list, tools: toolList, pool: p }, planned, now);

it("captures the selection cause before usage changes and names independence separately", () => {
  const p = pool({ limited: [{ toolId: opus.toolId, until: now + 3600000, reason: "Weekly allowance exhausted" }] });
  const selected = choose(opus, p);
  expect(selected.kind !== "none" && selected.reason).toContain("Weekly allowance exhausted");
  p.limited = [];
  expect(selected.kind !== "none" && selected.reason).toContain("Weekly allowance exhausted");
  const independent = chooseProfile({ profiles, tools, pool: p }, sol, now, { awayFrom: { toolId: sol.toolId, modelId: sol.modelId } });
  expect(independent.kind !== "none" && independent.reason).toContain("independent");
});

describe("who works a step", () => {
  it("is the planned profile when nothing is out or close", () => {
    expect(choose(opus, pool())).toEqual({ kind: "planned", profile: opus, reason: expect.any(String) });
    // A limit that ended no longer counts.
    expect(choose(opus, pool({ limited: [out("claude-code", now - 1)] }))).toEqual({ kind: "planned", profile: opus, reason: expect.any(String) });
  });

  it("is another model on the same tool when only the planned model is out (Opus out, Sonnet)", () => {
    expect(choose(opus, pool({ limited: [out("claude-code", now + HOUR, "opus")] }))).toEqual({ kind: "substitute", profile: sonnet, reason: expect.any(String) });
    // The other tool's profiles are not asked while the same tool has one.
    expect(choose(opusX, pool({ limited: [out("claude-code", now + HOUR, "opus")] }))).toEqual({ kind: "substitute", profile: sonnet, reason: expect.any(String) });
  });

  it("preserves the engine's default stand-in preference in the shared catalog while retaining saved demo profiles", () => {
    const catalog = DEFAULT_PROFILES.filter(profile => profile.id !== "fable-xhigh");
    const limited = pool({ limited: [out("claude-code", now + HOUR, "opus")] });
    const medium = catalog.find(profile => profile.id === "sonnet-medium")!;
    expect(choose(opusX, pool(), catalog)).toEqual({ kind: "planned", profile: opusX, reason: expect.any(String) });
    expect(choose(opusX, limited, catalog)).toEqual({ kind: "substitute", profile: sonnet, reason: expect.any(String) });
    expect(choose(medium, limited, catalog)).toEqual({ kind: "planned", profile: medium, reason: expect.any(String) });
    expect(choose(opusX, limited, catalog.filter(profile => profile.id !== sonnet.id))).toEqual({ kind: "substitute", profile: medium, reason: expect.any(String) });
  });

  it("is a profile on another tool when the whole tool is out, preferring the same effort", () => {
    const limited = pool({ limited: [out("claude-code", now + HOUR)] });
    expect(choose(opus, limited)).toEqual({ kind: "substitute", profile: sol, reason: expect.any(String) });
    expect(choose(opusX, limited)).toEqual({ kind: "substitute", profile: solX, reason: expect.any(String) });
  });

  it("goes by the order of the profile list among equals, and never uses a profile that is not in it", () => {
    const limited = pool({ limited: [out("claude-code", now + HOUR)] });
    expect(choose(opus, limited, [opus, solX, sol])).toEqual({ kind: "substitute", profile: sol, reason: expect.any(String) });
    expect(choose(opus, limited, [opus, solX])).toEqual({ kind: "substitute", profile: solX, reason: expect.any(String) });
    expect(choose(opus, limited, [opus]).kind).toBe("none");
  });

  it("skips a tool that is not ready, unless none is", () => {
    const limited = pool({ limited: [out("claude-code", now + HOUR)] });
    expect(choose(opus, limited, profiles, [tools[0]!, { ...tools[1]!, status: "not-installed" }]).kind).toBe("none");
    expect(choose(opus, limited, profiles, tools.map((tool) => ({ ...tool, status: "not-installed" as const }))).kind).toBe("substitute");
  });

  it("waits, with the words for it, when everyone is out", () => {
    const everyone = pool({ limited: [out("claude-code", now + 2 * HOUR), out("codex", now + HOUR)] });
    expect(choose(opus, everyone)).toEqual({ kind: "none", waiting: "Waiting for usage: Claude Code and Codex are out until 13:00" });
    expect(waitingWords({ tools, pool: pool({ limited: [out("claude-code", now + 3 * 24 * HOUR, "opus")] }) }, now)).toBe(`Waiting for usage: Claude Code (Opus) is out until ${untilWords(now + 3 * 24 * HOUR, now)}`);
  });

  it("prefers an equal profile on another tool once the planned tool is close to its limit", () => {
    const close = pool({ usage: [report({ status: "allowed_warning", resetsAt: now + HOUR })] });
    expect(choose(opus, close)).toEqual({ kind: "substitute", profile: sol, reason: expect.any(String) });
    // At 90% with no warning.
    expect(choose(opusX, pool({ usage: [report({ utilization: 0.9, resetsAt: now + HOUR })] }))).toEqual({ kind: "substitute", profile: solX, reason: expect.any(String) });
    expect(choose(opus, pool({ usage: [report({ utilization: 0.89, resetsAt: now + HOUR })] })).kind).toBe("planned");
    // Never the other way when that tool is close too, and never a stand-in profile for this.
    const both = pool({ usage: [report({ utilization: 0.95 }), report({ toolId: "codex", utilization: 0.95 })] });
    expect(choose(opus, both).kind).toBe("planned");
  });

  it("keeps a planned profile when its tool is full, and sends a stand-in on to the next tool that has a seat", () => {
    const grok: AgentProfile = { id: "grok-high", toolId: "grok", model: "Grok 4.7", modelId: "grok-4.7", effort: "high" };
    const list = [opus, sol, grok];
    const toolList: Tool[] = [...tools, { id: "grok", name: "Grok", command: [], status: "ready", models: [] }];
    const state = { profiles: list, tools: toolList, pool: pool({ limited: [out("claude-code", now + HOUR)] }) };
    // Codex is the first equal stand-in, so it still wins while it has a seat.
    expect(chooseWithRoom(state, opus, now)).toEqual({ kind: "substitute", profile: sol, reason: expect.any(String) });
    expect(chooseWithRoom(state, opus, now, {}, (toolId) => toolId !== "codex")).toEqual({ kind: "substitute", profile: grok, reason: expect.any(String) });
    // Every stand-in is full: wait for the first of them, not for a usage limit.
    expect(chooseWithRoom(state, opus, now, {}, () => false)).toEqual({ kind: "substitute", profile: sol, reason: expect.any(String) });
    // The planned profile is never skipped just because its tool is full.
    expect(chooseWithRoom({ ...state, pool: pool() }, opus, now, {}, () => false)).toEqual({ kind: "planned", profile: opus, reason: expect.any(String) });
    expect(chooseProfile(state, opus, now, { skipTools: new Set(["codex"]) })).toEqual({ kind: "substitute", profile: grok, reason: expect.any(String) });
    expect(chooseProfile({ ...state, pool: pool() }, opus, now, { skipTools: new Set(["claude-code"]) })).toEqual({ kind: "planned", profile: opus, reason: expect.any(String) });
    const allOut = pool({ limited: [out("claude-code", now + 2 * HOUR), out("codex", now + HOUR), out("grok", now + HOUR)] });
    expect(waitingWords({ tools: toolList, pool: allOut }, now)).toBe("Waiting for usage: Claude Code, Codex and Grok are out until 13:00");
  });

  it("does not move agents for a report that no longer counts", () => {
    expect(nearLimit(pool({ usage: [report({ utilization: 0.95, resetsAt: now - 1 })] }), opus, now)).toBe(false);
    expect(nearLimit(pool({ usage: [report({ utilization: 0.95, at: now - 31 * 60_000 })] }), opus, now)).toBe(false);
    expect(nearLimit(pool({ usage: [report({ utilization: 0.95, at: now - 5 * 60_000 })] }), opus, now)).toBe(true);
    // A report about one model's week is about that model only.
    expect(nearLimit(pool({ usage: [report({ kind: "seven_day_opus", model: "opus", utilization: 0.95 })] }), sonnet, now)).toBe(false);
  });
});

describe("limits and reports", () => {
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
    expect(usageLines({ tools, pool: pool({ usage: [report({ status: "allowed_warning" })] }) }, now)[0]).toMatchObject({ text: `weekly nearly used · ${HOLDING_BACK}`, tone: "near" });
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

describe("balancing by what is left", () => {
  it("measures room as the unused share of the tightest window per hour until it resets", () => {
    // 20% left with an hour to go beats 50% left with a week to go.
    expect(headroom(pool({ usage: [report({ utilization: 0.8, resetsAt: now + HOUR })] }), opus, now)).toBeCloseTo(0.2);
    expect(headroom(pool({ usage: [report({ utilization: 0.5, resetsAt: now + 7 * 24 * HOUR })] }), opus, now)).toBeCloseTo(0.5 / 168);
    // The tightest window counts: the 5-hour one here (0.02 of it left per hour, against 0.009 of the week).
    expect(headroom(pool({ usage: [report({ utilization: 0.1, resetsAt: now + 100 * HOUR }), report({ kind: "five_hour", utilization: 0.98, resetsAt: now + 4 * HOUR })] }), opus, now)).toBeCloseTo(0.005);
    // A warning with no number counts as 90% used; no reset time counts as within the hour; out is nothing.
    expect(headroom(pool({ usage: [report({ status: "allowed_warning" })] }), opus, now)).toBeCloseTo(0.1);
    expect(headroom(pool({ usage: [report({ status: "rejected", utilization: 1, resetsAt: now + HOUR })] }), opus, now)).toBe(0);
    // A tool that said nothing, or whose report no longer counts, has no number.
    expect(headroom(pool(), opus, now)).toBeUndefined();
    expect(headroom(pool({ usage: [report({ utilization: 0.5, resetsAt: now - 1 })] }), opus, now)).toBeUndefined();
    // A report about one model's week is about that model only; a whole tool counts every report.
    expect(headroom(pool({ usage: [report({ kind: "seven_day_opus", model: "opus", utilization: 0.9, resetsAt: now + HOUR })] }), sonnet, now)).toBeUndefined();
    expect(headroom(pool({ usage: [report({ kind: "seven_day_opus", model: "opus", utilization: 0.9, resetsAt: now + HOUR })] }), { toolId: "claude-code" }, now)).toBeCloseTo(0.1);
  });

  it("puts the roomiest first, keeps order among equals, and lets one that said nothing tie with the roomiest", () => {
    const rooms: Record<string, number | undefined> = { a: 0.1, b: 0.5, c: undefined, d: 0.5 };
    expect(byRoom(["a", "b", "c", "d"], (item) => rooms[item])).toEqual(["b", "c", "d", "a"]);
    expect(byRoom(["a", "b"], () => undefined)).toEqual(["a", "b"]);
  });

  it("sends a stand-in to the tool with more of its limit left, after independence, nearness and effort", () => {
    const grok: AgentProfile = { id: "grok-high", toolId: "grok", model: "Grok 4.7", modelId: "grok-4.7", effort: "high" };
    const grokX: AgentProfile = { id: "grok-xhigh", toolId: "grok", model: "Grok 4.7", modelId: "grok-4.7", effort: "xhigh" };
    const list = [opusX, opus, solX, sol, grokX, grok, sonnet];
    const toolList: Tool[] = [...tools, { id: "grok", name: "Grok", command: [], status: "ready", models: [] }];
    const claudeOut = out("claude-code", now + HOUR);
    const state = (usage: UsageReport[]) => ({ profiles: list, tools: toolList, pool: pool({ limited: [claudeOut], usage }) });
    // Codex at 70% of a week, Grok at 20%: Grok has more room, so it takes the step.
    const codexBusy = [report({ toolId: "codex", utilization: 0.7, resetsAt: now + 100 * HOUR }), report({ toolId: "grok", utilization: 0.2, resetsAt: now + 100 * HOUR })];
    expect(chooseProfile(state(codexBusy), opus, now)).toEqual({ kind: "substitute", profile: grok, reason: expect.any(String) });
    expect(chooseProfile(state(codexBusy), opusX, now)).toEqual({ kind: "substitute", profile: grokX, reason: expect.any(String) });
    // The other way round, and the same effort still comes before room.
    const grokBusy = [report({ toolId: "codex", utilization: 0.2, resetsAt: now + 100 * HOUR }), report({ toolId: "grok", utilization: 0.7, resetsAt: now + 100 * HOUR })];
    expect(chooseProfile(state(grokBusy), opus, now)).toEqual({ kind: "substitute", profile: sol, reason: expect.any(String) });
    expect(chooseProfile({ profiles: [opus, solX, grok], tools: toolList, pool: pool({ limited: [claudeOut], usage: codexBusy }) }, opus, now)).toEqual({ kind: "substitute", profile: grok, reason: expect.any(String) });
    expect(chooseProfile({ profiles: [opus, solX, grokX], tools: toolList, pool: pool({ limited: [claudeOut], usage: codexBusy }) }, opusX, now)).toEqual({ kind: "substitute", profile: grokX, reason: expect.any(String) });
    // Reset time scales it: Codex at 70% resetting in two hours has more room per hour than Grok at 20% with four days to go.
    const codexSoon = [report({ toolId: "codex", utilization: 0.7, resetsAt: now + 2 * HOUR }), report({ toolId: "grok", utilization: 0.2, resetsAt: now + 96 * HOUR })];
    expect(chooseProfile(state(codexSoon), opus, now)).toEqual({ kind: "substitute", profile: sol, reason: expect.any(String) });
    // A tool that said nothing is not pushed behind one that has: the list's order decides, as before.
    expect(chooseProfile(state([report({ toolId: "codex", utilization: 0.7, resetsAt: now + 100 * HOUR })]), opus, now)).toEqual({ kind: "substitute", profile: sol, reason: expect.any(String) });
    // Near a limit still loses to not near, whatever the room says.
    const codexNear = [report({ toolId: "codex", utilization: 0.92, resetsAt: now + HOUR }), report({ toolId: "grok", utilization: 0.5, resetsAt: now + 100 * HOUR })];
    expect(chooseProfile(state(codexNear), opus, now)).toEqual({ kind: "substitute", profile: grok, reason: expect.any(String) });
    // An equal profile for a tool that is near: the roomier of the others.
    const claudeNear = pool({ usage: [report({ utilization: 0.95, resetsAt: now + HOUR }), ...codexBusy] });
    expect(chooseProfile({ profiles: list, tools: toolList, pool: claudeNear }, opus, now)).toEqual({ kind: "substitute", profile: grok, reason: expect.any(String) });
    // A review planned on Codex stays there (keep), and a security review still goes to another tool first.
    expect(chooseProfile({ profiles: list, tools: toolList, pool: pool({ usage: codexBusy }) }, sol, now, { keep: true })).toEqual({ kind: "planned", profile: sol, reason: expect.any(String) });
    // Codex out, Claude Code busy with the builder: Grok, even with less room than Claude Code's own stand-in would have.
    expect(chooseProfile({ profiles: list, tools: toolList, pool: pool({ limited: [out("codex", now + HOUR)], usage: grokBusy }) }, solX, now, { awayFrom: { toolId: "claude-code", modelId: "opus" } })).toEqual({ kind: "substitute", profile: grokX, reason: expect.any(String) });
  });

  it("slows a tool down past 80% of a window: half its cap of new agents, rounded up, at least one", () => {
    const busy = pool({ toolCaps: { codex: 3, "claude-code": 1 }, usage: [report({ toolId: "codex", utilization: 0.85, resetsAt: now + HOUR })] });
    expect(slowingDown(busy, "codex", now)).toBe(true);
    expect(slowingDown(busy, "claude-code", now)).toBe(false);
    expect(toolCapNow(busy, "codex", now)).toBe(2);
    expect(toolCapNow(busy, "claude-code", now)).toBe(1);
    expect(toolCapNow(pool({ toolCaps: { codex: 1 }, usage: busy.usage }), "codex", now)).toBe(1);
    expect(toolCapNow(pool({ toolCaps: { codex: 4 }, usage: busy.usage }), "codex", now)).toBe(2);
    // With no cap of its own, half the pool.
    expect(toolCapNow(pool({ limit: 5, usage: busy.usage }), "codex", now)).toBe(3);
    expect(toolCapNow(pool({ limit: 5 }), "codex", now)).toBeUndefined();
    // Below the mark, as set; a warning counts; a report that no longer counts does not.
    expect(toolCapNow(pool({ toolCaps: { codex: 3 }, usage: [report({ toolId: "codex", utilization: 0.79, resetsAt: now + HOUR })] }), "codex", now)).toBe(3);
    expect(toolCapNow(pool({ toolCaps: { codex: 3 }, usage: [report({ toolId: "codex", status: "allowed_warning" })] }), "codex", now)).toBe(2);
    expect(toolCapNow(pool({ toolCaps: { codex: 3 }, usage: [report({ toolId: "codex", utilization: 0.85, resetsAt: now - 1 })] }), "codex", now)).toBe(3);
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

describe("reviews keep their independence", () => {
  const grok: AgentProfile = { id: "grok-high", toolId: "grok", model: "Grok 4.7", modelId: "grok-4.7", effort: "high" };
  const withGrok = { profiles: [...profiles, grok], tools: [...tools, { id: "grok", name: "Grok", command: [], status: "ready" as const, models: [] }] };

  it("keeps a replacement on a different tool from its partner, including when its independent seat is busy", () => {
    const state = { ...withGrok, pool: pool({ limited: [out("claude-code", now + HOUR)] }) };
    const rules = { keep: true, awayFromTools: ["codex"] };
    expect(chooseProfile(state, opus, now, rules)).toEqual({ kind: "substitute", profile: grok, reason: expect.any(String) });
    // A full pool (including a one-seat pool) waits; it must not collapse the pair onto Codex.
    expect(chooseWithRoom(state, opus, now, rules, () => false)).toEqual({ kind: "substitute", profile: grok, reason: expect.any(String) });
    expect(chooseWithRoom(state, sol, now, rules, (tool) => tool === "codex")).toEqual({ kind: "substitute", profile: grok, reason: expect.any(String) });
    // The partner's actual replacement matters even when our planned tool still works.
    expect(chooseProfile(state, sol, now, rules)).toEqual({ kind: "substitute", profile: grok, reason: expect.any(String) });
  });

  it("uses the best remaining tool when every independent tool is out or unavailable", () => {
    const rules = { keep: true, awayFromTools: ["codex"] };
    const state = { ...withGrok, pool: pool({ limited: [out("claude-code", now + HOUR), out("grok", now + HOUR)] }) };
    expect(chooseProfile(state, opus, now, rules)).toEqual({ kind: "substitute", profile: sol, reason: expect.any(String) });
    const unavailable = { ...withGrok, tools: withGrok.tools.map((tool) => tool.id === "grok" ? { ...tool, status: "not-installed" as const } : tool), pool: pool({ limited: [out("claude-code", now + HOUR)] }) };
    expect(chooseProfile(unavailable, grok, now, rules)).toEqual({ kind: "substitute", profile: sol, reason: expect.any(String) });
  });

  it("moves a still-available planned reviewer away from a builder that changed tools", () => {
    const rules = { keep: true, awayFrom: { toolId: "codex", modelId: solX.modelId! } };
    expect(chooseProfile({ profiles, tools, pool: pool() }, solX, now, rules)).toEqual({ kind: "substitute", profile: opusX, reason: expect.any(String) });
    expect(chooseProfile({ profiles, tools, pool: pool({ limited: [out("claude-code", now + HOUR)] }) }, solX, now, rules)).toEqual({ kind: "planned", profile: solX, reason: expect.any(String) });
  });

  it("moves a security review as far from the builder as it can, and never waits for that", () => {
    const fromOpus = { awayFrom: { toolId: "claude-code", modelId: "opus" } };
    // Planned on Codex because the builder is on Claude Code (Opus); Codex is out: Sonnet, not Opus.
    const codexOut = pool({ limited: [out("codex", now + HOUR)] });
    expect(chooseProfile({ profiles, tools, pool: codexOut }, solX, now, fromOpus)).toEqual({ kind: "substitute", profile: sonnet, reason: expect.any(String) });
    // Only the builder's own model left: it still switches rather than wait.
    const onlyOpus = pool({ limited: [out("codex", now + HOUR), out("claude-code", now + HOUR, "sonnet")] });
    const last = chooseProfile({ profiles, tools, pool: onlyOpus }, solX, now, fromOpus);
    expect(last.kind === "substitute" && last.profile.modelId).toBe("opus");
  });

  it("keeps a reviewer on its planned tool when that tool is only near its limit", () => {
    const busy = pool({ usage: [report({ status: "allowed_warning", utilization: 0.95 })] });
    expect(chooseProfile({ profiles, tools, pool: busy }, opus, now, { keep: true })).toEqual({ kind: "planned", profile: opus, reason: expect.any(String) });
  });
});
