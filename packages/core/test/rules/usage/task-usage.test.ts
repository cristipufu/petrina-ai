import { NOW, MIN, HOUR, task, state, turn, line, logWith } from '../../fixtures/analytics.js';
import { describe, expect, it } from "vitest";

import { ranAsAsked, usageView } from "../../../src/analytics.js";

describe("The task sheet", () => {
  it("groups Grok's verified session alias with its response model without treating alias resolution as a fallback", () => {
    const a = turn({ taskId: "grok", roleId: "builder", profileId: "sol-high", toolId: "grok", modelAsked: "grok-4.7", modelAskedName: "Grok 4.7", modelRan: "grok-4.7-build", modelRanName: "grok-4.7", tokens: { total: 100 } });
    const b = turn({ ...a, id: "alias-turn", sessionId: "another-session", modelRan: "grok-4.7", tokens: { total: 200 } });
    const log = logWith([{ turn: a, lines: [line(a.id, "grok-4.7-build", 100)] }, { turn: b, lines: [line(b.id, "grok-4.7", 200)] }]);
    const ctx = { now: NOW, state: state([task("grok", "shop")]) };
    const analytics = usageView(log, { view: "analytics", period: "7d" }, ctx);
    expect(analytics.byModel).toHaveLength(1);
    expect(analytics.headline.tokens.value).toBe(300);
    expect(analytics.byModel[0]).toMatchObject({ label: "Grok 4.7", tokens: { value: 300 }, time: { value: 20 * MIN } });
    expect(analytics.overTime.splits.model.series.map((s) => s.label)).toEqual(["Grok 4.7"]);
    expect(ranAsAsked(a)).toBe(true);
    expect(ranAsAsked({ ...a, modelRan: "grok-4.7-build[fast]" })).toBe(false);
    expect(ranAsAsked({ ...a, toolId: "codex" })).toBe(false);
    expect(ranAsAsked({ ...a, effortRan: "other" })).toBe(false);
    const sheet = usageView(log, { view: "task", taskId: "grok" }, ctx);
    expect(sheet.stages[0]!.agents[0]).toMatchObject({ settings: `Grok 4.7 at ${a.effortRan}`, differs: false });
  });

  it("adds up each stage and agent in plan order, planning first, with rounds and models", () => {
    const t = task("a", "shop");
    const plan = turn({ taskId: "a", roleId: "planner", profileId: "sonnet-medium", stageId: "a:plan", stageTitle: "Planning", stageKind: "plan" });
    const arch1 = turn({ taskId: "a", roleId: "architect", profileId: "opus-high", stageId: "a:design", stageKind: "converge", stageTitle: "Design", round: 1 });
    const arch2 = turn({ taskId: "a", roleId: "architect", profileId: "opus-high", stageId: "a:design", stageKind: "converge", stageTitle: "Design", round: 2 });
    const build = turn({ taskId: "a", roleId: "builder", profileId: "sol-high" });
    const fix = turn({ taskId: "a", roleId: "builder", profileId: "sol-high", round: 2, fixing: true });
    const old = turn({ taskId: "a", roleId: "researcher", profileId: "sonnet-medium", stageId: "a:research", stageTitle: "Research", startedAt: NOW - 3 * HOUR });
    const log = logWith([
      { turn: build },
      { turn: arch1, lines: [line(arch1.id, "claude-opus-5-5", 9000), line(arch1.id, "claude-haiku-5-5", 1000)] },
      { turn: arch2 },
      { turn: plan },
      { turn: fix },
      { turn: old },
    ]);
    const view = usageView(log, { view: "task", taskId: "a" }, { now: NOW, state: state([t]) });
    expect(view.stages.map((stage) => stage.title)).toEqual(["Planning", "Design", "Build", "Research"]);
    expect(view.stages.find((stage) => stage.title === "Research")?.removed).toBe(true);
    const design = view.stages[1]!;
    expect(design.rounds).toBe(2);
    expect(design.tokens).toEqual({ value: 20_000, atLeast: false });
    expect(design.agents[0]!.models).toEqual([
      { label: "Opus 5.5", tokens: 9000 },
      { label: "Haiku 5.5", tokens: 1000 },
    ]);
    expect(view.stages[2]!.rounds).toBe(2);
    expect(view.stages[2]!.time.value).toBe(20 * MIN);
    expect(view.tokens).toEqual({ value: 60_000, atLeast: false });
    expect(view.cacheRead).toBe(48_000);
    expect(view.atLeast).toBe("");
  });

  it("says what ran when it differs from what was asked, or that it wasn't confirmed", () => {
    const off = turn({ taskId: "b", roleId: "design-reviewer", profileId: "sol-xhigh", stageId: "b:design", modelRan: "gpt-6.1", modelRanName: "gpt-6.1", effortRan: "medium" });
    const unknown = turn({ taskId: "b", roleId: "builder", profileId: "sol-high", modelRan: undefined, modelRanName: undefined, effortRan: undefined });
    const view = usageView(logWith([{ turn: off }, { turn: unknown }]), { view: "task", taskId: "b" }, { now: NOW, state: state([task("b", "shop")]) });
    const agents = view.stages.flatMap((stage) => stage.agents);
    expect(agents.find((agent) => agent.roleId === "design-reviewer")?.settings).toBe("asked for sol at xhigh, ran gpt-6.1 at medium");
    expect(agents.find((agent) => agent.roleId === "builder")?.settings).toBe("settings not confirmed");
  });

  it("shows a calm line instead of zeros when nothing was recorded", () => {
    const log = logWith([]);
    log.markUntracked("old", "shop");
    const s = state([task("old", "shop"), task("new", "shop", { state: "queued" })]);
    expect(usageView(log, { view: "task", taskId: "old" }, { now: NOW, state: s }).empty).toBe("untracked");
    expect(usageView(log, { view: "task", taskId: "new" }, { now: NOW, state: s })).toMatchObject({
      empty: "nothing", tokens: { atLeast: false, value: 0 }, time: { atLeast: false, value: 0 },
    });
  });
});
