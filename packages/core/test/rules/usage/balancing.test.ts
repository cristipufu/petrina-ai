import { describe, expect, it } from "vitest";
import type { AgentProfile, Pool, Tool, UsageLimit, UsageReport } from "../../../src/model.js";

import { HOLDING_BACK, byRoom, chooseProfile, chooseWithRoom, headroom, limitOf, nearLimit, slowingDown, toolCapNow, untilWords, usageLines } from "../../../src/usage.js";
import { balanced, pickStarts } from "../../../src/scheduler.js";

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

describe("balancing by what is left", () => {
  it("measures room as the unused share of the tightest window per hour until it resets", () => {
    // 20% left with an hour to go beats 50% left with a week to go.
    expect(headroom(pool({ usage: [report({ utilization: 0.8, resetsAt: now + HOUR })] }), opus, now)).toBeCloseTo(0.2);
    expect(headroom(pool({ usage: [report({ utilization: 0.5, resetsAt: now + 7 * 24 * HOUR })] }), opus, now)).toBeCloseTo(0.5 / 168);
    // The tightest window counts: the 5-hour one here (0.02 of it left per hour, against 0.009 of the week).
    expect(headroom(pool({ usage: [report({ utilization: 0.1, resetsAt: now + 100 * HOUR }), report({ kind: "five_hour", utilization: 0.98, resetsAt: now + 4 * HOUR })] }), opus, now)).toBeCloseTo(0.005);
    // A warning with no number says nothing about room; no reset time counts as within the hour; out is nothing.
    expect(headroom(pool({ usage: [report({ status: "allowed_warning" })] }), opus, now)).toBeUndefined();
    expect(headroom(pool({ usage: [report({ status: "allowed_warning", utilization: 0.26 })] }), opus, now)).toBeCloseTo(0.74);
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
    // Below the mark, as set; a warning counts only by its number; a report that no longer counts does not.
    expect(toolCapNow(pool({ toolCaps: { codex: 3 }, usage: [report({ toolId: "codex", utilization: 0.79, resetsAt: now + HOUR })] }), "codex", now)).toBe(3);
    expect(toolCapNow(pool({ toolCaps: { codex: 3 }, usage: [report({ toolId: "codex", status: "allowed_warning" })] }), "codex", now)).toBe(3);
    expect(toolCapNow(pool({ toolCaps: { codex: 3 }, usage: [report({ toolId: "codex", status: "allowed_warning", utilization: 0.8 })] }), "codex", now)).toBe(2);
    expect(toolCapNow(pool({ toolCaps: { codex: 3 }, usage: [report({ toolId: "codex", utilization: 0.85, resetsAt: now - 1 })] }), "codex", now)).toBe(3);
  });
});

describe("a provider warning is evidence, measured usage decides", () => {
  const WEEK_LEFT = 6 * 24 * HOUR;

  const running = (count: number, profile: AgentProfile = opusX) => Array.from({ length: count }, (_, index) => ({ taskId: `running-${profile.id}-${index}`, toolId: profile.toolId, model: profile.model, modelId: profile.modelId! }));

  const next = (profile: AgentProfile = opusX) => ({ taskId: "next", toolId: profile.toolId, model: profile.model, modelId: profile.modelId! });

  const weekly = (status: UsageReport["status"], utilization?: number) => report({ status, ...(utilization === undefined ? {} : { utilization }), resetsAt: now + WEEK_LEFT });

  const capped = (...usage: UsageReport[]) => pool({ limit: 10, toolCaps: { "claude-code": 7 }, usage });

  const state = (p: Pool) => ({ profiles, tools, pool: p });

  const statuses = ["allowed", "allowed_warning"] as const;

  it("keeps the planned profile and the full cap below 80%, whatever status the provider reports", () => {
    for (const utilization of [0, 0.26, 0.27, 0.3, 0.79, 0.7999]) for (const status of statuses) {
      const why = `${status} at ${utilization}`;
      // Codex having more of its allowance left does not override a healthy plan.
      const p = capped(weekly(status, utilization), report({ toolId: "codex", utilization: 0, resetsAt: now + HOUR }));
      expect(nearLimit(p, opusX, now), why).toBe(false);
      expect(slowingDown(p, "claude-code", now), why).toBe(false);
      expect(toolCapNow(p, "claude-code", now, opusX), why).toBe(7);
      expect(headroom(p, opusX, now), why).toBeCloseTo((1 - utilization) / (WEEK_LEFT / HOUR));
      expect(pickStarts({ candidates: [next()], inUse: running(4), pool: p, now }), why).toEqual(["next"]);
      expect(chooseProfile(state(p), opusX, now), why).toMatchObject({ kind: "planned", profile: opusX });
      const line = usageLines({ tools, pool: p }, now)[0]!;
      expect(line.tone, why).toBe("fine");
      expect(line.text, why).toContain(`weekly ${Math.round(utilization * 100)}%${status === "allowed_warning" ? ", provider warning" : ""}, resets`);
      expect(line.text, why).not.toContain(HOLDING_BACK);
    }
  });

  it("slows new agents from 80% and keeps the planned profile waiting for its own slot", () => {
    for (const utilization of [0.8, 0.85, 0.89, 0.8999]) for (const status of statuses) {
      const why = `${status} at ${utilization}`;
      const p = capped(weekly(status, utilization));
      expect(nearLimit(p, opusX, now), why).toBe(false);
      expect(toolCapNow(p, "claude-code", now, opusX), why).toBe(4);
      expect(pickStarts({ candidates: [next()], inUse: running(3), pool: p, now }), why).toEqual(["next"]);
      expect(pickStarts({ candidates: [next()], inUse: running(4), pool: p, now }), why).toEqual([]);
      expect(chooseWithRoom(state(p), opusX, now, {}, (toolId) => toolId !== "claude-code"), why).toMatchObject({ kind: "planned", profile: opusX });
      const line = usageLines({ tools, pool: p }, now)[0]!;
      expect(line.tone, why).toBe("near");
      expect(line.text, why).toContain(HOLDING_BACK);
      expect(line.text.includes("provider warning"), why).toBe(status === "allowed_warning");
    }
  });

  it("allows the near-limit substitution from 90%, keeping the plan without an equal alternative or for reviews", () => {
    for (const utilization of [0.9, 0.95]) for (const status of statuses) {
      const why = `${status} at ${utilization}`;
      const p = capped(weekly(status, utilization));
      expect(nearLimit(p, opusX, now), why).toBe(true);
      expect(chooseProfile(state(p), opusX, now), why).toMatchObject({ kind: "substitute", profile: solX });
      expect(chooseProfile({ ...state(p), profiles: [opusX, sol, sonnet] }, opusX, now), why).toMatchObject({ kind: "planned", profile: opusX });
      expect(chooseProfile(state(capped(weekly(status, utilization), report({ toolId: "codex", utilization: 0.92 }))), opusX, now), why).toMatchObject({ kind: "planned", profile: opusX });
      expect(chooseProfile(state(p), opusX, now, { keep: true }), why).toMatchObject({ kind: "planned", profile: opusX });
      expect(usageLines({ tools, pool: p }, now)[0]!.text, why).not.toContain("provider warning");
    }
  });

  it("treats a warning without a percentage as unknown, while other measured windows still count", () => {
    const unknown = capped(weekly("allowed_warning"));
    expect(nearLimit(unknown, opusX, now)).toBe(false);
    expect(slowingDown(unknown, "claude-code", now)).toBe(false);
    expect(toolCapNow(unknown, "claude-code", now, opusX)).toBe(7);
    expect(headroom(unknown, opusX, now)).toBeUndefined();
    expect(pickStarts({ candidates: [next()], inUse: running(4), pool: unknown, now })).toEqual(["next"]);
    expect(chooseProfile(state(unknown), opusX, now)).toMatchObject({ kind: "planned", profile: opusX });
    expect(usageLines({ tools, pool: unknown }, now)[0]).toMatchObject({ text: `weekly provider warning, percentage not reported, resets ${untilWords(now + WEEK_LEFT, now)}`, tone: "fine" });
    // No invented number in balancing: the waiting Claude task keeps its place beside Codex at 50%.
    const codexHalf = report({ toolId: "codex", utilization: 0.5, resetsAt: now + WEEK_LEFT });
    expect(balanced([next(), next(sol)], capped(weekly("allowed_warning"), codexHalf), now)[0]!.toolId).toBe("claude-code");
    // A measured 5-hour window still slows the tool and sets its room.
    const measured = capped(weekly("allowed_warning"), report({ kind: "five_hour", utilization: 0.85, resetsAt: now + HOUR }));
    expect(toolCapNow(measured, "claude-code", now, opusX)).toBe(4);
    expect(headroom(measured, opusX, now)).toBeCloseTo(0.15);
    expect(usageLines({ tools, pool: measured }, now)[0]!.text).toBe(`5-hour 85%, resets 13:00 · weekly provider warning, percentage not reported, resets ${untilWords(now + WEEK_LEFT, now)} · ${HOLDING_BACK}`);
  });

  it.each([0.85, 0.95])("keeps the measured cause at %s visible ahead of low provider warnings", (utilization) => {
    const high = report({ kind: "five_hour", utilization, resetsAt: now + HOUR });
    const low = weekly("allowed_warning", 0.26);
    const modelWarning = report({ kind: "seven_day_opus", model: "opus", status: "allowed_warning", utilization: 0.3, resetsAt: now + WEEK_LEFT });
    // Account and live readings can arrive in either order; the fuller window explains the decision.
    for (const usage of [[high, low, modelWarning], [modelWarning, low, high]]) {
      const p = capped(...usage);
      expect(usageLines(state(p), now)[0]).toEqual({
        toolId: "claude-code", name: "Claude Code", tone: "near",
        text: `5-hour ${utilization * 100}%, resets 13:00 · weekly Opus 30%, provider warning, resets ${untilWords(now + WEEK_LEFT, now)} · ${HOLDING_BACK}`,
      });
      expect(toolCapNow(p, "claude-code", now, opusX)).toBe(4);
      expect(pickStarts({ candidates: [next()], inUse: running(4), pool: p, now })).toEqual([]);
      expect(chooseProfile(state(p), opusX, now)).toMatchObject(utilization < 0.9 ? { kind: "planned", profile: opusX } : { kind: "substitute", profile: solX });
      expect(p.usage).toEqual(usage);
    }
    // Once that window expires, the retained low warnings no longer describe a slowdown.
    const recovered = capped({ ...high, resetsAt: now }, low, modelWarning);
    const line = usageLines(state(recovered), now)[0]!;
    expect(line.tone).toBe("fine");
    expect(line.text).toContain("weekly 26%, provider warning");
    expect(line.text).not.toContain(HOLDING_BACK);
    expect(toolCapNow(recovered, "claude-code", now, opusX)).toBe(7);
    expect(chooseProfile(state(recovered), opusX, now)).toMatchObject({ kind: "planned", profile: opusX });
  });

  it("keeps a rejection visible ahead of measured warnings even when it has no or a low percentage", () => {
    for (const utilization of [undefined, 0.26]) {
      const p = capped(weekly("allowed_warning", 0.79), report({ kind: "seven_day_opus", model: "opus", status: "allowed_warning", utilization: 0.3 }), report({ kind: "five_hour", status: "rejected", utilization }));
      expect(usageLines(state(p), now)[0]!.text).toBe(`5-hour ${utilization === undefined ? "used up" : "26%"} · weekly 79%, provider warning, resets ${untilWords(now + WEEK_LEFT, now)} · ${HOLDING_BACK}`);
    }
  });

  it("shows the fullest measured windows first when several readings affect scheduling", () => {
    const p = capped(weekly("allowed_warning", 0.85), report({ kind: "seven_day_opus", model: "opus", status: "allowed_warning", utilization: 0.8 }), report({ kind: "five_hour", utilization: 0.95 }));
    expect(usageLines(state(p), now)[0]!.text).toBe(`5-hour 95% · weekly 85%, provider warning, resets ${untilWords(now + WEEK_LEFT, now)} · ${HOLDING_BACK}`);
  });

  it("keeps a current rejection effective with a low or missing percentage", () => {
    for (const utilization of [undefined, 0, 0.26]) {
      const spent = capped(weekly("rejected", utilization));
      expect(slowingDown(spent, "claude-code", now), String(utilization)).toBe(true);
      expect(headroom(spent, opusX, now), String(utilization)).toBe(0);
      const out = { ...spent, limited: [{ toolId: "claude-code", until: now + WEEK_LEFT, reason: "Claude Code's weekly limit", source: "report" as const }] };
      expect(chooseProfile(state(out), opusX, now), String(utilization)).toMatchObject({ kind: "substitute", profile: solX });
    }
  });

  it("stops counting a reading at its reset, or 30 minutes after it without one, while a refusal keeps its own lifetime", () => {
    for (const status of statuses) {
      for (const expired of [report({ status, utilization: 0.95, resetsAt: now - 1 }), report({ status, utilization: 0.95, at: now - 31 * 60_000 })]) {
        const p = capped(expired);
        expect(nearLimit(p, opusX, now), status).toBe(false);
        expect(toolCapNow(p, "claude-code", now, opusX), status).toBe(7);
        expect(headroom(p, opusX, now), status).toBeUndefined();
        expect(chooseProfile(state(p), opusX, now), status).toMatchObject({ kind: "planned", profile: opusX });
      }
      const fresh = capped(report({ status, utilization: 0.95, at: now - 29 * 60_000 }));
      expect(toolCapNow(fresh, "claude-code", now, opusX), status).toBe(4);
      expect(chooseProfile(state(fresh), opusX, now), status).toMatchObject({ kind: "substitute", profile: solX });
    }
    const refused = { ...capped(weekly("allowed_warning", 0.26)), limited: [{ toolId: "claude-code", until: now + HOUR, reason: "Claude Code refused the request", source: "refusal" as const }] };
    expect(limitOf(refused, opusX, now)).toBeDefined();
    expect(chooseProfile(state(refused), opusX, now)).toMatchObject({ kind: "substitute", profile: solX });
  });

  it("keeps a model's window to that model, so a low shared warning lends no other model its reduced allowance", () => {
    const opusWindow = (utilization: number) => report({ kind: "seven_day_opus", model: "opus", status: "allowed_warning", utilization, resetsAt: now + HOUR });
    const p = capped(weekly("allowed_warning", 0.26), opusWindow(0.85));
    expect(toolCapNow(p, "claude-code", now, opusX)).toBe(4);
    expect(toolCapNow(p, "claude-code", now, sonnet)).toBe(7);
    expect(slowingDown(p, "claude-code", now, sonnet)).toBe(false);
    expect(nearLimit(p, opusX, now)).toBe(false);
    // Opus's half counts Opus agents only; Sonnet agents never use it up.
    expect(pickStarts({ candidates: [next()], inUse: running(4, sonnet), pool: p, now })).toEqual(["next"]);
    expect(pickStarts({ candidates: [next()], inUse: running(4), pool: p, now })).toEqual([]);
    expect(pickStarts({ candidates: [next(sonnet)], inUse: running(4), pool: p, now })).toEqual(["next"]);
    // The configured tool cap still counts every model on the tool.
    expect(pickStarts({ candidates: [next(sonnet)], inUse: [...running(3), ...running(4, sonnet)], pool: p, now })).toEqual([]);
    // From 90%, only Opus moves.
    const near = capped(weekly("allowed_warning", 0.26), opusWindow(0.92));
    expect(chooseProfile(state(near), opusX, now)).toMatchObject({ kind: "substitute", profile: solX });
    expect(nearLimit(near, sonnet, now)).toBe(false);
  });
});
