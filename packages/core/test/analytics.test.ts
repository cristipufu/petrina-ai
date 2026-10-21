import { describe, expect, it } from "vitest";
import { createDemo, createPortfolioDemo } from "../src/demo.js";
import { BUILT_IN_ROLES, DEFAULT_PROFILES, KNOWN_TOOLS } from "../src/library.js";
import type { State, Task } from "../src/model.js";
import { agoText, atLeastLine, codexLimits, durationText, figureText, limitWords, nearestLimit, nearestLimitWords, nextReset, tokensText } from "../src/numbers.js";
import { Simulator } from "../src/sim.js";
import { periodRange, ranAsAsked, usageView } from "../src/analytics.js";
import { CHANGED_LABEL, MemoryWorkLog, NOT_CONFIRMED_LABEL, modelLabel, turnTokens, type TokenLine, type WorkMoment, type WorkTurn } from "../src/worklog.js";

const NOW = new Date(2026, 9, 17, 15, 0, 0).getTime();
const MIN = 60_000;
const HOUR = 60 * MIN;

function task(id: string, productId: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    productId,
    title: `Task ${id}`,
    description: "",
    area: "it",
    kind: "feature",
    priority: 0,
    held: false,
    state: "done",
    column: "done",
    holdsSlot: false,
    approvePlan: false,
    delivery: "pull-request",
    approveDelivery: true,
    stageIndex: 3,
    rounds: {},
    sub: 0,
    fixing: false,
    statusLine: "",
    createdAt: NOW - 5 * HOUR,
    startedAt: NOW - 4 * HOUR,
    timeline: [],
    session: [],
    queued: [],
    objections: [],
    findings: [],
    plan: {
      plannerProfileId: "sonnet-medium",
      rationale: "",
      stages: [
        { id: `${id}:design`, kind: "converge", title: "Design", roleId: "architect", profileIds: ["opus-high"], reviewerRoleId: "design-reviewer", reviewerProfileIds: ["sol-xhigh"], maxRounds: 3 },
        { id: `${id}:build`, kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-high"] },
        { id: `${id}:review`, kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high", "sol-xhigh"], maxRounds: 2 },
      ],
    },
    ...extra,
  };
}

function state(tasks: Task[]): State {
  return {
    now: NOW,
    seq: 0,
    products: [
      { id: "shop", name: "Shop", repo: "acme/shop", tone: "blue" },
      { id: "notes", name: "Notes", repo: "acme/notes", tone: "green" },
    ],
    roles: BUILT_IN_ROLES,
    tools: KNOWN_TOOLS,
    profiles: DEFAULT_PROFILES,
    tasks,
    inbox: [],
    pool: { limit: 3, paused: false, toolCaps: {} },
    work: { version: 1, since: NOW - 10 * 24 * HOUR },
  };
}

let serial = 0;
/** A finished turn that ran as asked, unless told otherwise. */
function turn(extra: Partial<WorkTurn> & Pick<WorkTurn, "taskId" | "roleId" | "profileId">): WorkTurn {
  serial += 1;
  const profile = DEFAULT_PROFILES.find((entry) => entry.id === extra.profileId)!;
  const startedAt = extra.startedAt ?? NOW - 2 * HOUR;
  return {
    id: `t${serial}`,
    productId: "shop",
    stageId: `${extra.taskId}:build`,
    stageTitle: "Build",
    stageKind: "do",
    round: 1,
    fixing: false,
    toolId: profile.toolId,
    modelAsked: profile.modelId!,
    modelAskedName: profile.model,
    effortAsked: profile.effort,
    modelRan: profile.modelId!,
    modelRanName: profile.toolId === "codex" ? profile.modelId! : profile.model,
    effortRan: profile.effort,
    sessionId: `s-${extra.taskId}`,
    reason: "first",
    startedAt,
    endedAt: startedAt + 10 * MIN,
    end: "finished",
    mainOnly: false,
    helpers: 0,
    workMs: 10 * MIN,
    tokens: { input: 1000, cacheRead: 8000, cacheWrite: 500, output: 500, total: 10_000 },
    ...extra,
  };
}

function line(turnId: string, model: string, total: number, extra: Partial<TokenLine> = {}): Omit<TokenLine, "turnId"> & { turnId?: string } {
  return { model, input: total * 0.1, cacheRead: total * 0.8, cacheWrite: total * 0.05, output: total * 0.05, total, ...extra, turnId };
}

function logWith(entries: { turn: WorkTurn; lines?: Omit<TokenLine, "turnId">[] }[], moments: WorkMoment[] = [], since = NOW - 10 * 24 * HOUR): MemoryWorkLog {
  const log = new MemoryWorkLog(since);
  for (const entry of entries) log.addTurn(entry.turn, entry.lines ?? []);
  for (const moment of moments) log.addMoment(moment);
  return log;
}

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
    expect(usageView(log, { view: "task", taskId: "new" }, { now: NOW, state: s }).empty).toBe("nothing");
  });
});

describe("“At least”", () => {
  it("reads “at least” only when whole turns are missing, judged separately for tokens and time", () => {
    const silent = turn({ taskId: "c", roleId: "builder", profileId: "sol-high", end: "stopped", tokens: undefined });
    const lost = turn({ taskId: "d", roleId: "builder", profileId: "sol-high", end: "lost", endedAt: undefined, workMs: undefined, tokens: undefined });
    const mainOnly = turn({ taskId: "e", roleId: "builder", profileId: "opus-high", mainOnly: true });
    const helpers = turn({ taskId: "e", roleId: "builder", profileId: "sol-high", helpers: 2, mainOnly: true });
    const log = logWith([{ turn: silent }, { turn: lost }, { turn: mainOnly }, { turn: helpers }]);
    const s = state([task("c", "shop"), task("d", "shop"), task("e", "shop")]);
    const c = usageView(log, { view: "task", taskId: "c" }, { now: NOW, state: s });
    expect(c.tokens).toEqual({ atLeast: true });
    expect(c.time).toEqual({ value: 10 * MIN, atLeast: false });
    expect(figureText(c.tokens, "tokens")).toBe("not reported");
    expect(c.atLeast).toBe("“At least” because 1 turn sent no token report.");
    const d = usageView(log, { view: "task", taskId: "d" }, { now: NOW, state: s });
    expect(d.time.atLeast).toBe(true);
    expect(d.atLeast).toContain("cut off when Petrina stopped");
    // Main-agent-only turns, helpers and cache reuse never make a total "at least".
    const e = usageView(log, { view: "task", taskId: "e" }, { now: NOW, state: s });
    expect(e.tokens).toEqual({ value: 20_000, atLeast: false });
    expect(e.atLeast).toBe("");
  });

  it("keeps work from before tracking began “at least”, and periods that start before it", () => {
    const log = logWith([{ turn: turn({ taskId: "f", roleId: "builder", profileId: "sol-high" }) }], [], NOW - 3 * 24 * HOUR);
    log.markUntracked("f", "shop");
    const s = state([task("f", "shop")]);
    const f = usageView(log, { view: "task", taskId: "f" }, { now: NOW, state: s });
    expect(f.tokens.atLeast && f.time.atLeast).toBe(true);
    expect(f.atLeast).toContain("before Petrina started keeping track");
    expect(usageView(log, { view: "analytics", period: "7d" }, { now: NOW, state: s }).headline.tokens.atLeast).toBe(true);
    expect(usageView(log, { view: "analytics", period: "today" }, { now: NOW, state: s }).headline.tokens.atLeast).toBe(false);
    const products = usageView(log, { view: "products" }, { now: NOW, state: s });
    expect(products.products.find((entry) => entry.productId === "shop")?.tokens.atLeast).toBe(true);
    expect(products.products.find((entry) => entry.productId === "notes")?.tokens).toEqual({ value: 0, atLeast: false });
    // The page gives its reason once, not on every line.
    expect(products.atLeast).toContain("before Petrina started keeping track");
    const fresh = usageView(logWith([{ turn: turn({ taskId: "g", roleId: "builder", profileId: "sol-high" }) }]), { view: "products" }, { now: NOW, state: state([task("g", "shop")]) });
    expect(fresh.atLeast).toBe("");
  });

  it("never turns unknown older use into zero: it says it isn't known", () => {
    // Shop's only work ran before Petrina started keeping track; nothing of it was recorded.
    const log = logWith([], [], NOW - 3 * 24 * HOUR);
    log.markUntracked("old", "shop");
    const s = state([task("old", "shop")]);
    const month = usageView(log, { view: "analytics", period: "30d", productId: "shop" }, { now: NOW, state: s });
    expect(month.headline.tokens).toEqual({ atLeast: true, unknown: true });
    expect(month.headline.time).toEqual({ atLeast: true, unknown: true });
    expect([figureText(month.headline.tokens, "tokens"), figureText(month.headline.time, "time")]).toEqual(["not known", "not known"]);
    expect(month.atLeast).toBe("Not known: work from before Petrina started keeping track wasn't recorded.");
    const all = usageView(log, { view: "analytics", period: "30d" }, { now: NOW, state: s });
    expect(figureText(all.headline.tokens, "tokens")).toBe("not known");
    const shop = usageView(log, { view: "products" }, { now: NOW, state: s }).products.find((entry) => entry.productId === "shop")!;
    expect([figureText(shop.tokens, "tokens"), figureText(shop.time, "time")]).toEqual(["not known", "not known"]);
    // A turn cut off when Petrina stopped: its tokens and time aren't known either.
    const lost = turn({ taskId: "z", roleId: "builder", profileId: "sol-high", end: "lost", endedAt: undefined, workMs: undefined, tokens: undefined });
    const z = usageView(logWith([{ turn: lost }]), { view: "task", taskId: "z" }, { now: NOW, state: state([task("z", "shop")]) });
    expect([figureText(z.tokens, "tokens"), figureText(z.time, "time")]).toEqual(["not known", "not known"]);
    const lostModel = usageView(logWith([{ turn: lost }]), { view: "analytics", period: "today" }, { now: NOW, state: s }).byModel[0]!;
    expect([figureText(lostModel.tokens, "tokens"), figureText(lostModel.time, "time")]).toEqual(["not known", "not known"]);
    // A product added after tracking began has nothing missing: zero is zero there.
    log.recordProduct({ id: "notes", name: "Notes", addedAt: NOW - HOUR });
    const notes = usageView(log, { view: "analytics", period: "30d", productId: "notes" }, { now: NOW, state: s });
    expect(notes.headline.tokens).toEqual({ value: 0, atLeast: false });
    expect(notes.atLeast).toBe("");
  });

  it("never reads “at least 0” or “at least under a minute”", () => {
    expect(figureText({ value: 0, atLeast: true }, "tokens")).toBe("not known");
    expect(figureText({ value: 0, atLeast: true }, "time")).toBe("not known");
    expect(figureText({ value: 20_000, atLeast: true }, "time")).toBe("at least a few seconds");
    expect(figureText({ value: 0, atLeast: false }, "time")).toBe("under a minute");
    expect(figureText({ value: 0, atLeast: false }, "tokens")).toBe("0 tokens");
    expect(figureText({ atLeast: true }, "tokens")).toBe("not reported");
  });

  it("keeps the warning on every split when the period starts before tracking began", () => {
    const since = NOW - 3 * 24 * HOUR;
    const early = turn({ taskId: "f", roleId: "builder", profileId: "sol-high" });
    const later = turn({ taskId: "n", productId: "notes", roleId: "code-reviewer", profileId: "opus-high", stageId: "n:review", stageKind: "review-chain" });
    const log = logWith([{ turn: early, lines: [line(early.id, "gpt-6.1-sol", 10_000)] }, { turn: later, lines: [line(later.id, "claude-opus-5-5", 10_000)] }], [], since);
    log.markUntracked("f", "shop");
    log.recordProduct({ id: "shop", name: "Shop", addedAt: since });
    // Notes was added after Petrina started keeping track: nothing of it can be missing.
    log.recordProduct({ id: "notes", name: "Notes", addedAt: since + HOUR });
    const s = state([task("f", "shop"), task("n", "notes")]);
    const week = usageView(log, { view: "analytics", period: "7d" }, { now: NOW, state: s });
    expect(week.headline.tokens.atLeast && week.headline.time.atLeast).toBe(true);
    for (const split of [week.byTool, week.byRole, week.byModel]) {
      expect(split.length).toBeGreaterThan(0);
      for (const entry of split) expect([entry.label, entry.tokens.atLeast, entry.time.atLeast]).toEqual([entry.label, true, true]);
    }
    expect(week.byProduct?.find((entry) => entry.productId === "shop")).toMatchObject({ tokens: { atLeast: true }, time: { atLeast: true } });
    expect(week.byProduct?.find((entry) => entry.productId === "notes")).toMatchObject({ tokens: { atLeast: false }, time: { atLeast: false } });
    expect(week.byTask.find((entry) => entry.taskId === "f")?.tokens.atLeast).toBe(true);
    expect(week.byTask.find((entry) => entry.taskId === "n")?.tokens.atLeast).toBe(false);
    // A period that starts after tracking began has nothing missing, on any line, a task's that started before it included.
    const today = usageView(log, { view: "analytics", period: "today" }, { now: NOW, state: s });
    expect(today.byTask.map((entry) => entry.taskId).sort()).toEqual(["f", "n"]);
    for (const entry of [...today.byTool, ...today.byRole, ...today.byModel, ...(today.byProduct ?? []), ...today.byTask]) expect(entry.tokens.atLeast || entry.time.atLeast).toBe(false);
    expect(today.atLeast).toBe("");
    // The task's own sheet still says its earlier work was not recorded: that is all of its work, not one period.
    expect(usageView(log, { view: "task", taskId: "f" }, { now: NOW, state: s }).atLeast).not.toBe("");
  });
});

describe("Analytics", () => {
  const s = state([task("g", "shop"), task("h", "notes"), task("r", "gone")]);
  const opus = turn({ taskId: "g", roleId: "builder", profileId: "opus-high" });
  const fallback = turn({ taskId: "g", roleId: "code-reviewer", profileId: "opus-high", modelChangedTo: "Sonnet 5.5", stageId: "g:review", stageKind: "review-chain" });
  const unconfirmed = turn({ taskId: "h", productId: "notes", roleId: "builder", profileId: "sonnet-medium", modelRan: undefined, modelRanName: undefined, effortRan: undefined });
  const codex = turn({ taskId: "h", productId: "notes", roleId: "code-reviewer", profileId: "sol-xhigh", stageId: "h:review", stageKind: "review-chain" });
  const rerouted = turn({ taskId: "h", productId: "notes", roleId: "code-reviewer", profileId: "sol-high", modelChangedTo: "gpt-6.1-mini", stageId: "h:review", stageKind: "review-chain", round: 2 });
  const removed = turn({ taskId: "r", productId: "gone", roleId: "builder", profileId: "sol-high", helpers: 1, mainOnly: true });
  const noBreakdown = turn({ taskId: "g", roleId: "planner", profileId: "sonnet-medium", stageId: "g:plan", stageKind: "plan", mainOnly: true });
  const log = logWith([
    { turn: opus, lines: [line(opus.id, "claude-opus-5-5", 9000), line(opus.id, "claude-haiku-5-5", 1000)] },
    { turn: fallback, lines: [line(fallback.id, "claude-opus-5-5", 4000), line(fallback.id, "claude-sonnet-5-5", 6000)] },
    { turn: unconfirmed, lines: [line(unconfirmed.id, "claude-sonnet-5-5", 10_000)] },
    { turn: codex, lines: [line(codex.id, "gpt-6.1-sol", 10_000)] },
    { turn: rerouted, lines: [line(rerouted.id, "gpt-6.1-sol", 10_000, { changed: true })] },
    { turn: removed, lines: [line(removed.id, "gpt-6.1-sol", 10_000)] },
    { turn: noBreakdown, lines: [line(noBreakdown.id, "Sonnet 5.5", 10_000)] },
  ]);
  log.recordProduct({ id: "gone", name: "Old app", removedAt: NOW - 24 * HOUR });
  const view = usageView(log, { view: "analytics", period: "7d" }, { now: NOW, state: s });

  it("gives the headline, the chart and the tool, role, product and task splits", () => {
    expect(view.headline).toEqual({ tokens: { value: 70_000, atLeast: false }, time: { value: 70 * MIN, atLeast: false }, turns: 7, tasks: 3 });
    expect(view.chart.buckets).toHaveLength(7);
    const today = view.chart.buckets.at(-1)!;
    expect(today.tokens).toEqual({ "claude-code": 40_000, codex: 30_000 });
    expect(view.byTool.map((entry) => [entry.label, entry.tokens.value])).toEqual([
      ["Claude Code", 40_000],
      ["Codex", 30_000],
    ]);
    expect(view.byRole.map((entry) => entry.label)).toEqual(["Builder", "Code reviewer", "Planner"]);
    expect(view.byProduct?.find((entry) => entry.productId === "gone")).toMatchObject({ label: "Old app", note: "removed", tokens: { value: 10_000 } });
    expect(view.byTask).toHaveLength(3);
    expect(view.byTool[0]!.detail).toEqual({ input: 4000, cacheRead: 32_000, cacheWrite: 2000, output: 2000 });
    // Only all-products views split by product.
    expect(usageView(log, { view: "analytics", period: "7d", productId: "shop" }, { now: NOW, state: s }).byProduct).toBeUndefined();
  });

  it("splits by model exactly as reported, and puts time only with the agent's own model", () => {
    const byLabel = new Map(view.byModel.map((entry) => [entry.label, entry]));
    expect(byLabel.get("Opus 5.5")).toMatchObject({ tokens: { value: 13_000 }, time: { value: 10 * MIN } });
    // A model that only appeared inside another model's turns has tokens but no time of its own, never zero.
    expect(byLabel.get("Haiku 5.5")?.time.value).toBeUndefined();
    expect(figureText(byLabel.get("Haiku 5.5")!.time, "time")).toBe("not reported");
    // The planner's main figure sits under its confirmed model name, and so does its time.
    expect(byLabel.get("Sonnet 5.5")).toMatchObject({ tokens: { value: 26_000 }, time: { value: 10 * MIN } });
    expect(byLabel.get(NOT_CONFIRMED_LABEL)).toMatchObject({ time: { value: 10 * MIN } });
    expect(byLabel.get(NOT_CONFIRMED_LABEL)?.tokens.value).toBeUndefined();
    // A Claude fallback's time and a Codex reroute's tokens and time go on the "changed" line.
    expect(byLabel.get(CHANGED_LABEL)).toMatchObject({ tokens: { value: 10_000 }, time: { value: 20 * MIN } });
    expect(byLabel.get("gpt-6.1-sol")).toMatchObject({ tokens: { value: 20_000 }, time: { value: 20 * MIN } });
    for (const entry of view.byModel) expect(entry.label).not.toMatch(/high|medium|xhigh|effort/);
  });

  it("only credits a profile with stages that ran on its own model and effort", () => {
    const reviews: WorkMoment[] = [
      { id: "v1", at: NOW - HOUR, kind: "verdict", taskId: "g", productId: "shop", stageId: "g:review", round: 1, roleId: "code-reviewer", profileId: "opus-high", count: 2, blocking: 1 },
      { id: "v2", at: NOW - HOUR, kind: "verdict", taskId: "h", productId: "notes", stageId: "h:review", round: 1, roleId: "code-reviewer", profileId: "sol-xhigh", count: 1, blocking: 1 },
    ];
    const withVerdicts = logWith(
      [
        { turn: fallback, lines: [] },
        { turn: codex, lines: [] },
      ],
      reviews,
    );
    const squad = usageView(withVerdicts, { view: "analytics", period: "7d" }, { now: NOW, state: s }).squad;
    const rows = squad.details.reviewers;
    expect(rows.find((row) => row.label === "Codex · sol · xhigh")).toMatchObject({ credited: true, stages: 1, rounds: 1, blocking: 1, sentBack: 1 });
    // The Opus reviewer fell back to Sonnet, so that review is listed under what ran, not under the Opus profile.
    expect(rows.some((row) => row.label === "Claude Code · Opus 5.5 · high")).toBe(false);
    expect(rows.find((row) => row.label.includes("Sonnet 5.5"))).toMatchObject({ credited: false, blocking: 1 });
    expect(squad.details.settingsLine).toContain("1 agent stage ran on settings other than those asked for");
  });

  it("gives no profile credit for a stage when any of its rounds ran on other settings", () => {
    const review = { taskId: "g", roleId: "code-reviewer", profileId: "opus-high", stageId: "g:review", stageKind: "review-chain" } as const;
    const asAsked = turn({ ...review, round: 1 });
    const offRound = turn({ ...review, round: 2, modelRan: "sonnet", modelRanName: "Sonnet 5.5" });
    const verdicts: WorkMoment[] = [1, 2].map((round) => ({ id: `w${round}`, at: NOW - HOUR, kind: "verdict", taskId: "g", productId: "shop", stageId: "g:review", round, roleId: "code-reviewer", profileId: "opus-high", count: 1, blocking: 1 }));
    const squad = usageView(logWith([{ turn: asAsked }, { turn: offRound }], verdicts), { view: "analytics", period: "7d" }, { now: NOW, state: s }).squad;
    const rows = squad.details.reviewers;
    // Round 1 alone ran as asked, but the stage didn't: neither round counts for the Opus profile.
    expect(rows.some((row) => row.credited)).toBe(false);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ credited: false, stages: 1, rounds: 2, blocking: 2 });
    expect(rows[0]!.label).toContain("Sonnet 5.5");
    expect(squad.details.settingsLine).toContain("1 agent stage ran on settings other than those asked for");
  });

  it("judges a stage on every round, also the ones before the period", () => {
    const review = { taskId: "g", roleId: "code-reviewer", profileId: "opus-high", stageId: "g:review", stageKind: "review-chain" } as const;
    // Yesterday's round ran on Sonnet; today's ran on the Opus profile as asked.
    const yesterday = turn({ ...review, round: 1, startedAt: NOW - 20 * HOUR, modelRan: "sonnet", modelRanName: "Sonnet 5.5" });
    const todayRound = turn({ ...review, round: 2 });
    const verdicts: WorkMoment[] = [
      { id: "y1", at: NOW - 19 * HOUR, kind: "verdict", taskId: "g", productId: "shop", stageId: "g:review", round: 1, roleId: "code-reviewer", profileId: "opus-high", count: 1, blocking: 1 },
      { id: "y2", at: NOW - HOUR, kind: "verdict", taskId: "g", productId: "shop", stageId: "g:review", round: 2, roleId: "code-reviewer", profileId: "opus-high", count: 0, blocking: 0 },
    ];
    const squad = usageView(logWith([{ turn: yesterday }, { turn: todayRound }], verdicts), { view: "analytics", period: "today" }, { now: NOW, state: s }).squad;
    const rows = squad.details.reviewers;
    // Only today's round is in the period, but the stage didn't run on the profile's settings throughout.
    expect(rows.some((row) => row.credited)).toBe(false);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ credited: false, stages: 1, rounds: 1, blocking: 0 });
    expect(rows[0]!.label).toContain("Sonnet 5.5");
    expect(squad.details.settingsLine).toContain("1 agent stage ran on settings other than those asked for");
  });

  it("keeps unknown profile time unknown, and marks recorded time mixed with a lost turn as at least", () => {
    const review = { taskId: "g", roleId: "code-reviewer", profileId: "opus-high", stageId: "g:review", stageKind: "review-chain" } as const;
    const lost = turn({ ...review, round: 2, end: "lost", endedAt: undefined, workMs: undefined, tokens: undefined });
    const onlyLost = usageView(logWith([{ turn: lost }]), { view: "analytics", period: "today" }, { now: NOW, state: s }).squad.details.reviewers[0]!;
    expect(onlyLost.time).toEqual({ atLeast: true, unknown: true });
    expect(figureText(onlyLost.time, "time")).toBe("not known");
    const known = turn({ ...review, round: 1, workMs: 10 * MIN });
    const mixed = usageView(logWith([{ turn: known }, { turn: lost }]), { view: "analytics", period: "today" }, { now: NOW, state: s }).squad.details.reviewers[0]!;
    expect(mixed.time).toEqual({ value: 10 * MIN, atLeast: true });
    expect(figureText(mixed.time, "time")).toBe("at least 10m");
  });

  it("includes Security reviewers' stages and time alongside their verdicts", () => {
    const security = turn({ taskId: "g", roleId: "security-reviewer", profileId: "opus-high", stageId: "g:security", stageKind: "review-chain", workMs: 10 * MIN });
    const verdict: WorkMoment = { id: "security-verdict", taskId: "g", productId: "shop", at: NOW - HOUR, stageId: "g:security", kind: "verdict", roleId: "security-reviewer", profileId: "opus-high", verdict: "fail", count: 1, blocking: 1 };
    const row = usageView(logWith([{ turn: security }], [verdict]), { view: "analytics", period: "today" }, { now: NOW, state: s }).squad.details.reviewers[0]!;
    expect(row).toMatchObject({ stages: 1, time: { value: 10 * MIN, atLeast: false }, rounds: 1, blocking: 1, sentBack: 1 });
  });

  it("keeps a reviewer's fail verdict even when no new blocking finding was raised", () => {
    const reviewer = turn({ taskId: "g", roleId: "code-reviewer", profileId: "opus-high", stageId: "g:review" });
    const verdict: WorkMoment = { id: "verdict-only", taskId: "g", productId: "shop", at: NOW - HOUR, stageId: "g:review", kind: "verdict", roleId: "code-reviewer", profileId: "opus-high", verdict: "fail", count: 0, blocking: 0 };
    const row = usageView(logWith([{ turn: reviewer }], [verdict]), { view: "analytics", period: "today" }, { now: NOW, state: s }).squad.details.reviewers[0]!;
    expect(row).toMatchObject({ rounds: 1, blocking: 0, sentBack: 1 });
  });

  it("counts what the “About these numbers” note mentions", () => {
    expect(view.about).toMatchObject({ turns: 7, codexHelperTurns: 1, claudeMainOnly: 1 });
  });
});

describe("The squad", () => {
  it("counts fix rounds for a custom build-result role", () => {
    const current = state([task("custom", "shop")]);
    current.roles = [...current.roles, { ...current.roles.find(role => role.result === "build")!, id: "repair-specialist", name: "Repair specialist" }];
    const moment: WorkMoment = { id: "custom-fix", taskId: "custom", productId: "shop", at: NOW - HOUR, kind: "stage-end", stageKind: "do", roleId: "repair-specialist", round: 2, outcome: "done", durationMs: MIN, workMs: MIN };
    const squad = usageView(logWith([], [moment]), { view: "analytics", period: "today" }, { now: NOW, state: current }).squad;
    expect(squad.stageKinds).toEqual([expect.objectContaining({ key: "fixes", label: "Fixes after review", runs: 1 })]);
  });
  it("counts stages, deliveries, send-backs, design rounds, questions and failures", () => {
    const at = NOW - 2 * HOUR;
    const base = { taskId: "k", productId: "shop" };
    const moments: WorkMoment[] = [
      { ...base, id: "1", at, kind: "stage-end", stageKind: "do", roleId: "builder", round: 1, outcome: "done", durationMs: 40 * MIN, workMs: 30 * MIN },
      { ...base, id: "2", at, kind: "stage-end", stageKind: "do", roleId: "builder", round: 1, outcome: "done", durationMs: 20 * MIN, workMs: 20 * MIN },
      { ...base, id: "3", at, kind: "stage-end", stageKind: "review-chain", roleId: "code-reviewer", outcome: "sent-back", durationMs: 10 * MIN, workMs: 10 * MIN },
      { ...base, id: "4", at, kind: "review-end", outcome: "sent-back" },
      { ...base, id: "5", at, kind: "review-end", outcome: "passed" },
      { ...base, id: "6", at, kind: "design-end", outcome: "settled", rounds: 2 },
      { ...base, id: "7", at, kind: "design-end", outcome: "to-you", rounds: 3 },
      { ...base, id: "8", at, kind: "ask", ask: "question", answer: "answered", durationMs: 4 * MIN },
      { ...base, id: "9", at, kind: "ask", ask: "permission", answer: "allowed", durationMs: 2 * MIN },
      { ...base, id: "10", at, kind: "ask", ask: "checkpoint", answer: "approved", durationMs: 30 * MIN },
      { ...base, id: "11", at, kind: "failure", outcome: "limit" },
      { ...base, id: "12", at, kind: "retry" },
      { ...base, id: "13", at, kind: "redo" },
      { ...base, id: "14", at, kind: "task-end", outcome: "delivered" },
      { ...base, id: "15", at, kind: "task-end", outcome: "cancelled" },
    ];
    const log = logWith([{ turn: turn({ taskId: "k", roleId: "builder", profileId: "sol-high", end: "interrupted" }) }], moments);
    const squad = usageView(log, { view: "analytics", period: "today" }, { now: NOW, state: state([task("k", "shop")]) }).squad;
    expect(squad).toMatchObject({ stagesRun: 3, turnsRun: 1, delivered: 1, cancelled: 1 });
    // Deliveries are charted per day, Today included: one column for today, not one per hour.
    expect(squad.chart).toEqual([{ start: periodRange("today", NOW).from, label: "Today", delivered: 1, cancelled: 1 }]);
    const week = usageView(log, { view: "analytics", period: "7d" }, { now: NOW, state: state([task("k", "shop")]) }).squad;
    expect(week.chart).toHaveLength(7);
    expect(week.chart.at(-1)).toMatchObject({ delivered: 1, cancelled: 1 });
    expect(squad.stageKinds.find((kind) => kind.label === "Build")).toMatchObject({ runs: 2, typicalMs: 30 * MIN, agentShare: 50 / 60 });
    expect(squad.sendBacks).toBe("1 of 2 reviews sent work back to the builder.");
    expect(squad.designRounds).toBe("Designs took 2.5 rounds on average; 1 of 2 came to you to decide.");
    expect(squad.asks).toBe("Agents stopped to ask you 2 times; you answered in 3m on average. 1 checkpoint waited 30m on average for your OK.");
    expect(squad.failures).toBe("1 failure (1 usage limit reached) and 1 retry.");
    expect(squad.details).toMatchObject({ retries: 1, redone: 1, interrupted: 1 });
  });
});

describe("Unanswered requests", () => {
  it("counts unanswered questions without treating them as zero-length answers", () => {
    const base = { taskId: "q", productId: "shop", kind: "ask" as const, at: NOW - HOUR };
    const log = logWith([], [
      { ...base, id: "question", ask: "question" },
      { ...base, id: "permission", ask: "permission", answer: "allowed", durationMs: 4 * MIN },
      { ...base, id: "checkpoint", ask: "checkpoint" },
    ]);
    const squad = usageView(log, { view: "analytics", period: "today" }, { now: NOW, state: state([task("q", "shop")]) }).squad;
    expect(squad.asks).toContain("Agents stopped to ask you 2 times");
    expect(squad.asks).toContain("you answered in 4m on average; 1 unanswered");
    expect(squad.asks).toContain("1 checkpoint; 1 unanswered");
    expect(squad.asks).not.toContain("under a minute");
  });
});

describe("Today", () => {
  it("adds up since local midnight across products, per tool", () => {
    const yesterday = turn({ taskId: "m", roleId: "builder", profileId: "sol-high", startedAt: NOW - 20 * HOUR });
    const log = logWith([{ turn: turn({ taskId: "m", roleId: "builder", profileId: "sol-high" }) }, { turn: turn({ taskId: "n", productId: "notes", roleId: "builder", profileId: "opus-high" }) }, { turn: yesterday }]);
    const s = { ...state([task("m", "shop"), task("n", "notes")]), work: { version: 1, since: 0 } };
    const today = usageView(log, { view: "today" }, { now: NOW, state: s });
    expect(today.tokens.value).toBe(20_000);
    expect(today.byTool.find((entry) => entry.toolId === "codex")).toMatchObject({ tokens: { value: 10_000 } });
  });

  it("gives each tool's nearest limit with when it was reported, and drops it the moment it resets", () => {
    const weekly = { toolId: "codex", kind: "codex:primary", windowMinutes: 10_080, utilization: 0.16, status: "allowed" as const, resetsAt: NOW + 5 * 24 * HOUR, at: NOW - 2 * MIN };
    const fiveHour = { ...weekly, kind: "codex:secondary", windowMinutes: 300, utilization: 0.91, status: "allowed_warning" as const, resetsAt: NOW + HOUR };
    const limits = [weekly, fiveHour];
    expect(nearestLimitWords(limits, "codex", NOW)).toMatchObject({ label: "5-hour", used: "91% used · close to the limit", reported: "reported 2m ago" });
    expect(nextReset(limits, NOW)).toBe(NOW + HOUR);
    // Once the 5-hour limit resets, its old percentage is gone and the weekly one is the nearest.
    expect(nearestLimitWords(limits, "codex", NOW + HOUR)).toMatchObject({ label: "weekly", used: "16% used", reported: "reported 1h ago" });
    expect(nextReset(limits, NOW + HOUR)).toBe(NOW + 5 * 24 * HOUR);
    expect(nearestLimitWords(limits, "claude-code", NOW)).toBeUndefined();
    expect(nearestLimitWords(limits, "codex", NOW + 6 * 24 * HOUR)).toBeUndefined();
  });

  it("counts periods from local midnight", () => {
    const today = periodRange("today", NOW);
    expect(new Date(today.from).getHours()).toBe(0);
    expect(today.buckets).toHaveLength(24);
    const month = periodRange("30d", NOW);
    expect(month.buckets).toHaveLength(30);
    expect(new Date(month.from).getDate()).toBe(new Date(NOW - 29 * 24 * HOUR).getDate());
  });
});

describe("Words", () => {
  it("reads numbers in plain language", () => {
    expect(tokensText(820)).toBe("820 tokens");
    expect(tokensText(48_200)).toBe("48k tokens");
    expect(tokensText(1_900_000)).toBe("1.9M tokens");
    expect(durationText(40_000)).toBe("under a minute");
    expect(durationText(12 * MIN)).toBe("12m");
    expect(durationText(65 * MIN)).toBe("1h 05m");
    expect(durationText(312 * HOUR + 20 * MIN)).toBe("312h");
    expect(figureText({ value: 48_000, atLeast: true }, "tokens")).toBe("at least 48k tokens");
    expect(figureText({ atLeast: false }, "time")).toBe("not reported");
    expect(atLeastLine({ noTokens: 2, lost: 1, beforeTracking: true })).toBe(
      "“At least” because 2 turns sent no token report, 1 turn was cut off when Petrina stopped and work from before Petrina started keeping track isn't counted.",
    );
  });

  it("words limits with when they were reported, and never shows an old percentage as current", () => {
    const limit = { toolId: "claude-code", kind: "seven_day_opus", status: "allowed_warning" as const, utilization: 0.83, resetsAt: NOW + 2 * HOUR, at: NOW - 5 * MIN };
    expect(limitWords(limit, NOW)).toMatchObject({ used: "83% used · close to the limit", reported: "reported 5m ago", stale: false });
    expect(limitWords(limit, NOW).resets).toMatch(/^resets today \d\d:\d\d$/);
    expect(limitWords(limit, NOW + 3 * HOUR)).toMatchObject({ used: "has reset since it was last reported", stale: true });
    const { resetsAt: _reset, ...withoutReset } = { ...limit, at: NOW - HOUR };
    expect(limitWords(withoutReset, NOW)).toMatchObject({ used: "not reported", stale: true });
    expect(nearestLimit([withoutReset], "claude-code", NOW)).toBeUndefined();
    expect(limitWords({ toolId: "codex", kind: "primary", status: "allowed", at: NOW }, NOW).used).toBe("not reported");
    expect(limitWords({ ...limit, kind: "five_hour", status: "rejected" }, NOW)).toMatchObject({ label: "5-hour", status: "reached", used: "83% used · limit reached" });
    expect(agoText(NOW - 3 * HOUR, NOW)).toBe("3h ago");
  });

  it("reads Codex's limits, keeping only percentages, lengths and resets", () => {
    const limits = codexLimits(
      {
        rateLimits: { limitId: "codex", primary: { usedPercent: 16, windowDurationMins: 10_080, resetsAt: 1_792_673_339 } },
        rateLimitsByLimitId: { codex: { limitId: "codex", limitName: null, primary: { usedPercent: 16, windowDurationMins: 10_080, resetsAt: 1_792_673_339 }, secondary: { usedPercent: 91, windowDurationMins: 300, resetsAt: Math.round(NOW / 1000) + 3600 }, planType: "pro" } },
        accountId: "secret-account",
      },
      NOW,
    );
    expect(limits).toEqual([
      { toolId: "codex", kind: "codex:primary", windowMinutes: 10_080, at: NOW, utilization: 0.16, status: "allowed", resetsAt: 1_792_673_339_000 },
      { toolId: "codex", kind: "codex:secondary", windowMinutes: 300, at: NOW, utilization: 0.91, status: "allowed_warning", resetsAt: (Math.round(NOW / 1000) + 3600) * 1000 },
    ]);
    expect(JSON.stringify(limits)).not.toContain("secret");
    expect(nearestLimit(limits, "codex", NOW)?.kind).toBe("codex:secondary");
    expect(codexLimits(undefined, NOW)).toEqual([]);
  });
});

describe("Demos", () => {
  for (const [name, make] of [
    ["demo", createDemo],
    ["portfolio", createPortfolioDemo],
  ] as const) {
    it(`completes each existing request once in the ${name}`, () => {
      const demo = make(NOW);
      const sim = new Simulator(demo.state, { log: demo.log, open: demo.open, quirks: demo.quirks, triggers: demo.triggers });
      const requestKinds = ["question", "permission", "plan", "design", "delivery", "disagreement"];
      const pending = demo.state.inbox.filter((item) => requestKinds.includes(item.kind));
      expect(pending.length).toBeGreaterThan(0);
      for (const item of pending) {
        const requests = () => demo.log.moments({ taskId: item.taskId, kinds: ["ask"] });
        const before = requests();
        const original = before.find((moment) => moment.at === item.at && moment.answer === undefined)!;
        expect(original).toBeDefined();
        const respond = () => {
          if (item.kind === "question") sim.answer(item.id, item.options?.[0] ?? "Yes");
          else if (item.kind === "permission") sim.allow(item.id);
          else sim.approve(item.id);
        };
        respond();
        // Settling a disagreement can immediately raise a separate design checkpoint.
        const newRequests = sim.getState().inbox.filter((next) => next.taskId === item.taskId && requestKinds.includes(next.kind) && !pending.some((previous) => previous.id === next.id));
        expect(requests()).toHaveLength(before.length + newRequests.length);
        const completed = requests().find((moment) => moment.id === original.id)!;
        expect(completed.answer).toBe(item.kind === "question" ? "answered" : item.kind === "permission" ? "allowed" : "approved");
        expect(completed.at).toBe(original.at);
        expect(completed.durationMs).toBe(NOW - item.at);
        expect(requests().filter((moment) => moment.answer === undefined)).toHaveLength(before.filter((moment) => moment.answer === undefined).length - 1 + newRequests.length);
        const after = requests();
        respond();
        expect(requests()).toEqual(after);
      }
    });

    it(`gives the ${name} thirty believable days with every case the app explains`, () => {
      const demo = make(NOW);
      const sim = new Simulator(demo.state, { log: demo.log, open: demo.open, quirks: demo.quirks, triggers: demo.triggers });
      const month = sim.usage({ view: "analytics", period: "30d" });
      expect(month.byTool.map((entry) => entry.toolId).sort()).toEqual(["claude-code", "codex"]);
      expect(month.chart.buckets.filter((bucket) => Object.keys(bucket.tokens).length > 0).length).toBeGreaterThan(20);
      expect(month.headline.tokens.atLeast).toBe(true);
      expect(month.byProduct?.some((entry) => entry.note === "removed")).toBe(true);
      expect(month.about.codexHelperTurns).toBeGreaterThan(0);
      expect(month.squad.details.settingsLine).not.toMatch(/^0 agent stages/);
      expect(demo.log.lines({}).some((entry, _index, all) => all.some((other) => other.turnId === entry.turnId && other.model !== entry.model))).toBe(true);
      expect(demo.state.tasks.some((entry) => sim.usage({ view: "task", taskId: entry.id }).atLeast !== "")).toBe(true);
      expect(sim.usage({ view: "today" }).tokens.value).toBeGreaterThan(0);
      expect(sim.usage({ view: "products" }).products.every((entry) => entry.turns > 0 || !demo.state.tasks.some((t) => t.productId === entry.productId && t.state !== "queued"))).toBe(true);
      expect(demo.state.pool.usage?.length).toBeGreaterThan(0);
    });
  }

  it("keeps unanswered requests in the simulated squad when their task is cancelled", () => {
    const demo = createDemo(NOW);
    const sim = new Simulator(demo.state, { log: demo.log, open: demo.open, quirks: demo.quirks, triggers: demo.triggers });
    const question = demo.state.inbox.find((item) => item.kind === "question")!;
    const requests = () => demo.log.moments({ taskId: question.taskId, kinds: ["ask"] }).filter((moment) => moment.ask === "question" && moment.answer === undefined);
    expect(requests().length).toBeGreaterThan(0);
    const before = requests();
    sim.cancel(question.taskId);
    expect(requests()).toEqual(before);
    expect(sim.getState().inbox.some((item) => item.id === question.id)).toBe(false);
  });

  it("builds each demo once and gives every caller its own copy", () => {
    const first = createDemo(NOW);
    const size = first.log.size();
    const sim = new Simulator(first.state, { log: first.log, open: first.open, quirks: first.quirks, triggers: first.triggers, tickMs: 60_000 });
    for (let tick = 0; tick < 10; tick += 1) sim.tick();
    (first.state.tasks[0] as { title: string }).title = "Changed by one caller";
    expect(first.log.size()).toBeGreaterThan(size);
    const second = createDemo(NOW);
    expect(second.log.size()).toBe(size);
    expect(second.state.tasks[0]!.title).not.toBe("Changed by one caller");
    expect(second.log.products()).toEqual(first.log.products());
    expect(second.log.untracked()).toEqual(first.log.untracked());
  });

  it("keeps writing the same entries as the demo squad works", () => {
    const demo = createDemo(NOW);
    const sim = new Simulator(demo.state, { log: demo.log, open: demo.open, quirks: demo.quirks, triggers: demo.triggers, tickMs: 60_000 });
    const before = sim.usage({ view: "today" }).turns;
    const version = sim.getState().work!.version;
    for (let tick = 0; tick < 30; tick += 1) sim.tick();
    expect(sim.usage({ view: "today" }).turns).toBeGreaterThan(before);
    expect(sim.getState().work!.version).toBeGreaterThan(version);
  });
});

describe("A cancelled task's questions", () => {
  it("stay in its work history unanswered, so Analytics still counts how often agents needed you", () => {
    const demo = createDemo(NOW);
    const sim = new Simulator(demo.state, { log: demo.log, open: demo.open, quirks: demo.quirks, triggers: demo.triggers });
    const question = demo.state.inbox.find((item) => item.kind === "question")!;
    const open = () => demo.log.moments({ taskId: question.taskId, kinds: ["ask"] }).filter((moment) => moment.ask === "question" && moment.answer === undefined);
    const before = sim.usage({ view: "analytics", period: "7d" }).squad;
    expect(before.asks).toMatch(/unanswered/);
    expect(open().length).toBeGreaterThan(0);
    sim.cancel(question.taskId);
    expect(sim.getState().tasks.find((task) => task.id === question.taskId)?.state).toBe("cancelled");
    // The question is still there, still unanswered, and the squad's line reads the same.
    expect(open().length).toBeGreaterThan(0);
    const after = sim.usage({ view: "analytics", period: "7d" }).squad;
    expect(after.asks).toBe(before.asks);
    expect(after.cancelled).toBe(before.cancelled + 1);
  });
});
