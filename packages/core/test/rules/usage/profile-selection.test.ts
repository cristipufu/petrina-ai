import { describe, expect, it } from "vitest";
import type { AgentProfile, Pool, Tool, UsageLimit, UsageReport } from "../../../src/model.js";
import { DEFAULT_PROFILES } from "../../../src/profiles.js";
import { chooseProfile, chooseWithRoom, nearLimit, untilWords, waitingWords } from "../../../src/usage.js";

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
    const close = pool({ usage: [report({ status: "allowed_warning", utilization: 0.9, resetsAt: now + HOUR })] });
    expect(choose(opus, close)).toEqual({ kind: "substitute", profile: sol, reason: expect.any(String) });
    // A provider's warning without a number is not a measurement of 90%.
    expect(choose(opus, pool({ usage: [report({ status: "allowed_warning", resetsAt: now + HOUR })] })).kind).toBe("planned");
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

it("captures the selection cause before usage changes and names independence separately", () => {
  const p = pool({ limited: [{ toolId: opus.toolId, until: now + 3600000, reason: "Weekly allowance exhausted" }] });
  const selected = choose(opus, p);
  expect(selected.kind !== "none" && selected.reason).toContain("Weekly allowance exhausted");
  p.limited = [];
  expect(selected.kind !== "none" && selected.reason).toContain("Weekly allowance exhausted");
  const independent = chooseProfile({ profiles, tools, pool: p }, sol, now, { awayFrom: { toolId: sol.toolId, modelId: sol.modelId } });
  expect(independent.kind !== "none" && independent.reason).toContain("independent");
});
