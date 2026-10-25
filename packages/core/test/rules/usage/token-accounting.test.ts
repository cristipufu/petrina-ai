import { NOW, task, state, turn, line, logWith } from "../../fixtures/analytics.js";
import { describe, expect, it } from "vitest";

import { usageView } from "../../../src/analytics.js";

import { modelLabel, turnTokens } from "../../../src/worklog.js";

describe("Counting tokens", () => {
  it("keeps Claude Code's per-model breakdown as reported, counted once and never added to the main figure", () => {
    const counted = turnTokens({
      toolId: "claude-code",
      model: "Opus 5.5",
      report: {
        main: { input: 100, cacheRead: 900, cacheWrite: 50, output: 40, total: 1090 },
        models: [
          { model: "claude-opus-5-5", counts: { input: 150, cacheRead: 1200, cacheWrite: 60, output: 70, reasoning: 0, total: 1480 } },
          { model: "claude-haiku-5-5", counts: { input: 20, cacheRead: 100, cacheWrite: 0, output: 10, reasoning: 0 } },
        ],
      },
    });
    expect(counted.lines.map((entry) => [entry.model, entry.total])).toEqual([
      ["claude-opus-5-5", 1480],
      ["claude-haiku-5-5", 130],
    ]);
    // The turn is the breakdown's sum, not breakdown + main, and there is no helper figure anywhere.
    expect(counted.tokens?.total).toBe(1610);
    expect(counted.mainOnly).toBe(false);
    expect(Object.keys(counted.tokens!).sort()).toEqual(["cacheRead", "cacheWrite", "input", "output", "total"]);
    for (const entry of counted.lines) expect(Object.keys(entry)).not.toContain("effort");
  });

  it("falls back to the main figure under the confirmed model, counting the main agent only", () => {
    const counted = turnTokens({ toolId: "claude-code", model: "Opus 5.5", report: { main: { input: 10, cacheRead: 90, output: 5, total: 105 } } });
    expect(counted.lines).toEqual([{ model: "Opus 5.5", input: 10, cacheRead: 90, output: 5, total: 105 }]);
    expect(counted.mainOnly).toBe(true);
  });

  it("works the total out the same way for both tools, and uses a lone total as given", () => {
    const codex = turnTokens({ toolId: "codex", model: "gpt-6.1-sol", report: { models: [{ model: "gpt-6.1-sol", counts: { input: 100, cacheRead: 800, cacheWrite: 0, output: 50, reasoning: 20, total: 999 } }] } });
    expect(codex.tokens).toEqual({ input: 100, cacheRead: 800, cacheWrite: 0, output: 50, reasoning: 20, total: 950 });
    expect(turnTokens({ toolId: "codex", report: { main: { total: 4242 } } }).tokens).toEqual({ total: 4242 });
    expect(turnTokens({ toolId: "codex" }).tokens).toBeUndefined();
  });

  it("marks a Codex reroute on its line and a Codex helper agent on the turn", () => {
    const counted = turnTokens({ toolId: "codex", rerouted: true, helpers: 1, report: { models: [{ model: "gpt-6.1-sol", counts: { input: 1, output: 1 } }] } });
    expect(counted.lines[0]?.changed).toBe(true);
    expect(counted.mainOnly).toBe(true);
  });

  it("keeps Grok's own single figure and missing reports separate from Claude Code and Codex", () => {
    const counted = turnTokens({ toolId: "grok", model: "grok-code", report: { main: { input: 100, cacheRead: 800, output: 50, total: 999 } } });
    expect(counted.tokens?.total).toBe(950);
    expect(counted.lines).toEqual([{ model: "grok-code", input: 100, cacheRead: 800, output: 50, total: 950 }]);
    expect(counted.mainOnly).toBe(false);
    expect(turnTokens({ toolId: "grok" }).tokens).toBeUndefined();

    const grok = turn({ taskId: "grok-task", roleId: "builder", profileId: "sol-high", toolId: "grok", modelRan: "grok-code", modelRanName: "Grok Code", tokens: counted.tokens, helpers: 1 });
    const log = logWith([{ turn: grok, lines: counted.lines }]);
    const ctx = { now: NOW, state: state([task("grok-task", "shop")]) };
    const analytics = usageView(log, { view: "analytics", period: "today" }, ctx);
    expect(analytics.byTool.map((entry) => [entry.label, entry.tokens.value])).toEqual([["Grok", 950]]);
    expect(analytics.byModel.map((entry) => entry.label)).toEqual(["grok-code"]);
    expect(analytics.about.codexHelperTurns).toBe(0);
    expect(analytics.about.claudeMainOnly).toBe(0);
    expect(usageView(log, { view: "today" }, ctx).byTool.find((entry) => entry.toolId === "grok")).toMatchObject({ label: "Grok", tokens: { value: 950, atLeast: false } });
  });

  it("names models plainly when it recognises them, and as reported otherwise", () => {
    expect(modelLabel("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelLabel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(modelLabel("gpt-6.1-sol")).toBe("gpt-6.1-sol");
    expect(modelLabel("grok-4.7")).toBe("Grok 4.7");
    expect(modelLabel("grok-4.7-build")).toBe("Grok 4.7");
    expect(modelLabel("grok-4.7-build[fast]")).toBe("grok-4.7-build[fast]");
    expect(modelLabel("some-new-model")).toBe("some-new-model");
    // A name Petrina doesn't recognise, bracketed ending and all, stays exactly as reported.
    expect(modelLabel("claude-sonnet-5[1m]")).toBe("claude-sonnet-5[1m]");
    expect(modelLabel("acme-coder[fast]")).toBe("acme-coder[fast]");
    expect(modelLabel("Claude-Opus-5-5")).toBe("Claude-Opus-5-5");
  });

  it("never merges unfamiliar model names into each other or into a model it recognises", () => {
    const one = turn({ taskId: "u", roleId: "builder", profileId: "opus-high" });
    const lines = [line(one.id, "claude-opus-5-5", 4000), line(one.id, "claude-opus-5-5[1m]", 3000), line(one.id, "acme-coder[fast]", 2000), line(one.id, "acme-coder[slow]", 1000), line(one.id, "acme-coder", 500)];
    const log = logWith([{ turn: one, lines }]);
    const view = usageView(log, { view: "analytics", period: "today" }, { now: NOW, state: state([task("u", "shop")]) });
    expect(view.byModel.map((entry) => [entry.label, entry.tokens.value])).toEqual([
      ["Opus 5.5", 4000],
      ["claude-opus-5-5[1m]", 3000],
      ["acme-coder[fast]", 2000],
      ["acme-coder[slow]", 1000],
      ["acme-coder", 500],
    ]);
    // The task sheet lists the agent's models the same way.
    const sheet = usageView(log, { view: "task", taskId: "u" }, { now: NOW, state: state([task("u", "shop")]) });
    expect(sheet.stages[0]!.agents[0]!.models.map((model) => model.label)).toEqual(["Opus 5.5", "claude-opus-5-5[1m]", "acme-coder[fast]", "acme-coder[slow]", "acme-coder"]);
  });
});
