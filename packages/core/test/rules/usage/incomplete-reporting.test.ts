import { NOW, MIN, HOUR, task, state, turn, line, logWith } from '../../fixtures/analytics.js';
import { describe, expect, it } from "vitest";

import { figureText } from "../../../src/numbers.js";

import { usageView } from "../../../src/analytics.js";

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
